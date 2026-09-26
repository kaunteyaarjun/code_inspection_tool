function analyzeBugs(filePath, content) {
  const findings = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    checkEmptyCatch(lines, i, findings, filePath);
    checkSwallowedError(trimmed, lineNum, findings, filePath);
    checkAssignmentInCondition(trimmed, lineNum, findings, filePath);
    checkLooseEquality(trimmed, lineNum, findings, filePath);
    checkOffByOne(trimmed, lineNum, findings, filePath);
    checkUnreachableCode(trimmed, lines, i, findings, filePath);
    checkAlwaysTrueFalse(trimmed, lineNum, findings, filePath);
    checkDuplicateCondition(lines, i, findings, filePath);
  }

  return findings;
}

function checkEmptyCatch(lines, lineIndex, findings, filePath) {
  const line = lines[lineIndex];
  const lineNum = lineIndex + 1;

  const catchMatch = line.match(/catch\s*(?:\([^)]*\))?\s*\{\s*$/);
  if (!catchMatch) return;

  let braceCount = 1;
  const bodyLines = [];

  for (let j = lineIndex + 1; j < Math.min(lineIndex + 10, lines.length); j++) {
    const bodyLine = lines[j];
    braceCount += (bodyLine.match(/{/g) || []).length;
    braceCount -= (bodyLine.match(/}/g) || []).length;
    bodyLines.push(bodyLine.trim());

    if (braceCount <= 0) {
      const bodyContent = bodyLines.join(' ')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim();

      if (!bodyContent || bodyContent === '}') {
        findings.push({
          file: filePath,
          line: lineNum,
          column: null,
          rule: 'empty-catch',
          message: 'Empty catch block swallows errors silently',
          severity: 'HIGH',
          category: 'bugs',
          suggestedFix: 'Add error handling, logging, or rethrow the error.',
        });
      }
      return;
    }
  }
}

function checkSwallowedError(line, lineNum, findings, filePath) {
  const patterns = [
    /catch\s*\([^)]*\)\s*\{\s*(?:\/\/.*|\/\*.*\*\/\s*)*\}/,
    /catch\s*\([^)]*\)\s*\{\s*\/\/\s*(?:ignore|swallow|suppress|silent|noop|do nothing)/i,
  ];

  for (const pattern of patterns) {
    if (pattern.test(line)) {
      findings.push({
        file: filePath,
        line: lineNum,
        column: null,
        rule: 'swallowed-error',
        message: 'Error is caught but appears to be silently ignored',
        severity: 'MEDIUM',
        category: 'bugs',
        suggestedFix: 'Log the error or handle it meaningfully.',
      });
      return;
    }
  }
}

