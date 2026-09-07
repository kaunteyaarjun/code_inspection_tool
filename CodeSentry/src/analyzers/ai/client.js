'use strict';

const { createOpenRouterClient, OPENROUTER_MODELS, selectModel } = require('./openrouter');

function createAIClient(options = {}) {
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
  selectModel,
};
