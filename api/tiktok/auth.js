'use strict';
const { missingTikTok } = require('../../lib/config');
const { redirect } = require('../../lib/http');
const { randomId } = require('../../lib/crypto');
const { loadSession, saveSession } = require('../../lib/session');
const tiktok = require('../../lib/tiktok');

// GET /api/tiktok/auth  -> redirects the browser to TikTok's authorization page.
module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') {
      res.statusCode = 405;
      return res.end('Method not allowed');
    }
    const missing = missingTikTok();
    if (missing.length) {
      return redirect(res, '/dashboard/?error=' + encodeURIComponent('Server is missing environment variables: ' + missing.join(', ')));
    }
    const s = await loadSession(req, res);
    const state = randomId(24);
    s.data.oauth.tiktok = { state, at: Date.now() };
    await saveSession(req, res, s);
    return redirect(res, tiktok.buildAuthUrl(state));
  } catch (e) {
    console.error(e);
    return redirect(res, '/dashboard/?error=' + encodeURIComponent(e.status ? e.message : 'Could not start TikTok login.'));
  }
};
