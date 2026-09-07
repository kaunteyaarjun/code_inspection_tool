'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  generateRuleFix,
  formatDiffPreview,
  applyFixToFile,
} = require('../../../src/cli/fixer');

describe('Fixer Engine', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codesentry-fixer-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe('generateRuleFix', () => {
    it('should generate fix for loose equality', () => {
      const code = 'if (user.id == targetId) { doSomething(); }';
      const finding = {
        rule: 'loose-equality',
        line: 1,
        message: 'Use === instead of ==',
      };
      const fix = generateRuleFix(finding, code);
      assert.ok(fix);
      assert.equal(fix.newSnippet, 'if (user.id === targetId) { doSomething(); }');
    });

    it('should generate fix for off-by-one boundary', () => {
      const code = 'for (let i = 0; i <= items.length; i++) {';
      const finding = {
        rule: 'off-by-one',
        line: 1,
        message: 'Off-by-one loop error',
      };
      const fix = generateRuleFix(finding, code);
      assert.ok(fix);
      assert.equal(fix.newSnippet, 'for (let i = 0; i < items.length; i++) {');
    });

    it('should generate fix for empty catch block', () => {
      const code = 'try { dangerous(); } catch (err) {\n}';
      const finding = {
        rule: 'empty-catch',
        line: 1,
        message: 'Empty catch block',
      };
      const fix = generateRuleFix(finding, code);
      assert.ok(fix);
      assert.ok(fix.newSnippet.includes('console.error(err);'));
    });

    it('should generate fix for hardcoded secret', () => {
      const code = "const API_KEY = 'secret-token-12345';";
      const finding = {
        rule: 'hardcoded-secret',
        line: 1,
        message: 'Hardcoded secret detected',
      };
      const fix = generateRuleFix(finding, code);
      assert.ok(fix);
      assert.ok(fix.newSnippet.includes('process.env.API_KEY'));
    });

    it('should generate fix for Python assignment in condition', () => {
      const code = '    if status = "active":';
      const finding = {
        file: 'app.py',
        rule: 'assignment-in-condition',
        line: 1,
        message: 'Assignment in condition',
      };
      const fix = generateRuleFix(finding, code);
      assert.ok(fix);
      assert.equal(fix.newSnippet, '    if status == "active":');
    });
  });

  describe('formatDiffPreview', () => {
    it('should render diff card with file, issue, and +/- changes', () => {
      const finding = {
        file: 'src/app.js',
        line: 42,
        severity: 'HIGH',
        message: 'Loose equality check',
      };
      const fix = {
        oldSnippet: 'if (a == b)',
        newSnippet: 'if (a === b)',
        explanation: 'Use strict equality',
      };
      const preview = formatDiffPreview(finding, fix);
      assert.ok(preview.includes('src/app.js'));
      assert.ok(preview.includes('IMPROVEMENT PREVIEW'));
      assert.ok(preview.includes('if (a == b)'));
      assert.ok(preview.includes('if (a === b)'));
    });
  });

  describe('applyFixToFile', () => {
    it('should accurately update file content on disk', () => {
      const targetFile = path.join(tempDir, 'sample.js');
      const original = 'const a = 1;\nif (x == y) {\n  return a;\n}\n';
      fs.writeFileSync(targetFile, original, 'utf8');

      const finding = {
        file: targetFile,
        line: 2,
        rule: 'loose-equality',
        message: 'Loose equality',
      };
      const fix = {
        oldSnippet: 'if (x == y) {',
        newSnippet: 'if (x === y) {',
      };

      const result = applyFixToFile(tempDir, finding, fix);
      assert.equal(result.success, true);

      const updated = fs.readFileSync(targetFile, 'utf8');
      assert.ok(updated.includes('if (x === y) {'));
      assert.ok(!updated.includes('if (x == y) {'));
    });
  });
});
