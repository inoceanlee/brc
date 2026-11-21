// End-to-end OAuth + MCP client test against a running relay (simulates claude.ai).
// node scripts/e2e-oauth.mjs http://localhost:3210 admin test-pass-123
import { createHash, randomBytes } from 'node:crypto';
const [base, user, pass] = process.argv.slice(2);
const b64 = (b) => b.toString('base64url');
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const step = (n, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);

// discovery
const prm = await j(await fetch(`${base}/.well-known/oauth-protected-resource/mcp`));
const meta = await j(await fetch(`${base}/.well-known/oauth-authorization-server`));
step('discovery', !!meta.authorization_endpoint && !!prm.resource, `auth=${meta.authorization_endpoint} token=${meta.token_endpoint} reg=${meta.registration_endpoint}`);

// dynamic client registration
const redirect = 'https://claude.ai/api/mcp/auth_callback';
const reg = await j(await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) }));
step('register', !!reg.client_id, `client_id=${reg.client_id}`);

// authorize with PKCE -> expect redirect to login
const verifier = b64(randomBytes(32)); const challenge = b64(createHash('sha256').update(verifier).digest());
const state = b64(randomBytes(8));
const authUrl = `${meta.authorization_endpoint}?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${challenge}&code_challenge_method=S256&state=${state}&scope=mcp:tools&resource=${encodeURIComponent(prm.resource)}`;
let r = await fetch(authUrl, { redirect: 'manual' });
const loginLoc = r.headers.get('location') ?? '';
step('authorize -> login redirect', r.status === 302 && loginLoc.startsWith('/auth/login'), loginLoc);

// login (cookie), then follow returnTo to consent
r = await fetch(`${base}/auth/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: user, password: pass, returnTo: new URL(loginLoc, base).searchParams.get('returnTo') }) });
const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
const consentLoc = r.headers.get('location') ?? '';
step('login', r.status === 302 && cookie.startsWith('brc_session='), consentLoc);
r = await fetch(new URL(consentLoc, base), { headers: { cookie } });
const html = await r.text();
const pending = html.match(/name="pending" value="([^"]+)"/)?.[1];
step('consent page', r.status === 200 && !!pending, `pending=${pending}`);

// allow -> code
r = await fetch(`${base}/auth/consent`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ pending, decision: 'allow' }) });
const cb = new URL(r.headers.get('location'));
const code = cb.searchParams.get('code');
step('consent -> code', r.status === 302 && !!code && cb.searchParams.get('state') === state, `${cb.origin}${cb.pathname}`);

// token exchange
const tok = await j(await fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirect, resource: prm.resource }) }));
step('token', !!tok.access_token && !!tok.refresh_token, `expires_in=${tok.expires_in} scope=${tok.scope}`);

// MCP: initialize, tools/list, tools/call
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.access_token}` };
const rpc = async (method, params, id, headers = H) => {
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  const ct = res.headers.get('content-type') ?? '';
  const text = await res.text();
  if (ct.includes('text/event-stream')) { const m = text.match(/^data: (.+)$/m); return { status: res.status, body: m ? JSON.parse(m[1]) : null }; }
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } }, 1);
step('mcp initialize', init.status === 200 && init.body?.result?.serverInfo?.name === 'brc', `server=${init.body?.result?.serverInfo?.name}@${init.body?.result?.serverInfo?.version}`);

const list = await rpc('tools/list', {}, 2);
const names = (list.body?.result?.tools ?? []).map((t) => t.name);
step('mcp tools/list', names.includes('list_devices') && names.includes('read_file') && names.includes('start_process'), `${names.length} tools`);

const devs = await rpc('tools/call', { name: 'list_devices', arguments: {} }, 3);
const devJson = JSON.parse(devs.body?.result?.content?.[0]?.text ?? '{}');
step('mcp list_devices', devJson.devices?.some((d) => d.online), JSON.stringify(devJson.devices?.map((d) => `${d.name}:${d.online ? 'online' : 'offline'}`)));

