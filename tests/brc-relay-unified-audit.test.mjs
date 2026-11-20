import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayAuditLog, RELAY_DIAGNOSTICS_SCHEMA_VERSION } from '../packages/relay/dist/adapters/storage/relay-audit.js';
import { importLegacyIdentityDatabase } from '../packages/relay/dist/adapters/storage/legacy-import.js';
import { SqliteStore } from '../packages/relay/dist/adapters/storage/sqlite.js';

const tempDirectory = () => mkdtempSync(path.join(os.tmpdir(), 'brc-relay-compliance-'));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function createLegacyIdentity(file) {
  SqliteStore.initialize(file);
  const store = SqliteStore.open(file);
  try {
    store.bootstrapAdministrator('admin', 'legacy-password');
    const user = store.getUserByName('admin');
    const deviceToken = store.issueDeviceToken('dev-legacy', user.id, 'Legacy PC', 'win32');
    const accessHash = sha256('legacy-access');
    store.insertToken({
      token_hash: accessHash, kind: 'access', client_id: 'client', user_id: user.id,
      scopes: 'mcp:tools', resource: null, expires_at: Date.now() + 60_000,
      created_at: Date.now(), revoked: 0,
    });
    return { userId: user.id, deviceToken, accessHash, passwordHash: user.password_hash };
  } finally {
    store.close();
  }
}

function legacySnapshot(file) {
  const db = new DatabaseSync(file);
  try {
    return {
      users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
      devices: db.prepare('SELECT COUNT(*) n FROM devices').get().n,
      tokens: db.prepare('SELECT COUNT(*) n FROM tokens').get().n,
    };
  } finally {
    db.close();
  }
}

