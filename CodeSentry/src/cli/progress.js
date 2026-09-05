const PROGRESS_STATES = {
  STARTED: 'started',
  DISCOVERING: 'discovering',
  ANALYZING: 'analyzing',
  PROCESSING: 'processing',
  AI_ANALYSIS: 'ai_analysis',
  GENERATING: 'generating',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

const PROGRESS_MESSAGES = {
  [PROGRESS_STATES.STARTED]: 'Scan started',
  [PROGRESS_STATES.DISCOVERING]: 'Discovering repository...',
  [PROGRESS_STATES.ANALYZING]: 'Running analysis...',
  [PROGRESS_STATES.PROCESSING]: 'Processing findings...',
  [PROGRESS_STATES.AI_ANALYSIS]: 'Running AI analysis...',
  [PROGRESS_STATES.GENERATING]: 'Generating report...',
  [PROGRESS_STATES.COMPLETED]: 'Scan completed',
  [PROGRESS_STATES.FAILED]: 'Scan failed',
};

class ProgressTracker {
  constructor(options = {}) {
    this.verbose = options.verbose || false;
    this.jsonMode = options.jsonMode || false;
    this.currentState = null;
    this.steps = [];
    this.startTime = Date.now();
  }

  start() {
    this.currentState = PROGRESS_STATES.STARTED;
    this.log(PROGRESS_MESSAGES[PROGRESS_STATES.STARTED]);
  }

  update(state, message) {
    if (!PROGRESS_MESSAGES[state]) {
      throw new Error(`Invalid progress state: "${state}"`);
    }
    
    this.currentState = state;
    const step = {
      state,
      message: message || PROGRESS_MESSAGES[state],
      timestamp: Date.now(),
    };
    this.steps.push(step);
    
    if (this.verbose && !this.jsonMode) {
      this.log(`✓ ${step.message}`);
    }
  }

  warn(message) {
    if (this.verbose && !this.jsonMode) {
      this.log(`⚠ ${message}`);
    }
  }

  error(message) {
    if (!this.jsonMode) {
      this.log(`✖ ${message}`);
    }
  }

  complete(success = true) {
    this.currentState = success ? PROGRESS_STATES.COMPLETED : PROGRESS_STATES.FAILED;
    const message = success ? PROGRESS_MESSAGES[PROGRESS_STATES.COMPLETED] : PROGRESS_MESSAGES[PROGRESS_STATES.FAILED];
    
    if (this.verbose && !this.jsonMode) {
      this.log(`✓ ${message}`);
    }
    
    return this.getSummary();
  }

  getSummary() {
    const duration = Date.now() - this.startTime;
    return {
      steps: this.steps,
      duration,
      success: this.currentState === PROGRESS_STATES.COMPLETED,
    };
  }

  log(message) {
    if (!this.jsonMode) {
      console.error(message);
    }
  }
}

function createProgressTracker(options = {}) {
  return new ProgressTracker(options);
}

module.exports = {
  PROGRESS_STATES,
  PROGRESS_MESSAGES,
  ProgressTracker,
  createProgressTracker,
};