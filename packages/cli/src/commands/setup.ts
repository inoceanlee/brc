import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export { allowsInteractiveInput } from '../adapters/terminal/interaction.js';
import { allowsInteractiveInput, type InteractiveTerminal } from '../adapters/terminal/interaction.js';
import { UsageError } from './parser.js';

export interface AdministratorPrompt {
  askUsername(signal?: AbortSignal): Promise<string>;
  askHiddenPassword(label: string, signal?: AbortSignal): Promise<string>;
}

/** Validate credentials before creating a persistent Relay identity. */
export function validateAdministratorPassword(password: string, confirmation?: string): void {
  if (confirmation !== undefined && password !== confirmation) {
    throw new Error('Administrator passwords do not match. Run brc setup again.');
  }
  if (password.length < 8) {
    throw new Error('Administrator password must contain at least 8 characters.');
  }
}

export async function collectAdministratorCredentials(
  env: NodeJS.ProcessEnv,
  interactive: boolean,
  prompt: AdministratorPrompt,
  signal?: AbortSignal,
): Promise<{ username: string; password: string }> {
  signal?.throwIfAborted();
  const suppliedPassword = env.BRC_ADMIN_PASSWORD;
  if (suppliedPassword === undefined && !interactive) {
    throw new UsageError(
      'Non-interactive setup requires BRC_ADMIN_PASSWORD. Set BRC_ADMIN_PASSWORD or run brc setup without --no-input.',
      'brc help setup',
    );
  }
  let username = env.BRC_ADMIN_USER?.trim();
  if (!username && interactive) username = (await prompt.askUsername(signal)).trim();
  username ||= 'admin';
  let password = suppliedPassword;
  if (password === undefined) {
    password = await prompt.askHiddenPassword('Administrator password (hidden): ', signal);
    const confirmation = await prompt.askHiddenPassword('Confirm administrator password (hidden): ', signal);
    validateAdministratorPassword(password, confirmation);
  } else {
    validateAdministratorPassword(password);
  }
  return { username, password };
}

export interface RequestAdministratorOptions extends Pick<InteractiveTerminal, 'interactive' | 'noInput'> {
  signal?: AbortSignal;
}

export async function requestAdministrator(options: RequestAdministratorOptions = {}): Promise<{ username: string; password: string }> {
  const interactive = allowsInteractiveInput({
    stdinTTY: Boolean(process.stdin.isTTY),
    stdoutTTY: Boolean(process.stdout.isTTY),
    stderrTTY: Boolean(process.stderr.isTTY),
    ci: process.env.CI === 'true',
    interactive: options.interactive,
    noInput: options.noInput,
  });
  return collectAdministratorCredentials(process.env, interactive, {
    async askUsername(signal): Promise<string> {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try { return await rl.question('Administrator username [admin]: ', { signal }); }
      finally { rl.close(); }
    },
    async askHiddenPassword(label: string, signal): Promise<string> {
      const silentOutput = new Writable({ write(_chunk, _encoding, done) { done(); } });
      const rl = createInterface({ input: process.stdin, output: silentOutput, terminal: true });
      try {
        process.stderr.write(label);
        return await rl.question('', { signal });
      } finally {
        rl.close();
        process.stderr.write('\n');
      }
    },
  }, options.signal);
}
