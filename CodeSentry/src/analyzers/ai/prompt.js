class PromptGenerator {
  constructor(options = {}) {
    this.maxContextLength = options.maxContextLength || 2000;
    this.includeSource = options.includeSource !== false;
    this.includeMetadata = options.includeMetadata !== false;
  }

  generateFindingAnalysisPrompt(finding, sourceContext = null, fileContext = null) {
    const parts = [];
    
    parts.push('Analyze the following code finding and provide a security/quality assessment:');
    parts.push('');
    
    if (this.includeMetadata) {
      parts.push('Finding Metadata:');
      parts.push(`- Category: ${finding.category}`);
      parts.push(`- Severity: ${finding.severity}`);
      parts.push(`- File: ${finding.file}`);
      if (finding.line) parts.push(`- Line: ${finding.line}`);
      if (finding.rule) parts.push(`- Rule: ${finding.rule}`);
      parts.push(`- Tool: ${finding.tool}`);
      parts.push(`- Message: ${finding.message}`);
      if (finding.suggestedFix) parts.push(`- Suggested Fix: ${finding.suggestedFix}`);
      parts.push('');
    }
    
    if (sourceContext && this.includeSource) {
      parts.push('Relevant Source Code:');
      parts.push('```');
      parts.push(sourceContext);
      parts.push('```');
      parts.push('');
    }
    
    if (fileContext) {
      parts.push('File Context:');
      parts.push('```');
      parts.push(fileContext);
      parts.push('```');
      parts.push('');
    }
    
    parts.push('Please provide:');
    parts.push('1. A detailed explanation of the issue');
    parts.push('2. Severity assessment (HIGH, MEDIUM, LOW)');
    parts.push('3. Confidence level (0.0 to 1.0)');
    parts.push('4. False positive probability (0.0 to 1.0)');
    parts.push('5. Potential impact');
    parts.push('6. Recommended fix');
    parts.push('');
    parts.push('Respond in JSON format:');
    parts.push('```json');
    parts.push('{');
    parts.push('  "explanation": "...",');
    parts.push('  "severity": "HIGH|MEDIUM|LOW",');
    parts.push('  "confidence": 0.0-1.0,');
    parts.push('  "falsePositiveProbability": 0.0-1.0,');
    parts.push('  "impact": "...",');
    parts.push('  "suggestedFix": "..."');
    parts.push('}');
    parts.push('```');
    
    return parts.join('\n');
  }

  generateCorrelationPrompt(findings) {
    const parts = [];
    
    parts.push('Analyze the following code findings and identify any correlations or relationships between them:');
    parts.push('');
    
    for (let i = 0; i < findings.length; i++) {
      const finding = findings[i];
      parts.push(`Finding ${i + 1}:`);
      parts.push(`- Category: ${finding.category}`);
      parts.push(`- Severity: ${finding.severity}`);
      parts.push(`- File: ${finding.file}:${finding.line || '?'}`);
      parts.push(`- Rule: ${finding.rule}`);
      parts.push(`- Message: ${finding.message}`);
      parts.push('');
    }
    
    parts.push('Please identify:');
    parts.push('1. Which findings might be related');
    parts.push('2. Common patterns or root causes');
    parts.push('3. Potential attack chains or combined risks');
    parts.push('4. Prioritized remediation order');
    parts.push('');
    parts.push('Respond in JSON format:');
    parts.push('```json');
    parts.push('{');
    parts.push('  "correlations": [');
    parts.push('    {');
    parts.push('      "findingIndices": [0, 1, 2],');
    parts.push('      "relationship": "...",');
    parts.push('      "riskLevel": "HIGH|MEDIUM|LOW",');
    parts.push('      "explanation": "..."');
    parts.push('    }');
    parts.push('  ],');
    parts.push('  "rootCause": "...",');
    parts.push('  "prioritizedFixes": ["..."]');
    parts.push('}');
    parts.push('```');
    
    return parts.join('\n');
  }

  generateSeverityReconciliationPrompt(finding, aiAnalysis) {
    const parts = [];
    
    parts.push('Reconcile the following severity assessments:');
    parts.push('');
    parts.push('Original Finding:');
    parts.push(`- Tool Severity: ${finding.severity}`);
    parts.push(`- Category: ${finding.category}`);
    parts.push(`- Rule: ${finding.rule}`);
    parts.push(`- Message: ${finding.message}`);
    parts.push('');
    parts.push('AI Analysis:');
    parts.push(`- AI Severity: ${aiAnalysis.severity}`);
    parts.push(`- Confidence: ${aiAnalysis.confidence}`);
    parts.push(`- Explanation: ${aiAnalysis.explanation}`);
    parts.push('');
    parts.push('Please provide a reconciled severity and confidence assessment.');
    parts.push('');
    parts.push('Respond in JSON format:');
    parts.push('```json');
    parts.push('{');
    parts.push('  "reconciledSeverity": "HIGH|MEDIUM|LOW",');
    parts.push('  "reconciledConfidence": 0.0-1.0,');
    parts.push('  "reasoning": "..."');
    parts.push('}');
    parts.push('```');
    
    return parts.join('\n');
  }

  truncateContext(context, maxLength) {
    if (!context || context.length <= maxLength) {
      return context;
    }
    
    const truncationMarker = '\n... [truncated] ...';
    const availableLength = maxLength - truncationMarker.length;
    
    if (availableLength <= 0) {
      return truncationMarker;
    }
    
    // Try to truncate at a line break
    const truncated = context.substring(0, availableLength);
    const lastNewline = truncated.lastIndexOf('\n');
    
    if (lastNewline > availableLength * 0.8) {
      return truncated.substring(0, lastNewline) + truncationMarker;
    }
    
    return truncated + truncationMarker;
  }

  extractRelevantContext(sourceCode, line, contextLines = 10) {
    if (!sourceCode) return null;
    
    const lines = sourceCode.split('\n');
    const start = Math.max(0, line - contextLines - 1);
    const end = Math.min(lines.length, line + contextLines);
    
    return lines.slice(start, end).join('\n');
  }
}

function createPromptGenerator(options = {}) {
  return new PromptGenerator(options);
}

module.exports = {
  PromptGenerator,
  createPromptGenerator,
};