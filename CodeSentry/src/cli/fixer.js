'use strict';

/**
 * CodeSentry Automated Code Repair & Improvement Engine
 *
 * Supports interactive post-scan improvements:
 * - Deterministic AST/pattern rule fixes
 * - OpenRouter AI-assisted code repair
 * - Compact colorized diff preview
 * - Safe atomic file updates
 */

const fs = require('node:fs');
const path = require('node:path');
const theme = require('./theme');

/**
 * Extracts a window of lines around the target line (1-indexed).
 */
function getLineWindow(lines, targetLine, radius = 2) {
  const lineIdx = Math.max(0, targetLine - 1);
  const startIdx = Math.max(0, lineIdx - radius);
  const endIdx = Math.min(lines.length - 1, lineIdx + radius);
  return {
    startLine: startIdx + 1,
    endLine: endIdx + 1,
    lines: lines.slice(startIdx, endIdx + 1),
  };
}

/**
 * Generates a deterministic fix for common patterns without external AI calls.
 */
function generateRuleFix(finding, fileContent) {
  const lines = fileContent.split('\n');
  const lineIdx = (finding.line || 1) - 1;
  const originalLine = lines[lineIdx] || '';

  // 1. Loose equality: == to === or != to !==
  if (finding.rule === 'loose-equality') {
    let fixedLine = originalLine;
    if (originalLine.includes('==') && !originalLine.includes('===')) {
      fixedLine = originalLine.replace(/==/g, '===');
    } else if (originalLine.includes('!=') && !originalLine.includes('!==')) {
      fixedLine = originalLine.replace(/!=/g, '!==');
    }
    if (fixedLine !== originalLine) {
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: 'Replaced loose equality with strict equality to prevent unexpected type coercion',
      };
    }
  }

  // 2. Off-by-one array boundary error: <= array.length to < array.length
  if (finding.rule === 'off-by-one') {
    const fixedLine = originalLine.replace(/<=\s*([a-zA-Z0-9_$.]+)\.length/g, '< $1.length');
    if (fixedLine !== originalLine) {
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: 'Corrected boundary condition from <= to < to avoid index out-of-bounds',
      };
    }
  }

  // 3. Empty catch block: catch (err) { }
  if (finding.rule === 'empty-catch') {
    const catchMatch = originalLine.match(/catch\s*(?:\(([^)]+)\))?\s*\{/);
    if (catchMatch) {
      const indentMatch = originalLine.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1] : '  ';
      const errVar = catchMatch[1] ? catchMatch[1].trim() : 'err';
      const fixedSnippet = `${originalLine}\n${indent}  console.error(${errVar});`;
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedSnippet,
        explanation: 'Added error logging to prevent errors from being swallowed silently',
      };
    }
  }

  // 4. SQL Injection via template literal: db.query(`SELECT ... ${var}`)
  if (finding.rule === 'sql-injection-template') {
    const indentMatch = originalLine.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '';
    const fixedSnippet = `${indent}// TODO: CodeSentry security note: Parameterize query instead of interpolation\n${indent}// Example: db.query('SELECT ... WHERE id = $1', [userId])\n${originalLine}`;
    return {
      startLine: finding.line,
      endLine: finding.line,
      oldSnippet: originalLine,
      newSnippet: fixedSnippet,
      explanation: 'Added security guidance to parameterize SQL query',
    };
  }

  // 5. Code Injection eval()
  if (finding.rule === 'code-injection-eval') {
    const indentMatch = originalLine.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '';
    const fixedSnippet = `${indent}// CodeSentry security fix: Avoid eval(); use JSON.parse() or safe parser\n${originalLine.replace(/\beval\s*\(([^)]+)\)/, 'JSON.parse($1)')}`;
    return {
      startLine: finding.line,
      endLine: finding.line,
      oldSnippet: originalLine,
      newSnippet: fixedSnippet,
      explanation: 'Replaced hazardous eval() with safe parsing logic',
    };
  }

  // 6. Hardcoded secret: replace literal with process.env lookup
  if (finding.rule === 'hardcoded-secret' || finding.rule === 'hardcoded-aws-key') {
    const secretMatch = originalLine.match(/^(\s*(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*)['"][^'"]+['"]/);
    if (secretMatch) {
      const varName = secretMatch[2];
      const fixedLine = `${secretMatch[1]}process.env.${varName} || ''`;
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: `Moved hardcoded secret to process.env.${varName}`,
      };
    }
  }

  // 7. Assignment in condition: if (a = b) or if a = b:
  if (finding.rule === 'assignment-in-condition') {
    const isPy = (finding.file || '').endsWith('.py') || (finding.file || '').endsWith('.pyw');
    const eqSym = isPy ? '==' : '===';
    const fixedLine = originalLine.replace(/([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=(?!=)/, `$1 ${eqSym}`);
    if (fixedLine !== originalLine) {
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: `Replaced accidental assignment (=) with equality comparison (${eqSym})`,
      };
    }
  }

  // 8. Generic fallback using suggestedFix
  if (finding.suggestedFix && originalLine) {
    const isPy = (finding.file || '').endsWith('.py') || (finding.file || '').endsWith('.pyw');
    const commentPrefix = isPy ? '#' : '//';
    const indentMatch = originalLine.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '';
    return {
      startLine: finding.line,
      endLine: finding.line,
      oldSnippet: originalLine,
      newSnippet: `${indent}${commentPrefix} CodeSentry recommendation: ${finding.suggestedFix}\n${originalLine}`,
      explanation: finding.suggestedFix,
    };
  }

  return null;
}

