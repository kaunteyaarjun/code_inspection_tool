/**
 * CodeSentry CLI Authentication & Global Configuration
 *
 * Provides a proper CLI experience (similar to gh, vercel, or aws CLI):
 * - Stores user configuration globally in ~/.codesentry/config.json
 * - Detects first-time boot when no OPENROUTER_API_KEY is configured
 * - Interactively prompts for API key and saves it locally
 * - Masks API keys for safe display in logs and status screens
 * - Provides 'codesentry auth' commands to inspect or update credentials
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const theme = require('./theme');
const { Select } = require('./components/select');
const { formatStatusIndicator } = require('./components/status-indicator');

/**
 * Returns the global configuration directory path: ~/.codesentry
 */
function getGlobalConfigDir() {
  return path.join(os.homedir(), '.codesentry');
}

/**
 * Returns the global config file path: ~/.codesentry/config.json
 */
function getGlobalConfigPath() {
  return path.join(getGlobalConfigDir(), 'config.json');
}

/**
 * Reads and parses the global config JSON file.
 * Returns an empty object if the file doesn't exist or is invalid.
 */
function readGlobalConfig(customPath = null) {
  const filePath = customPath || getGlobalConfigPath();
  try {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
  * Merges updates into the global config JSON file and writes it to disk.
  * Creates the ~/.codesentry directory if it doesn't exist.
  */
function saveGlobalConfig(updates = {}, customPath = null) {
  const filePath = customPath || getGlobalConfigPath();
  const dirPath = path.dirname(filePath);

  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    const existing = readGlobalConfig(filePath);
    const merged = {
      ...existing,
      ...updates,
      updated_at: new Date().toISOString(),
    };

    if (!merged.created_at) {
      merged.created_at = new Date().toISOString();
    }

    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  } catch (err) {
    return null;
  }
}

/**
 * Loads global config and injects OPENROUTER_API_KEY and OPENROUTER_MODEL
 * into process.env if they are not already set.
 */
function loadGlobalConfig(customPath = null) {
  const config = readGlobalConfig(customPath);

  if (!process.env.OPENROUTER_API_KEY && config.openrouter_api_key) {
    process.env.OPENROUTER_API_KEY = config.openrouter_api_key;
  }

  if (!process.env.OPENROUTER_MODEL && config.openrouter_model) {
    process.env.OPENROUTER_MODEL = config.openrouter_model;
  }

  return {
    config,
    apiKey: process.env.OPENROUTER_API_KEY || null,
    model: process.env.OPENROUTER_MODEL || 'poolside/laguna-s-2.1:free',
    isConfigured: Boolean(process.env.OPENROUTER_API_KEY),
  };
}

/**
 * Masks an API key for safe display: e.g. "sk-or-v1-••••••••9339"
 */
function maskApiKey(key) {
  if (!key || typeof key !== 'string') {
    return '(not configured)';
  }
  const trimmed = key.trim();
  if (trimmed.length <= 12) {
    return '••••••••';
  }
  if (trimmed.startsWith('sk-or-v1-')) {
    const suffix = trimmed.slice(-4);
    return `sk-or-v1-••••••••••••${suffix}`;
  }
  const prefix = trimmed.slice(0, 6);
  const suffix = trimmed.slice(-4);
  return `${prefix}••••••••••••${suffix}`;
}

/**
 * Interactive prompt to read input from terminal using readline.
 */
function promptInput(promptText = '> ') {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      resolve('');
      return;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(promptText, (answer) => {
      rl.close();
      resolve((answer || '').trim());
    });
  });
}

/**
 * First-boot authentication check.
 * If OPENROUTER_API_KEY is missing and running in an interactive TTY,
 * displays the setup wizard, prompts the user, and persists the key locally.
 */
