/**
 * OpenAI Direct AI Client for CodeSentry
 *
 * Implements native OpenAI API integration for vulnerability triage and code repair:
 *   - chatCompletion({ messages, model, temperature, maxTokens, timeout })
 *   - analyze(prompt)
 *   - repairCode(options)
 *   - repairFileBatch({ filePath, originalContent, findings, preferredModel, onModelSwitch })
 *
 * Endpoint: https://api.openai.com/v1 (or OPENAI_BASE_URL)
 */

'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { createAIResponseParser } = require('./parser');

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

const OPENAI_MODELS = {
  GPT_4O:         'gpt-4o',
  GPT_4O_MINI:    'gpt-4o-mini',
  O3_MINI:        'o3-mini',
  O1_MINI:        'o1-mini',
  GPT_4_TURBO:    'gpt-4-turbo',
  GPT_3_5_TURBO:  'gpt-3.5-turbo',
};

const OPENAI_FALLBACK_CHAIN = [
  'gpt-4o-mini',
  'gpt-4o',
  'o3-mini',
  'gpt-4-turbo',
  'gpt-3.5-turbo',
];

const SYSTEM_PROMPT = `You are CodeSentry, an expert DevSecOps code security and quality analyzer.
Analyze findings and provide actionable remediation in valid JSON format:
{
  "explanation": "Clear root cause explanation",
  "confidence": 0.95,
  "falsePositiveProbability": 0.05,
  "impact": "Security or runtime impact",
  "suggestedFix": "Precise code fix instruction"
}`;

function selectModel(scanContext = {}) {
  if (scanContext && scanContext.model) return scanContext.model;
  return OPENAI_MODELS.GPT_4O_MINI;
}

class OpenAIClient {
  constructor(options = {}) {
    this.provider = 'openai';
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY || '';
    this.baseUrl = options.baseUrl || OPENAI_BASE_URL;
    this.model = options.model || selectModel(options.scanContext);
    this.maxTokens = options.maxTokens || 4096;
    this.temperature = options.temperature ?? 0.1;
    this.timeout = options.timeout || 10000;
    this.mockMode = Boolean(options.mockMode || !this.apiKey);
    this.parser = createAIResponseParser();
  }

  async chatCompletion({ messages, model, temperature, maxTokens, timeout }) {
    if (this.mockMode || !this.apiKey) {
      return {
        content: `// CodeSentry mock AI repair\n${messages[messages.length - 1]?.content?.slice(0, 100) || ''}`,
        model: model || this.model,
      };
    }

    const effectiveModel = model || this.model;
    const effectiveTimeout = timeout || this.timeout;
    const isReasoningModel = /^o[13](?:-|$)/.test(effectiveModel);

    const payload = {
      model: effectiveModel,
      messages,
    };

    if (isReasoningModel) {
      payload.max_completion_tokens = maxTokens || this.maxTokens;
    } else {
      payload.max_tokens = maxTokens || this.maxTokens;
      payload.temperature = temperature ?? this.temperature;
    }

    const bodyData = JSON.stringify(payload);
    const parsedUrl = new URL(`${this.baseUrl}/chat/completions`);
    const isHttps = parsedUrl.protocol === 'https:';
    const requestFn = isHttps ? https.request : http.request;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        req.destroy(new Error(`OpenAI request timed out after ${effectiveTimeout}ms`));
      }, effectiveTimeout);

      const req = requestFn(parsedUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'User-Agent': 'CodeSentry-CLI/0.2.1',
          'Content-Length': Buffer.byteLength(bodyData),
        },
      }, (res) => {
        let rawData = '';
        res.on('data', (chunk) => { rawData += chunk; });
        res.on('end', () => {
          clearTimeout(timer);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(rawData);
              const messageContent = parsed.choices?.[0]?.message?.content || '';
              resolve({
                content: messageContent,
                model: parsed.model || effectiveModel,
                usage: parsed.usage,
              });
            } catch (err) {
              reject(new Error(`Failed to parse OpenAI response: ${err.message}`));
            }
          } else {
            let errorMsg = `OpenAI HTTP ${res.statusCode}: ${rawData.slice(0, 250)}`;
            try {
              const errJson = JSON.parse(rawData);
              if (errJson.error && errJson.error.message) {
                errorMsg = `OpenAI API Error: ${errJson.error.message} (${errJson.error.code || res.statusCode})`;
              }
            } catch {}
            reject(new Error(errorMsg));
          }
        });
      });

      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      req.write(bodyData);
      req.end();
    });
  }

  async analyze(prompt) {
    if (this.mockMode) {
      return {
        explanation: 'Mock OpenAI analysis for finding remediation.',
        confidence: 0.95,
        falsePositiveProbability: 0.05,
        impact: 'Identified potential vulnerability.',
        suggestedFix: 'Apply parameterized sanitization or environment configuration.',
        model: this.model,
      };
    }

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ];

    let lastError = null;
    for (const candidateModel of [this.model, ...OPENAI_FALLBACK_CHAIN]) {
      try {
        const res = await this.chatCompletion({ messages, model: candidateModel });
        const parsed = this.parser.parse(res.content);
        return {
          explanation: parsed.explanation || res.content,
          confidence: parsed.confidence || 0.9,
          falsePositiveProbability: parsed.falsePositiveProbability || 0.1,
          impact: parsed.impact || 'Identified potential risk.',
          suggestedFix: parsed.suggestedFix || 'Sanitize and validate inputs.',
          model: res.model || candidateModel,
        };
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error('OpenAI analysis failed across all fallback models');
  }

  async repairFileBatch(options = {}) {
    const { filePath, originalContent, findings, preferredModel, onModelSwitch } = options;
    const modelsToTry = [preferredModel || this.model, ...OPENAI_FALLBACK_CHAIN].filter(
      (m, idx, arr) => arr.indexOf(m) === idx
    );

    let lastError = null;
    for (let i = 0; i < modelsToTry.length; i++) {
      const activeModel = modelsToTry[i];
      try {
        const issuesSummary = (findings || []).map((f, idx) =>
          `${idx + 1}. [${f.severity || 'MEDIUM'}] Rule ${f.rule} at line ${f.line}: ${f.message}`
        ).join('\n');

        const systemPrompt = `You are CodeSentry's expert automated code repair engine powered by OpenAI.
Repair all security vulnerabilities and code quality issues listed in the file.
Return ONLY the raw updated file content. Do NOT include markdown code fences, backticks, or explanation.`;

        const userPrompt = `Target File: ${filePath}

Identified Issues:
${issuesSummary}

Original File Content:
${originalContent}`;

        const res = await this.chatCompletion({
          model: activeModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          timeout: 12000,
        });

        let repaired = res.content || '';
        repaired = repaired.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '');
        if (repaired.length > 10) {
          return {
            repairedContent: repaired,
            modelUsed: activeModel,
            switchedFrom: i > 0 ? modelsToTry[0] : null,
          };
        }
      } catch (err) {
        lastError = err;
        if (onModelSwitch && i + 1 < modelsToTry.length) {
          onModelSwitch({
            failedModel: activeModel,
            nextModel: modelsToTry[i + 1],
            error: err.message,
          });
        }
      }
    }

    throw lastError || new Error('OpenAI repair failed across all fallback models');
  }
}

function createOpenAIClient(options = {}) {
  return new OpenAIClient(options);
}

module.exports = {
  createOpenAIClient,
  OpenAIClient,
  OPENAI_MODELS,
  OPENAI_FALLBACK_CHAIN,
  selectModel,
};
