export interface InteractiveTerminal {
  stdinTTY: boolean;
  stdoutTTY?: boolean;
  stderrTTY: boolean;
  ci?: boolean;
  interactive?: boolean;
  noInput?: boolean;
}

export function allowsInteractiveInput(options: InteractiveTerminal): boolean {
  return options.stdinTTY && options.stderrTTY
    && !options.noInput && (!options.ci || options.interactive === true);
}
