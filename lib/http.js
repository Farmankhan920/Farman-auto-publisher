'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (k) out[k] = part.slice(i + 1).trim();
  });
  return out;
}

function addSetCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  const list = !prev ? [] : Array.isArray(prev) ? prev.slice() : [String(prev)];
  list.push(cookie);
  res.setHeader('Set-Cookie', list);
}

function cookieString(name, value, maxAge, req) {
  const local = req && /^(localhost|127\.)/.test(String(req.headers.host || ''));
  return name + '=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (local ? '' : '; Secure');
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

// CSRF protection for state-changing requests: POST + custom header + same-origin check.
function requirePost(req) {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  if (req.headers['x-requested-with'] !== 'fetch') throw new HttpError(403, 'Missing request header');
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch (e) { throw new HttpError(403, 'Bad origin'); }
    if (host !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked');
  }
}

function requireGet(req) {
  if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
}

function body(req) {
  let b = req.body;
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch (e) { b = {}; }
  }
  return b && typeof b === 'object' ? b : {};
}

// Wraps a JSON API handler. Errors with a `status` are shown to the user; others are hidden.
function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      const status = e && e.status ? e.status : 500;
      if (status >= 500 && !e.status) console.error(e);
      if (!res.headersSent) sendJson(res, status, { error: e && e.status ? e.message : 'Internal server error' });
    }
  };
}

module.exports = {
  HttpError, parseCookies, addSetCookie, cookieString, sendJson, redirect,
  requirePost, requireGet, body, handle
};
