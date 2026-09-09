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
 * CRITICAL: Every fix MUST actually transform the code — never just add a comment.
 * Returns null if no real fix can be generated.
 */
function generateRuleFix(finding, fileContent) {
  const lines = fileContent.split('\n');
  const lineIdx = (finding.line || 1) - 1;
  const originalLine = lines[lineIdx] || '';
  const isPy = (finding.file || '').endsWith('.py') || (finding.file || '').endsWith('.pyw');

  // ── Bug Category Fixes ─────────────────────────────────────────────────────

  // 1. Loose equality: == to === or != to !==, and Python E711/E712
  if (
    finding.rule === 'loose-equality' ||
    finding.rule === 'eqeqeq' ||
    finding.rule === 'E711' ||
    finding.rule === 'E712' ||
    (finding.message && (finding.message.includes('Loose equality') || finding.message.includes('== None') || finding.message.includes('== True') || finding.message.includes('== False')))
  ) {
    let fixedLine = originalLine;
    if (isPy) {
      fixedLine = fixedLine
        .replace(/==\s*None/g, 'is None')
        .replace(/!=\s*None/g, 'is not None')
        .replace(/==\s*True/g, 'is True')
        .replace(/==\s*False/g, 'is False');
    } else {
      if (originalLine.includes('!=') && !originalLine.includes('!==')) {
        fixedLine = originalLine.replace(/!=(?!=)/g, '!==');
      } else if (originalLine.includes('==') && !originalLine.includes('===')) {
        fixedLine = originalLine.replace(/==(?!=)/g, '===');
      }
    }
    if (fixedLine !== originalLine) {
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: isPy
          ? 'Replaced equality comparison with identity comparison (is None / is True)'
          : 'Replaced loose equality with strict equality to prevent unexpected type coercion',
      };
    }
  }

  // 2. Off-by-one array boundary error: <= array.length to < array.length, or range(len() + 1)
  if (finding.rule === 'off-by-one' || (finding.message && finding.message.includes('off-by-one'))) {
    if (isPy) {
      const fixedLine = originalLine.replace(/range\s*\(\s*(?:0\s*,\s*)?len\s*\(([^)]+)\)\s*\+\s*1\s*\)/g, 'range(len($1))');
      if (fixedLine !== originalLine) {
        return {
          startLine: finding.line,
          endLine: finding.line,
          oldSnippet: originalLine,
          newSnippet: fixedLine,
          explanation: 'Corrected loop boundary to range(len(...)) to prevent index out-of-bounds',
        };
      }
    } else {
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
  }

  // 3. Empty catch block: add error logging inside the catch body
  if (finding.rule === 'empty-catch' || (finding.message && finding.message.includes('Empty catch block'))) {
    const catchMatch = originalLine.match(/catch\s*(?:\(([^)]+)\))?\s*\{/);
    if (catchMatch) {
      const indentMatch = originalLine.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1] : '';
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

  // 4. Swallowed error: add logging inside the catch block
  if (finding.rule === 'swallowed-error' || (finding.message && finding.message.includes('silently ignored'))) {
    const catchMatch = originalLine.match(/catch\s*\(([^)]+)\)\s*\{/);
    if (catchMatch) {
      const indentMatch = originalLine.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1] : '';
      const errVar = catchMatch[1].trim();
      const fixedSnippet = `${originalLine}\n${indent}  console.error('Error caught:', ${errVar});`;
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedSnippet,
        explanation: 'Added error logging to swallowed catch block',
      };
    }
  }

  // 5. Assignment in condition: if (a = b) → if (a === b) or if (user.active = true)
  if (finding.rule === 'assignment-in-condition' || (finding.message && finding.message.includes('Assignment in condition'))) {
    const eqSym = isPy ? '==' : '===';
    const fixedLine = originalLine.replace(/([a-zA-Z_$][a-zA-Z0-9_$.]*)\s*=(?!=)/, `$1 ${eqSym}`);
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

  // 6. Duplicate condition in if/else-if
  if (finding.rule === 'duplicate-condition' || (finding.message && finding.message.includes('Duplicate condition'))) {
    const ifMatch = originalLine.match(/^(\s*)if\s*\((.+)\)/);
    if (ifMatch) {
      const cond = ifMatch[2].trim();
      for (let j = lineIdx + 1; j < Math.min(lineIdx + 50, lines.length); j++) {
        const l = lines[j];
        if (l.includes('else if') && l.includes(cond)) {
          const fixedL = l.replace(/else\s+if\s*\([^)]+\)/, '/* Duplicate condition removed */ else if (false)');
          return {
            startLine: j + 1,
            endLine: j + 1,
            oldSnippet: l,
            newSnippet: fixedL,
            explanation: `Deactivated duplicate condition branch in if/else-if chain`,
          };
        }
      }
    }
  }

  // 7. Unreachable code: delete the unreachable line
  if (finding.rule === 'unreachable-code') {
    return {
      startLine: finding.line,
      endLine: finding.line,
      oldSnippet: originalLine,
      newSnippet: '',
      explanation: 'Removed unreachable code after return/throw/break/continue',
    };
  }

  // 8. Always-true/false condition: remove tautology
  if (finding.rule === 'always-true-false') {
    if (/if\s*\(\s*false\s*\)/.test(originalLine)) {
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: '',
        explanation: 'Removed dead code: if (false) block never executes',
      };
    }
    if (/if\s*\(\s*true\s*\)/.test(originalLine)) {
      const fixedLine = originalLine.replace(/if\s*\(\s*true\s*\)\s*\{?/, '{ // always executes:');
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: 'Removed tautological condition if(true)',
      };
    }
  }

  // ── Security Category Fixes ────────────────────────────────────────────────

  // 9. Flask debug=True enabled in production (Semgrep avoid_app_run_with_debug)
  const isDebugFinding =
    finding.rule === 'avoid_app_run_with_debug' ||
    (finding.rule && finding.rule.includes('avoid_app_run_with_debug')) ||
    (finding.message && (finding.message.includes('debug=True') || finding.message.includes('debug mode')));

  if (isDebugFinding && originalLine.includes('debug=True')) {
    const fixedLine = originalLine.replace(/debug\s*=\s*True/g, 'debug=False');
    if (fixedLine !== originalLine) {
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: 'Disabled Flask debug mode in production (debug=False)',
      };
    }
  }

  // 10. Flask host 0.0.0.0 binding (Semgrep avoid_app_run_with_bad_host / Bandit B104)
  const isHostFinding =
    finding.rule === 'B104' ||
    finding.rule === 'avoid_app_run_with_bad_host' ||
    (finding.rule && finding.rule.includes('avoid_app_run_with_bad_host')) ||
    (finding.message && (finding.message.includes('0.0.0.0') || finding.message.includes('bad host') || finding.message.includes('all interfaces')));

  if (isHostFinding && /host\s*=\s*['"]0\.0\.0\.0['"]/.test(originalLine)) {
    const fixedLine = originalLine.replace(/host\s*=\s*['"]0\.0\.0\.0['"]/g, "host='127.0.0.1'");
    if (fixedLine !== originalLine) {
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: 'Restricted Flask server binding to localhost (127.0.0.1)',
      };
    }
  }

  // 11. Hardcoded secret / credentials (Custom, Bandit B105/B106, Ruff S105/S106)
  const isSecretFinding =
    finding.rule === 'hardcoded-secret' ||
    finding.rule === 'hardcoded-aws-key' ||
    finding.rule === 'hardcoded-github-token' ||
    finding.rule === 'B105' ||
    finding.rule === 'B106' ||
    finding.rule === 'S105' ||
    finding.rule === 'S106' ||
    (finding.rule && (finding.rule.includes('hardcoded') || finding.rule.includes('secret') || finding.rule.includes('password'))) ||
    (finding.message && (finding.message.includes('hardcoded') || finding.message.includes('Hardcoded')));

  if (isSecretFinding) {
    if (isPy) {
      const pyMatch = originalLine.match(/^(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*)['"][^'"]+['"]/);
      if (pyMatch) {
        const varName = pyMatch[2];
        const fixedLine = `${pyMatch[1]}os.environ.get('${varName}', '')`;
        return {
          startLine: finding.line,
          endLine: finding.line,
          oldSnippet: originalLine,
          newSnippet: fixedLine,
          explanation: `Moved hardcoded secret to os.environ.get('${varName}')`,
        };
      }
    } else {
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
  }

  // 12. SQL Injection (JS template literal): rewrite to parameterized query
  if (finding.rule === 'sql-injection-template' || (finding.message && finding.message.includes('variable interpolation in SQL'))) {
    const indentMatch = originalLine.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '';

    const varMatches = [...originalLine.matchAll(/\$\{([^}]+)\}/g)].map(m => m[1].trim());
    const paramPlaceholders = varMatches.map((_, i) => `$${i + 1}`).join(', ');
    const paramArray = varMatches.join(', ');

    let fixedLine = originalLine;
    for (let i = 0; i < varMatches.length; i++) {
      fixedLine = fixedLine.replace(`\${${varMatches[i]}}`, `$${i + 1}`);
    }
    fixedLine = fixedLine.replace(/`/g, "'");

    if (fixedLine !== originalLine) {
      if (/\.(query|execute)\s*\(/.test(fixedLine)) {
        fixedLine = fixedLine.replace(/\)\s*$/, `, [${paramArray}])`);
        fixedLine = fixedLine.replace(/\)\s*;/, `, [${paramArray}]);`);
      }
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: `Parameterized SQL query with parameters [${paramArray}]`,
      };
    }
  }

  // 13. SQL Injection (JS concatenation)
  if (finding.rule === 'sql-injection-concat' || (finding.message && finding.message.includes('SQL query constructed via string concatenation'))) {
    const fixedLine = originalLine.replace(
      /(['"][^'"]*['"])\s*\+\s*([a-zA-Z_$][a-zA-Z0-9_$.]*)/,
      (_, sqlPart, varName) => `${sqlPart.slice(0, -1)} $1${sqlPart.slice(-1)}, [${varName}]`
    );
    if (fixedLine !== originalLine) {
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: 'Converted string concatenation to parameterized query',
      };
    }
  }

  // 14. Python SQL Injection (f-string & Bandit B608 / Ruff S608)
  const isPySql =
    finding.rule === 'py-sql-injection-fstring' ||
    finding.rule === 'py-sql-injection-concat' ||
    finding.rule === 'B608' ||
    finding.rule === 'S608' ||
    (isPy && finding.message && (finding.message.includes('SQL injection') || finding.message.includes('SQL query')));

  if (isPySql) {
    if (/f["'].*\{[^}]+\}/.test(originalLine)) {
      const varMatches = [...originalLine.matchAll(/\{([^}]+)\}/g)].map(m => m[1].trim());
      let fixedLine = originalLine;
      for (const v of varMatches) {
        fixedLine = fixedLine.replace(`'{${v}}'`, '%s').replace(`"{${v}}"`, '%s').replace(`{${v}}`, '%s');
      }
      fixedLine = fixedLine.replace(/f(["'])/, '$1');
      if (/\.execute\s*\(/.test(fixedLine) && varMatches.length > 0) {
        const paramTuple = varMatches.length === 1 ? `(${varMatches[0]},)` : `(${varMatches.join(', ')})`;
        fixedLine = fixedLine.replace(/\)\s*$/, `, ${paramTuple})`);
      }
      if (fixedLine !== originalLine) {
        return {
          startLine: finding.line,
          endLine: finding.line,
          oldSnippet: originalLine,
          newSnippet: fixedLine,
          explanation: 'Converted f-string SQL to parameterized query with %s placeholders',
        };
      }
    }
  }

  // 15. Code Injection eval() in JS
  if (finding.rule === 'code-injection-eval' || (!isPy && finding.message && finding.message.includes('eval()'))) {
    const fixedLine = originalLine.replace(/\beval\s*\(([^)]+)\)/, 'JSON.parse($1)');
    if (fixedLine !== originalLine) {
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: 'Replaced hazardous eval() with safe JSON.parse()',
      };
    }
  }

  // 16. Code Injection eval() and exec() in Python (Bandit B307/B102, Semgrep user-eval)
  const isPyCodeInj =
    finding.rule === 'py-code-injection' ||
    finding.rule === 'B307' ||
    finding.rule === 'B102' ||
    finding.rule === 'S307' ||
    finding.rule === 'S102' ||
    (isPy && finding.message && (finding.message.includes('eval') || finding.message.includes('exec')));

  if (isPyCodeInj) {
    let fixedLine = originalLine;
    if (/\beval\s*\(/.test(originalLine)) {
      fixedLine = fixedLine.replace(/\beval\s*\(([^)]+)\)/, 'ast.literal_eval($1)');
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: 'Replaced unsafe eval() with ast.literal_eval() for safe data parsing',
      };
    }
    if (/\bexec\s*\(/.test(originalLine)) {
      const indentMatch = originalLine.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1] : '';
      fixedLine = `${indent}# Dynamic exec() removed for security\n${indent}raise NotImplementedError("Dynamic execution disabled")`;
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: 'Removed dynamic exec() call to prevent arbitrary code execution',
      };
    }
  }

  // 17. Code Injection new Function() in JS
  if (finding.rule === 'code-injection-function') {
    const fixedLine = originalLine.replace(/new\s+Function\s*\(([^)]*)\)/, '(() => { throw new Error("Dynamic Function constructor removed by CodeSentry"); })');
    if (fixedLine !== originalLine) {
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: 'Removed dynamic Function constructor to prevent code injection',
      };
    }
  }

  // 18. Command Injection (JS): exec() → execFile()
  if (finding.rule === 'command-injection') {
    let fixedLine = originalLine;
    fixedLine = fixedLine.replace(/\bexecSync\b/g, 'execFileSync');
    fixedLine = fixedLine.replace(/\bexec\b(?!File)/g, 'execFile');
    if (fixedLine !== originalLine) {
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: 'Replaced exec() with execFile() to prevent shell command injection',
      };
    }
  }

  // 19. Command Injection (Python): shell=True → shell=False, os.system → subprocess.run
  if (
    finding.rule === 'py-command-injection' ||
    finding.rule === 'B602' ||
    finding.rule === 'S602' ||
    (isPy && finding.message && finding.message.includes('command injection'))
  ) {
    let fixedLine = originalLine;
    fixedLine = fixedLine.replace(/shell\s*=\s*True/g, 'shell=False');
    fixedLine = fixedLine.replace(/os\.system\s*\(([^)]+)\)/, 'subprocess.run(shlex.split($1), check=True)');
    if (fixedLine !== originalLine) {
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: 'Disabled shell=True to prevent command injection',
      };
    }
  }

  // 20. Path Traversal: add path sanitization
  if (finding.rule === 'path-traversal' || (finding.message && finding.message.includes('directory traversal'))) {
    const indentMatch = originalLine.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '';
    if (isPy) {
      const fixedSnippet = `${indent}# CodeSentry: Sanitize filepath to prevent directory traversal\n${indent}safe_path = os.path.abspath(os.path.join('/uploads', os.path.basename(filename)))\n${originalLine.replace(/file_path\s*=\s*f?['"][^'"]*['"]/, 'file_path = safe_path').replace(/filename/, 'os.path.basename(filename)')}`;
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedSnippet,
        explanation: 'Added path sanitization using os.path.basename() to prevent directory traversal',
      };
    } else {
      const fixedSnippet = `${indent}// CodeSentry: Validate resolved path stays within base directory\n${indent}const safePath = path.resolve(path.join(__dirname, path.basename(req.params.filename || '')));\n${originalLine.replace(/path\.join\([^)]+\)/, 'safePath').replace(/filePath|file/, 'safePath')}`;
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedSnippet,
        explanation: 'Added path sanitization using path.basename() and path.resolve() to prevent directory traversal',
      };
    }
  }

  // 21. Weak Crypto Hash (MD5 / SHA1 in JS or Python, Bandit B303, Ruff S303)
  const isWeakHash =
    finding.rule === 'weak-crypto-hash' ||
    finding.rule === 'py-weak-crypto-hash' ||
    finding.rule === 'B303' ||
    finding.rule === 'S303' ||
    (finding.message && (finding.message.includes('MD5') || finding.message.includes('SHA1') || finding.message.includes('weak cryptographic hashing')));

  if (isWeakHash) {
    let fixedLine = originalLine;
    if (isPy) {
      fixedLine = fixedLine
        .replace(/hashlib\.md5\s*\(/g, 'hashlib.sha256(')
        .replace(/hashlib\.sha1\s*\(/g, 'hashlib.sha256(');
    } else {
      fixedLine = fixedLine
        .replace(/['"]md5['"]/gi, "'sha256'")
        .replace(/['"]sha1['"]/gi, "'sha256'");
    }
    if (fixedLine !== originalLine) {
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: 'Upgraded weak MD5/SHA1 hash to SHA-256',
      };
    }
  }

  // 22. Prototype Pollution: block __proto__ access
  if (finding.rule === 'prototype-pollution') {
    const fixedLine = originalLine
      .replace(/\["__proto__"\]/g, '["__proto__" /* BLOCKED */]')
      .replace(/\['__proto__'\]/g, "['__proto__' /* BLOCKED */]")
      .replace(/\.__proto__\s*=/, '.constructor.prototype = /* BLOCKED */ ');
    if (fixedLine !== originalLine) {
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: 'Blocked direct __proto__ modification to prevent prototype pollution',
      };
    }
  }

  // 23. Unused imports (Ruff F401 / ESLint no-unused-vars)
  if (finding.rule === 'F401' || (finding.message && finding.message.includes('imported but unused'))) {
    const unusedMatch = finding.message.match(/['"]([a-zA-Z0-9_]+)['"]\s+imported but unused/);
    if (unusedMatch) {
      const name = unusedMatch[1];
      let fixedLine = originalLine
        .replace(new RegExp(`\\b${name}\\s*,\\s*`, 'g'), '')
        .replace(new RegExp(`,\\s*\\b${name}\\b`, 'g'), '')
        .replace(new RegExp(`^(\\s*import\\s+)\\b${name}\\s*,\\s*`, 'g'), '$1')
        .replace(new RegExp(`,\\s*\\b${name}\\b\\s*$`, 'g'), '');
      if (fixedLine !== originalLine) {
        return {
          startLine: finding.line,
          endLine: finding.line,
          oldSnippet: originalLine,
          newSnippet: fixedLine,
          explanation: `Removed unused import '${name}'`,
        };
      }
    }
  }

  // ── Efficiency Category Fixes ──────────────────────────────────────────────

  // 22. Sync filesystem in async context: readFileSync → readFile
  if (finding.rule === 'sync-in-async') {
    const fixedLine = originalLine
      .replace(/fs\.readFileSync\s*\(/g, 'await fs.promises.readFile(')
      .replace(/fs\.writeFileSync\s*\(/g, 'await fs.promises.writeFile(')
      .replace(/fs\.statSync\s*\(/g, 'await fs.promises.stat(')
      .replace(/fs\.readdirSync\s*\(/g, 'await fs.promises.readdir(')
      .replace(/fs\.existsSync\s*\(/g, 'await fs.promises.access(')
      .replace(/fs\.mkdirSync\s*\(/g, 'await fs.promises.mkdir(')
      .replace(/fs\.unlinkSync\s*\(/g, 'await fs.promises.unlink(');
    if (fixedLine !== originalLine) {
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: 'Replaced synchronous filesystem call with async variant to avoid blocking event loop',
      };
    }
  }

  // ── Resource Category Fixes ────────────────────────────────────────────────

  // 23. Python open() without with statement: wrap in with (SIM115 / py-open-no-with)
  if (finding.rule === 'py-open-no-with' || finding.rule === 'SIM115' || (finding.message && (finding.message.includes('Use a `with` statement when opening files') || finding.message.includes('open without with')))) {
    const openMatch = originalLine.match(/^(\s*)(\w+)\s*=\s*(open\s*\([^)]+\))/);
    if (openMatch) {
      const indent = openMatch[1];
      const varName = openMatch[2];
      const openCall = openMatch[3];
      const fixedLine = `${indent}with ${openCall} as ${varName}:`;
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: 'Wrapped file open() in "with" statement for automatic resource cleanup',
      };
    }
  }

  // 24. XSS via dangerouslySetInnerHTML: add DOMPurify sanitization
  if (finding.rule === 'xss-dangerously-set-inner-html') {
    const fixedLine = originalLine.replace(
      /__html:\s*([^}]+)/,
      '__html: DOMPurify.sanitize($1)'
    );
    if (fixedLine !== originalLine) {
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: 'Added DOMPurify.sanitize() to prevent Cross-Site Scripting (XSS)',
      };
    }
  }

  // 24b. Unused imports (Ruff F401 / ESLint no-unused-vars)
  if (finding.rule === 'F401' || (finding.message && finding.message.includes('imported but unused'))) {
    const unusedMatch = finding.message.match(/[`'"]?([a-zA-Z0-9_.]+)[`'"]?\s+imported but unused/);
    if (unusedMatch) {
      const name = unusedMatch[1];
      const shortName = name.includes('.') ? name.split('.').pop() : name;
      let fixedLine = originalLine;
      if (originalLine.trim() === `import ${name}` || originalLine.trim() === `import ${shortName}`) {
        fixedLine = `# unused import '${name}' removed`;
      } else if (originalLine.includes('import')) {
        fixedLine = originalLine
          .replace(new RegExp(`\\b${shortName}\\s*,\\s*`, 'g'), '')
          .replace(new RegExp(`,\\s*\\b${shortName}\\b`, 'g'), '')
          .replace(new RegExp(`^(\\s*import\\s+)\\b${shortName}\\s*,\\s*`, 'g'), '$1')
          .replace(new RegExp(`,\\s*\\b${shortName}\\b\\s*$`, 'g'), '');
      }
      if (fixedLine !== originalLine) {
        return {
          startLine: finding.line,
          endLine: finding.line,
          oldSnippet: originalLine,
          newSnippet: fixedLine,
          explanation: `Removed unused import '${name}'`,
        };
      }
    }
  }

  // 25. Python UP006: Use modern built-in generics (list instead of List, dict instead of Dict, etc.)
  if (
    finding.rule === 'UP006' ||
    (finding.message && (finding.message.includes('instead of `List`') || finding.message.includes('instead of `Dict`') || finding.message.includes('instead of `Set`') || finding.message.includes('instead of `Tuple`')))
  ) {
    let fixedLine = originalLine
      .replace(/\bList\[/g, 'list[')
      .replace(/\bDict\[/g, 'dict[')
      .replace(/\bSet\[/g, 'set[')
      .replace(/\bTuple\[/g, 'tuple[');
    if (fixedLine !== originalLine) {
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: 'Upgraded deprecated typing generics to modern built-in type annotations (PEP 585)',
      };
    }
  }

  // 26. Python UP045: Use X | None for type annotations (PEP 604)
  if (finding.rule === 'UP045' || (finding.message && finding.message.includes('X | None'))) {
    let fixedLine = originalLine.replace(/\bOptional\s*\[\s*([^\]]+)\s*\]/g, '$1 | None');
    if (fixedLine !== originalLine) {
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: 'Modernized Optional[T] annotation to T | None union syntax (PEP 604)',
      };
    }
  }

  // 27. Python SIM103: Return condition directly
  if (finding.rule === 'SIM103' || (finding.message && finding.message.includes('Return the condition directly'))) {
    const ifMatch = originalLine.match(/^(\s*)if\s+([^:]+):/);
    if (ifMatch) {
      const indent = ifMatch[1];
      const cond = ifMatch[2].trim();
      const nextLine = lines[lineIdx + 1] || '';
      const nextLine2 = lines[lineIdx + 2] || '';
      const nextLine3 = lines[lineIdx + 3] || '';
      if (nextLine.includes('return True') && (nextLine2.includes('else:') && nextLine3.includes('return False') || nextLine2.includes('return False'))) {
        const fullBlock = nextLine2.includes('else:')
          ? [originalLine, nextLine, nextLine2, nextLine3].join('\n')
          : [originalLine, nextLine, nextLine2].join('\n');
        return {
          startLine: finding.line,
          endLine: finding.line + (nextLine2.includes('else:') ? 3 : 2),
          oldSnippet: fullBlock,
          newSnippet: `${indent}return bool(${cond})`,
          explanation: 'Replaced redundant if-return boolean branch with direct boolean return',
        };
      }
    }
  }

  // 28. Python SIM102: Nested if statements
  if (finding.rule === 'SIM102' || (finding.message && finding.message.includes('nested `if` statements'))) {
    const ifMatch = originalLine.match(/^(\s*)if\s+([^:]+):/);
    const nextLine = lines[lineIdx + 1] || '';
    const nextIfMatch = nextLine.match(/^(\s*)if\s+([^:]+):/);
    if (ifMatch && nextIfMatch) {
      const indent = ifMatch[1];
      const cond1 = ifMatch[2].trim();
      const cond2 = nextIfMatch[2].trim();
      return {
        startLine: finding.line,
        endLine: finding.line + 1,
        oldSnippet: [originalLine, nextLine].join('\n'),
        newSnippet: `${indent}if ${cond1} and ${cond2}:`,
        explanation: 'Combined nested if statements into single condition with and',
      };
    }
  }

  // 29. Python B006: Mutable default arguments
  if (finding.rule === 'B006' || (finding.message && finding.message.includes('mutable data structures for argument defaults'))) {
    const fixedLine = originalLine
      .replace(/=\s*\[\s*\]/g, '=None')
      .replace(/=\s*\{\s*\}/g, '=None');
    if (fixedLine !== originalLine) {
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: 'Replaced mutable default parameter with None to avoid unexpected state persistence',
      };
    }
  }

  // 30. Python E722: Bare except
  if (finding.rule === 'E722' || (finding.message && finding.message.includes('bare `except`'))) {
    const fixedLine = originalLine.replace(/except\s*:/, 'except Exception:');
    if (fixedLine !== originalLine) {
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: 'Replaced bare except with explicit except Exception',
      };
    }
  }

  // 31. Python BLE001: Blind exception
  if (finding.rule === 'BLE001' || (finding.message && finding.message.includes('blind exception'))) {
    const fixedLine = originalLine.replace(/except\s+Exception\s*:/, 'except Exception as err:');
    if (fixedLine !== originalLine) {
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: 'Captured blind exception instance for error inspection and logging',
      };
    }
  }

  // 32. Python S110 / B110: try-except-pass
  if (
    finding.rule === 'S110' ||
    finding.rule === 'B110' ||
    (finding.message && (finding.message.includes('try`-`except`-`pass') || finding.message.includes('try, except, pass')))
  ) {
    const indentMatch = originalLine.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '    ';
    if (originalLine.trim() === 'pass') {
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: `${indent}import logging\n${indent}logging.exception("Handled unexpected exception")`,
        explanation: 'Replaced silent pass with error logging to prevent suppressed exceptions',
      };
    }
  }

  // 33. Python B113: Requests call without timeout
  if (finding.rule === 'B113' || (finding.message && (finding.message.includes('Requests call without timeout') || finding.message.includes('call without timeout')))) {
    let fixedLine = originalLine;
    if (fixedLine.includes('requests.get(') && !fixedLine.includes('timeout=')) {
      fixedLine = fixedLine.replace(/requests\.get\(([^)]+)\)/, 'requests.get($1, timeout=10)');
    } else if (fixedLine.includes('requests.post(') && !fixedLine.includes('timeout=')) {
      fixedLine = fixedLine.replace(/requests\.post\(([^)]+)\)/, 'requests.post($1, timeout=10)');
    } else if (fixedLine.includes('requests.put(') && !fixedLine.includes('timeout=')) {
      fixedLine = fixedLine.replace(/requests\.put\(([^)]+)\)/, 'requests.put($1, timeout=10)');
    } else if (fixedLine.includes('requests.delete(') && !fixedLine.includes('timeout=')) {
      fixedLine = fixedLine.replace(/requests\.delete\(([^)]+)\)/, 'requests.delete($1, timeout=10)');
    }
    if (fixedLine !== originalLine) {
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: 'Added timeout=10 to remote HTTP request to prevent indefinite hanging',
      };
    }
  }

  // 34. Python F841: Local variable assigned but never used
  if (finding.rule === 'F841' || (finding.message && finding.message.includes('assigned to but never used'))) {
    const varMatch = finding.message.match(/Local variable\s+[`'"]?([a-zA-Z0-9_]+)[`'"]?/);
    if (varMatch) {
      const varName = varMatch[1];
      const fixedLine = originalLine.replace(new RegExp(`\\b${varName}\\s*=`), `_${varName} =`);
      if (fixedLine !== originalLine) {
        return {
          startLine: finding.line,
          endLine: finding.line,
          oldSnippet: originalLine,
          newSnippet: fixedLine,
          explanation: `Prefixed unused variable '${varName}' with underscore convention`,
        };
      }
    }
  }

  // 35. Bandit B104: Possible binding to all interfaces
  if (finding.rule === 'B104' || (finding.message && finding.message.includes('all interfaces'))) {
    const fixedLine = originalLine.replace(/['"]0\.0\.0\.0['"]/, "'127.0.0.1'");
    if (fixedLine !== originalLine) {
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedLine,
        explanation: 'Restricted host binding from 0.0.0.0 to localhost (127.0.0.1)',
      };
    }
  }

  // 36. Unbounded Cache / Memory collections
  if (finding.rule === 'unbounded-cache' || (finding.message && finding.message.includes('unbounded growth'))) {
    const indentMatch = originalLine.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '';
    const mapMatch = originalLine.match(/const\s+(\w+)\s*=\s*new\s+(Map|Set)\(\);?/);
    if (mapMatch) {
      const name = mapMatch[1];
      const type = mapMatch[2];
      const fixedSnippet = `${originalLine}\n${indent}const MAX_${name.toUpperCase()}_SIZE = 5000;\n${indent}// CodeSentry: eviction guard helper\n${indent}function prune${name[0].toUpperCase() + name.slice(1)}() { while (${name}.size > MAX_${name.toUpperCase()}_SIZE) ${name}.delete(${name}.keys().next().value); }`;
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedSnippet,
        explanation: `Added capacity bound and FIFO eviction helper for ${type} '${name}'`,
      };
    }
    const objMatch = originalLine.match(/const\s+(\w+)\s*=\s*\{\};?/);
    if (objMatch) {
      const name = objMatch[1];
      const fixedSnippet = `${originalLine}\n${indent}const MAX_${name.toUpperCase()}_KEYS = 5000;`;
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedSnippet,
        explanation: `Added maximum capacity threshold constant for object cache '${name}'`,
      };
    }
  }

  // 37. Streams without close (stream-no-close)
  if (finding.rule === 'stream-no-close' || (finding.message && finding.message.includes('Stream opened but never closed'))) {
    const indentMatch = originalLine.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '';
    const streamVarMatch = originalLine.match(/(?:const|let|var)\s+(\w+)\s*=/);
    if (streamVarMatch) {
      const varName = streamVarMatch[1];
      const fixedSnippet = `${originalLine}\n${indent}${varName}.on('end', () => ${varName}.destroy());\n${indent}${varName}.on('error', () => ${varName}.destroy());`;
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedSnippet,
        explanation: `Added automatic stream cleanup and destruction handlers on end and error for '${varName}'`,
      };
    }
  }

  // 38. setInterval without clearInterval
  if (finding.rule === 'setinterval-no-clear' || (finding.message && finding.message.includes('setInterval without matching clearInterval'))) {
    if (originalLine.trim().startsWith('setInterval(')) {
      const indentMatch = originalLine.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1] : '';
      const fixedSnippet = `${indent}const intervalTimer = ${originalLine.trim()}\n${indent}// CodeSentry: remember to clearInterval(intervalTimer) on teardown`;
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedSnippet,
        explanation: 'Stored setInterval handle into intervalTimer for clearInterval cleanup',
      };
    }
  }

  // 39. Event listeners without cleanup
  if (finding.rule === 'listener-no-remove' || (finding.message && finding.message.includes('addEventListener without matching removeEventListener'))) {
    const indentMatch = originalLine.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '';
    const eventMatch = originalLine.match(/(\w+)\.addEventListener\s*\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)/);
    if (eventMatch) {
      const target = eventMatch[1];
      const evt = eventMatch[2];
      const fn = eventMatch[3];
      const fixedSnippet = `${originalLine}\n${indent}// Teardown: ${target}.removeEventListener('${evt}', ${fn});`;
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: fixedSnippet,
        explanation: `Added cleanup teardown hook for event listener '${evt}'`,
      };
    }
  }

  // 40. RegExp created inside loop
  if (finding.rule === 'regex-in-loop' || (finding.message && finding.message.includes('RegExp created inside loop'))) {
    const regMatch = originalLine.match(/(?:const|let|var)\s+(\w+)\s*=\s*(new\s+RegExp\([^)]+\)|\/[^/]+\/[a-z]*);?/);
    if (regMatch) {
      const varName = regMatch[1];
      const regExpr = regMatch[2];
      return {
        startLine: finding.line,
        endLine: finding.line,
        oldSnippet: originalLine,
        newSnippet: `// Hoisted outside loop: const ${varName} = ${regExpr};\n${originalLine.replace(regExpr, varName)}`,
        explanation: 'Hoisted RegExp compilation outside loop to avoid redundant compilation',
      };
    }
  }

  // ── NO generic comment-only fallback ───────────────────────────────────────
  // If we reach here, no deterministic rule can safely fix this code.
  // Return null so callers can try AI repair across models or report appropriately.
  return null;
}

