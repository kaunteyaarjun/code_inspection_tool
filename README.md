# CodeSentry

> **Zero-Dependency DevSecOps & AI Code Inspection Engine**  
> Fast deterministic SAST analysis combined with contextual OpenRouter AI verification and automated code repairs.

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Pure Node](https://img.shields.io/badge/Docker-Not%20Required-success.svg)](#zero-docker-required)
[![Architecture & Workflow](https://img.shields.io/badge/Architecture-workflow.md-blue.svg)](workflow.md)

CodeSentry inspects JavaScript, TypeScript, and Python codebases for security vulnerabilities, logic bugs, algorithmic bottlenecks, and resource leaks. Built with a terminal-native dark aesthetic and live typewriter progress telemetry, it offers built-in security detection, interactive code repairs, and dynamic AI-powered security hardening.

---

## ⚡ Quick Start (Zero-Install)

Run instantly without cloning or installing dependencies:

```bash
# Run directly via npx (zero install):
npx codesentry-ai scan .

# Or install globally from npm:
npm install -g codesentry-ai
codesentry scan .

# Or install directly from GitHub:
npm install -g github:raelx20/codesentry
```

> **Note**: Both `codesentry` and `codesentry-ai` command aliases work identically in your shell.

On first run, CodeSentry interactively configures your free OpenRouter API key and saves it to `~/.codesentry/config.json`. Subsequent runs never prompt again.

---

## 🌟 Key Capabilities

### 1. 🛠️ Interactive Post-Scan Fix Engine
After any scan, CodeSentry provides an interactive improvement menu:
- **Whole Codebase Mode**: Batch-repairs all detected vulnerabilities and bugs across the entire project.
- **Specific Flaw Mode**: Two-tier category filter (`Security Flaws`, `Code Bugs`, `Efficiency`) to select and preview individual issues.
- **Safe Diff Preview**: Color-coded diff card (`- red` / `+ green`) showing the exact file, line, and proposed change.
- **Confirmation Guard**: Requires explicit approval (`Yes, apply fix to file`) before writing to disk.
- **Auto-Verification**: Re-initiates scan immediately after fixes are written to confirm the issue is resolved.

### 2. 🛡️ Native Built-in Security Detection
Even with zero external linters installed, CodeSentry's native AST engine catches:
- Hardcoded secrets and API keys (`sk-`, AWS tokens, Bearer tokens)
- SQL Injection vectors (interpolated raw queries)
- Command Injection risks (`child_process.exec`, `eval`, `pickle.loads`)
- Loose equality pitfalls (`==` vs `===`)
- Regex Denial of Service (ReDoS) vulnerabilities

### 3. 🤖 AI-Powered Architectural Security Hardening
Clean codebases aren't always secure. When 0 bugs are detected, CodeSentry offers proactive AI security hardening:
- Analyzes project tech stack (Flask, Express, Next.js, Django)
- Generates defense-in-depth architectural suggestions (CSP, HSTS, Rate Limiting, CORS)
- Exports complete hardening guides to `AI-SECURITY-SUGGESTIONS.md`

---

## 💻 CLI Commands & Options

```bash
# Basic scan
codesentry scan .

# Fast static mode (skips cloud AI triage)
codesentry scan . --no-ai

# Automatic code repair
codesentry scan . --fix

# Configure or check OpenRouter API credentials
codesentry auth

# Interactively toggle AI reasoning models
codesentry model
```
