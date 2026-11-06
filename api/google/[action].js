'use strict';
const { missingGoogle } = require('../../lib/config');
const { handle, sendJson, requirePost, redirect, HttpError } = require('../../lib/http');
const { randomId, safeEqual } = require('../../lib/crypto');
const { loadSession, saveSession } = require('../../lib/session');
const google = require('../../lib/google');

function back(res, key, value) {
  return redirect(res, '/dashboard/?' + key + '=' + encodeURIComponent(value));
}

// GET  /api/google/auth        - redirect to Google's consent screen
// GET  /api/google/callback    - OAuth redirect URI
// POST /api/google/disconnect  - revoke and delete Google tokens
module.exports = handle(async (req, res) => {
  const action = req.query.action;

  if (action === 'auth') {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    const missing = missingGoogle();
    if (missing.length) return back(res, 'error', 'Server is missing environment variables: ' + missing.join(', '));
    const s = await loadSession(req, res);
    const state = randomId(24);
    s.data.oauth.google = { state, at: Date.now() };
    await saveSession(req, res, s);
    return redirect(res, google.buildAuthUrl(state));
  }

  if (action === 'callback') {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    if (missingGoogle().length) return back(res, 'error', 'Server is not configured for Google.');
    const q = req.query || {};
    if (q.error) return back(res, 'error', 'Google authorization was not completed: ' + String(q.error).slice(0, 100));

    const s = await loadSession(req, res);
    const saved = s.data.oauth && s.data.oauth.google;
    delete s.data.oauth.google;
    const valid = saved && q.state && safeEqual(saved.state, q.state) && Date.now() - saved.at < 10 * 60 * 1000;
    if (!valid || !q.code) {
      await saveSession(req, res, s);
      return back(res, 'error', 'Security check failed (invalid or expired state). Please try connecting Google Drive again.');
    }
    try {
      const tokens = await google.exchangeCode(String(q.code));
      google.applyTokens(s.data, tokens);
      s.data.google.email = await google.userEmail(s.data.google.accessToken);
      await saveSession(req, res, s);
      return back(res, 'google', 'connected');
    } catch (e) {
      console.error(e);
      return back(res, 'error', e.status ? e.message : 'Google connection failed.');
    }
  }

  if (action === 'disconnect') {
    requirePost(req);
    const s = await loadSession(req, res);
    const g = s.data.google;
    if (g) {
      await google.revoke(g.refreshToken || g.accessToken);
      delete s.data.google;
      delete s.data.folder;
      s.data.queue.forEach((i) => { if (i.auto) { i.auto = false; if (i.status === 'scheduled') i.status = 'pending'; } });
    }
    await saveSession(req, res, s);
    return sendJson(res, 200, { ok: true });
  }

  throw new HttpError(404, 'Unknown action');
});
