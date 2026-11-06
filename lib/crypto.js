'use strict';
const crypto = require('crypto');

let cache = null;

function secret() {
  const s = (process.env.SESSION_SECRET || process.env.TIKTOK_CLIENT_SECRET || '').trim();
  if (!s) throw new Error('No encryption secret configured');
  return s;
}

function keys() {
  const s = secret();
  if (cache && cache.s === s) return cache;
  cache = {
    s,
    enc: Buffer.from(crypto.hkdfSync('sha256', s, 'fap-salt-v1', 'fap-enc', 32)),
    mac: Buffer.from(crypto.hkdfSync('sha256', s, 'fap-salt-v1', 'fap-mac', 32))
  };
  return cache;
}

// AES-256-GCM: returns base64url(iv | tag | ciphertext)
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keys().enc, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

function decrypt(str) {
  try {
    const b = Buffer.from(String(str), 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', keys().enc, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    const pt = Buffer.concat([d.update(b.subarray(28)), d.final()]);
    return JSON.parse(pt.toString('utf8'));
  } catch (e) {
    return null;
  }
}

function sign(value) {
  return crypto.createHmac('sha256', keys().mac).update(value).digest('base64url');
}

function signValue(value) {
  return value + '.' + sign(value);
}

function verifySigned(str) {
  const i = String(str).lastIndexOf('.');
  if (i < 1) return null;
  const value = str.slice(0, i);
  const a = Buffer.from(str.slice(i + 1));
  const b = Buffer.from(sign(value));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value;
}

function randomId(bytes) {
  return crypto.randomBytes(bytes || 24).toString('base64url');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { encrypt, decrypt, signValue, verifySigned, randomId, safeEqual };
