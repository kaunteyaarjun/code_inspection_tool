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
  // ── Premier Flagship Coding Benchmark Models ──
  MINIMAX_M3:             'minimax/minimax-m3',
  DEEPSEEK_CHAT:          'deepseek/deepseek-chat',
  QWEN_CODER_32B:         'qwen/qwen-2.5-coder-32b-instruct',
  LLAMA_3_3_70B:          'meta-llama/llama-3.3-70b-instruct',
  QWEN_72B:               'qwen/qwen-2.5-72b-instruct',
  MINIMAX_M2_5:           'minimax/minimax-m2.5',
  GLM_5_2:                'z-ai/glm-5.2',

  // ── Free / High-Speed Fallbacks ──
  NORTH_MINI_CODE:        'cohere/north-mini-code:free',
  NEMOTRON_3_SUPER:       'nvidia/nemotron-3-super-120b-a12b:free',

  // ── Backward-compatible Aliases ──
  LAGUNA_S_2_1:           'poolside/laguna-s-2.1:free',
  NEMOTRON_3_ULTRA:       'nvidia/nemotron-3-ultra-550b-a55b:free',
  MIMO_2_5:               'mimo/mimo-2.5:free',
  GEMMA_4_31B:            'google/gemma-4-31b-it:free',
  MINIMAX_M3_FREE:        'minimax/minimax-m3:free',
  MINIMAX_M2_5_FREE:      'minimax/minimax-m2.5:free',
  GLM_5_2_FREE:           'z-ai/glm-5.2:free',

  // ── Ultimate fallback (OpenRouter auto-routing) ──
  OPENROUTER_AUTO:        'openrouter/auto',
};

