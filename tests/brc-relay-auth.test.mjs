import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore, randomToken, sha256 } from '../packages/relay/dist/adapters/storage/sqlite.js';
import { RelayClientsStore, RelayOAuthProvider } from '../packages/relay/dist/adapters/http/oauth-provider.js';
import { HmacSessionSigner } from '../packages/relay/dist/adapters/http/sessions.js';
import { SessionPolicy, SESSION_TTL_MS } from '../packages/relay/dist/core/auth/sessions.js';
import { AUTH_CODE_TTL_MS } from '../packages/relay/dist/core/auth/policy.js';

test('signed login cookies reject tampering and expiry', () => {
  const policy = new SessionPolicy(new HmacSessionSigner('test-secret'));
  const cookie = policy.issue('user', 1_000);
  assert.equal(cookie.maxAge, SESSION_TTL_MS);
  assert.equal(policy.userId(cookie.value, 1_001), 'user');
  assert.equal(policy.userId(cookie.value, 1_000 + SESSION_TTL_MS + 1), null);
  assert.equal(policy.userId(cookie.value.replace('user', 'other'), 1_001), null);
  assert.equal(policy.userId('user.abc.signature', 1_001), null);
});

test('OAuth registration, consent, authorization, rotation, revocation and expiry', async () => {
  const store = SqliteStore.open(':memory:');
  try {
    const user = store.upsertUser('admin', 'password');
    const tokens = { randomToken, sha256 };
    const clientsStore = new RelayClientsStore(store, tokens);
    const client = clientsStore.registerClient({
      client_name: 'test-client', redirect_uris: ['https://client.invalid/callback'],
      token_endpoint_auth_method: 'none',
    });
    assert.equal(clientsStore.getClient(client.client_id).client_id, client.client_id);
    assert.equal(client.client_secret, undefined);
    let pendingId;
    const provider = new RelayOAuthProvider({
      store, tokens, currentUserId: () => user.id,
      renderLogin: () => assert.fail('authenticated user must not see login'),
      renderConsent: (_response, id) => { pendingId = id; },
      issuer: 'https://relay.invalid',
    }, clientsStore);
    const params = {
      redirectUri: 'https://client.invalid/callback',
      codeChallenge: 'challenge', state: 'csrf-state', scopes: ['mcp:tools'],
    };
    await provider.authorize(client, params, {});
    assert.ok(pendingId);
    const redirect = new URL(provider.issueCode(pendingId, user.id));
    assert.equal(redirect.searchParams.get('state'), 'csrf-state');
    assert.equal(redirect.searchParams.get('iss'), 'https://relay.invalid');
    const code = redirect.searchParams.get('code');
    assert.equal(await provider.challengeForAuthorizationCode(client, code), 'challenge');
    const auth = await provider.exchangeAuthorizationCode(client, code, 'verifier', params.redirectUri);
    assert.equal((await provider.verifyAccessToken(auth.access_token)).extra.userId, user.id);
    await assert.rejects(provider.exchangeAuthorizationCode(client, code, 'verifier', params.redirectUri), /invalid authorization code/);
    const rotated = await provider.exchangeRefreshToken(client, auth.refresh_token);
    assert.equal((await provider.verifyAccessToken(rotated.access_token)).clientId, client.client_id);
    await assert.rejects(provider.exchangeRefreshToken(client, auth.refresh_token), /invalid refresh token/);
    await provider.revokeToken(client, { token: rotated.access_token });
    await assert.rejects(provider.verifyAccessToken(rotated.access_token), /invalid or expired access token/);
    provider.pending.set('expired', { client, params, createdAt: Date.now() - AUTH_CODE_TTL_MS - 1 });
    provider.prunePending();
    assert.equal(provider.pending.has('expired'), false);
  } finally {
    store.close();
  }
});
