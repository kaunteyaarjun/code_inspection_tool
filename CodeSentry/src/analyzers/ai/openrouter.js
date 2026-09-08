/**
 * OpenRouter AI Client for CodeSentry
 *
 * Implements the same adapter interface as anthropic.js:
 *   - analyze(prompt)          — single-prompt analysis
 *   - analyzeFindings(findings, discoveryResult) — batch finding analysis
 *   - mockMode                 — local testing without API key
 *   - setModelForContext(ctx)  — auto-select model based on codebase complexity
 *
 * All prompts are formatted as OpenAI-compatible messages:
 *   [{ role: "system", content: "..." }, { role: "user", content: "..." }]
 */

// ---------------------------------------------------------------------------
// Model catalogue – grouped by tier
// ---------------------------------------------------------------------------
const OPENROUTER_MODELS = {
  // ── Top-tier / flagship free models ──
  LAGUNA_S_2_1:           'poolside/laguna-s-2.1:free',
  NEMOTRON_3_ULTRA:       'nvidia/nemotron-3-ultra-550b-a55b:free',
  MINIMAX_M2_5:           'minimax/minimax-m2.5:free',

  // ── High-quality free models ──
  NEMOTRON_3_SUPER:       'nvidia/nemotron-3-super-120b-a12b:free',
  MIMO_2_5:               'mimo/mimo-2.5:free',
  NORTH_MINI_CODE:        'cohere/north-mini-code:free',

  // ── Solid free alternatives ──
  NEMOTRON_3_5_LIGHTNING: 'nvidia/nemotron-3.5-lightning:free',
  NEMOTRON_3_NANO:        'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  GLM_5_2:                'z-ai/glm-5.2:free',
  MINIMAX_M3:             'minimax/minimax-m3:free',
  INKLING:                'thinkingmachines/inkling:free',
  GEMMA_4_31B:            'google/gemma-4-31b-it:free',

  // ── Ultimate fallback (OpenRouter auto-routing) ──
  OPENROUTER_AUTO:        'openrouter/auto',
};

// Ordered fallback chain – tried in sequence when the primary model errors
const MODEL_FALLBACK_CHAIN = [
  OPENROUTER_MODELS.LAGUNA_S_2_1,
  OPENROUTER_MODELS.MINIMAX_M2_5,
  OPENROUTER_MODELS.NEMOTRON_3_SUPER,
  OPENROUTER_MODELS.MIMO_2_5,
  OPENROUTER_MODELS.NORTH_MINI_CODE,
  OPENROUTER_MODELS.NEMOTRON_3_ULTRA,
  OPENROUTER_MODELS.GLM_5_2,
  OPENROUTER_MODELS.GEMMA_4_31B,
];

// Absolute last resort — OpenRouter picks whatever free model is available
const LAST_RESORT_MODEL = OPENROUTER_MODELS.OPENROUTER_AUTO;

const DEFAULT_MODEL  = OPENROUTER_MODELS.LAGUNA_S_2_1;
const COMPLEX_MODEL  = OPENROUTER_MODELS.NEMOTRON_3_ULTRA;

// ---------------------------------------------------------------------------
// Complexity heuristics
// ---------------------------------------------------------------------------
const COMPLEXITY_THRESHOLDS = {
  fileCount: 50,
  languageCount: 3,
  totalLines: 5000,
  complexLanguages: ['typescript', 'python', 'java', 'go', 'rust'],
};

