const { createOpenRouterClient, OPENROUTER_MODELS, selectModel } = require('./openrouter');
const { createAnthropicClient, AI_MODELS: ANTHROPIC_MODELS } = require('./anthropic');

function createAIClient(options = {}) {
  const provider = options.provider || process.env.AI_PROVIDER || 'openrouter';

  if (provider === 'anthropic') {
    return createAnthropicClient({
      apiKey: options.apiKey || process.env.ANTHROPIC_API_KEY,
      model: options.model || process.env.ANTHROPIC_MODEL,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      timeout: options.timeout,
      mockMode: options.mockMode,
    });
  }

  return createOpenRouterClient({
    apiKey: options.apiKey || process.env.OPENROUTER_API_KEY,
    model: options.model || selectModel(options.scanContext),
    scanContext: options.scanContext,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    timeout: options.timeout,
    mockMode: options.mockMode,
  });
}

module.exports = {
  createAIClient,
  OPENROUTER_MODELS,
  ANTHROPIC_MODELS,
  selectModel,
};
