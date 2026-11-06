'use strict';
const { missingTikTok } = require('../../lib/config');
const { redirect } = require('../../lib/http');
const { safeEqual } = require('../../lib/crypto');
const { loadSession, saveSession } = require('../../lib/session');
const tiktok = require('../../lib/tiktok');

function back(res, key, value) {
  return redirect(res, '/dashboard/?' + key + '=' + encodeURIComponent(value));
}

// GET /api/tiktok/callback  -> TikTok redirects here with ?code=...&state=...
module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') {
      res.statusCode = 405;
      return res.end('Method not allowed');
    }
    if (missingTikTok().length) return back(res, 'error', 'Server is not configured for TikTok.');

    const q = req.query || {};
    if (q.error) {
      return back(res, 'error', 'TikTok authorization was not completed: ' + String(q.error_description || q.error).slice(0, 150));
    }

    const s = await loadSession(req, res);
    const saved = s.data.oauth && s.data.oauth.tiktok;
    delete s.data.oauth.tiktok; // single use

    // Secure OAuth state validation (CSRF protection)
    const valid = saved && q.state && safeEqual(saved.state, q.state) && Date.now() - saved.at < 10 * 60 * 1000;
    if (!valid) {
      await saveSession(req, res, s);
      return back(res, 'error', 'Security check failed (invalid or expired state). Please try connecting again.');
    }
    if (!q.code) {
      await saveSession(req, res, s);
      return back(res, 'error', 'TikTok did not return an authorization code.');
    }

    const tokens = await tiktok.exchangeCode(String(q.code));
    tiktok.applyTokens(s.data, tokens);
    s.data.tiktok.connectedAt = Date.now();

    try {
      const u = await tiktok.userInfo(s.data.tiktok.accessToken);
      s.data.tiktok.displayName = u.display_name || '';
      s.data.tiktok.avatarUrl = u.avatar_url || '';
    } catch (e) { /* profile is optional */ }

    await saveSession(req, res, s);
    return back(res, 'tiktok', 'connected');
  } catch (e) {
    console.error(e);
    return back(res, 'error', e.status ? e.message : 'TikTok connection failed.');
  }
};
