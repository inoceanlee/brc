import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RelayDatabase } from '../packages/cli/dist/adapters/storage/relay-database.js';
import { buildRelay } from '../packages/relay/dist/adapters/http/app.js';
import { SqliteStore, hashPassword, verifyPassword, sha256 } from '../packages/relay/dist/adapters/storage/sqlite.js';

const legacySchema = `
CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE oauth_clients (client_id TEXT PRIMARY KEY, client_secret TEXT, metadata TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE auth_codes (code TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL, code_challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT, expires_at INTEGER NOT NULL);
CREATE TABLE tokens (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, user_id TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT, expires_at INTEGER, created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE devices (device_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, platform TEXT, created_at INTEGER NOT NULL, last_seen INTEGER, paused INTEGER NOT NULL DEFAULT 0);
CREATE TABLE device_codes (device_code TEXT PRIMARY KEY, user_code TEXT UNIQUE NOT NULL, client_name TEXT NOT NULL, user_id TEXT, approved INTEGER NOT NULL DEFAULT 0, denied INTEGER NOT NULL DEFAULT 0, device_id TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT, device_id TEXT, client TEXT, tool TEXT NOT NULL, args_hash TEXT, ok INTEGER NOT NULL, ms INTEGER, error TEXT);
CREATE INDEX audit_ts ON audit(ts);
CREATE TABLE api_keys (key_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, prefix TEXT NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER, revoked INTEGER NOT NULL DEFAULT 0);
`;

function createLegacyDatabase(file, { userId = 'admin-id', orphanUserId = null, seedUser = true } = {}) {
  const db = new DatabaseSync(file);
  db.exec(legacySchema);
  if (seedUser) db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(userId, 'admin', hashPassword('password'), 1);
  if (seedUser || orphanUserId) {
    const owner = orphanUserId ?? userId;
    db.prepare('INSERT INTO oauth_clients VALUES (?,?,?,?)').run('client', null, '{}', 1);
    db.prepare('INSERT INTO auth_codes VALUES (?,?,?,?,?,?,?,?)').run('auth-code', 'client', owner, 'challenge', 'https://client.invalid/callback', 'mcp:tools', null, Date.now() + 60_000);
    db.prepare('INSERT INTO tokens VALUES (?,?,?,?,?,?,?,?,?)').run(sha256('legacy-access'), 'access', 'client', owner, 'mcp:tools', null, Date.now() + 60_000, 1, 0);
    db.prepare('INSERT INTO devices VALUES (?,?,?,?,?,?,?,?)').run('device-id', owner, 'Agent', sha256('legacy-device-token'), 'win32', 1, null, 0);
    db.prepare('INSERT INTO device_codes VALUES (?,?,?,?,?,?,?,?,?)').run('approved-code', 'AAAA-BBBB', 'Agent', owner, 1, 0, 'device-id', Date.now() + 60_000, 1);
    db.prepare('INSERT INTO device_codes VALUES (?,?,?,?,?,?,?,?,?)').run('pending-code', 'CCCC-DDDD', 'Agent', null, 0, 0, null, Date.now() + 60_000, 1);
    db.prepare('INSERT INTO api_keys VALUES (?,?,?,?,?,?,?)').run('legacy-key-hash', owner, 'legacy key', 'legacy-key', 1, null, 0);
    db.prepare('INSERT INTO audit (ts,user_id,device_id,client,tool,args_hash,ok,ms,error) VALUES (?,?,?,?,?,?,?,?,?)').run(1, 'historical-user', null, 'client', 'tool', null, 1, null, null);
  }
  db.close();
}

function tempDatabase() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'brc-identity-'));
  return { directory, file: path.join(directory, 'relay.sqlite') };
}

function config(dbFile, sessionSecret = 'shared-session-secret') {
  return {
    port: 0,
    host: '127.0.0.1',
    publicUrl: 'http://127.0.0.1',
    trustProxy: false,
    dbFile,
    sessionSecret,
    adminUser: 'admin',
    adminPassword: 'password',
    audit: { retentionDays: 30, maxEntries: 50_000 },
    relayVersion: 'test',
  };
}

