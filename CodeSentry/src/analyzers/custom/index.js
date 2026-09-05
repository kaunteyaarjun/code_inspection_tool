const fs = require('node:fs');
const path = require('node:path');
const { analyzeBugs } = require('./bugs');
const { analyzeEfficiency } = require('./efficiency');
const { analyzeResources } = require('./resources');

const ANALYZERS = [
  { name: 'bugs', analyze: analyzeBugs },
  { name: 'efficiency', analyze: analyzeEfficiency },
  { name: 'resources', analyze: analyzeResources },
];

const JS_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const PY_EXTENSIONS = new Set(['.py', '.pyw']);

function isAnalyzable(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return JS_EXTENSIONS.has(ext) || PY_EXTENSIONS.has(ext);
}

async function runCustomAnalyzers(discoveryResult, config = {}) {
  const projectPath = config.projectPath || process.cwd();
  const allFiles = discoveryResult.files || [];
  const rawResults = [];

  for (const relativePath of allFiles) {
    const fullPath = path.resolve(projectPath, relativePath);

    if (!isAnalyzable(fullPath)) continue;

    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      continue;
    }

    for (const analyzer of ANALYZERS) {
      try {
        const findings = analyzer.analyze(relativePath, content);
        for (const finding of findings) {
          rawResults.push({
            file: finding.file,
            line: finding.line,
            column: finding.column,
            rule: finding.rule,
            message: finding.message,
            severity: finding.severity,
            category: finding.category,
            suggestedFix: finding.suggestedFix || null,
            analyzer: analyzer.name,
          });
        }
      } catch {
        // Skip analyzer failures for individual files
      }
    }
  }

  return {
    tool: 'codesentry',
    rawResults,
    available: true,
    errors: [],
    warning: null,
  };
}

module.exports = {
  runCustomAnalyzers,
  ANALYZERS,
  isAnalyzable,
};