const call = await rpc('tools/call', { name: 'start_process', arguments: { command: 'echo brc-mcp-ok', timeout_ms: 8000 } }, 4);
const out = call.body?.result?.content?.[0]?.text ?? '';
step('mcp start_process via device', out.includes('brc-mcp-ok'), `isError=${call.body?.result?.isError} device=${call.body?.result?._meta?.deviceName}`);
const longStartedAt = Date.now();
const longCall = await rpc('tools/call', {
  name: 'start_process',
  arguments: { command: `node -e "setTimeout(() => console.log('BRC_LONG_REQUEST_OK'), 2500)"`, timeout_ms: 10_000 },
}, 5);
const longText = longCall.body?.result?.content?.[0]?.text ?? '';
const longDurationMs = Date.now() - longStartedAt;
step('mcp long request via Agent WebSocket', longCall.status === 200 && !longCall.body?.result?.isError
  && longText.includes('BRC_LONG_REQUEST_OK') && longDurationMs >= 2000, `duration=${longDurationMs}ms`);

const largeCall = await rpc('tools/call', {
  name: 'start_process',
  arguments: { command: `node -e "process.stdout.write('BRC_LARGE_BEGIN' + 'x'.repeat(256 * 1024) + 'BRC_LARGE_END')"`, timeout_ms: 10_000 },
}, 6);
const largeText = largeCall.body?.result?.content?.[0]?.text ?? '';
step('mcp large response via Agent WebSocket', largeCall.status === 200 && !largeCall.body?.result?.isError
  && largeText.length >= 256 * 1024 && largeText.includes('BRC_LARGE_BEGIN') && largeText.includes('BRC_LARGE_END'),
  `chars=${largeText.length}`);
const redirect2 = 'https://claude.ai/api/mcp/auth_callback';
const reg2 = await j(await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ client_name: 'Second BRC client', redirect_uris: [redirect2], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) }));
const verifier2 = b64(randomBytes(32));
const challenge2 = b64(createHash('sha256').update(verifier2).digest());
const authUrl2 = `${meta.authorization_endpoint}?response_type=code&client_id=${reg2.client_id}&redirect_uri=${encodeURIComponent(redirect2)}&code_challenge=${challenge2}&code_challenge_method=S256&scope=mcp:tools&resource=${encodeURIComponent(prm.resource)}`;
const consent2 = await fetch(authUrl2, { headers: { cookie } });
const html2 = await consent2.text();
const pending2 = html2.match(/name="pending" value="([^"]+)"/)?.[1];
const allowed2 = await fetch(`${base}/auth/consent`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ pending: pending2, decision: 'allow' }) });
const code2 = new URL(allowed2.headers.get('location')).searchParams.get('code');
const tok2 = await j(await fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code: code2, code_verifier: verifier2, client_id: reg2.client_id, redirect_uri: redirect2, resource: prm.resource }) }));
const devs2 = await rpc('tools/call', { name: 'list_devices', arguments: {} }, 7, { ...H, authorization: `Bearer ${tok2.access_token}` });
const devices2 = JSON.parse(devs2.body?.result?.content?.[0]?.text ?? '{}').devices ?? [];
const stableDevices = (devices) => devices.map(({ deviceId, name, platform, online, paused }) => ({ deviceId, name, platform, online, paused })).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
step('second OAuth client sees same devices', consent2.status === 200 && !!tok2.access_token && JSON.stringify(stableDevices(devices2)) === JSON.stringify(stableDevices(devJson.devices)), JSON.stringify(devices2.map((device) => device.name)));

// unauthorized / refresh
const bad = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...H, authorization: 'Bearer nope' }, body: '{}' });
step('mcp rejects bad token', bad.status === 401, `www-authenticate=${bad.headers.get('www-authenticate')?.slice(0, 60)}`);
const ref = await j(await fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id }) }));
step('refresh token', !!ref.access_token && ref.refresh_token !== tok.refresh_token);
const reuse = await fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id }) });
step('old refresh token rotated out', reuse.status === 400);