test('relay audit writes to the unified SQLite store and keeps business queries', async () => {
  const directory = tempDirectory();
  try {
    const identityFile = path.join(directory, 'relay.sqlite');
    const audit = RelayAuditLog.open({ dbFile: identityFile, env: {} });
    try {
      await audit.append({ ts: Date.now(), userId: 'u1', deviceId: 'd1', client: 'c', tool: 'read_file', ok: true, ms: 5 });
      await audit.append({ ts: Date.now(), userId: 'u1', tool: 'write_file', ok: false, ms: 7, error: 'denied' });
      assert.deepEqual(audit.auditStats('u1'), { total: 2, failed: 1, last24h: 2 });
      assert.equal(audit.recentAudit('u1')[0].tool, 'write_file');
      const unified = new DatabaseSync(path.join(directory, 'brc-diagnostics.sqlite'));
      try {
        assert.equal(unified.prepare('SELECT COUNT(*) n FROM relay_audit').get().n, 2);
      } finally {
        unified.close();
      }
      assert.equal(existsSync(identityFile), false, 'audit writes do not create an identity database');
    } finally {
      audit.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy audit rows import row by row into the unified store', async () => {
  const directory = tempDirectory();
  try {
    const legacyFile = path.join(directory, 'old.sqlite');
    const legacy = new DatabaseSync(legacyFile);
    legacy.exec('CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT, device_id TEXT, client TEXT, tool TEXT NOT NULL, args_hash TEXT, ok INTEGER NOT NULL, ms INTEGER, error TEXT)');
    const insert = legacy.prepare('INSERT INTO audit (ts,user_id,device_id,client,tool,args_hash,ok,ms,error) VALUES (?,?,?,?,?,?,?,?,?)');
    insert.run(Date.now() - 1000, 'u1', 'd1', 'c', 'read_file', 'aa', 1, 4, null);
    insert.run(Date.now(), 'u1', 'd2', 'c', 'write_file', 'bb', 0, 6, 'boom');
    legacy.close();

    const audit = RelayAuditLog.open({ dbFile: path.join(directory, 'relay.sqlite'), env: {} });
    try {
      assert.equal(await audit.importLegacyAudit(legacyFile), 2);
      assert.deepEqual(audit.auditStats('u1'), { total: 2, failed: 1, last24h: 2 });
      assert.equal(audit.recentAudit('u1').some((row) => row.error === 'boom'), true);
      const preserved = new DatabaseSync(legacyFile);
      try {
        assert.equal(preserved.prepare('SELECT COUNT(*) n FROM audit').get().n, 2);
        assert.equal(preserved.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='users'").get().n, 0);
      } finally {
        preserved.close();
      }
    } finally {
      audit.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy identity database imports across paths with users devices and tokens intact', () => {
  const directory = tempDirectory();
  try {
    const legacyFile = path.join(directory, 'legacy', 'relay.sqlite');
    const targetFile = path.join(directory, 'new', 'relay.sqlite');
    mkdirSync(path.dirname(legacyFile), { recursive: true });
    const original = createLegacyIdentity(legacyFile);
    const before = legacySnapshot(legacyFile);

    const result = importLegacyIdentityDatabase(legacyFile, targetFile);
    assert.deepEqual({ users: result.users, devices: result.devices, tokens: result.tokens }, before);
    assert.equal(existsSync(targetFile), true);
    assert.equal(existsSync(legacyFile), true);

    const store = SqliteStore.open(targetFile);
    try {
      const user = store.getUser(original.userId);
      assert.equal(user?.password_hash, original.passwordHash);
      assert.equal(store.getDeviceByToken(original.deviceToken)?.device_id, 'dev-legacy');
      assert.ok(store.getToken('legacy-access', 'access'));
      assert.equal(store.getAdministrator().username, 'admin');
      assert.match(store.getSessionSecret(), /^[0-9a-f]{64}$/);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('failed legacy import preserves the source and never creates a replacement identity', () => {
  const directory = tempDirectory();
  try {
    const legacyFile = path.join(directory, 'broken.sqlite');
    const targetFile = path.join(directory, 'new.sqlite');
    const broken = new DatabaseSync(legacyFile);
    broken.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
    broken.close();
    const before = readFileSync(legacyFile);

    assert.throws(() => importLegacyIdentityDatabase(legacyFile, targetFile), /required tables|integrity/i);
    assert.deepEqual(readFileSync(legacyFile), before);
    assert.equal(existsSync(targetFile), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('identity and unified stores record and enforce supported schema versions', async () => {
  const directory = tempDirectory();
  try {
    const identityFile = path.join(directory, 'relay.sqlite');
    SqliteStore.initialize(identityFile);
    const db = new DatabaseSync(identityFile);
    assert.equal(db.prepare("SELECT value FROM brc_meta WHERE key = 'schema_version'").get().value, String(RELAY_DIAGNOSTICS_SCHEMA_VERSION));
    db.prepare("UPDATE brc_meta SET value = '99' WHERE key = 'schema_version'").run();
    db.close();
    assert.throws(() => SqliteStore.open(identityFile), /schema version|unsupported/i);

    const auditFile = path.join(directory, 'other', 'relay.sqlite');
    const audit = RelayAuditLog.open({ dbFile: auditFile, env: {} });
    try {
      assert.equal(audit.schemaVersion, RELAY_DIAGNOSTICS_SCHEMA_VERSION);
      const unified = new DatabaseSync(path.join(directory, 'other', 'brc-diagnostics.sqlite'));
      try {
        assert.equal(unified.prepare("SELECT value FROM relay_schema_meta WHERE key = 'schema_version'").get().value, String(RELAY_DIAGNOSTICS_SCHEMA_VERSION));
      } finally {
        unified.close();
      }
    } finally {
      audit.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('missing legacy candidate still initializes a fresh identity', () => {
  const directory = tempDirectory();
  try {
    const targetFile = path.join(directory, 'relay.sqlite');
    SqliteStore.initialize(targetFile);
    const db = new DatabaseSync(targetFile);
    try {
      assert.equal(db.prepare("SELECT value FROM brc_meta WHERE key = 'schema_version'").get().value, String(RELAY_DIAGNOSTICS_SCHEMA_VERSION));
      assert.equal(db.prepare("SELECT value FROM brc_meta WHERE key = 'admin_bootstrap'").get().value, 'pending');
    } finally {
      db.close();
    }
    const store = SqliteStore.open(targetFile);
    try {
      assert.equal(store.getUserByName('admin'), undefined);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