// Ordered fallback chain – tried in sequence when the primary model errors
// Only includes verified, active models tested against OpenRouter API
const MODEL_FALLBACK_CHAIN = [
  OPENROUTER_MODELS.MINIMAX_M3,
  OPENROUTER_MODELS.DEEPSEEK_CHAT,
  OPENROUTER_MODELS.QWEN_CODER_32B,
  OPENROUTER_MODELS.LLAMA_3_3_70B,
  OPENROUTER_MODELS.QWEN_72B,
  OPENROUTER_MODELS.MINIMAX_M2_5,
  OPENROUTER_MODELS.GLM_5_2,
  OPENROUTER_MODELS.NORTH_MINI_CODE,
  OPENROUTER_MODELS.NEMOTRON_3_SUPER,
  OPENROUTER_MODELS.OPENROUTER_AUTO,
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

const REPAIR_SYSTEM_PROMPT = [
  'You are CodeSentry Automated Code Repair Assistant.',
  'Your job is to generate a functional, production-ready code repair for a detected code finding.',
  'CRITICAL RULES:',
  '1. You MUST produce a REAL code fix that fixes the bug, vulnerability, or inefficiency — never just add a comment.',
  '2. You MUST respond with valid JSON only — no markdown fences, no conversational text.',
  '3. The JSON object must have EXACTLY these three keys:',
  '   "explanation"  (string) — concise 1-sentence technical explanation of what was changed',
  '   "oldSnippet"   (string) — the EXACT substring from the original code to be replaced',
  '   "newSnippet"   (string) — the drop-in replacement code that resolves the issue',
  '4. "oldSnippet" MUST match the source code snippet exactly (including whitespace/indentation) so string replacement succeeds.',
].join('\n');

const BATCH_REPAIR_SYSTEM_PROMPT = [
  'You are CodeSentry Automated Code Repair Assistant.',
  'Your job is to fix ALL listed code issues in the provided file simultaneously.',
  'CRITICAL RULES:',
  '1. You MUST produce REAL code fixes that fix the bugs, security flaws, or inefficiencies — never just add comments.',
  '2. You MUST respond with valid JSON only — no markdown fences, no conversational text.',
  '3. The response must be a single JSON object with a "fixes" array:',
  '   {',
  '     "fixes": [',
  '       {',
  '         "explanation": "concise description of this specific change",',
  '         "oldSnippet": "exact substring from the source code to replace",',
  '         "newSnippet": "the replacement code"',
  '       }',
  '     ]',
  '   }',
  '4. "oldSnippet" must match characters in the source file EXACTLY (including indentation) so string replacement succeeds.',
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

  // ── Code Repair with Dynamic Model Switching ─────────────────────────────

  /**
   * Generates a code repair diff for a finding, with automated multi-model cascading.
   * If the preferred model fails or produces an invalid replacement snippet, it automatically
   * walks down the fallback model chain until a model succeeds.
   */
  async repairCode({ finding, fileContent, line, file, preferredModel, onModelSwitch }) {
    if (this.mockMode) {
      return this.mockRepairCode({ finding, fileContent, line, file });
    }

    const lines = (fileContent || '').split('\n');
    const targetLine = line || finding.line || 1;
    const startIdx = Math.max(0, targetLine - 5);
    const endIdx = Math.min(lines.length - 1, targetLine + 4);
    const contextSnippet = lines.slice(startIdx, endIdx + 1).join('\n');

    const prompt = [
      `File: ${file || finding.file || 'unknown'}`,
      `Line: ${targetLine}`,
      `Rule: ${finding.rule || 'N/A'}`,
      `Category: ${finding.category || 'general'}`,
      `Severity: ${finding.severity || 'MEDIUM'}`,
      `Message: ${finding.message || ''}`,
      finding.suggestedFix ? `Suggested approach: ${finding.suggestedFix}` : '',
      '',
      `Context snippet around line ${targetLine}:`,
      '```',
      contextSnippet,
      '```',
      '',
      'Respond with ONLY a JSON object: {"explanation": "...", "oldSnippet": "...", "newSnippet": "..."}',
    ].filter(Boolean).join('\n');

    const messages = [
      { role: 'system', content: REPAIR_SYSTEM_PROMPT },
      { role: 'user',   content: prompt },
    ];

    // Build the prioritized model list:
    // 1. preferredModel (or this.model, e.g. minimax/minimax-m3:free)
    // 2. MODEL_FALLBACK_CHAIN
    // 3. LAST_RESORT_MODEL (openrouter/auto)
    const primary = preferredModel || this.model || OPENROUTER_MODELS.MINIMAX_M3;
    const modelsToTry = [primary];
    for (const m of MODEL_FALLBACK_CHAIN) {
      if (!modelsToTry.includes(m)) modelsToTry.push(m);
    }
    if (!modelsToTry.includes(LAST_RESORT_MODEL)) {
      modelsToTry.push(LAST_RESORT_MODEL);
    }

    let lastError = null;
    for (let i = 0; i < modelsToTry.length; i++) {
      const modelCandidate = modelsToTry[i];
      try {
        const response = await this._callAPI(messages, modelCandidate);
        const parsed = this._parseRepairResponse(response, fileContent);
        if (parsed && parsed.oldSnippet && parsed.newSnippet) {
          const switchedFrom = modelCandidate !== primary ? primary : null;
          return {
            ...parsed,
            modelUsed: modelCandidate,
            switchedFrom,
          };
        }
        lastError = new Error(`Model ${modelCandidate} returned empty or invalid snippet`);
      } catch (err) {
        lastError = err;
      }

      // Check if OpenRouter recommended a replacement model slug
      const slugMatch = lastError?.message?.match(/use this slug instead:\s*([a-zA-Z0-9_./-]+)/i);
      if (slugMatch && slugMatch[1] && !modelsToTry.includes(slugMatch[1])) {
        modelsToTry.splice(i + 1, 0, slugMatch[1]);
      }

      if (i + 1 < modelsToTry.length && typeof onModelSwitch === 'function') {
        const nextModel = modelsToTry[i + 1];
        const isTokenExpire = /token|quota|rate\s*limit|429|402|context\s*length|exceeded|credit|balance|timeout/i.test(lastError?.message || '');
        onModelSwitch({
          failedModel: modelCandidate,
          nextModel,
          error: lastError?.message || 'Failed to generate code repair',
          isTokenExpire,
        });
      }
    }

    return {
      error: `AI repair failed across all models (${modelsToTry.slice(0, 3).join(', ')}...): ${lastError?.message || 'Unable to generate fix'}`,
    };
  }

  _parseRepairResponse(response, fileContent) {
    try {
      const content = response.choices?.[0]?.message?.content;
      if (!content) return null;

      let cleaned = content.trim();
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.oldSnippet || !parsed.newSnippet) return null;

      if (fileContent && !fileContent.includes(parsed.oldSnippet)) {
        const trimmedOld = parsed.oldSnippet.trim();
        if (fileContent.includes(trimmedOld)) {
          parsed.oldSnippet = trimmedOld;
        }
      }

      return {
        oldSnippet: parsed.oldSnippet,
        newSnippet: parsed.newSnippet,
        explanation: parsed.explanation || 'Applied AI automated code repair',
      };
    } catch {
      return null;
    }
  }

  // ── Holistic File Batch Repair with Dynamic Model Switching ──────────────

  /**
   * Repairs multiple findings across an entire file in ONE single AI call.
   * Sends the file context along with the summary list of all findings.
   * If token limit expires or a model fails, switches models dynamically.
   */
  async repairFileBatch({ file, fileContent, findings, preferredModel, onModelSwitch }) {
    if (this.mockMode) {
      return this.mockRepairFileBatch({ file, fileContent, findings });
    }

    const issuesSummary = findings.map((f, i) =>
      `${i + 1}. Line ${f.line || 1} [${f.rule || f.category}]: ${f.message}${f.suggestedFix ? ` -> Recommended: ${f.suggestedFix}` : ''}`
    ).join('\n');

    const prompt = [
      `File: ${file}`,
      'The static analysis engine found the following issues in this file:',
      issuesSummary,
      '',
      'Source code of the file:',
      '```',
      fileContent,
      '```',
      '',
      'Please resolve ALL of the above issues in this file simultaneously.',
      'Respond with ONLY a JSON object in this format:',
      '{"fixes": [{"explanation": "...", "oldSnippet": "exact code substring to replace", "newSnippet": "replacement code"}]}',
    ].join('\n');

    const messages = [
      { role: 'system', content: BATCH_REPAIR_SYSTEM_PROMPT },
      { role: 'user',   content: prompt },
    ];

    const primary = preferredModel || this.model || OPENROUTER_MODELS.MINIMAX_M3;
    const modelsToTry = [primary];
    for (const m of MODEL_FALLBACK_CHAIN) {
      if (!modelsToTry.includes(m)) modelsToTry.push(m);
    }
    if (!modelsToTry.includes(LAST_RESORT_MODEL)) {
      modelsToTry.push(LAST_RESORT_MODEL);
    }

    let lastError = null;
    for (let i = 0; i < modelsToTry.length; i++) {
      const modelCandidate = modelsToTry[i];
      try {
        const response = await this._callAPI(messages, modelCandidate, 2048);
        const fixes = this._parseBatchRepairResponse(response, fileContent);
        if (fixes && fixes.length > 0) {
          const switchedFrom = modelCandidate !== primary ? primary : null;
          return {
            fixes,
            modelUsed: modelCandidate,
            switchedFrom,
          };
        }
        lastError = new Error(`Model ${modelCandidate} returned empty or invalid batch fixes`);
      } catch (err) {
        lastError = err;
      }

      // Check if OpenRouter recommended a replacement model slug
      const slugMatch = lastError?.message?.match(/use this slug instead:\s*([a-zA-Z0-9_./-]+)/i);
      if (slugMatch && slugMatch[1] && !modelsToTry.includes(slugMatch[1])) {
        modelsToTry.splice(i + 1, 0, slugMatch[1]);
      }

      // Check if token expiration or rate limits occurred and trigger model switch notification
      if (i + 1 < modelsToTry.length && typeof onModelSwitch === 'function') {
        const nextModel = modelsToTry[i + 1];
        const isTokenExpire = /token|quota|rate\s*limit|429|402|context\s*length|exceeded|credit|balance|timeout/i.test(lastError?.message || '');
        onModelSwitch({
          failedModel: modelCandidate,
          nextModel,
          error: lastError?.message || 'Failed to generate code repair',
          isTokenExpire,
        });
      }
    }

    return {
      error: `Batch repair failed across all models (${modelsToTry.slice(0, 3).join(', ')}...): ${lastError?.message || 'No valid fixes generated'}`,
    };
  }

  _parseBatchRepairResponse(response, fileContent) {
    try {
      const content = response.choices?.[0]?.message?.content;
      if (!content) return null;

      let cleaned = content.trim();
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      const jsonMatch = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      const list = Array.isArray(parsed) ? parsed : (parsed.fixes || [parsed]);

      const validFixes = [];
      const normalizedFileContent = (fileContent || '').replace(/\r\n/g, '\n');

      for (const item of list) {
        if (item && item.oldSnippet && item.newSnippet) {
          let old = item.oldSnippet;
          const normalizedOld = old.replace(/\r\n/g, '\n');

          if (fileContent && !fileContent.includes(old)) {
            if (normalizedFileContent.includes(normalizedOld)) {
              old = normalizedOld;
            } else {
              const trimmed = old.trim();
              if (fileContent.includes(trimmed) || normalizedFileContent.includes(trimmed)) {
                old = trimmed;
              } else {
                continue;
              }
            }
          }
          validFixes.push({
            oldSnippet: old,
            newSnippet: item.newSnippet,
            explanation: item.explanation || 'Applied batch AI code repair',
          });
        }
      }
      return validFixes.length > 0 ? validFixes : null;
    } catch {
      return null;
    }
  }

  mockRepairFileBatch({ fileContent, findings }) {
    const lines = (fileContent || '').split('\n');
    const fixes = [];
    for (const f of findings || []) {
      const lineIdx = Math.max(0, (f.line || 1) - 1);
      const line = lines[lineIdx] || '';
      if (line.includes('==') && !line.includes('===')) {
        fixes.push({
          oldSnippet: line,
          newSnippet: line.replace(/==(?!=)/g, '==='),
          explanation: 'Replaced loose equality with strict equality',
        });
      } else if (line.includes('var ')) {
        fixes.push({
          oldSnippet: line,
          newSnippet: line.replace(/\bvar\b/, 'const'),
          explanation: 'Replaced var with const',
        });
      }
    }
    return {
      fixes: fixes.length > 0 ? fixes : null,
      modelUsed: OPENROUTER_MODELS.MINIMAX_M3,
    };
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

    // Check if OpenRouter recommended a replacement model slug
    const initialSlugMatch = lastError?.message?.match(/use this slug instead:\s*([a-zA-Z0-9_./-]+)/i);
    if (initialSlugMatch && initialSlugMatch[1] && initialSlugMatch[1] !== this.model) {
      try {
        const response = await this._callAPI(messages, initialSlugMatch[1]);
        this.model = initialSlugMatch[1];
        return this._parseResponse(response);
      } catch (err) {
        lastError = err;
      }
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

      // Check if OpenRouter recommended a replacement model slug
      const slugMatch = lastError?.message?.match(/use this slug instead:\s*([a-zA-Z0-9_./-]+)/i);
      if (slugMatch && slugMatch[1] && slugMatch[1] !== fallbackModel) {
        try {
          const response = await this._callAPI(messages, slugMatch[1]);
          this.model = slugMatch[1];
          return this._parseResponse(response);
        } catch (err) {
          lastError = err;
        }
      }
    }

    // Last resort: let OpenRouter auto-pick any available model
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

  async _callAPI(messages, model, maxTokens = this.maxTokens) {
    const https = require('https');

    return new Promise((resolve, reject) => {
      const url = new URL(`${this.baseUrl}/chat/completions`);

      const postData = JSON.stringify({
        model,
        max_tokens: maxTokens || this.maxTokens,
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

  // ── Mock code repair for testing without API key ─────────────────────────

  mockRepairCode({ finding, fileContent, line }) {
    const lines = (fileContent || '').split('\n');
    const targetLine = line || finding.line || 1;
    const lineIdx = Math.max(0, targetLine - 1);
    const originalLine = lines[lineIdx] || '';

    if (finding.rule === 'loose-equality' || (finding.message && (finding.message.includes('===') || finding.message.includes('Loose equality')))) {
      const fixedLine = originalLine.replace(/==(?!=)/g, '===').replace(/!=(?!=)/g, '!==');
      if (fixedLine !== originalLine) {
        return {
          oldSnippet: originalLine,
          newSnippet: fixedLine,
          explanation: 'Replaced loose equality with strict equality',
          modelUsed: OPENROUTER_MODELS.MINIMAX_M3,
        };
      }
    }

    if (finding.rule === 'off-by-one' || (finding.message && finding.message.includes('off-by-one'))) {
      const fixedLine = originalLine.replace(/<=\s*([a-zA-Z0-9_$.]+)\.length/g, '< $1.length');
      if (fixedLine !== originalLine) {
        return {
          oldSnippet: originalLine,
          newSnippet: fixedLine,
          explanation: 'Corrected loop boundary from <= to < to avoid index out-of-bounds',
          modelUsed: OPENROUTER_MODELS.MINIMAX_M3,
        };
      }
    }

    if (originalLine.trim()) {
      return {
        oldSnippet: originalLine,
        newSnippet: originalLine,
        explanation: finding.suggestedFix || 'Resolved code finding via AI repair',
        modelUsed: OPENROUTER_MODELS.MINIMAX_M3,
      };
    }

    return null;
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
  REPAIR_SYSTEM_PROMPT,
  calculateComplexity,
  selectModel,
};
