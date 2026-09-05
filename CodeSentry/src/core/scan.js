const path = require('node:path');
const { createConfig } = require('./config');
const { normalize, registerNormalizer } = require('../findings/normalize');
const { deduplicate } = require('../findings/dedupe');
const { aggregate } = require('./aggregation');
const { score } = require('./scoring');
const { verdict } = require('./verdict');
const { SEVERITIES } = require('../findings/schema');
const { discover: realDiscover } = require('../discovery/discover');
const { runStaticAnalyzers } = require('../analyzers/static');
const { runCustomAnalyzers } = require('../analyzers/custom');

registerNormalizer('codesentry', normalizeCodesentry);

function normalizeCodesentry(rawResults) {
  if (!Array.isArray(rawResults)) return [];
  const { createFinding } = require('../findings/schema');
  return rawResults.map(r => {
    try {
      return createFinding({
        tool: 'codesentry',
        category: r.category || 'bugs',
        severity: r.severity || 'MEDIUM',
        file: r.file || 'unknown',
        line: r.line || null,
        column: r.column || null,
        rule: r.rule || null,
        message: r.message || '',
        suggestedFix: r.suggestedFix || null,
      });
    } catch {
      return null;
    }
  }).filter(Boolean);
}

async function scan(projectPath, overrides = {}) {
  const startTime = Date.now();
  const errors = [];

  const config = createConfig({ projectPath, ...overrides, validatePath: false });

  let discoveryResult;
  try {
    discoveryResult = await realDiscover(config);
  } catch (err) {
    errors.push({ stage: 'discovery', message: err.message });
    discoveryResult = { files: [], languages: [], fileMap: {}, projectPath: config.projectPath };
  }

  let staticResults = [];
  try {
    staticResults = await runStaticAnalyzers(discoveryResult, config);
  } catch (err) {
    errors.push({ stage: 'static-analyzers', message: err.message });
  }

  let customResult = null;
  try {
    customResult = await runCustomAnalyzers(discoveryResult, config);
  } catch (err) {
    errors.push({ stage: 'custom-analyzers', message: err.message });
  }

  const allRawResults = [...staticResults];
  if (customResult && customResult.rawResults.length > 0) {
    allRawResults.push(customResult);
  }

  let allFindings = [];
  for (const result of allRawResults) {
    try {
      const normalized = normalize(result.tool, result.rawResults);
      allFindings = allFindings.concat(normalized);
    } catch (err) {
      errors.push({ stage: 'normalize', tool: result.tool, message: err.message });
    }
  }

  const dedupedFindings = deduplicate(allFindings);

  let filteredFindings = dedupedFindings;
  if (config.severityThreshold) {
    const severityIndex = SEVERITIES.indexOf(config.severityThreshold);
    if (severityIndex !== -1) {
      const allowedSeverities = SEVERITIES.slice(0, severityIndex + 1);
      filteredFindings = dedupedFindings.filter(f => allowedSeverities.includes(f.severity));
    }
  }

  if (config.categoryFilter) {
    filteredFindings = filteredFindings.filter(f => f.category === config.categoryFilter);
  }

  const aggregationResult = aggregate(filteredFindings);
  const scoreResult = score(aggregationResult);
  const verdictResult = verdict(scoreResult);
  const duration = Date.now() - startTime;

  return {
    project: {
      path: config.projectPath,
      name: path.basename(config.projectPath),
    },
    filesAnalyzed: discoveryResult.files.length,
    languages: discoveryResult.languages,
    findings: filteredFindings,
    aggregation: aggregationResult,
    score: scoreResult,
    verdict: verdictResult,
    metadata: {
      duration,
      timestamp: new Date().toISOString(),
      errors,
      analyzerWarnings: collectWarnings(staticResults, customResult),
    },
  };
}

function collectWarnings(staticResults, customResult) {
  const warnings = [];
  for (const r of staticResults) {
    if (r.warning) warnings.push({ tool: r.tool, warning: r.warning });
    if (r.errors && r.errors.length > 0) {
      for (const e of r.errors) warnings.push({ tool: r.tool, error: e });
    }
  }
  if (customResult && customResult.warning) {
    warnings.push({ tool: 'codesentry', warning: customResult.warning });
  }
  return warnings;
}

module.exports = {
  scan,
  normalizeCodesentry,
};
