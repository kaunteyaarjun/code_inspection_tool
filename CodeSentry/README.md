# CodeSentry

Terminal-based developer code-analysis tool for detecting security vulnerabilities, bugs, inefficiencies, and resource management problems.

## Installation

```bash
npm install
```

## Usage

```bash
# Scan current directory
codesentry scan

# Scan specific project
codesentry scan ./my-project

# JSON output
codesentry scan ./my-project --json

# Filter by severity
codesentry scan ./my-project --severity HIGH

# Filter by category
codesentry scan ./my-project --category security

# Show help
codesentry help
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Clean — no findings |
| 1 | Findings detected |
| 2 | Error during scan |

## Supported Languages

- **JavaScript** (.js, .jsx, .mjs, .cjs)
- **TypeScript** (.ts, .tsx, .mts, .cts)
- **Python** (.py, .pyw)

## Static Analyzers

CodeSentry wraps external CLI tools for comprehensive analysis:

| Analyzer | Languages | Install |
|----------|-----------|---------|
| ESLint | JS/TS | `npm install -g eslint` |
| TypeScript | TS | `npm install -g typescript` |
| Ruff | Python | `pip install ruff` |
| Bandit | Python | `pip install bandit` |
| Semgrep | All | `pip install semgrep` |

Missing tools produce warnings, not errors. CodeSentry continues with available analyzers.

## Custom Analyzers

CodeSentry includes built-in pattern-based detection:

### Bugs (`src/analyzers/custom/bugs.js`)
- Empty catch blocks / swallowed errors
- Assignment in conditions (`if (x = y)`)
- Loose equality (`==` vs `===`)
- Off-by-one errors
- Unreachable code
- Always-true/false conditions
- Duplicate conditions

### Efficiency (`src/analyzers/custom/efficiency.js`)
- Nested loop O(n²) patterns
- String concatenation in loops
- Synchronous blocking calls in async contexts
- Regex compilation inside loops
- Repeated array traversals

### Resources (`src/analyzers/custom/resources.js`)
- `setInterval` without `clearInterval`
- Event listeners without `removeEventListener`
- Streams without `.close()`
- Python `open()` without `with` statement
- Unbounded caches/collections

## AI Configuration

Set `ANTHROPIC_API_KEY` in your `.env` file to enable AI analysis for:
- Ambiguous findings
- False-positive reduction
- Contextual explanations
- Complex bug analysis

Without an API key, CodeSentry uses deterministic analysis only.

## Ignore Configuration

Create `.codesentryignore` in your project root. Patterns are one per line:

```
node_modules/
dist/
*.min.js
```

See `.codesentryignore` in this repo for examples.

## Output

Terminal output format:

```
SEVERITY  FILE:LINE

Problem description
Why it matters

Fix: Suggested remediation
```

## Development

```bash
# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run integration tests only
npm run test:integration
```

## Architecture

```
bin/codesentry.js          CLI entry point
src/core/                  Orchestration (scan, config, scoring, verdict)
src/discovery/             File discovery, language detection, ignore patterns
src/analyzers/static/      External tool wrappers (ESLint, Ruff, etc.)
src/analyzers/custom/      Built-in pattern detection (bugs, efficiency, resources)
src/analyzers/ai/          Optional AI analysis (Anthropic)
src/findings/              Normalization, deduplication, schema
src/cli/                   Terminal output, progress, formatting
tests/                     Unit, integration, and analyzer tests
```

## License

MIT