function checkAssignmentInCondition(line, lineNum, findings, filePath) {
  const isPy = (filePath || '').endsWith('.py') || (filePath || '').endsWith('.pyw');
  const patterns = isPy ? [
    /(?:if|elif|while)\s+[a-zA-Z_]\w*\s*=[^=!<>\n:]+/,
  ] : [
    /if\s*\(\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*=[^=!]/,
    /while\s*\(\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*=[^=!]/,
    /if\s*\(\s*\([^)]*\b[a-zA-Z_$][a-zA-Z0-9_$]*\s*=[^=!]/,
  ];

  for (const pattern of patterns) {
    if (pattern.test(line)) {
      const eqSym = isPy ? '==' : '===';
      findings.push({
        file: filePath,
        line: lineNum,
        column: null,
        rule: 'assignment-in-condition',
        message: `Assignment in condition — likely should be comparison (${eqSym})`,
        severity: 'HIGH',
        category: 'bugs',
        suggestedFix: `Use ${eqSym} for comparison, or move assignment outside the condition.`,
      });
      return;
    }
  }
}

function checkLooseEquality(line, lineNum, findings, filePath) {
  if (line.includes('===')) return;
  if (line.includes('!==')) return;

  const match = line.match(/[^!=<>]==(?!=)/);
  if (match) {
    const context = line.substring(0, 80);
    if (context.includes('//') || context.includes('*')) return;

    findings.push({
      file: filePath,
      line: lineNum,
      column: null,
      rule: 'loose-equality',
      message: 'Loose equality (==) used instead of strict equality (===)',
      severity: 'LOW',
      category: 'bugs',
      suggestedFix: 'Use === or !== for type-safe comparisons.',
    });
  }
}

function checkOffByOne(line, lineNum, findings, filePath) {
  const patterns = [
    /for\s*\([^)]*<=\s*(?:arr|items|data|results|list|elements|values|array)\.length/,
    /for\s*\([^)]*<=\s*(?:str|string|text|input|buffer)\.length/,
    /range\s*\(\s*(?:0\s*,\s*)?len\s*\([^)]+\)\s*\+\s*1\s*\)/,
  ];

  for (const pattern of patterns) {
    if (pattern.test(line)) {
      findings.push({
        file: filePath,
        line: lineNum,
        column: null,
        rule: 'off-by-one',
        message: 'Potential off-by-one loop boundary error',
        severity: 'HIGH',
        category: 'bugs',
        suggestedFix: 'Check loop boundary condition (use < length or range(len(...))).',
      });
      return;
    }
  }
}

function checkUnreachableCode(line, lines, lineIndex, findings, filePath) {
  const lineNum = lineIndex + 1;
  if (!line || line.startsWith('//') || line.startsWith('/*') || line === '}' || line === '{') return;
  if (line.startsWith('@') || /^def\s+/.test(line) || /^class\s+/.test(line) || /^function\s+/.test(line)) return;

  let prevIndex = lineIndex - 1;
  while (prevIndex >= 0) {
    const prevTrimmed = lines[prevIndex].trim();
    if (prevTrimmed === '' || prevTrimmed.startsWith('//') || prevTrimmed.startsWith('/*') || prevTrimmed.startsWith('*')) {
      prevIndex--;
      continue;
    }
    break;
  }
  if (prevIndex < 0) return;
  const prevLine = lines[prevIndex].trim();
  const rawPrevLine = lines[prevIndex];
  const rawCurrLine = lines[lineIndex];

  if (!prevLine) return;

  // Check indentation: if current line is at a lower indentation level than previous line,
  // it has exited the block or function, so it is not unreachable.
  const prevIndent = (rawPrevLine.match(/^(\s*)/)[1] || '').length;
  const currIndent = (rawCurrLine.match(/^(\s*)/)[1] || '').length;
  if (currIndent < prevIndent) return;

  const terminatorPattern = /^(return|throw|break|continue)\b/;
  if (terminatorPattern.test(prevLine) && !prevLine.endsWith('{') && !prevLine.endsWith(',')) {
    findings.push({
      file: filePath,
      line: lineNum,
      column: null,
      rule: 'unreachable-code',
      message: 'Code appears to be unreachable after return/throw/break/continue',
      severity: 'MEDIUM',
      category: 'bugs',
      suggestedFix: 'Remove unreachable code or fix control flow.',
    });
  }
}

function checkAlwaysTrueFalse(line, lineNum, findings, filePath) {
  const patterns = [
    { regex: /if\s*\(\s*true\s*\)/, message: 'Always-true condition (if (true))' },
    { regex: /if\s*\(\s*false\s*\)/, message: 'Always-false condition (if (false))' },
    { regex: /while\s*\(\s*true\s*\)/, msg: 'Infinite loop (while (true)) — verify intentional' },
    { regex: /while\s*\(\s*false\s*\)/, message: 'Dead code — while (false) never executes' },
  ];

  for (const { regex, message, msg } of patterns) {
    if (regex.test(line)) {
      findings.push({
        file: filePath,
        line: lineNum,
        column: null,
        rule: 'always-true-false',
        message: message || msg,
        severity: 'MEDIUM',
        category: 'bugs',
        suggestedFix: 'Review control flow logic.',
      });
      return;
    }
  }
}

function checkDuplicateCondition(lines, lineIndex, findings, filePath) {
  const line = lines[lineIndex].trim();
  const lineNum = lineIndex + 1;

  const ifMatch = line.match(/^if\s*\((.+)\)\s*\{?$/);
  if (!ifMatch) return;

  const condition = ifMatch[1].trim();

  // Check all subsequent if/else-if lines for the same condition
  for (let j = lineIndex + 1; j < Math.min(lineIndex + 100, lines.length); j++) {
    const otherLine = lines[j].trim();

    const otherIfMatch = otherLine.match(/^}?\s*else\s+if\s*\((.+)\)\s*\{?$/);
    if (otherIfMatch) {
      const otherCondition = otherIfMatch[1].trim();
      if (condition === otherCondition) {
        findings.push({
          file: filePath,
          line: lineNum,
          column: null,
          rule: 'duplicate-condition',
          message: 'Duplicate condition in if/else-if chain',
          severity: 'MEDIUM',
          category: 'bugs',
          suggestedFix: 'Remove or consolidate the duplicate branch.',
        });
        return;
      }
      continue;
    }

    // If we hit a closing brace or a non-else-if line at the same indent level, stop
    if (otherLine === '}' || (otherLine.startsWith('if') && !otherLine.startsWith('else'))) break;
  }
}

module.exports = {
  analyzeBugs,
};
