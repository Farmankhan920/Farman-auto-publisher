'use strict';
const { missingTikTok, missingGoogle, env, googleRedirectUri, TIKTOK_SCOPES } = require('../lib/config');
const { handle, sendJson, requireGet } = require('../lib/http');
const { loadSession, saveSession, kvEnabled } = require('../lib/session');
const publisher = require('../lib/publisher');

// GET /api/dashboard - safe snapshot for the UI. Never includes tokens or upload URLs.
module.exports = handle(async (req, res) => {
  requireGet(req);
  const s = await loadSession(req, res);
  const d = s.data;

  // Finalize anything TikTok is still processing (max 5 per page load).
  let changed = false;
  const processing = d.queue.filter((i) => i.status === 'processing').slice(0, 5);
  for (const item of processing) {
    try { await publisher.pollStatus(d, item); changed = true; } catch (e) { /* try again next load */ }
  }
  if (changed || d.tiktok) {
    try { await saveSession(req, res, s); } catch (e) { /* non-fatal for a read */ }
  }

  const t = d.tiktok;
  const g = d.google;
  sendJson(res, 200, {
    storage: s.mode,
    config: {
      tiktok: missingTikTok().length === 0,
      tiktokMissing: missingTikTok(),
      google: missingGoogle().length === 0,
      googleMissing: missingGoogle(),
      googleRedirectUri: googleRedirectUri(),
      scheduling: kvEnabled() && !!env('CRON_SECRET')
    },
    tiktok: t ? {
      connected: true, displayName: t.displayName || '', avatarUrl: t.avatarUrl || '',
      scope: t.scope || TIKTOK_SCOPES.join(','), connectedAt: t.connectedAt,
      refreshExpiresAt: t.refreshExpiresAt || null
    } : { connected: false },
    google: g ? { connected: true, email: g.email || '', connectedAt: g.connectedAt } : { connected: false },
    folder: d.folder || null,
    queue: d.queue.map(publisher.publicItem),
    history: d.history.slice(0, 50),
    stats: publisher.computeStats(d)
  });
});
