import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface DeviceCredentials {
  relayUrl: string;
  deviceId: string;
  deviceToken: string;
  name: string;
  pairedAt: string;
}

interface CredentialFileOperations {
  openSync: typeof openSync;
  writeFileSync: typeof writeFileSync;
  fsyncSync: typeof fsyncSync;
  closeSync: typeof closeSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
}

const FILE_OPERATIONS: CredentialFileOperations = { openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync };
const RENAME_RETRIES = 5;
const RENAME_RETRY_DELAY_MS = 40;

function isCredential(value: unknown): value is DeviceCredentials {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return ['relayUrl', 'deviceId', 'deviceToken', 'name', 'pairedAt'].every((key) => typeof candidate[key] === 'string' && candidate[key] !== '');
}

export class CredentialStore {
  private readonly credentialFile: string;
  private readonly operations: CredentialFileOperations;

  constructor(private readonly homeDir: string, operations: Partial<CredentialFileOperations> = {}) {
    this.credentialFile = path.join(homeDir, 'device.json');
    this.operations = { ...FILE_OPERATIONS, ...operations };
  }

  load(): DeviceCredentials | null {
    let contents: string;
    try { contents = readFileSync(this.credentialFile, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Cannot read saved Agent credentials.', { cause: error });
    }
    let value: unknown;
    try { value = JSON.parse(contents); }
    catch { throw new Error('Invalid saved Agent credentials.'); }
    if (!isCredential(value)) throw new Error('Invalid saved Agent credentials.');
    return value;
  }

  save(credentials: DeviceCredentials): void {
    mkdirSync(this.homeDir, { recursive: true });
    const temporaryFile = path.join(this.homeDir, `.device-${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = this.operations.openSync(temporaryFile, 'wx', 0o600);
      this.operations.writeFileSync(descriptor, JSON.stringify(credentials, null, 2), 'utf8');
      this.operations.fsyncSync(descriptor);
      this.operations.closeSync(descriptor);
      descriptor = undefined;
      try { chmodSync(temporaryFile, 0o600); } catch { /* windows */ }
      this.replaceWithRetry(temporaryFile);
    } catch (error) {
      if (descriptor !== undefined) this.operations.closeSync(descriptor);
      try { this.operations.unlinkSync(temporaryFile); } catch { /* already removed */ }
      throw error;
    }
  }

  private replaceWithRetry(temporaryFile: string): void {
    for (let attempt = 0; ; attempt++) {
      try {
        this.operations.renameSync(temporaryFile, this.credentialFile);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= RENAME_RETRIES || !['EBUSY', 'EPERM', 'EACCES'].includes(code ?? '')) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_DELAY_MS);
      }
    }
  }
}
