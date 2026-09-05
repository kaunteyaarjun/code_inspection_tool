const COMMANDS = {
  SCAN: 'scan',
  VERSION: 'version',
  HELP: 'help',
};

const OPTIONS = {
  JSON: '--json',
  VERBOSE: '--verbose',
  SEVERITY: '--severity',
  CATEGORY: '--category',
  AI: '--ai',
  AI_MODEL: '--ai-model',
  HELP: '--help',
  VERSION: '--version',
};

class CommandParser {
  constructor() {
    this.commands = COMMANDS;
    this.options = OPTIONS;
  }

  parse(args) {
    const result = {
      command: null,
      projectPath: null,
      options: {},
      errors: [],
    };

    if (!args || args.length === 0) {
      result.command = COMMANDS.HELP;
      return result;
    }

    let i = 0;
    
    // Parse command
    const command = args[i];
    if (Object.values(COMMANDS).includes(command)) {
      result.command = command;
      i++;
    } else if (command.startsWith('-')) {
      // It's an option, default to scan command
      result.command = COMMANDS.SCAN;
    } else {
      result.command = COMMANDS.SCAN;
      result.projectPath = command;
      i++;
    }

    // Parse remaining arguments
    while (i < args.length) {
      const arg = args[i];
      
      if (arg === OPTIONS.JSON) {
        result.options.json = true;
        i++;
      } else if (arg === OPTIONS.VERBOSE) {
        result.options.verbose = true;
        i++;
      } else if (arg === OPTIONS.HELP || arg === '-h') {
        result.command = COMMANDS.HELP;
        i++;
      } else if (arg === OPTIONS.VERSION) {
        result.command = COMMANDS.VERSION;
        i++;
      } else if (arg === OPTIONS.SEVERITY) {
        if (i + 1 < args.length) {
          result.options.severity = args[i + 1];
          i += 2;
        } else {
          result.errors.push('Missing value for --severity');
          i++;
        }
      } else if (arg === OPTIONS.CATEGORY) {
        if (i + 1 < args.length) {
          result.options.category = args[i + 1];
          i += 2;
        } else {
          result.errors.push('Missing value for --category');
          i++;
        }
      } else if (arg === OPTIONS.AI) {
        result.options.ai = true;
        i++;
      } else if (arg === OPTIONS.AI_MODEL) {
        if (i + 1 < args.length) {
          result.options.aiModel = args[i + 1];
          i += 2;
        } else {
          result.errors.push('Missing value for --ai-model');
          i++;
        }
      } else if (!arg.startsWith('-') && !result.projectPath) {
        result.projectPath = arg;
        i++;
      } else {
        result.errors.push(`Unknown argument: ${arg}`);
        i++;
      }
    }

    // Default project path
    if (!result.projectPath && result.command === COMMANDS.SCAN) {
      result.projectPath = process.cwd();
    }

    return result;
  }

  validate(parsed) {
    const errors = [...parsed.errors];
    
    if (parsed.command === COMMANDS.SCAN) {
      if (!parsed.projectPath) {
        errors.push('Project path is required');
      }
      
      if (parsed.options.severity) {
        const validSeverities = ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
        if (!validSeverities.includes(parsed.options.severity.toUpperCase())) {
          errors.push(`Invalid severity: "${parsed.options.severity}". Must be one of: ${validSeverities.join(', ')}`);
        }
      }
      
      if (parsed.options.category) {
        const validCategories = ['security', 'bugs', 'efficiency', 'resources'];
        if (!validCategories.includes(parsed.options.category.toLowerCase())) {
          errors.push(`Invalid category: "${parsed.options.category}". Must be one of: ${validCategories.join(', ')}`);
        }
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
    };
  }

  getHelp() {
    return `
Usage: codesentry <command> [options]

Commands:
  scan [path]     Scan the specified project (defaults to cwd)
  version         Show version
  help            Show this help message

Options:
  --json          Output results as JSON
  --verbose       Show detailed progress information
  --severity <level>  Filter by severity (BLOCKER, HIGH, MEDIUM, LOW, INFO)
  --category <cat>    Filter by category (security, bugs, efficiency, resources)
  --ai            Enable AI-powered analysis (auto-selects model based on codebase)
  --ai-model <model>  Force a specific AI model (e.g., nvidia/nemotron-3-super-120b-a12b:free)
  --help, -h      Show this help message
  --version       Show version

Examples:
  codesentry scan ./my-project
  codesentry scan ./my-project --json
  codesentry scan ./my-project --severity high
  codesentry scan ./my-project --category security
  codesentry scan ./my-project --ai
  codesentry scan ./my-project --ai --ai-model nvidia/nemotron-3-ultra-550b-a55b:free
  codesentry version
`;
  }

  getVersion() {
    const pkg = require('../../package.json');
    return `codesentry v${pkg.version}`;
  }
}

function createCommandParser() {
  return new CommandParser();
}

module.exports = {
  COMMANDS,
  OPTIONS,
  CommandParser,
  createCommandParser,
};