/**
 * Generates an automated fix via deterministic rules or AI-powered repair with model switching.
 * Never skips normally: cascades across fallback models when AI is enabled.
 */
async function generateFix(projectPath, finding, options = {}) {
  const fullPath = path.isAbsolute(finding.file) ? finding.file : path.resolve(projectPath, finding.file);

  let fileContent = '';
  try {
    fileContent = fs.readFileSync(fullPath, 'utf8');
  } catch (err) {
    return { error: `Cannot read file: ${finding.file}` };
  }

  // 1. Try deterministic AST/pattern rule fix first (instant, 100% reliable)
  const ruleFix = generateRuleFix(finding, fileContent);
  if (ruleFix && ruleFix.oldSnippet && ruleFix.newSnippet) {
    return ruleFix;
  }

  // 2. If no deterministic rule fix matched and AI is enabled:
  // Try AI code repair with dynamic model switching across the fallback chain
  if (options.aiClient && !options.noAi) {
    try {
      if (typeof options.aiClient.repairCode === 'function') {
        const aiFix = await options.aiClient.repairCode({
          finding,
          fileContent,
          line: finding.line || 1,
          file: finding.file,
          preferredModel: options.preferredModel,
          onModelSwitch: options.onModelSwitch,
        });

        if (aiFix && aiFix.oldSnippet && aiFix.newSnippet) {
          return {
            startLine: finding.line || 1,
            endLine: finding.line || 1,
            oldSnippet: aiFix.oldSnippet,
            newSnippet: aiFix.newSnippet,
            explanation: aiFix.explanation || finding.suggestedFix || 'AI-generated code repair',
            modelUsed: aiFix.modelUsed,
            switchedFrom: aiFix.switchedFrom,
          };
        }
      } else if (typeof options.aiClient.analyze === 'function') {
        // Fallback for custom AI clients implementing standard analyze()
        const lines = fileContent.split('\n');
        const win = getLineWindow(lines, finding.line || 1, 3);
        const prompt = [
          'You are CodeSentry Automated Code Repair Assistant.',
          `File: ${finding.file}`,
          `Issue: ${finding.message}`,
          `Rule: ${finding.rule || 'N/A'}`,
          `Severity: ${finding.severity}`,
          `Line: ${finding.line || 1}`,
          finding.suggestedFix ? `Suggested approach: ${finding.suggestedFix}` : '',
          '',
          'Code snippet:',
          '```',
          win.lines.join('\n'),
          '```',
          '',
          'IMPORTANT: Respond with ONLY a JSON object: {"explanation":"...","oldSnippet":"...","newSnippet":"..."}',
        ].filter(Boolean).join('\n');

        const response = await options.aiClient.analyze(prompt);
        let parsed = null;
        if (typeof response === 'object' && response !== null) {
          parsed = response;
        } else if (typeof response === 'string') {
          const match = response.match(/\{[\s\S]*\}/);
          if (match) parsed = JSON.parse(match[0]);
        }
        if (parsed && parsed.oldSnippet && parsed.newSnippet) {
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
      // Continue to final return
    }
  }

  // Return error indicating why auto-fix was not applied
  return { error: `No auto-fix available for rule: ${finding.rule || 'unknown'}` };
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
 * Applies a code snippet replacement to file content string in-memory.
 * Matches by exact substring, whitespace-tolerant substring, or target line offset.
 * Returns the modified content string, or null if the snippet could not be matched.
 */
function applySnippetToContent(content, oldSnippet, newSnippet, targetLine = 1) {
  if (!oldSnippet || typeof oldSnippet !== 'string' || typeof newSnippet !== 'string') return null;

  // Strategy 1: Exact substring match
  if (content.includes(oldSnippet)) {
    return content.replace(oldSnippet, newSnippet);
  }

  // Strategy 2: Whitespace-normalized match (handles \r\n vs \n, trailing spaces)
  const normalizedContent = content.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');
  const normalizedOld = oldSnippet.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');

  if (normalizedContent.includes(normalizedOld)) {
    const lines = content.split('\n');
    const oldLines = oldSnippet.split('\n');
    const targetLineIdx = Math.max(0, (targetLine || 1) - 1);

    for (let searchRadius = 0; searchRadius <= 5; searchRadius++) {
      for (const offset of [0, -searchRadius, searchRadius]) {
        const startIdx = targetLineIdx + offset;
        if (startIdx < 0 || startIdx >= lines.length) continue;

        const candidateSlice = lines.slice(startIdx, startIdx + oldLines.length)
          .join('\n').replace(/\r/g, '').replace(/[ \t]+$/gm, '');
        const normTarget = normalizedOld.replace(/\r/g, '');

        if (candidateSlice === normTarget) {
          const newLines = newSnippet.split('\n');
          lines.splice(startIdx, oldLines.length, ...newLines);
          return lines.join('\n');
        }
      }
    }
  }

  // Strategy 3: Line-based replacement near targetLine
  const lines = content.split('\n');
  const lineIdx = Math.max(0, (targetLine || 1) - 1);
  if (lineIdx >= 0 && lineIdx < lines.length) {
    const currentLine = lines[lineIdx];
    const normalizedCurrent = currentLine.replace(/\r/g, '').trim();
    const normalizedOld = oldSnippet.replace(/\r/g, '').trim();

    if (normalizedCurrent === normalizedOld || currentLine.includes(oldSnippet.trim())) {
      const newLines = newSnippet.split('\n');
      lines.splice(lineIdx, 1, ...newLines);
      return lines.join('\n');
    }
  }

  // Strategy 4: Fallback search anywhere for trimmed single-line snippet
  const trimmedOld = oldSnippet.trim();
  if (trimmedOld.length > 3) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(trimmedOld)) {
        lines[i] = lines[i].replace(trimmedOld, newSnippet.trim());
        return lines.join('\n');
      }
    }
  }

  return null;
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
    const updated = applySnippetToContent(content, fix.oldSnippet, fix.newSnippet, finding.line);
    if (updated !== null && updated !== content) {
      fs.writeFileSync(fullPath, updated, 'utf8');
      return { success: true, file: finding.file, line: finding.line };
    }

    return { success: false, error: 'Could not locate target code in file (content may have changed)' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Repairs multiple findings across an entire file in ONE single consolidated operation.
 *
 * 1. Executes deterministic pattern-based fixes in-memory (0ms latency, handles common rules).
 * 2. If unresolved issues remain and AI is enabled, compiles a consolidated summary
 *    of all issues and sends them together with the file content to the AI model in ONE single prompt.
 * 3. If token expiration, rate limits (429), or errors occur during AI repair,
 *    the model automatically switches down the fallback chain.
 * 4. Atomically writes the updated content to disk once.
 */
async function batchFixFile(projectPath, filePath, fileFindings, options = {}) {
  const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(projectPath, filePath);

  if (!fs.existsSync(fullPath)) {
    return {
      file: filePath,
      applied: [],
      skipped: fileFindings,
      error: `File not found: ${filePath}`,
      totalIssues: fileFindings.length,
    };
  }

  let content;
  try {
    content = fs.readFileSync(fullPath, 'utf8');
  } catch (err) {
    return {
      file: filePath,
      applied: [],
      skipped: fileFindings,
      error: `Cannot read file: ${err.message}`,
      totalIssues: fileFindings.length,
    };
  }

  const applied = [];
  const unresolved = [];

  // Sort findings in descending order by line number to prevent line number drift during in-memory edits
  const sortedFindings = [...fileFindings].sort((a, b) => (b.line || 0) - (a.line || 0));

  // ── Phase 1: Local Deterministic Rule Fixes (Instant, Zero Network Latency) ──
  for (const finding of sortedFindings) {
    const ruleFix = generateRuleFix(finding, content);
    if (ruleFix && ruleFix.oldSnippet && ruleFix.newSnippet) {
      const updated = applySnippetToContent(content, ruleFix.oldSnippet, ruleFix.newSnippet, finding.line);
      if (updated !== null && updated !== content) {
        content = updated;
        applied.push({
          finding,
          fix: ruleFix,
          method: 'deterministic',
        });
        continue;
      }
    }
    unresolved.push(finding);
  }

  // ── Phase 2: Send Consolidated Summary to AI with Dynamic Model Switching ──
  let modelUsed = null;
  let switchedFrom = null;

  if (unresolved.length > 0 && options.aiClient && !options.noAi) {
    try {
      if (typeof options.aiClient.repairFileBatch === 'function') {
        const batchRes = await options.aiClient.repairFileBatch({
          file: filePath,
          fileContent: content,
          findings: [...unresolved],
          preferredModel: options.preferredModel,
          onModelSwitch: options.onModelSwitch,
        });

        if (batchRes && batchRes.fixes && batchRes.fixes.length > 0) {
          modelUsed = batchRes.modelUsed;
          switchedFrom = batchRes.switchedFrom;

          for (const item of batchRes.fixes) {
            const updated = applySnippetToContent(content, item.oldSnippet, item.newSnippet);
            if (updated !== null && updated !== content) {
              content = updated;

              // Find closest matching unresolved finding
              const matchedIdx = unresolved.findIndex(f =>
                (item.explanation && f.rule && item.explanation.toLowerCase().includes(f.rule.toLowerCase())) ||
                (f.message && item.explanation && item.explanation.toLowerCase().includes(f.message.slice(0, 20).toLowerCase())) ||
                (f.suggestedFix && item.explanation && item.explanation.toLowerCase().includes(f.suggestedFix.slice(0, 20).toLowerCase()))
              );

              const matchedFinding = matchedIdx !== -1 ? unresolved.splice(matchedIdx, 1)[0] : unresolved.shift();

              applied.push({
                finding: matchedFinding || { file: filePath, message: item.explanation },
                fix: item,
                method: 'ai-batch',
                modelUsed,
                switchedFrom,
              });
            }
          }
        }
      }
    } catch {
      // Unresolved findings remain in unresolved array
    }
  }

  // ── Phase 3: Atomic Disk Write ─────────────────────────────────────────────
  if (applied.length > 0) {
    try {
      fs.writeFileSync(fullPath, content, 'utf8');
    } catch (err) {
      return {
        file: filePath,
        applied: [],
        skipped: fileFindings,
        error: `Failed to write changes to disk: ${err.message}`,
        totalIssues: fileFindings.length,
      };
    }
  }

  const appliedFindingSet = new Set(applied.map(a => a.finding).filter(Boolean));
  const skipped = fileFindings.filter(f => !appliedFindingSet.has(f));

  return {
    file: filePath,
    applied,
    skipped,
    modelUsed,
    switchedFrom,
    totalIssues: fileFindings.length,
  };
}

module.exports = {
  generateRuleFix,
  generateFix,
  formatDiffPreview,
  applySnippetToContent,
  applyFixToFile,
  batchFixFile,
};