function calculateComplexity(scanContext) {
  if (!scanContext) return { score: 0, level: 'simple' };

  const fileCount     = scanContext.files?.length || 0;
  const languages     = scanContext.languages || [];
  const languageCount = languages.length;

  let totalLines = 0;
  if (scanContext.files) {
    for (const file of scanContext.files) {
      totalLines += file.lines || 0;
    }
  }

  let score = 0;
  score += Math.min(fileCount / COMPLEXITY_THRESHOLDS.fileCount, 1) * 30;
  score += Math.min(languageCount / COMPLEXITY_THRESHOLDS.languageCount, 1) * 20;
  score += Math.min(totalLines / COMPLEXITY_THRESHOLDS.totalLines, 1) * 30;

  const hasComplexLang = languages.some(l =>
    COMPLEXITY_THRESHOLDS.complexLanguages.includes(l.toLowerCase())
  );
  if (hasComplexLang) score += 20;

  if (score >= 70) return { score, level: 'complex' };
  if (score >= 40) return { score, level: 'moderate' };
  return { score, level: 'simple' };
}

function selectModel(scanContext, forceModel = null) {
  if (forceModel) return forceModel;

  const envModel = process.env.OPENROUTER_MODEL;
  if (envModel && envModel !== 'auto') return envModel;

  const { level } = calculateComplexity(scanContext);
  return level === 'complex' ? COMPLEX_MODEL : DEFAULT_MODEL;
}

// ---------------------------------------------------------------------------
// System prompt – shared across all calls
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = [
  'You are CodeSentry, an expert static-analysis AI that reviews code findings.',
  'You MUST respond with valid JSON only — no markdown fences, no commentary.',
  'Every response must be a single JSON object with these exact keys:',
  '  "explanation"  (string)  — concise technical explanation',
  '  "severity"     (string)  — one of HIGH, MEDIUM, LOW',
  '  "confidence"   (number)  — 0.0 to 1.0',
  '  "falsePositiveProbability" (number) — 0.0 to 1.0',
  '  "impact"       (string)  — brief impact description',
  '  "suggestedFix" (string)  — actionable fix recommendation',
].join('\n');

// ---------------------------------------------------------------------------
// OpenRouterClient
// ---------------------------------------------------------------------------
class OpenRouterClient {
  constructor(options = {}) {
    this.apiKey      = options.apiKey || process.env.OPENROUTER_API_KEY;
    this.model       = options.model  || selectModel(options.scanContext);
    this.maxTokens   = options.maxTokens   || 1024;
    this.temperature = options.temperature || 0.3;
    this.timeout     = options.timeout     || parseInt(process.env.OPENROUTER_TIMEOUT || '30000', 10);
    this.mockMode    = options.mockMode !== undefined ? options.mockMode : !this.apiKey;
    this.baseUrl     = 'https://openrouter.ai/api/v1';
    this.maxRetries  = options.maxRetries || 1;
  }

  // ── Primary interface (matches anthropic.js) ─────────────────────────────