function sessionCookie(userId, secret) {
  const payload = `${userId}.${Date.now() + 60_000}`;
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `brc_session=${payload}.${signature}`;
}

async function listen(relay) {
  await new Promise((resolve, reject) => {
    relay.http.once('error', reject);
    relay.http.listen(0, '127.0.0.1', resolve);
  });
  return relay.http.address().port;
}

async function websocketStatus(port, token) {
  const socket = createConnection({ host: '127.0.0.1', port });
  const key = randomBytes(16).toString('base64');
  return await new Promise((resolve, reject) => {
    let response = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Relay WebSocket handshake timed out'));
    }, 3000);
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('connect', () => socket.write([
      `GET /ws HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      `Authorization: Bearer ${token}`,
      '',
      '',
    ].join('\r\n')));
    socket.on('data', (chunk) => {
      response += chunk.toString('latin1');
      const status = response.match(/^HTTP\/1\.1 (\d+)/)?.[1];
      if (!status) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(Number(status));
    });
  });
}

test('legacy Relay database migration preserves identity and adds restricted user foreign keys', () => {
  const { directory, file } = tempDatabase();
  createLegacyDatabase(file);
  const legacy = new DatabaseSync(file);
  const passwordHash = legacy.prepare('SELECT password_hash FROM users WHERE id = ?').get('admin-id').password_hash;
  const accessTokenHash = legacy.prepare('SELECT token_hash FROM tokens WHERE kind = ?').get('access').token_hash;
  const deviceTokenHash = legacy.prepare('SELECT token_hash FROM devices WHERE device_id = ?').get('device-id').token_hash;
  legacy.close();
  const store = SqliteStore.open(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  try {
    const user = store.getUserByName('admin');
    assert.equal(user.id, 'admin-id');
    assert.equal(user.password_hash, passwordHash);
    assert.equal(store.getDevice('device-id').user_id, 'admin-id');
    assert.equal(db.prepare('SELECT token_hash FROM devices WHERE device_id = ?').get('device-id').token_hash, deviceTokenHash);
    assert.equal(store.getToken('legacy-access', 'access').user_id, 'admin-id');
    assert.equal(db.prepare('SELECT token_hash FROM tokens WHERE kind = ?').get('access').token_hash, accessTokenHash);
    assert.equal(store.peekAuthCode('auth-code').user_id, 'admin-id');
    assert.equal(store.getDeviceCode('pending-code').user_id, null);
    assert.equal(db.prepare('SELECT user_id FROM api_keys').get().user_id, 'admin-id');
    assert.equal(db.prepare('SELECT user_id FROM audit').get().user_id, 'historical-user');
    for (const table of ['devices', 'tokens', 'auth_codes', 'device_codes', 'api_keys']) {
      const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
      assert.ok(foreignKeys.some((foreignKey) => foreignKey.table === 'users' && foreignKey.from === 'user_id' && foreignKey.to === 'id' && foreignKey.on_delete === 'RESTRICT'), `${table} must restrict user deletion`);
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.throws(() => db.prepare('DELETE FROM users WHERE id = ?').run('admin-id'), /FOREIGN KEY constraint failed/);
    assert.throws(() => store.issueDeviceToken('orphan', 'missing-user', 'Agent', 'win32'), /FOREIGN KEY constraint failed/);
    assert.doesNotThrow(() => db.prepare('INSERT INTO device_codes VALUES (?,?,?,?,?,?,?,?,?)').run('new-pending', 'EEEE-FFFF', 'Agent', null, 0, 0, null, Date.now() + 60_000, 1));
  } finally {
    db.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy Relay database with orphaned ownership is backed up and rejected without migration', () => {
  const { directory, file } = tempDatabase();
  createLegacyDatabase(file, { orphanUserId: 'missing-user' });
  let store;
  try {
    assert.throws(() => { store = SqliteStore.open(file); }, /orphan.*auth_codes=1.*tokens=1.*devices=1.*device_codes=1.*api_keys=1/i);
    const backups = readdirSync(directory).filter((name) => name.startsWith('relay.sqlite.pre-identity-migration-'));
    assert.equal(backups.length, 1, 'migration must preserve a backup before reporting orphaned ownership');
    const original = new DatabaseSync(file);
    try {
      assert.equal(original.prepare('SELECT user_id FROM devices').get().user_id, 'missing-user');
      assert.equal(original.prepare('PRAGMA foreign_key_list(devices)').all().length, 0, 'failed migration must leave original schema unchanged');
    } finally {
      original.close();
    }
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test('Relay startup rejects orphaned ownership in an already migrated database', () => {
  const { directory, file } = tempDatabase();
  SqliteStore.initialize(file);
  const store = SqliteStore.open(file);
  const user = store.upsertUser('admin', 'password');
  store.issueDeviceToken('device-id', user.id, 'Agent', 'win32');
  store.close();
  const tampered = new DatabaseSync(file);
  tampered.exec('PRAGMA foreign_keys = OFF;');
  tampered.prepare('UPDATE devices SET user_id = ? WHERE device_id = ?').run('missing-user', 'device-id');
  tampered.close();
  try {
    assert.throws(() => SqliteStore.open(file), /orphaned user references: devices=1/i);
    assert.equal(readdirSync(directory).filter((name) => name.startsWith('relay.sqlite.pre-identity-migration-')).length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Relay refuses a missing database and an existing database without its admin user', () => {
  const { directory } = tempDatabase();
  const missingFile = path.join(directory, 'missing.sqlite');
  const existingFile = path.join(directory, 'existing.sqlite');
  let missingStore;
  let existingStore;
  try {
    assert.throws(() => { missingStore = SqliteStore.open(missingFile); }, /database.*(missing|exist|setup)/i);
    createLegacyDatabase(existingFile, { seedUser: false });
    assert.throws(() => { existingStore = SqliteStore.open(existingFile); }, /admin|administrator|user/i);
  } finally {
    missingStore?.close();
    existingStore?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a signed cookie for a user absent from this database is treated as logged out', async () => {
  const { directory, file } = tempDatabase();
  createLegacyDatabase(file, { userId: 'current-admin-id' });
  const secret = 'shared-session-secret';
  const relay = buildRelay(config(file, secret), () => { });
  try {
    const port = await listen(relay);
    const stale = await fetch(`http://127.0.0.1:${port}/admin`, { redirect: 'manual', headers: { cookie: sessionCookie('old-database-user-id', secret) } });
    assert.equal(stale.status, 302);
    assert.match(stale.headers.get('location'), /^\/auth\/login/);
    const current = await fetch(`http://127.0.0.1:${port}/admin`, { headers: { cookie: sessionCookie('current-admin-id', secret) } });
    assert.equal(current.status, 200);
  } finally {
    await relay.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Relay rejects a device WebSocket whose stored owner no longer exists', async () => {
  const { directory, file } = tempDatabase();
  createLegacyDatabase(file, { userId: 'current-admin-id' });
  const relay = buildRelay(config(file), () => { });
  try {
    const token = 'orphan-device-token';
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA foreign_keys = OFF');
      db.prepare('INSERT INTO devices (device_id,user_id,name,token_hash,platform,created_at,last_seen,paused) VALUES (?,?,?,?,?,?,?,?)')
        .run('orphan-device', 'missing-user', 'Orphan', sha256(token), 'win32', Date.now(), null, 0);
    } finally {
      db.close();
    }
    const port = await listen(relay);
    assert.equal(await websocketStatus(port, token), 401);
  } finally {
    await relay.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test('setup initializes a fresh Relay identity once and rejects a missing database in an existing data root', () => {
  const { directory, file } = tempDatabase();
  const env = {
    ...process.env,
    BRC_DB: file,
    BRC_LOG_FILE: path.join(directory, 'relay.log'),
    BRC_LOG_ROTATE_MIB: '1',
  };
  delete env.BRC_ADMIN_PASSWORD;
  const database = new RelayDatabase(file, {
    entrypoint: path.resolve('packages/relay/dist/cli.js'),
    cwd: process.cwd(),
    env,
  });
  try {
    assert.throws(() => database.initializeForNewRoot(false), /existing.*data root/i);
    assert.equal(existsSync(file), false);
    database.initializeForNewRoot(true, { username: 'admin', password: 'password' });
    assert.equal(existsSync(file), true);
    const store = SqliteStore.open(file);
    let first;
    try {
      first = store.upsertUser('admin', 'password');
      const second = store.upsertUser('admin', 'password');
      assert.equal(second.id, first.id);
      assert.equal(second.password_hash, first.password_hash);
    } finally {
      store.close();
    }
    database.initializeForNewRoot(false);
    const reopened = SqliteStore.open(file);
    try {
      assert.equal(reopened.getUserByName('admin').id, first.id);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('setup discards incomplete staging and rebuilds a clean identity', () => {
  const { directory, file } = tempDatabase();
  const stage = `${file}.initializing`;
  const marker = `${file}.setup-pending`;
  SqliteStore.initialize(stage);
  writeFileSync(marker, '');
  const database = new RelayDatabase(file, {
    entrypoint: path.resolve('packages/relay/dist/cli.js'),
    cwd: process.cwd(),
    env: { ...process.env, BRC_DB: file },
  });
  try {
    database.initializeForNewRoot(false, { username: 'alice', password: 'new-test-password' });
    assert.equal(existsSync(stage), false);
    assert.equal(existsSync(marker), false);
    const store = SqliteStore.open(file);
    try {
      assert.equal(store.getAdministrator().username, 'alice');
      assert.match(store.getSessionSecret(), /^[a-f0-9]{64}$/);
    } finally { store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('failed first setup keeps retry marker and never creates a live identity', () => {
  const { directory, file } = tempDatabase();
  const entrypoint = path.resolve('packages/relay/dist/cli.js');
  try {
    const broken = new RelayDatabase(file, {
      entrypoint: path.join(directory, 'missing-entrypoint.js'),
      cwd: process.cwd(),
      env: { ...process.env, BRC_DB: file },
    });
    assert.throws(() => broken.initializeForNewRoot(true, { username: 'alice', password: 'new-test-password' }));
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(`${file}.initializing`), false);
    assert.equal(existsSync(`${file}.setup-pending`), true);

    const repaired = new RelayDatabase(file, { entrypoint, cwd: process.cwd(), env: { ...process.env, BRC_DB: file } });
    repaired.initializeForNewRoot(false, { username: 'alice', password: 'new-test-password' });
    assert.equal(existsSync(`${file}.setup-pending`), false);
    const store = SqliteStore.open(file);
    try { assert.equal(store.getAdministrator().username, 'alice'); }
    finally { store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('completed identity survives stale setup files without replacement', () => {
  const { directory, file } = tempDatabase();
  const database = new RelayDatabase(file, {
    entrypoint: path.resolve('packages/relay/dist/cli.js'), cwd: process.cwd(), env: { ...process.env, BRC_DB: file },
  });
  try {
    database.initializeForNewRoot(true, { username: 'alice', password: 'initial-secret' });
    const original = SqliteStore.open(file);
    let identity;
    try { identity = { id: original.getAdministrator().id, secret: original.getSessionSecret() }; }
    finally { original.close(); }
    writeFileSync(`${file}.setup-pending`, '');
    writeFileSync(`${file}.initializing`, 'partial');
    database.initializeForNewRoot(false);
    const reopened = SqliteStore.open(file);
    try {
      assert.equal(reopened.getAdministrator().id, identity.id);
      assert.equal(reopened.getSessionSecret(), identity.secret);
      assert.equal(existsSync(`${file}.setup-pending`), false);
      assert.equal(existsSync(`${file}.initializing`), false);
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('invalid administrator bootstrap input leaves the database absent', () => {
  for (const input of ['{invalid-json', JSON.stringify({ username: 'alice', password: 'short' })]) {
    const { directory, file } = tempDatabase();
    try {
      const result = spawnSync(process.execPath, [path.resolve('packages/relay/dist/cli.js'), '--initialize'], {
        cwd: process.cwd(),
        env: { ...process.env, BRC_DB: file, BRC_LOG_FILE: path.join(directory, 'relay.log') },
        input,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
      });
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(file), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test('first setup persists administrator hash and session key for subsequent password-free starts', () => {
  const { directory, file } = tempDatabase();
  const env = { ...process.env, BRC_DB: file };
  delete env.BRC_ADMIN_PASSWORD;
  const database = new RelayDatabase(file, {
    entrypoint: path.resolve('packages/relay/dist/cli.js'),
    cwd: process.cwd(),
    env,
  });
  try {
    database.initializeForNewRoot(true, { username: 'alice', password: 'test-private-password' });
    const first = SqliteStore.open(file);
    let userId;
    let hash;
    let secret;
    try {
      const user = first.getAdministrator();
      userId = user.id;
      hash = user.password_hash;
      secret = first.getSessionSecret();
      assert.equal(user.username, 'alice');
      assert.equal(verifyPassword('test-private-password', hash), true);
      assert.notEqual(hash, 'test-private-password');
      assert.match(secret, /^[0-9a-f]{64}$/);
      assert.throws(() => first.bootstrapAdministrator('mallory', 'new-password'), /already|initialized|complete/i);
    } finally { first.close(); }

    database.initializeForNewRoot(false);
    const reopened = SqliteStore.open(file);
    try {
      assert.equal(reopened.getAdministrator().id, userId);
      assert.equal(reopened.getAdministrator().password_hash, hash);
      assert.equal(reopened.getSessionSecret(), secret);
    } finally { reopened.close(); }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('browser login survives password-free Relay restart using the stored session secret', async () => {
  const { directory, file } = tempDatabase();
  SqliteStore.initialize(file);
  const store = SqliteStore.open(file);
  try { store.bootstrapAdministrator('alice', 'test-private-password'); }
  finally { store.close(); }
  const configWithoutSecrets = { ...config(file, ''), adminUser: 'ignored', adminPassword: '' };
  let relay;
  try {
    relay = buildRelay(configWithoutSecrets, () => { });
    const port = await listen(relay);
    const response = await fetch(`http://127.0.0.1:${port}/auth/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: 'alice', password: 'test-private-password', returnTo: '/admin' }),
      redirect: 'manual',
    });
    assert.equal(response.status, 302);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie?.startsWith('brc_session='));
    await relay.close();
    relay = null;

    relay = buildRelay(configWithoutSecrets, () => { });
    const restartedPort = await listen(relay);
    const home = await fetch(`http://127.0.0.1:${restartedPort}/admin`, {
      headers: { cookie },
      redirect: 'manual',
    });
    assert.equal(home.status, 200);
  } finally {
    await relay?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('start and restart reject a missing Relay database without creating one', () => {
  const cliEntrypoint = path.resolve('packages/cli/dist/cli.js');
  for (const command of ['start', 'restart']) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'brc-missing-relay-db-'));
    try {
      const result = spawnSync(process.execPath, [cliEntrypoint, command], {
        cwd: process.cwd(),
        env: { ...process.env, BRC_DATA_ROOT: root, BRC_ADMIN_PASSWORD: 'test-only' },
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      });
      assert.equal(result.status, 1, `${command}: ${result.stderr}`);
      assert.match(`${result.stdout}${result.stderr}`, /Relay database is missing.*brc setup/i);
      assert.equal(existsSync(path.join(root, 'data', 'relay.sqlite')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
function addAudit(store, ts, tool = 'test') {
  store.audit({
    ts,
    user_id: 'admin-id',
    device_id: null,
    client: 'test-client',
    tool,
    args_hash: null,
    ok: 1,
    ms: 1,
    error: null,
  });
}

test('audit housekeeping enforces zero, one, 50000 and 50001 row boundaries', () => {
  const store = SqliteStore.open(':memory:');
  const policy = { retentionDays: 30, maxEntries: 50_000 };
  try {
    store.vacuumExpired(policy);
    assert.equal(store.auditStats('admin-id').total, 0);

    const now = Date.now();
    addAudit(store, now, 'first');
    store.vacuumExpired(policy);
    assert.equal(store.auditStats('admin-id').total, 1);

    for (let index = 1; index < 50_000; index += 1) addAudit(store, now + index, `entry-${index}`);
    store.vacuumExpired(policy);
    assert.equal(store.auditStats('admin-id').total, 50_000);

    addAudit(store, now + 50_000, 'newest');
    store.vacuumExpired(policy);
    assert.equal(store.auditStats('admin-id').total, 50_000);
    assert.equal(store.recentAudit('admin-id', 1)[0].tool, 'newest');
  } finally {
    store.close();
  }
});

test('audit housekeeping enforces maxEntries when excess exceeds one cleanup batch', () => {
  const store = SqliteStore.open(':memory:');
  try {
    const now = Date.now();
    for (let index = 0; index < 1_012; index += 1) addAudit(store, now + index, `entry-${index}`);

    store.vacuumExpired({ retentionDays: 30, maxEntries: 10 });

    assert.equal(store.auditStats('admin-id').total, 10);
    assert.equal(store.recentAudit('admin-id', 1)[0].tool, 'entry-1011');
  } finally {
    store.close();
  }
});

test('audit housekeeping deletes expired rows in bounded batches', () => {
  const store = SqliteStore.open(':memory:');
  try {
    const expiredAt = Date.now() - 31 * 86_400_000;
    for (let index = 0; index < 1_001; index += 1) addAudit(store, expiredAt + index);

    store.vacuumExpired({ retentionDays: 30, maxEntries: 50_000 });
    assert.equal(store.auditStats('admin-id').total, 1);

    store.vacuumExpired({ retentionDays: 30, maxEntries: 50_000 });
    assert.equal(store.auditStats('admin-id').total, 0);
  } finally {
    store.close();
  }
});

test('audit housekeeping removes expired rows and retains newer rows', () => {
  const store = SqliteStore.open(':memory:');
  try {
    const now = Date.now();
    addAudit(store, now - 31 * 86_400_000, 'expired');
    addAudit(store, now - 29 * 86_400_000, 'retained');

    store.vacuumExpired({ retentionDays: 30, maxEntries: 10 });

    assert.deepEqual(store.recentAudit('admin-id').map(({ tool }) => tool), ['retained']);
  } finally {
    store.close();
  }
});

test('audit housekeeping preserves users, devices, auth codes and tokens', () => {
  const store = SqliteStore.open(':memory:');
  try {
    const user = store.upsertUser('admin', 'password');
    const deviceToken = store.issueDeviceToken('device-id', user.id, 'Agent', 'win32');
    const expiresAt = Date.now() + 60_000;
    store.insertAuthCode({
      code: 'auth-code', client_id: 'client', user_id: user.id, code_challenge: 'challenge',
      redirect_uri: 'https://client.invalid/callback', scopes: 'mcp:tools', resource: null, expires_at: expiresAt,
    });
    store.insertToken({
      token_hash: sha256('access-token'), kind: 'access', client_id: 'client', user_id: user.id,
      scopes: 'mcp:tools', resource: null, expires_at: expiresAt, created_at: Date.now(), revoked: 0,
    });
    addAudit(store, 1);

    store.vacuumExpired({ retentionDays: 0, maxEntries: 1 });

    assert.equal(store.getUser(user.id).username, 'admin');
    assert.equal(store.getDeviceByToken(deviceToken).device_id, 'device-id');
    assert.equal(store.peekAuthCode('auth-code').user_id, user.id);
    assert.equal(store.getToken('access-token', 'access').user_id, user.id);
    assert.equal(store.recentAudit(user.id).length, 0);
  } finally {
    store.close();
  }
});
