/**
 * REPL and Process State Detection Utilities
 * Detects when processes are waiting for input vs finished vs running
 */

export interface ProcessState {
  isWaitingForInput: boolean;
  isFinished: boolean;
  isRunning: boolean;
  detectedPrompt?: string;
  lastOutput: string;
}


const REPL_PROMPTS = {
  python: ['>>> ', '... '],
  node: ['> ', '... '],
  r: ['> ', '+ '],
  julia: ['julia> ', '       '],
  shell: ['$ ', '# ', '% ', 'bash-', 'zsh-'],
  mysql: ['mysql> ', '    -> '],
  postgres: ['=# ', '-# '],
  redis: ['redis> '],
  mongo: ['> ', '... ']
};


const ERROR_COMPLETION_PATTERNS = [
  /Error:/i,
  /Exception:/i,
  /Traceback/i,
  /SyntaxError/i,
  /NameError/i,
  /TypeError/i,
  /ValueError/i,
  /ReferenceError/i,
  /Uncaught/i,
  /at Object\./i,
  /^\s*\^/m       
];


const COMPLETION_INDICATORS = [
  /Process finished/i,
  /Command completed/i,
  /\[Process completed\]/i,
  /Program terminated/i,
  /Exit code:/i
];

/**
 * Analyze process output to determine current state
 */
export function analyzeProcessState(output: string, pid?: number): ProcessState {
  if (!output || output.trim().length === 0) {
    return {
      isWaitingForInput: false,
      isFinished: false,
      isRunning: true,
      lastOutput: output
    };
  }

  const lines = output.split('\n');
  const lastLine = lines[lines.length - 1] || '';
  const lastFewLines = lines.slice(-3).join('\n');


  const allPrompts = Object.values(REPL_PROMPTS).flat();
  const detectedPrompt = allPrompts.find(prompt => 
    lastLine.endsWith(prompt) || lastLine.includes(prompt)
  );

  if (detectedPrompt) {
    return {
      isWaitingForInput: true,
      isFinished: false,
      isRunning: true,
      detectedPrompt,
      lastOutput: output
    };
  }


  const hasCompletionIndicator = COMPLETION_INDICATORS.some(pattern => 
    pattern.test(output)
  );

  if (hasCompletionIndicator) {
    return {
      isWaitingForInput: false,
      isFinished: true,
      isRunning: false,
      lastOutput: output
    };
  }


  const hasErrorCompletion = ERROR_COMPLETION_PATTERNS.some(pattern => 
    pattern.test(lastFewLines)
  );

  if (hasErrorCompletion) {

    if (detectedPrompt) {
      return {
        isWaitingForInput: true,
        isFinished: false,
        isRunning: true,
        detectedPrompt,
        lastOutput: output
      };
    } else {
      return {
        isWaitingForInput: false,
        isFinished: true,
        isRunning: false,
        lastOutput: output
      };
    }
  }


  return {
    isWaitingForInput: false,
    isFinished: false,
    isRunning: true,
    lastOutput: output
  };
}

/**
 * Clean output by removing prompts and input echoes
 */
export function cleanProcessOutput(output: string, inputSent?: string): string {
  let cleaned = output;


  if (inputSent) {
    const inputLines = inputSent.split('\n');
    inputLines.forEach(line => {
      if (line.trim()) {
        cleaned = cleaned.replace(new RegExp(`^${escapeRegExp(line.trim())}\\s*\n?`, 'm'), '');
      }
    });
  }


  cleaned = cleaned.replace(/^>>>\s*/gm, '');  
  cleaned = cleaned.replace(/^>\s*/gm, '');    
  cleaned = cleaned.replace(/^\.{3}\s*/gm, ''); 
  cleaned = cleaned.replace(/^\+\s*/gm, '');   


  cleaned = cleaned.replace(/\n>>>\s*$/, '');
  cleaned = cleaned.replace(/\n>\s*$/, '');
  cleaned = cleaned.replace(/\n\+\s*$/, '');

  return cleaned.trim();
}

/**
 * Escape special regex characters
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Format process state for user display
 */
export function formatProcessStateMessage(state: ProcessState, pid: number): string {
  if (state.isWaitingForInput) {
    return `Process ${pid} is waiting for input${state.detectedPrompt ? ` (detected: "${state.detectedPrompt.trim()}")` : ''}`;
  } else if (state.isFinished) {
    return `Process ${pid} has finished execution`;
  } else {
    return `Process ${pid} is running`;
  }
}
