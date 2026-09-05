const { SEVERITIES } = require('../findings/schema');

class ScanResultFormatter {
  constructor(options = {}) {
    this.options = options;
  }

  formatSummary(result) {
    const { project, filesAnalyzed, languages, aggregation, score, verdict } = result;
    
    const lines = [];
    lines.push(`Project: ${project.name}`);
    lines.push(`Path: ${project.path}`);
    lines.push(`Files analyzed: ${filesAnalyzed}`);
    lines.push(`Languages: ${languages.join(', ') || 'none detected'}`);
    lines.push('');
    lines.push('Analysis Summary:');
    lines.push(`  Total findings: ${aggregation.total}`);
    lines.push('');
    
    lines.push('By Category:');
    for (const [category, count] of Object.entries(aggregation.byCategory)) {
      lines.push(`  ${this.capitalizeFirst(category)}: ${count}`);
    }
    lines.push('');
    
    lines.push('By Severity:');
    for (const severity of SEVERITIES) {
      const count = aggregation.bySeverity[severity] || 0;
      if (count > 0) {
        lines.push(`  ${severity}: ${count}`);
      }
    }
    lines.push('');
    
    lines.push(`Score: ${score.value}/${score.max}`);
    lines.push(`Verdict: ${verdict.status} — ${verdict.message}`);
    
    return lines;
  }

  formatFindings(findings, options = {}) {
    const { limit = 10, showDetails = true } = options;
    
    if (findings.length === 0) {
      return ['No findings detected.'];
    }
    
    const lines = [];
    lines.push(`Findings (${findings.length} total):`);
    lines.push('');
    
    const displayFindings = findings.slice(0, limit);
    
    for (const finding of displayFindings) {
      lines.push(...this.formatFinding(finding, showDetails));
      lines.push('');
    }
    
    if (findings.length > limit) {
      lines.push(`... and ${findings.length - limit} more findings`);
    }
    
    return lines;
  }

  formatFinding(finding, showDetails = true) {
    const lines = [];
    
    const severityTag = `[${finding.severity}]`;
    const categoryTag = finding.category.toUpperCase();
    const location = `${finding.file}:${finding.line || '?'}`;
    
    lines.push(`${severityTag} ${categoryTag}`);
    lines.push(location);
    lines.push('');
    
    if (showDetails) {
      if (finding.rule) {
        lines.push(`Rule: ${finding.rule}`);
      }
      if (finding.tool) {
        lines.push(`Detected by: ${this.capitalizeFirst(finding.tool)}`);
      }
      lines.push('');
      lines.push(finding.message);
      
      if (finding.suggestedFix) {
        lines.push('');
        lines.push('Suggested fix:');
        lines.push(`  ${finding.suggestedFix}`);
      }
      
      if (finding.ai) {
        lines.push('');
        lines.push('AI Analysis:');
        if (finding.ai.confidence) {
          lines.push(`  Confidence: ${Math.round(finding.ai.confidence * 100)}%`);
        }
        if (finding.ai.falsePositiveProbability) {
          lines.push(`  False-positive probability: ${Math.round(finding.ai.falsePositiveProbability * 100)}%`);
        }
        if (finding.ai.explanation) {
          lines.push(`  Explanation: ${finding.ai.explanation}`);
        }
        if (finding.ai.impact) {
          lines.push(`  Impact: ${finding.ai.impact}`);
        }
        if (finding.ai.suggestedFix) {
          lines.push(`  Recommended fix: ${finding.ai.suggestedFix}`);
        }
      }
    }
    
    return lines;
  }

  formatJSON(result) {
    return JSON.stringify(result, null, 2);
  }

  capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}

function createFormatter(options = {}) {
  return new ScanResultFormatter(options);
}

module.exports = {
  ScanResultFormatter,
  createFormatter,
};