async function ensureAuth(options = {}) {
  const { jsonMode = false, forcePrompt = false, noAi = false } = options;

  // If user explicitly passed --no-ai, respect it without prompting
  if (noAi) {
    return { isConfigured: false, skipped: true };
  }

  // Check if we already have an API key (from env, .env, or ~/.codesentry/config.json)
  const currentKey = process.env.OPENROUTER_API_KEY;
  if (currentKey && !forcePrompt) {
    return {
      isConfigured: true,
      apiKey: currentKey,
      model: process.env.OPENROUTER_MODEL || 'poolside/laguna-s-2.1:free',
    };
  }

  // In non-interactive environments (CI/CD, pipes, JSON mode), do not block
  const isInteractive = Boolean(process.stdout.isTTY && process.stdin.isTTY && !jsonMode);
  if (!isInteractive) {
    return {
      isConfigured: false,
      apiKey: null,
      skipped: true,
    };
  }

  // ── Render First-Time Setup Welcome Card ──────────────────────────────────
  const setupLines = [
    `${theme.colors.cyan('▎')} ${theme.colors.brightWhite(theme.bold('Welcome to CodeSentry!'))}`,
    `${theme.colors.cyan('▎')}`,
    `${theme.colors.cyan('▎')} CodeSentry uses OpenRouter AI for DevSecOps vulnerability triage,`,
    `${theme.colors.cyan('▎')} remediation diff generation, and architecture security checks.`,
    `${theme.colors.cyan('▎')}`,
    `${theme.colors.cyan('▎')} ${theme.colors.cyan('•')} ${theme.colors.white('Free tier models supported out of the box (Laguna S 2.1, Nemotron)')}`,
    `${theme.colors.cyan('▎')} ${theme.colors.cyan('•')} ${theme.colors.white('Get a free API key at:')} ${theme.colors.cyan('https://openrouter.ai/keys')}`,
    `${theme.colors.cyan('▎')} ${theme.colors.cyan('•')} ${theme.colors.white('Keys are saved locally to:')} ${theme.colors.gray('~/.codesentry/config.json')}`,
  ];

  console.log('');
  console.log(theme.card(setupLines, {
    title: theme.colors.cyan(theme.bold('FIRST-TIME SETUP')),
    rightTitle: theme.colors.gray('codesentry v0.1.0'),
    width: 72,
  }));
  console.log('');

  const choices = [
    {
      label: 'Enter OpenRouter API Key now (Recommended)',
      value: 'enter_key',
      badge: 'RECOMMENDED',
      description: 'Save key locally to unlock AI deep security triage and fixes',
    },
    {
      label: 'Continue with Static Rules only (Skip AI for now)',
      value: 'skip',
      description: 'Run static engines (Ruff, Bandit, Semgrep) without cloud AI',
    },
  ];

  const choice = await Select({
    label: 'Select setup option:',
    options: choices,
    defaultIndex: 0,
  });

  if (choice === 'enter_key') {
    console.log('\n' + theme.colors.cyan('▎') + ' ' + theme.colors.white('Paste your OpenRouter API key below (starts with sk-or-):'));
    const inputKey = await promptInput(theme.colors.cyan('  OpenRouter API Key: '));

    if (inputKey && inputKey.length >= 8) {
      const defaultModel = process.env.OPENROUTER_MODEL || 'poolside/laguna-s-2.1:free';
      saveGlobalConfig({
        openrouter_api_key: inputKey,
        openrouter_model: defaultModel,
      });

      process.env.OPENROUTER_API_KEY = inputKey;
      process.env.OPENROUTER_MODEL = defaultModel;

      console.log('');
      console.log(formatStatusIndicator({
        status: 'online',
        label: `OpenRouter API key saved locally to ${theme.colors.gray('~/.codesentry/config.json')}`,
      }));
      console.log(theme.colors.gray(`  Key: ${maskApiKey(inputKey)} · Model: ${defaultModel}\n`));

      return {
        isConfigured: true,
        apiKey: inputKey,
        model: defaultModel,
      };
    } else {
      console.log('\n' + formatStatusIndicator({
        status: 'warning',
        label: 'No valid key entered. Continuing with static analysis only.',
      }));
      console.log(theme.colors.gray("  Run 'codesentry auth' anytime to configure your key.\n"));
      return { isConfigured: false, skipped: true };
    }
  }

  // User chose to skip
  console.log('\n' + formatStatusIndicator({
    status: 'warning',
    label: 'Proceeding with static analysis only (AI disabled).',
  }));
  console.log(theme.colors.gray("  Run 'codesentry auth' anytime to configure your key.\n"));

  return {
    isConfigured: false,
    skipped: true,
  };
}

