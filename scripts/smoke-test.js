'use strict';
// Offline smoke test: runs every API handler against mocked TikTok, Google and KV endpoints.
// Usage: node scripts/smoke-test.js   (no network, no dependencies)
const assert = require('assert');
const path = require('path');

process.env.TIKTOK_CLIENT_KEY = 'ck_test';
process.env.TIKTOK_CLIENT_SECRET = 'cs_test_secret';
process.env.TIKTOK_REDIRECT_URI = 'https://example.vercel.app/api/tiktok/callback';
process.env.GOOGLE_CLIENT_ID = 'gid';
process.env.GOOGLE_CLIENT_SECRET = 'gsecret';
process.env.CRON_SECRET = 'cron_secret_value';

const SIZE = 25 * 1024 * 1024;
const kvStore = new Map();
const sets = new Map();
const puts = [];
let publishStatus = 'PUBLISH_COMPLETE';

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) };
}

global.fetch = async (url, init) => {
  url = String(url);
  init = init || {};
  if (url.startsWith('http://kv.mock')) {
    const c = JSON.parse(init.body);
    const [op, key, val] = c;
    if (op === 'GET') return json(200, { result: kvStore.has(key) ? kvStore.get(key) : null });
    if (op === 'SET') { kvStore.set(key, val); return json(200, { result: 'OK' }); }
    if (op === 'DEL') { kvStore.delete(key); return json(200, { result: 1 }); }
    if (op === 'SADD') { (sets.get(key) || sets.set(key, new Set()).get(key)).add(val); return json(200, { result: 1 }); }
    if (op === 'SREM') { (sets.get(key) || new Set()).delete(val); return json(200, { result: 1 }); }
    if (op === 'SMEMBERS') return json(200, { result: Array.from(sets.get(key) || []) });
  }
  if (url.includes('open.tiktokapis.com/v2/oauth/token')) {
    const p = new URLSearchParams(init.body);
    if (p.get('client_secret') !== 'cs_test_secret') return json(400, { error: 'invalid_client' });
    return json(200, { access_token: 'tt_access', expires_in: 86400, open_id: 'oid', refresh_token: 'tt_refresh', refresh_expires_in: 31536000, scope: 'user.info.basic,video.upload,video.publish' });
  }
  if (url.includes('/oauth/revoke')) return json(200, {});
  if (url.includes('/v2/user/info')) return json(200, { data: { user: { display_name: 'Tester', avatar_url: 'https://a/b.png' } }, error: { code: 'ok' } });
  if (url.includes('creator_info/query')) return json(200, { data: { creator_nickname: 'Tester', creator_username: 'tester', privacy_level_options: ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'], comment_disabled: false, duet_disabled: false, stitch_disabled: true, max_video_post_duration_sec: 600 }, error: { code: 'ok' } });
  if (url.includes('/post/publish/video/init') || url.includes('/inbox/video/init')) {
    const b = JSON.parse(init.body);
    assert.strictEqual(b.source_info.video_size, SIZE);
    assert.strictEqual(b.source_info.total_chunk_count, 2);
    assert.strictEqual(b.source_info.chunk_size, 10 * 1024 * 1024);
    if (url.includes('/inbox/')) assert.ok(!b.post_info, 'draft init must not send post_info');
    else assert.strictEqual(b.post_info.privacy_level, 'SELF_ONLY');
    return json(200, { data: { publish_id: 'pub123', upload_url: 'https://upload.tiktok.mock/u' }, error: { code: 'ok' } });
  }
  if (url.startsWith('https://upload.tiktok.mock/')) {
    puts.push(init.headers['Content-Range']);
    return json(puts.length % 2 === 0 ? 201 : 206, {});
  }
  if (url.includes('/post/publish/status/fetch')) return json(200, { data: { status: publishStatus }, error: { code: 'ok' } });
  if (url.includes('oauth2.googleapis.com/token')) return json(200, { access_token: 'g_access', expires_in: 3600, refresh_token: 'g_refresh', scope: 'drive.readonly' });
  if (url.includes('oauth2.googleapis.com/revoke')) return json(200, {});
  if (url.includes('googleapis.com/oauth2/v2/userinfo')) return json(200, { email: 'me@example.com' });
  if (url.includes('googleapis.com/drive/v3/files/VIDEOID12345?alt=media')) {
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    const len = Number(m[2]) - Number(m[1]) + 1;
    return { ok: true, status: 206, arrayBuffer: async () => new ArrayBuffer(len) };
  }
  if (url.includes('googleapis.com/drive/v3/files/VIDEOID12345')) return json(200, { id: 'VIDEOID12345', name: 'clip.mp4', mimeType: 'video/mp4', size: String(SIZE), videoMediaMetadata: { durationMillis: '30000' } });
  if (url.includes('googleapis.com/drive/v3/files')) {
    if (url.includes('folder')) return json(200, { files: [{ id: 'FOLDERID123', name: 'Clips' }] });
    return json(200, { files: [{ id: 'VIDEOID12345', name: 'clip.mp4', mimeType: 'video/mp4', size: String(SIZE) }] });
  }
  throw new Error('Unmocked fetch: ' + url);
};

function makeRes() {
  const headers = {};
  return {
    statusCode: 200, headersSent: false, body: '',
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    getHeader(k) { return headers[k.toLowerCase()]; },
    end(b) { this.body = b || ''; this.headersSent = true; },
    _h: headers
  };
}

function client(handlerPath) {
  const jar = {};
  return async function call(file, opts) {
    const handler = require(path.join('..', file));
    const o = opts || {};
    const res = makeRes();
    const req = {
      method: o.method || 'GET', query: o.query || {}, body: o.body,
      headers: Object.assign({ host: 'example.vercel.app', origin: o.method === 'POST' ? 'https://example.vercel.app' : undefined,
        cookie: Object.keys(jar).map((k) => k + '=' + jar[k]).join('; ') }, o.method === 'POST' ? { 'x-requested-with': 'fetch' } : {}, o.headers || {})
    };
    await handler(req, res);
    [].concat(res._h['set-cookie'] || []).forEach((c) => {
      const [kv, ...attrs] = c.split('; ');
      const i = kv.indexOf('=');
      if (attrs.some((a) => a === 'Max-Age=0')) delete jar[kv.slice(0, i)]; else jar[kv.slice(0, i)] = kv.slice(i + 1);
      assert.ok(attrs.includes('HttpOnly') && attrs.includes('Secure') && attrs.includes('SameSite=Lax'), 'cookie flags');
    });
    let parsed = null;
    try { parsed = JSON.parse(res.body); } catch (e) { /* redirect */ }
    return { status: res.statusCode, location: res._h.location, json: parsed, jar };
  };
}

async function suite(mode) {
  console.log('\n== ' + mode + ' mode ==');
  const call = client();

  // OAuth start
  let r = await call('api/tiktok/auth.js');
  assert.strictEqual(r.status, 302);
  const u = new URL(r.location);
  assert.strictEqual(u.origin + u.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
  assert.strictEqual(u.searchParams.get('client_key'), 'ck_test');
  assert.strictEqual(u.searchParams.get('redirect_uri'), process.env.TIKTOK_REDIRECT_URI);
  assert.strictEqual(u.searchParams.get('scope'), 'user.info.basic,video.upload,video.publish');
  const state = u.searchParams.get('state');
  assert.ok(state && state.length >= 20);
  console.log('ok  auth redirect with state');

  // Bad state is rejected
  r = await call('api/tiktok/callback.js', { query: { code: 'c', state: 'WRONG' } });
  assert.ok(decodeURIComponent(r.location).includes('Security check failed'));
  // state is single-use: start again to get a fresh one
  r = await call('api/tiktok/auth.js');
  const state2 = new URL(r.location).searchParams.get('state');
  r = await call('api/tiktok/callback.js', { query: { code: 'abc', state: state2 } });
  assert.strictEqual(r.location, '/dashboard/?tiktok=connected');
  console.log('ok  callback: bad state rejected, good state exchanged');

  // State cannot be replayed
  r = await call('api/tiktok/callback.js', { query: { code: 'abc', state: state2 } });
  assert.ok(decodeURIComponent(r.location).includes('Security check failed'));
  console.log('ok  state is single use');

  // Google connect
  r = await call('api/google/[action].js', { query: { action: 'auth' } });
  const gstate = new URL(r.location).searchParams.get('state');
  r = await call('api/google/[action].js', { query: { action: 'callback', code: 'gc', state: gstate } });
  assert.strictEqual(r.location, '/dashboard/?google=connected');
  console.log('ok  google connect');

  // Dashboard never leaks tokens
  r = await call('api/dashboard.js');
  assert.strictEqual(r.json.tiktok.connected, true);
  assert.strictEqual(r.json.google.email, 'me@example.com');
  const dump = JSON.stringify(r.json);
  ['tt_access', 'tt_refresh', 'g_access', 'g_refresh', 'cs_test_secret'].forEach((s) => assert.ok(!dump.includes(s), 'leak: ' + s));
  console.log('ok  dashboard has no secrets');

  // CSRF: POST without header is rejected
  r = await call('api/queue.js', { method: 'POST', body: { action: 'create' }, headers: { 'x-requested-with': 'nope' } });
  assert.strictEqual(r.status, 403);
  console.log('ok  CSRF guard');

  // Drive browsing + creator info
  r = await call('api/drive/[action].js', { query: { action: 'list', folderId: 'root' } });
  assert.strictEqual(r.json.videos.length, 1);
  r = await call('api/drive/[action].js', { query: { action: 'list', folderId: "x' or '1'='1" } });
  assert.strictEqual(r.status, 400);
  r = await call('api/tiktok/[action].js', { query: { action: 'creator' } });
  assert.deepStrictEqual(r.json.privacyOptions, ['SELF_ONLY', 'PUBLIC_TO_EVERYONE']);
  console.log('ok  drive list, id validation, creator info');

  // Queue + full direct publish
  r = await call('api/queue.js', { method: 'POST', body: { action: 'create', items: [{ fileId: 'VIDEOID12345', caption: 'Hello', hashtags: '#fyp, test', mode: 'direct', privacy: 'SELF_ONLY', opts: { allowComment: true } }] } });
  assert.strictEqual(r.status, 200);
  const id = r.json.queue[0].id;
  r = await call('api/publish/[action].js', { method: 'POST', query: { action: 'start' }, body: { id } });
  assert.strictEqual(r.status, 400, 'start without confirmation must fail');
  r = await call('api/publish/[action].js', { method: 'POST', query: { action: 'start' }, body: { id, confirmed: true } });
  assert.strictEqual(r.json.item.status, 'uploading');
  puts.length = 0;
  r = await call('api/publish/[action].js', { method: 'POST', query: { action: 'chunk' }, body: { id } });
  assert.strictEqual(r.json.item.status, 'uploading');
  r = await call('api/publish/[action].js', { method: 'POST', query: { action: 'chunk' }, body: { id } });
  assert.strictEqual(r.json.item.status, 'processing');
  assert.deepStrictEqual(puts, ['bytes 0-10485759/' + SIZE, 'bytes 10485760-' + (SIZE - 1) + '/' + SIZE]);
  r = await call('api/publish/[action].js', { method: 'POST', query: { action: 'status' }, body: { id } });
  assert.strictEqual(r.json.item.status, 'published');
  r = await call('api/dashboard.js');
  assert.strictEqual(r.json.stats.published, 1);
  assert.strictEqual(r.json.queue.length, 0);
  console.log('ok  direct publish: init, 2 chunks with correct Content-Range, status, history');

  // Draft upload
  r = await call('api/queue.js', { method: 'POST', body: { action: 'create', items: [{ fileId: 'VIDEOID12345', mode: 'draft' }] } });
  const id2 = r.json.queue[0].id;
  await call('api/publish/[action].js', { method: 'POST', query: { action: 'start' }, body: { id: id2, confirmed: true } });
  await call('api/publish/[action].js', { method: 'POST', query: { action: 'chunk' }, body: { id: id2 } });
  await call('api/publish/[action].js', { method: 'POST', query: { action: 'chunk' }, body: { id: id2 } });
  publishStatus = 'SEND_TO_USER_INBOX';
  r = await call('api/publish/[action].js', { method: 'POST', query: { action: 'status' }, body: { id: id2 } });
  assert.strictEqual(r.json.item.status, 'draft_sent');
  publishStatus = 'PUBLISH_COMPLETE';
  console.log('ok  draft (video.upload) flow');

  // Scheduling + cron
  if (mode === 'kv') {
    const when = new Date(Date.now() + 1500).toISOString();
    r = await call('api/queue.js', { method: 'POST', body: { action: 'create', confirmed: true, items: [{ fileId: 'VIDEOID12345', mode: 'direct', privacy: 'SELF_ONLY', scheduledAt: when }] } });
    assert.strictEqual(r.json.queue[0].status, 'scheduled');
    r = await call('api/cron/run.js', { headers: { authorization: 'Bearer wrong' } });
    assert.strictEqual(r.status, 401);
    await new Promise((res) => setTimeout(res, 1700));
    r = await call('api/cron/run.js', { headers: { authorization: 'Bearer cron_secret_value' } });
    assert.strictEqual(r.json.processed, 1);
    r = await call('api/dashboard.js');
    assert.strictEqual(r.json.queue.length, 0);
    assert.strictEqual(r.json.stats.published, 2);
    console.log('ok  scheduled publish via cron (and cron auth)');
  } else {
    r = await call('api/queue.js', { method: 'POST', body: { action: 'create', confirmed: true, items: [{ fileId: 'VIDEOID12345', mode: 'draft', scheduledAt: new Date(Date.now() + 3600e3).toISOString() }] } });
    assert.strictEqual(r.status, 400);
    console.log('ok  scheduling correctly refused without KV');
  }

  // Disconnect
  r = await call('api/tiktok/[action].js', { method: 'POST', query: { action: 'disconnect' }, body: {} });
  assert.strictEqual(r.status, 200);
  r = await call('api/google/[action].js', { method: 'POST', query: { action: 'disconnect' }, body: {} });
  r = await call('api/dashboard.js');
  assert.strictEqual(r.json.tiktok.connected, false);
  assert.strictEqual(r.json.google.connected, false);
  console.log('ok  disconnect TikTok + Google');
}

(async () => {
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  await suite('cookie');
  process.env.KV_REST_API_URL = 'http://kv.mock';
  process.env.KV_REST_API_TOKEN = 'kvtoken';
  await suite('kv');
  console.log('\nAll smoke tests passed.');
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
