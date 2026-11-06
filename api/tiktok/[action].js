'use strict';
const { handle, sendJson, requirePost, requireGet, HttpError } = require('../../lib/http');
const { loadSession, saveSession } = require('../../lib/session');
const tiktok = require('../../lib/tiktok');

// POST /api/tiktok/disconnect   - revokes the token at TikTok and deletes it from our storage
// GET  /api/tiktok/creator      - creator info (nickname, allowed privacy levels, interaction settings)
module.exports = handle(async (req, res) => {
  const action = req.query.action;
  const s = await loadSession(req, res);

  if (action === 'disconnect') {
    requirePost(req);
    const t = s.data.tiktok;
    if (t) {
      if (t.accessToken) await tiktok.revoke(t.accessToken);
      delete s.data.tiktok;
      // Anything still waiting for TikTok can no longer be published.
      s.data.queue.forEach((i) => { if (i.auto) { i.auto = false; if (i.status === 'scheduled') i.status = 'pending'; } });
    }
    await saveSession(req, res, s);
    return sendJson(res, 200, { ok: true });
  }

  if (action === 'creator') {
    requireGet(req);
    const token = await tiktok.ensureAccess(s.data);
    const info = await tiktok.creatorInfo(token);
    await saveSession(req, res, s); // token may have been refreshed
    return sendJson(res, 200, {
      nickname: info.creator_nickname || '',
      username: info.creator_username || '',
      avatarUrl: info.creator_avatar_url || '',
      privacyOptions: info.privacy_level_options || [],
      commentDisabled: !!info.comment_disabled,
      duetDisabled: !!info.duet_disabled,
      stitchDisabled: !!info.stitch_disabled,
      maxDurationSec: info.max_video_post_duration_sec || null
    });
  }

  throw new HttpError(404, 'Unknown action');
});
