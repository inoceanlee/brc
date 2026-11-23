import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type { ManagedServiceSpec } from '../process/controller.js';

export interface PendingPairing {
  userCode: string;
  clientName: string;
  expiresAt: number;
}

export class RelayDatabase {
  constructor(
    private readonly file: string,
    private readonly relay: Pick<ManagedServiceSpec, 'entrypoint' | 'cwd' | 'env'>,
  ) {}

  exists(): boolean {
    return existsSync(this.file);
  }

  private regularFile(filename: string): boolean {
    if (!existsSync(filename)) return false;
    const info = lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Relay setup path is not a regular file: ${filename}`);
    }
    return true;
  }

  private discardStaging(): void {
    const staging = `${this.file}.initializing`;
    for (const filename of [staging, `${staging}-wal`, `${staging}-shm`, `${staging}-journal`]) {
      if (this.regularFile(filename)) unlinkSync(filename);
    }
  }

  initializeForNewRoot(rootWasEmpty: boolean, administrator?: { username: string; password: string }): void {
    const marker = `${this.file}.setup-pending`;
    const staging = `${this.file}.initializing`;

    if (this.exists()) {
      if (this.regularFile(marker)) {
        this.discardStaging();
        unlinkSync(marker);
      }
      return;
    }
    const retry = this.regularFile(marker);
    if (!rootWasEmpty && !retry) {
      throw new Error(`Relay database is missing at ${this.file}; refusing to create a replacement identity in an existing data root.`);
    }
    if (!administrator) throw new Error('Administrator credentials are required for first setup.');
    if (!retry) {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(marker, '', { flag: 'wx', mode: 0o600 });
    }

    this.discardStaging();
    try {
      const result = spawnSync(process.execPath, [this.relay.entrypoint, '--initialize'], {
        cwd: this.relay.cwd,
        env: { ...this.relay.env, BRC_DB: staging },
        encoding: 'utf8',
        input: JSON.stringify(administrator),
        timeout: 10_000,
        windowsHide: true,
      });
      if (result.error) throw new Error(`Unable to initialize Relay database: ${result.error.message}`);
      if (result.status !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || `Relay database initializer exited with code ${result.status ?? 'unknown'}.`;
        throw new Error(detail);
      }
      if (!this.regularFile(staging)) throw new Error('Relay initializer did not create its staging database.');
      if (this.exists()) throw new Error('A Relay database appeared during setup; refusing to replace it.');
      renameSync(staging, this.file);
      this.discardStaging();
      unlinkSync(marker);
    } catch (error) {
      this.discardStaging();
      throw error;
    }
    this.assertExists();
  }

  assertExists(): void {
    if (!this.exists()) {
      throw new Error(`Relay database is missing at ${this.file}; run brc setup for a new data root or restore the existing database.`);
    }
  }

  pendingPairings(): PendingPairing[] {
    if (!this.exists()) return [];
    const connection = new DatabaseSync(this.file, { readOnly: true });
    try {
      const rows = connection.prepare(
        'SELECT user_code, client_name, expires_at FROM device_codes WHERE approved = 0 AND denied = 0 AND expires_at > ? ORDER BY created_at DESC',
      ).all(Date.now()) as Array<{ user_code: string; client_name: string; expires_at: number }>;
      return rows.map((row) => ({ userCode: row.user_code, clientName: row.client_name, expiresAt: row.expires_at }));
    } finally {
      connection.close();
    }
  }
}
