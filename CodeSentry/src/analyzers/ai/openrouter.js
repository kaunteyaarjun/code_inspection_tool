const OPENROUTER_MODELS = {
  NEMOTRON_3_SUPER: 'nvidia/nemotron-3-super-120b-a12b:free',
  NEMOTRON_3_ULTRA: 'nvidia/nemotron-3-ultra-550b-a55b:free',
  NEMOTRON_3_5_LIGHTNING: 'nvidia/nemotron-3.5-lightning:free',
  NEMOTRON_3_NANO: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  GLM_5_2: 'z-ai/glm-5.2:free',
  MINIMAX_M3: 'minimax/minimax-m3:free',
  INKLING: 'thinkingmachines/inkling:free',
  GEMMA_4_31B: 'google/gemma-4-31b-it:free',
};

const DEFAULT_MODEL = OPENROUTER_MODELS.NEMOTRON_3_SUPER;
const COMPLEX_MODEL = OPENROUTER_MODELS.NEMOTRON_3_ULTRA;

const COMPLEXITY_THRESHOLDS = {
  fileCount: 50,
  languageCount: 3,
  totalLines: 5000,
  complexLanguages: ['typescript', 'python', 'java', 'go', 'rust'],
};

function calculateComplexity(scanContext) {
  if (!scanContext) return { score: 0, level: 'simple' };

  const fileCount = scanContext.files?.length || 0;
  const languages = scanContext.languages || [];
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

class OpenRouterClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.OPENROUTER_API_KEY;
    this.model = options.model || selectModel(options.scanContext);
    this.maxTokens = options.maxTokens || 1024;
    this.temperature = options.temperature || 0.3;
    this.timeout = options.timeout || 30000;
    this.mockMode = options.mockMode || !this.apiKey;
    this.baseUrl = 'https://openrouter.ai/api/v1';
  }

  async analyze(prompt) {
    if (this.mockMode) {
      return this.mockAnalysis(prompt);
    }

    try {
      const response = await this.callAPI(prompt);
      return this.parseResponse(response);
    } catch (error) {
      throw new Error(`AI analysis failed: ${error.message}`);
    }
  }

  setModelForContext(scanContext) {
    const newModel = selectModel(scanContext, null);
    if (newModel !== this.model) {
      this.model = newModel;
      return true;
    }
    return false;
  }

  async callAPI(prompt) {
    const https = require('https');

    return new Promise((resolve, reject) => {
      const url = new URL(`${this.baseUrl}/chat/completions`);

      const postData = JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'HTTP-Referer': 'https://github.com/codesentry',
          'X-Title': 'CodeSentry',
          'Content-Length': Buffer.byteLength(postData),
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

  parseResponse(response) {
    try {
      const content = response.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('No content in AI response');
      }

      const jsonMatch = content.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }

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

function createOpenRouterClient(options = {}) {
  return new OpenRouterClient(options);
}

module.exports = {
  OPENROUTER_MODELS,
  OpenRouterClient,
  createOpenRouterClient,
  DEFAULT_MODEL,
  COMPLEX_MODEL,
  calculateComplexity,
  selectModel,
};