/**
 * Interactive 'codesentry auth' dashboard handler
 */
async function handleAuthCommand(options = {}) {
  theme.applyBlackTerminalBackground();
  console.log(theme.renderLogo());

  const currentConfig = readGlobalConfig();
  const currentKey = process.env.OPENROUTER_API_KEY || currentConfig.openrouter_api_key || null;
  const currentModel = process.env.OPENROUTER_MODEL || currentConfig.openrouter_model || 'poolside/laguna-s-2.1:free';
  const configPath = getGlobalConfigPath();

  const isConfigured = Boolean(currentKey);

  const statusLines = [
    `${theme.colors.cyan('▎')} ${theme.colors.brightWhite(theme.bold('Authentication Status'))}`,
    `${theme.colors.cyan('▎')}`,
    `${theme.colors.cyan('▎')} ${theme.colors.white('Status:')}    ${isConfigured ? theme.colors.green('● Configured & Ready') : theme.colors.yellow('○ Not configured (Static mode only)')}`,
    `${theme.colors.cyan('▎')} ${theme.colors.white('API Key:')}   ${theme.colors.cyan(maskApiKey(currentKey))}`,
    `${theme.colors.cyan('▎')} ${theme.colors.white('AI Model:')}  ${theme.colors.brightWhite(currentModel)}`,
    `${theme.colors.cyan('▎')} ${theme.colors.white('Config:')}    ${theme.colors.gray(configPath)}`,
  ];

  console.log(theme.card(statusLines, {
    title: theme.colors.cyan(theme.bold('CODESENTRY AUTH')),
    rightTitle: theme.colors.gray('codesentry v0.1.0'),
    width: 72,
  }));
  console.log('');

  const menuOptions = [
    {
      label: isConfigured ? 'Update OpenRouter API Key' : 'Enter OpenRouter API Key',
      value: 'update_key',
      badge: 'KEY',
      description: 'Enter and save a new OpenRouter API key to ~/.codesentry/config.json',
    },
    {
      label: 'Switch Active AI Model',
      value: 'switch_model',
      badge: 'MODEL',
      description: 'Select your preferred AI model for vulnerability analysis',
    },
  ];

  if (isConfigured) {
    menuOptions.push({
      label: 'Remove API Key (Logout / Static mode)',
      value: 'logout',
      badge: 'LOGOUT',
      description: 'Delete stored key from ~/.codesentry/config.json',
    });
  }

  menuOptions.push({
    label: 'Done / Exit',
    value: 'exit',
    description: 'Return to terminal',
  });

  const action = await Select({
    label: 'Manage CodeSentry Authentication:',
    options: menuOptions,
    defaultIndex: 0,
  });

  if (action === 'update_key') {
    console.log('\n' + theme.colors.cyan('▎') + ' ' + theme.colors.white('Paste your OpenRouter API key below (https://openrouter.ai/keys):'));
    const inputKey = await promptInput(theme.colors.cyan('  OpenRouter API Key: '));

    if (inputKey && inputKey.length >= 8) {
      saveGlobalConfig({
        openrouter_api_key: inputKey,
        openrouter_model: currentModel,
      });
      process.env.OPENROUTER_API_KEY = inputKey;

      console.log('\n' + formatStatusIndicator({
        status: 'online',
        label: `OpenRouter API key updated in ${theme.colors.gray('~/.codesentry/config.json')}`,
      }));
      console.log(theme.colors.gray(`  Key: ${maskApiKey(inputKey)}\n`));
    } else {
      console.log('\n' + formatStatusIndicator({
        status: 'warning',
        label: 'No changes made.',
      }) + '\n');
    }
  } else if (action === 'switch_model') {
    const { Select: SelectComponent } = require('./components/select');
    // Import model catalog from bin or define standard options
    const modelOptions = [
      {
        label: 'MiniMax M3 (minimax/minimax-m3)',
        value: 'minimax/minimax-m3',
        badge: 'RECOMMENDED',
        description: 'Premier code reasoning & automated repair model with high precision synthesis',
      },
      {
        label: 'DeepSeek V3 (deepseek/deepseek-chat)',
        value: 'deepseek/deepseek-chat',
        badge: 'POPULAR',
        description: 'High-precision automated code repair and vulnerability remediation',
      },
      {
        label: 'Qwen 2.5 Coder 32B (qwen/qwen-2.5-coder-32b-instruct)',
        value: 'qwen/qwen-2.5-coder-32b-instruct',
        badge: '#1 CODING',
        description: 'Top-ranking open coding benchmark model (92.7% HumanEval)',
      },
      {
        label: 'Llama 3.3 70B (meta-llama/llama-3.3-70b-instruct)',
        value: 'meta-llama/llama-3.3-70b-instruct',
        badge: '70B PARAMS',
        description: 'State-of-the-art open reasoning and multi-turn refactoring',
      },
      {
        label: 'Qwen 2.5 72B (qwen/qwen-2.5-72b-instruct)',
        value: 'qwen/qwen-2.5-72b-instruct',
        badge: '72B PARAMS',
        description: 'Deep polyglot code reasoning and architectural analysis',
      },
      {
        label: 'MiniMax M2.5 (minimax/minimax-m2.5)',
        value: 'minimax/minimax-m2.5',
        badge: 'FAST',
        description: 'High-speed balanced code inspection and remediation diffs',
      },
      {
        label: 'GLM 5.2 (z-ai/glm-5.2)',
        value: 'z-ai/glm-5.2',
        description: 'High-performance general reasoning and code triage',
      },
      {
        label: 'Cohere North Mini Code (cohere/north-mini-code:free)',
        value: 'cohere/north-mini-code:free',
        badge: 'FREE',
        description: 'Fast Cohere-optimized code structure analysis',
      },
      {
        label: 'Auto (Smart Context-Aware Heuristics)',
        value: 'auto',
        badge: 'AUTO',
        description: 'Dynamically adapts model selection based on project size & complexity',
      },
      {
        label: 'Disable AI (Static Analysis Only)',
        value: 'none',
        description: 'Run static engines (Ruff, Bandit, Semgrep) without cloud AI',
      },
    ];

    const chosenModel = await SelectComponent({
      label: 'Select Active AI Model:',
      options: modelOptions,
      defaultIndex: 0,
    });

    if (chosenModel) {
      saveGlobalConfig({ openrouter_model: chosenModel });
      process.env.OPENROUTER_MODEL = chosenModel;
      console.log('\n' + formatStatusIndicator({
        status: 'online',
        label: `Active model saved to global config: ${theme.colors.cyan(chosenModel)}\n`,
      }));
    }
  } else if (action === 'logout') {
    saveGlobalConfig({ openrouter_api_key: null });
    delete process.env.OPENROUTER_API_KEY;
    console.log('\n' + formatStatusIndicator({
      status: 'warning',
      label: 'OpenRouter API key removed from local config. Running in static mode.\n',
    }));
  }

  process.exit(0);
}

module.exports = {
  getGlobalConfigDir,
  getGlobalConfigPath,
  readGlobalConfig,
  saveGlobalConfig,
  loadGlobalConfig,
  maskApiKey,
  promptInput,
  ensureAuth,
  handleAuthCommand,
};