  /**
   * Analyze a single prompt string.
   * The prompt is sent as the "user" message; a system message is prepended.
   */
  async analyze(prompt) {
    if (this.mockMode) {
      return this.mockAnalysis(prompt);
    }

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: prompt },
    ];

    return this._callWithFallback(messages);
  }

  /**
   * Convenience: analyze an array of findings, returning enriched findings.
   * This mirrors the pattern used by scan.js → analyzeWithAI().
   */
  async analyzeFindings(findings, discoveryResult, promptGenerator) {
    const analyzed = [];
    const maxFindings = parseInt(process.env.AI_MAX_FINDINGS || '10', 10);
    const batch = findings.slice(0, maxFindings);

    for (const finding of batch) {
      try {
        const sourceContext = this._getSourceContext(finding, discoveryResult);
        const prompt = promptGenerator.generateFindingAnalysisPrompt(finding, sourceContext);
        const aiResult = await this.analyze(prompt);
        analyzed.push({
          ...finding,
          aiAnalysis: {
            explanation: aiResult.explanation,
            confidence: aiResult.confidence,
            falsePositiveProbability: aiResult.falsePositiveProbability,
            impact: aiResult.impact,
            suggestedFix: aiResult.suggestedFix,
            model: this.model,
          },
        });
      } catch {
        analyzed.push(finding);
      }
    }

    const remaining = findings.slice(maxFindings);
    return [...analyzed, ...remaining];
  }

  // ── Model selection helpers ───────────────────────────────────────────────

  setModelForContext(scanContext) {
    const newModel = selectModel(scanContext, null);
    if (newModel !== this.model) {
      this.model = newModel;
      return true;
    }
    return false;
  }

  // ── API call with retry + model fallback ──────────────────────────────────

  async _callWithFallback(messages) {
    let lastError;

    // First: try the configured model
    try {
      const response = await this._callAPI(messages, this.model);
      return this._parseResponse(response);
    } catch (err) {
      lastError = err;
    }

    // Fallback: walk the chain, skipping the model we already tried
    for (const fallbackModel of MODEL_FALLBACK_CHAIN) {
      if (fallbackModel === this.model) continue;
      try {
        const response = await this._callAPI(messages, fallbackModel);
        this.model = fallbackModel; // sticky switch
        return this._parseResponse(response);
      } catch (err) {
        lastError = err;
      }
    }

    // Last resort: let OpenRouter auto-pick any available free model
    if (this.model !== LAST_RESORT_MODEL) {
      try {
        const response = await this._callAPI(messages, LAST_RESORT_MODEL);
        this.model = LAST_RESORT_MODEL;
        return this._parseResponse(response);
      } catch (err) {
        lastError = err;
      }
    }

    throw new Error(`AI analysis failed after trying all models including openrouter/auto: ${lastError?.message}`);
  }

  // ── Raw HTTP call (node:https, zero deps) ─────────────────────────────────

  async _callAPI(messages, model) {
    const https = require('https');

    return new Promise((resolve, reject) => {
      const url = new URL(`${this.baseUrl}/chat/completions`);

      const postData = JSON.stringify({
        model,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        messages,
      });

      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'Authorization':  `Bearer ${this.apiKey}`,
          'HTTP-Referer':   'https://github.com/codesentry',
          'X-Title':        'CodeSentry',
          'Content-Length':  Buffer.byteLength(postData),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const response = JSON.parse(data);

            if (response.error) {
              reject(new Error(`API error: ${response.error.message || JSON.stringify(response.error)}`));
              return;
            }

            if (res.statusCode !== 200) {
              reject(new Error(`API error ${res.statusCode}: ${response.error?.message || data}`));
              return;
            }

            resolve(response);
          } catch (err) {
            reject(new Error(`Failed to parse API response: ${err.message}`));
          }
        });
      });

      req.on('error', (err) => {
        reject(new Error(`API request failed: ${err.message}`));
      });

      const timeoutId = setTimeout(() => {
        req.destroy(new Error('API request timed out'));
        reject(new Error('API request timed out'));
      }, this.timeout);

      req.on('close', () => {
        clearTimeout(timeoutId);
      });

      req.write(postData);
      req.end();
    });
  }

  // ── Response parsing (handles nested JSON correctly) ──────────────────────

  _parseResponse(response) {
    try {
      const content = response.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('No content in AI response');
      }

      // Strip markdown code fences if the model wrapped the JSON
      let cleaned = content.trim();
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

      // Greedy match for the outermost JSON object (handles nested braces)
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }

      // Fallback: treat the whole response as a plain-text explanation
      return {
        explanation: content,
        severity: 'MEDIUM',
        confidence: 0.5,
        falsePositiveProbability: 0.3,
        impact: 'Unable to determine from AI response',
        suggestedFix: 'Review manually',
      };
    } catch (error) {
      throw new Error(`Failed to parse AI response: ${error.message}`);
    }
  }

  // ── Source context helper (for analyzeFindings) ────────────────────────────

  _getSourceContext(finding, discoveryResult) {
    if (!finding.file || !discoveryResult?.fileMap) return null;

    const fullPath = discoveryResult.fileMap[finding.file];
    if (!fullPath) return null;

    try {
      const fs = require('node:fs');
      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      const start = Math.max(0, (finding.line || 1) - 11);
      const end   = Math.min(lines.length, (finding.line || 1) + 10);
      return lines.slice(start, end).join('\n');
    } catch {
      return null;
    }
  }

  // ── Mock mode (testing without API key) ───────────────────────────────────

  async mockAnalysis(prompt) {
    await new Promise(resolve => setTimeout(resolve, 100));

    const lowerPrompt = prompt.toLowerCase();

    if (lowerPrompt.includes('sql injection') || lowerPrompt.includes('sql')) {
      return {
        explanation: 'User input is directly interpolated into a SQL query string without parameterization.',
        severity: 'HIGH',
        confidence: 0.92,
        falsePositiveProbability: 0.05,
        impact: 'Potential unauthorized database access or manipulation.',
        suggestedFix: 'Use parameterized queries or prepared statements.',
      };
    }

    if (lowerPrompt.includes('eval') || lowerPrompt.includes('exec')) {
      return {
        explanation: 'Use of eval() or exec() can execute arbitrary code, leading to code injection vulnerabilities.',
        severity: 'HIGH',
        confidence: 0.95,
        falsePositiveProbability: 0.02,
        impact: 'Remote code execution possible if input is attacker-controlled.',
        suggestedFix: 'Avoid eval/exec. Use safer alternatives like JSON.parse() for data or specific APIs for operations.',
      };
    }

    if (lowerPrompt.includes('hardcoded') || lowerPrompt.includes('credential') || lowerPrompt.includes('secret')) {
      return {
        explanation: 'Sensitive credentials are hardcoded in source code, making them visible to anyone with repository access.',
        severity: 'HIGH',
        confidence: 0.90,
        falsePositiveProbability: 0.08,
        impact: 'Credential leakage could lead to unauthorized access.',
        suggestedFix: 'Move credentials to environment variables or a secure vault.',
      };
    }

    if (lowerPrompt.includes('unused') || lowerPrompt.includes('dead code')) {
      return {
        explanation: 'Code is defined but never used, indicating potential dead code or incomplete implementation.',
        severity: 'LOW',
        confidence: 0.85,
        falsePositiveProbability: 0.10,
        impact: 'Code maintainability and clarity reduced.',
        suggestedFix: 'Remove unused code or add appropriate usage.',
      };
    }

    if (lowerPrompt.includes('xss') || lowerPrompt.includes('cross-site')) {
      return {
        explanation: 'User-supplied data is rendered in the DOM without sanitization, enabling cross-site scripting.',
        severity: 'HIGH',
        confidence: 0.88,
        falsePositiveProbability: 0.07,
        impact: 'Attackers can inject malicious scripts to steal sessions or data.',
        suggestedFix: 'Sanitize all user input before rendering. Use textContent or a sanitization library.',
      };
    }

    if (lowerPrompt.includes('path traversal') || lowerPrompt.includes('directory traversal')) {
      return {
        explanation: 'File path constructed from user input without validation allows directory traversal.',
        severity: 'HIGH',
        confidence: 0.91,
        falsePositiveProbability: 0.04,
        impact: 'Arbitrary file read/write outside intended directories.',
        suggestedFix: 'Validate and canonicalize paths. Use path.resolve() and verify the result is within the allowed directory.',
      };
    }

    // Default response
    return {
      explanation: 'This finding requires manual review to determine its severity and impact.',
      severity: 'MEDIUM',
      confidence: 0.50,
      falsePositiveProbability: 0.20,
      impact: 'Impact assessment requires contextual analysis.',
      suggestedFix: 'Review the code in context and apply appropriate remediation.',
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
function createOpenRouterClient(options = {}) {
  return new OpenRouterClient(options);
}

module.exports = {
  OPENROUTER_MODELS,
  MODEL_FALLBACK_CHAIN,
  LAST_RESORT_MODEL,
  OpenRouterClient,
  createOpenRouterClient,
  DEFAULT_MODEL,
  COMPLEX_MODEL,
  SYSTEM_PROMPT,
  calculateComplexity,
  selectModel,
};
