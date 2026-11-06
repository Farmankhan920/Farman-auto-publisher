'use strict';
const { kvConfig } = require('./config');
const { encrypt, decrypt, signValue, verifySigned, randomId } = require('./crypto');
const { parseCookies, addSetCookie, cookieString, HttpError } = require('./http');

const SID_COOKIE = 'fap_sid';
const DATA_COOKIE = 'fap_data';
const TTL = 60 * 60 * 24 * 90; // 90 days, refreshed on every save
const COOKIE_LIMIT = 3600; // encrypted cookie payload limit (bytes) in fallback mode

async function kv(cmd) {
  const cfg = kvConfig();
  const r = await fetch(cfg.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  let j = {};
  try { j = await r.json(); } catch (e) { /* ignore */ }
  if (!r.ok || j.error) throw new Error('Storage error: ' + (j.error || r.status));
  return j.result;
}

function emptyData() {
  return { queue: [], history: [], oauth: {} };
}

function normalize(d) {
  const data = d && typeof d === 'object' ? d : {};
  if (!Array.isArray(data.queue)) data.queue = [];
  if (!Array.isArray(data.history)) data.history = [];
  if (!data.oauth || typeof data.oauth !== 'object') data.oauth = {};
  return data;
}

// Loads (or creates) the session for this request.
async function loadSession(req, res) {
  const cookies = parseCookies(req);
  if (kvConfig()) {
    let sid = cookies[SID_COOKIE] ? verifySigned(cookies[SID_COOKIE]) : null;
    let data = null;
    if (sid) {
      const v = await kv(['GET', 'fap:s:' + sid]);
      if (v) data = decrypt(v);
    }
    if (!sid) sid = randomId(24);
    return { mode: 'kv', sid, data: normalize(data || emptyData()) };
  }
  const raw = cookies[DATA_COOKIE];
  return { mode: 'cookie', sid: null, data: normalize((raw && decrypt(raw)) || emptyData()) };
}

// Used by the scheduler (no browser request).
async function loadBySid(sid) {
  const v = await kv(['GET', 'fap:s:' + sid]);
  const data = v ? decrypt(v) : null;
  return data ? { mode: 'kv', sid, data: normalize(data) } : null;
}

function hasScheduled(data) {
  return data.queue.some((i) => i.auto && (i.status === 'scheduled' || i.status === 'uploading' || i.status === 'processing'));
}

async function saveSession(req, res, s) {
  const data = s.data;
  const now = Date.now();
  // drop stale OAuth states
  Object.keys(data.oauth || {}).forEach((k) => {
    if (!data.oauth[k] || now - data.oauth[k].at > 15 * 60 * 1000) delete data.oauth[k];
  });
  data.history = data.history.slice(0, s.mode === 'kv' ? 200 : 25);

  if (s.mode === 'kv') {
    await kv(['SET', 'fap:s:' + s.sid, encrypt(data), 'EX', String(TTL)]);
    await kv([hasScheduled(data) ? 'SADD' : 'SREM', 'fap:sched', s.sid]);
    if (res) addSetCookie(res, cookieString(SID_COOKIE, signValue(s.sid), TTL, req));
    return;
  }

  // Fallback mode: everything lives in one encrypted, HttpOnly cookie.
  let enc = encrypt(data);
  while (enc.length > COOKIE_LIMIT && data.history.length > 0) {
    data.history.pop();
    enc = encrypt(data);
  }
  if (enc.length > COOKIE_LIMIT) {
    throw new HttpError(507, 'Session storage is full. Configure Vercel KV / Upstash Redis for larger queues.');
  }
  if (res) addSetCookie(res, cookieString(DATA_COOKIE, enc, TTL, req));
}

async function destroySession(req, res, s) {
  if (s.mode === 'kv') {
    await kv(['DEL', 'fap:s:' + s.sid]);
    await kv(['SREM', 'fap:sched', s.sid]);
    addSetCookie(res, cookieString(SID_COOKIE, '', 0, req));
  } else {
    addSetCookie(res, cookieString(DATA_COOKIE, '', 0, req));
  }
}

async function scheduledSessionIds() {
  return (await kv(['SMEMBERS', 'fap:sched'])) || [];
}

module.exports = { loadSession, loadBySid, saveSession, destroySession, scheduledSessionIds, kvEnabled: () => !!kvConfig() };
