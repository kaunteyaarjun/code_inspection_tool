#!/usr/bin/env node

const { createCommandParser, COMMANDS } = require('../src/cli/commands');
const { createOutputHandler, OUTPUT_MODES } = require('../src/cli/output');
const { createProgressTracker, PROGRESS_STATES } = require('../src/cli/progress');
const { createFormatter } = require('../src/cli/formatter');
const { scan } = require('../src/core/scan');

async function main() {
  const parser = createCommandParser();
  const parsed = parser.parse(process.argv.slice(2));
  const validation = parser.validate(parsed);
  
  if (!validation.valid) {
    const output = createOutputHandler({ mode: OUTPUT_MODES.TERMINAL });
    output.printError('Error:');
    for (const error of validation.errors) {
      output.printError(`  ${error}`);
    }
    process.exit(2);
  }

  if (parsed.command === COMMANDS.HELP) {
    const output = createOutputHandler({ mode: OUTPUT_MODES.TERMINAL });
    output.print(parser.getHelp());
    process.exit(0);
  }

  if (parsed.command === COMMANDS.VERSION) {
    const output = createOutputHandler({ mode: OUTPUT_MODES.TERMINAL });
    output.print(parser.getVersion());
    process.exit(0);
  }

  if (parsed.command === COMMANDS.SCAN) {
    const jsonMode = parsed.options.json || false;
    const verbose = parsed.options.verbose || false;
    
    const output = createOutputHandler({ 
      mode: jsonMode ? OUTPUT_MODES.JSON : OUTPUT_MODES.TERMINAL 
    });
    
    const progress = createProgressTracker({ 
      verbose, 
      jsonMode 
    });
    
    const formatter = createFormatter();
    
    progress.start();
    
    try {
      progress.update(PROGRESS_STATES.DISCOVERING);
      
      const scanOptions = {
        projectPath: parsed.projectPath,
        jsonMode,
        verbose,
      };
      
      if (parsed.options.severity) {
        scanOptions.severityThreshold = parsed.options.severity.toUpperCase();
      }
      
      if (parsed.options.category) {
        scanOptions.categoryFilter = parsed.options.category.toLowerCase();
      }
      
      const result = await scan(parsed.projectPath, scanOptions);
      
      progress.update(PROGRESS_STATES.COMPLETED);
      const progressSummary = progress.complete(true);
      
      if (jsonMode) {
        output.printJSON(result);
      } else {
        output.print('');
        output.printBox(['CODESENTRY'], { width: 40, title: '' });
        output.print('');
        
        const summaryLines = formatter.formatSummary(result);
        for (const line of summaryLines) {
          output.print(line);
        }
        
        output.print('');
        output.printSeparator();
        output.print('');
        
        const findingLines = formatter.formatFindings(result.findings, { 
          limit: 10, 
          showDetails: true 
        });
        for (const line of findingLines) {
          output.print(line);
        }
        
        output.print('');
        output.print(`Completed in ${result.metadata.duration}ms`);
      }
      
      // Determine exit code based on findings
      let exitCode = 0;
      if (result.metadata.errors.length > 0) {
        exitCode = 2;
      } else if (result.aggregation.total > 0) {
        exitCode = 1;
      }
      
      process.exit(exitCode);
      
    } catch (err) {
      progress.error(`Scan failed: ${err.message}`);
      progress.complete(false);
      
      if (!jsonMode) {
        output.printError(`\nScan failed: ${err.message}\n`);
      } else {
        output.printJSON({ 
          error: err.message,
          success: false 
        });
      }
      
      process.exit(2);
    }
  }
}

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('Unhandled exception:', err.message);
  process.exit(2);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err.message || err);
  process.exit(2);
});

main();