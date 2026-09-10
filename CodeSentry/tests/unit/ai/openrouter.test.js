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
      assert.equal(OPENROUTER_MODELS.MINIMAX_M2_5, 'minimax/minimax-m2.5');
      assert.equal(OPENROUTER_MODELS.NEMOTRON_3_SUPER, 'nvidia/nemotron-3-super-120b-a12b:free');
      assert.equal(OPENROUTER_MODELS.MIMO_2_5, 'mimo/mimo-2.5:free');
      assert.equal(OPENROUTER_MODELS.NORTH_MINI_CODE, 'cohere/north-mini-code:free');
      assert.equal(OPENROUTER_MODELS.NEMOTRON_3_ULTRA, 'nvidia/nemotron-3-ultra-550b-a55b:free');
      assert.equal(OPENROUTER_MODELS.OPENROUTER_AUTO, 'openrouter/auto');
    });

    it('should have openrouter/auto as LAST_RESORT_MODEL', () => {
      assert.equal(LAST_RESORT_MODEL, 'openrouter/auto');
    });

    it('should configure model fallback chain containing preferred verified models', () => {
      assert.ok(MODEL_FALLBACK_CHAIN.includes('minimax/minimax-m3'));
      assert.ok(MODEL_FALLBACK_CHAIN.includes('deepseek/deepseek-chat'));
      assert.ok(MODEL_FALLBACK_CHAIN.includes('qwen/qwen-2.5-coder-32b-instruct'));
      assert.ok(MODEL_FALLBACK_CHAIN.includes('meta-llama/llama-3.3-70b-instruct'));
      assert.ok(MODEL_FALLBACK_CHAIN.includes('qwen/qwen-2.5-72b-instruct'));
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

  describe('AI Code Repair and Model Switching', () => {
    it('should generate code repair in mock mode with MiniMax M3 attribution', async () => {
      const client = createOpenRouterClient({ mockMode: true });
      const repair = await client.repairCode({
        finding: {
          rule: 'loose-equality',
          line: 2,
          message: 'Loose equality (==) used instead of strict equality (===)',
        },
        fileContent: 'function test() {\n  if (a == b) return true;\n}',
        line: 2,
      });

      assert.ok(repair);
      assert.equal(repair.oldSnippet, '  if (a == b) return true;');
      assert.equal(repair.newSnippet, '  if (a === b) return true;');
      assert.equal(repair.modelUsed, OPENROUTER_MODELS.MINIMAX_M3);
    });

    it('should correctly parse repair response removing markdown fences', () => {
      const client = createOpenRouterClient({ mockMode: true });
      const mockResponse = {
        choices: [
          {
            message: {
              content: '```json\n{"explanation":"Replaced == with ===","oldSnippet":"x == 1","newSnippet":"x === 1"}\n```',
            },
          },
        ],
      };

      const parsed = client._parseRepairResponse(mockResponse, 'const test = x == 1;');
      assert.ok(parsed);
      assert.equal(parsed.oldSnippet, 'x == 1');
      assert.equal(parsed.newSnippet, 'x === 1');
      assert.equal(parsed.explanation, 'Replaced == with ===');
    });

    it('should execute repairFileBatch in mock mode with MiniMax M3 model attribution', async () => {
      const client = createOpenRouterClient({ mockMode: true });
      const fileContent = 'function foo() {\n  if (a == b) return;\n  var x = 1;\n}';
      const findings = [
        { file: 'test.js', line: 2, rule: 'loose-equality', message: 'Use ===' },
        { file: 'test.js', line: 3, rule: 'no-var', message: 'Use const or let' },
      ];

      const res = await client.repairFileBatch({
        file: 'test.js',
        fileContent,
        findings,
      });

      assert.ok(res);
      assert.ok(res.fixes);
      assert.equal(res.fixes.length, 2);
      assert.equal(res.modelUsed, OPENROUTER_MODELS.MINIMAX_M3);
      assert.ok(res.fixes[0].newSnippet.includes('==='));
      assert.ok(res.fixes[1].newSnippet.includes('const'));
    });

    it('should correctly parse batch repair JSON response with array or object format', () => {
      const client = createOpenRouterClient({ mockMode: true });
      const mockBatchResponse = {
        choices: [
          {
            message: {
              content: '```json\n{"fixes": [{"explanation": "Fix 1", "oldSnippet": "foo == bar", "newSnippet": "foo === bar"}, {"explanation": "Fix 2", "oldSnippet": "var z = 2", "newSnippet": "const z = 2"}]}\n```',
            },
          },
        ],
      };

      const fileContent = 'const a = 1;\nif (foo == bar) {\n  var z = 2;\n}';
      const fixes = client._parseBatchRepairResponse(mockBatchResponse, fileContent);
      assert.ok(fixes);
      assert.equal(fixes.length, 2);
      assert.equal(fixes[0].oldSnippet, 'foo == bar');
      assert.equal(fixes[0].newSnippet, 'foo === bar');
      assert.equal(fixes[1].oldSnippet, 'var z = 2');
      assert.equal(fixes[1].newSnippet, 'const z = 2');
    });

    it('should switch models and notify onModelSwitch when token limits expire in repairFileBatch', async () => {
      const client = createOpenRouterClient({ apiKey: 'test-key', mockMode: false });
      const modelsCalled = [];
      let switchNotified = null;

      // Mock _callAPI to simulate primary model token expiry, succeeding on fallback
      client._callAPI = async (messages, model) => {
        modelsCalled.push(model);
        if (model === OPENROUTER_MODELS.MINIMAX_M3) {
          throw new Error('API error 429: Token rate limit reached, please try again later');
        }
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  fixes: [
                    {
                      explanation: 'Fallback model resolved issues',
                      oldSnippet: 'const x = 1;',
                      newSnippet: 'const x = 2;',
                    },
                  ],
                }),
              },
            },
          ],
        };
      };

      const res = await client.repairFileBatch({
        file: 'test.js',
        fileContent: 'const x = 1;\n',
        findings: [{ line: 1, rule: 'r1', message: 'msg1' }],
        preferredModel: OPENROUTER_MODELS.MINIMAX_M3,
        onModelSwitch: (evt) => {
          switchNotified = evt;
        },
      });

      assert.ok(res);
      assert.ok(res.fixes);
      assert.equal(res.fixes.length, 1);
      assert.equal(res.switchedFrom, OPENROUTER_MODELS.MINIMAX_M3);
      assert.ok(modelsCalled.length >= 2);
      assert.equal(modelsCalled[0], OPENROUTER_MODELS.MINIMAX_M3);
      assert.ok(switchNotified);
      assert.equal(switchNotified.failedModel, OPENROUTER_MODELS.MINIMAX_M3);
      assert.equal(switchNotified.isTokenExpire, true);
    });
  });
});
