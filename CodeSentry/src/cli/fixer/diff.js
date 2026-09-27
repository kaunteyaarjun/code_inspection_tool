/**
 * Fixer Diff Preview Module
 *
 * Formats visual, colorized terminal diff preview cards for code remediations.
 */

'use strict';

const theme = require('../theme');

/**
 * Formats a colorized terminal diff preview card.
 *
 * @param {Object} finding - The finding object (file, line, severity, message, suggestedFix)
 * @param {Object} fix - The proposed fix (oldSnippet, newSnippet, explanation)
 * @returns {string} Colorized terminal card
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

module.exports = {
  formatDiffPreview,
};