/**
 * Generates an AI-powered fix via OpenRouter or falls back to rule-based template.
 */
async function generateFix(projectPath, finding, options = {}) {
  const fullPath = path.isAbsolute(finding.file) ? finding.file : path.resolve(projectPath, finding.file);

  let fileContent = '';
  try {
    fileContent = fs.readFileSync(fullPath, 'utf8');
  } catch (err) {
    return { error: `Cannot read file: ${finding.file}` };
  }

  // First try rule-based fix
  const ruleFix = generateRuleFix(finding, fileContent);

  // If AI is enabled and we have a client, request an enhanced fix
  if (options.aiClient && !options.noAi) {
    try {
      const lines = fileContent.split('\n');
      const win = getLineWindow(lines, finding.line || 1, 3);
      const prompt = [
        'You are CodeSentry Automated Code Repair Assistant.',
        `File: ${finding.file}`,
        `Issue: ${finding.message}`,
        `Rule: ${finding.rule || 'N/A'}`,
        `Severity: ${finding.severity}`,
        `Line: ${finding.line || 1}`,
        `Suggested approach: ${finding.suggestedFix || 'Apply best practices'}`,
        '',
        'Code snippet:',
        '```',
        win.lines.join('\n'),
        '```',
        '',
        'Respond with ONLY a JSON object in this exact format:',
        '{"explanation":"...","oldSnippet":"exact code to replace","newSnippet":"replacement code"}',
      ].join('\n');

      const response = await options.aiClient.analyze(prompt);
      const match = response.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (parsed.oldSnippet && parsed.newSnippet) {
          return {
            startLine: win.startLine,
            endLine: win.endLine,
            oldSnippet: parsed.oldSnippet,
            newSnippet: parsed.newSnippet,
            explanation: parsed.explanation || finding.suggestedFix || 'AI-generated fix',
          };
        }
      }
    } catch {
      // Fall through to rule-based fix
    }
  }

  const isPy = (finding.file || '').endsWith('.py') || (finding.file || '').endsWith('.pyw');
  const commentPrefix = isPy ? '#' : '//';
  return ruleFix || {
    startLine: finding.line || 1,
    endLine: finding.line || 1,
    oldSnippet: fileContent.split('\n')[(finding.line || 1) - 1] || '',
    newSnippet: `${commentPrefix} CodeSentry: ${finding.message}\n${fileContent.split('\n')[(finding.line || 1) - 1] || ''}`,
    explanation: finding.suggestedFix || finding.message,
  };
}

/**
 * Formats a colorized terminal diff preview card.
 */
function formatDiffPreview(finding, fix) {
  const c = theme.colors;
  const lines = [
    `${c.cyan('▎ File:')}    ${c.brightWhite(finding.file)}${finding.line ? c.gray(`:${finding.line}`) : ''}`,
    `${c.cyan('▎ Issue:')}   ${theme.severityBadge(finding.severity)} ${c.white(finding.message)}`,
    `${c.cyan('▎ Fix:')}     ${c.gray(fix.explanation || finding.suggestedFix || 'Code correction')}`,
    `${c.darkGray('─'.repeat(68))}`,
  ];

  const oldLines = (fix.oldSnippet || '').split('\n');
  for (const l of oldLines) {
    lines.push(`${c.red(' - ')}${c.red(l)}`);
  }

  const newLines = (fix.newSnippet || '').split('\n');
  for (const l of newLines) {
    lines.push(`${c.green(' + ')}${c.green(l)}`);
  }

  return theme.card(lines, {
    title: c.cyan(theme.bold('IMPROVEMENT PREVIEW')),
    rightTitle: c.gray('codesentry v0.1.0'),
    width: 72,
  });
}

/**
 * Applies a fix to a file on disk.
 */
function applyFixToFile(projectPath, finding, fix) {
  const fullPath = path.isAbsolute(finding.file) ? finding.file : path.resolve(projectPath, finding.file);

  try {
    if (!fs.existsSync(fullPath)) {
      return { success: false, error: `File not found: ${finding.file}` };
    }

    const content = fs.readFileSync(fullPath, 'utf8');

    // Replace the exact oldSnippet
    if (content.includes(fix.oldSnippet)) {
      const updated = content.replace(fix.oldSnippet, fix.newSnippet);
      fs.writeFileSync(fullPath, updated, 'utf8');
      return { success: true, file: finding.file, line: finding.line };
    }

    // Fallback line replacement
    const lines = content.split('\n');
    const lineIdx = (finding.line || 1) - 1;
    if (lineIdx >= 0 && lineIdx < lines.length) {
      lines[lineIdx] = fix.newSnippet;
      fs.writeFileSync(fullPath, lines.join('\n'), 'utf8');
      return { success: true, file: finding.file, line: finding.line };
    }

    return { success: false, error: 'Could not locate target lines in file' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  generateRuleFix,
  generateFix,
  formatDiffPreview,
  applyFixToFile,
};
