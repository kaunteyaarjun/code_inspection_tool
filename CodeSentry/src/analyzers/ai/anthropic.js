const AI_MODELS = {
  CLAUDE_3_5_SONNET: 'claude-3-5-sonnet-20241022',
  CLAUDE_3_5_HAIKU: 'claude-3-5-haiku-20241022',
  CLAUDE_3_OPUS: 'claude-3-opus-20240229',
  CLAUDE_3_SONNET: 'claude-3-sonnet-20240229',
  CLAUDE_3_HAIKU: 'claude-3-haiku-20240307',
};

class AnthropicClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
    this.model = options.model || AI_MODELS.CLAUDE_3_5_SONNET;
    this.maxTokens = options.maxTokens || 1024;
    this.temperature = options.temperature || 0.3;
    this.timeout = options.timeout || 30000;
    this.mockMode = options.mockMode || !this.apiKey;
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

  async callAPI(prompt) {
    const https = require('https');
    const http = require('http');
    
    return new Promise((resolve, reject) => {
      const url = new URL('https://api.anthropic.com/v1/messages');
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;
      
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
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      const req = client.request(options, (res) => {
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

      // Set timeout with proper cleanup
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
      const content = response.content?.[0]?.text;
      if (!content) {
        throw new Error('No content in AI response');
      }

      // Try to parse as JSON (non-greedy match)
      const jsonMatch = content.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }

      // If not JSON, return as text explanation
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
    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Return mock analysis based on prompt content
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

function createAnthropicClient(options = {}) {
  return new AnthropicClient(options);
}

module.exports = {
  AI_MODELS,
  AnthropicClient,
  createAnthropicClient,
};