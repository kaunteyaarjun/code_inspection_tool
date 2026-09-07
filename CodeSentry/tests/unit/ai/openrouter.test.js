const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  OpenRouterClient,
  createOpenRouterClient,
  OPENROUTER_MODELS,
  MODEL_FALLBACK_CHAIN,
  LAST_RESORT_MODEL,
  DEFAULT_MODEL,
  COMPLEX_MODEL,
  calculateComplexity,
  selectModel,
  SYSTEM_PROMPT,
} = require('../../../src/analyzers/ai/openrouter');
const { createPromptGenerator } = require('../../../src/analyzers/ai/prompt');
const { createAIResponseParser } = require('../../../src/analyzers/ai/parser');
const { createFinding } = require('../../../src/findings/schema');

describe('OpenRouter AI Module', () => {
  describe('Model Catalog & Fallback Chain', () => {
    it('should have Laguna S 2.1 as default model', () => {
      assert.equal(DEFAULT_MODEL, 'poolside/laguna-s-2.1:free');
    });

    it('should have Nemotron 3 Ultra as complex model', () => {
      assert.equal(COMPLEX_MODEL, 'nvidia/nemotron-3-ultra-550b-a55b:free');
    });

    it('should include required top-tier and free models in catalog', () => {
      assert.equal(OPENROUTER_MODELS.LAGUNA_S_2_1, 'poolside/laguna-s-2.1:free');
      assert.equal(OPENROUTER_MODELS.MINIMAX_M2_5, 'minimax/minimax-m2.5:free');
      assert.equal(OPENROUTER_MODELS.NEMOTRON_3_SUPER, 'nvidia/nemotron-3-super-120b-a12b:free');
      assert.equal(OPENROUTER_MODELS.MIMO_2_5, 'mimo/mimo-2.5:free');
      assert.equal(OPENROUTER_MODELS.NORTH_MINI_CODE, 'cohere/north-mini-code:free');
      assert.equal(OPENROUTER_MODELS.NEMOTRON_3_ULTRA, 'nvidia/nemotron-3-ultra-550b-a55b:free');
      assert.equal(OPENROUTER_MODELS.OPENROUTER_AUTO, 'openrouter/auto');
    });

    it('should have openrouter/auto as LAST_RESORT_MODEL', () => {
      assert.equal(LAST_RESORT_MODEL, 'openrouter/auto');
    });

    it('should configure model fallback chain containing preferred free models', () => {
      assert.ok(MODEL_FALLBACK_CHAIN.includes('poolside/laguna-s-2.1:free'));
      assert.ok(MODEL_FALLBACK_CHAIN.includes('minimax/minimax-m2.5:free'));
      assert.ok(MODEL_FALLBACK_CHAIN.includes('nvidia/nemotron-3-super-120b-a12b:free'));
      assert.ok(MODEL_FALLBACK_CHAIN.includes('mimo/mimo-2.5:free'));
      assert.ok(MODEL_FALLBACK_CHAIN.includes('cohere/north-mini-code:free'));
    });
  });

  describe('Complexity & Model Selection', () => {
    it('should calculate simple complexity for empty or small projects', () => {
      const result = calculateComplexity({ files: [{ lines: 50 }], languages: ['javascript'] });
      assert.equal(result.level, 'simple');
      assert.equal(selectModel({ files: [{ lines: 50 }], languages: ['javascript'] }), DEFAULT_MODEL);
    });

    it('should calculate complex level for large polyglot codebases', () => {
      const files = Array(60).fill({ lines: 100 });
      const languages = ['typescript', 'python', 'go', 'rust'];
      const result = calculateComplexity({ files, languages });
      assert.equal(result.level, 'complex');
      assert.equal(selectModel({ files, languages }), COMPLEX_MODEL);
    });

    it('should respect forced model override', () => {
      const forced = 'custom/test-model:free';
      assert.equal(selectModel(null, forced), forced);
    });
  });

  describe('OpenRouter Client Mock Mode', () => {
    it('should default to mock mode when no API key provided', () => {
      const client = new OpenRouterClient({ apiKey: null });
      assert.equal(client.mockMode, true);
    });

    it('should return valid analysis for SQL injection prompt in mock mode', async () => {
      const client = createOpenRouterClient({ mockMode: true });
      const promptGen = createPromptGenerator();
      const parser = createAIResponseParser();

      const finding = createFinding({
        tool: 'codesentry',
        category: 'security',
        file: 'src/db.js',
        message: 'Potential SQL injection detected',
        line: 15,
        severity: 'HIGH',
      });

      const prompt = promptGen.generateFindingAnalysisPrompt(finding, 'SELECT * FROM users WHERE id = ' + 1);
      const res = await client.analyze(prompt);
      const parsed = parser.parse(res);

      assert.equal(parsed.severity, 'HIGH');
      assert.ok(parsed.explanation.toLowerCase().includes('sql'));
      assert.ok(parsed.confidence > 0.8);
      assert.ok(parsed.suggestedFix);
    });

    it('should return valid analysis for code execution vulnerabilities in mock mode', async () => {
      const client = createOpenRouterClient({ mockMode: true });
      const res = await client.analyze('Finding involves unsafe eval() execution');
      assert.equal(res.severity, 'HIGH');
      assert.ok(res.explanation.toLowerCase().includes('eval'));
    });

    it('should return valid analysis for hardcoded secrets in mock mode', async () => {
      const client = createOpenRouterClient({ mockMode: true });
      const res = await client.analyze('Finding involves hardcoded secret credential');
      assert.equal(res.severity, 'HIGH');
      assert.ok(res.explanation.toLowerCase().includes('credential') || res.explanation.toLowerCase().includes('secret'));
    });

    it('should analyze batch findings via analyzeFindings()', async () => {
      const client = createOpenRouterClient({ mockMode: true });
      const promptGen = createPromptGenerator();

      const findings = [
        createFinding({
          tool: 'codesentry',
          category: 'security',
          file: 'src/login.js',
          message: 'Hardcoded secret password',
          line: 5,
          severity: 'HIGH',
        }),
      ];

      const enriched = await client.analyzeFindings(findings, {}, promptGen);
      assert.equal(enriched.length, 1);
      assert.ok(enriched[0].aiAnalysis);
      assert.equal(enriched[0].aiAnalysis.model, client.model);
      assert.ok(enriched[0].aiAnalysis.explanation);
    });
  });

  describe('Response Parsing and OpenAI Schema', () => {
    it('should have system prompt defining required JSON structure', () => {
      assert.ok(SYSTEM_PROMPT.includes('CodeSentry'));
      assert.ok(SYSTEM_PROMPT.includes('explanation'));
      assert.ok(SYSTEM_PROMPT.includes('severity'));
      assert.ok(SYSTEM_PROMPT.includes('suggestedFix'));
    });

    it('should correctly parse markdown-wrapped JSON responses', () => {
      const client = createOpenRouterClient({ mockMode: true });
      const mockRawResponse = {
        choices: [
          {
            message: {
              content: '```json\n{"explanation":"Safe code","severity":"LOW","confidence":0.95,"falsePositiveProbability":0.05,"impact":"None","suggestedFix":"None"}\n```',
            },
          },
        ],
      };

      const parsed = client._parseResponse(mockRawResponse);
      assert.equal(parsed.explanation, 'Safe code');
      assert.equal(parsed.severity, 'LOW');
      assert.equal(parsed.confidence, 0.95);
    });

    it('should correctly parse nested JSON objects without truncation', () => {
      const client = createOpenRouterClient({ mockMode: true });
      const mockRawResponse = {
        choices: [
          {
            message: {
              content: '{"explanation":"Issue in {subblock}","severity":"HIGH","confidence":0.9,"falsePositiveProbability":0.1,"impact":"High","suggestedFix":"Fix it"}',
            },
          },
        ],
      };

      const parsed = client._parseResponse(mockRawResponse);
      assert.equal(parsed.severity, 'HIGH');
      assert.equal(parsed.explanation, 'Issue in {subblock}');
    });
  });
});
