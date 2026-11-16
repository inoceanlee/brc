import { lstatSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { CredentialStore } from './credential-store.js';

export function migrateCredentialFile(legacyFile: string, destinationDirectory: string): boolean {
  try {
    const information = lstatSync(legacyFile);
    if (!information.isFile() || information.isSymbolicLink()) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const legacyStore = new CredentialStore(path.dirname(legacyFile));
  let credentials;
  try { credentials = legacyStore.load(); }
  catch (error) {
    if (error instanceof Error && error.message === 'Invalid saved Agent credentials.') return false;
    throw error;
  }
  if (!credentials) return false;
  const target = path.join(destinationDirectory, 'device.json');
  try {
    lstatSync(target);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const targetStore = new CredentialStore(destinationDirectory);
  targetStore.save(credentials);
  const verified = targetStore.load();
  if (!verified || JSON.stringify(verified) !== JSON.stringify(credentials)) {
    throw new Error('Migrated device credentials failed verification.');
  }
  unlinkSync(legacyFile);
  return true;
}
