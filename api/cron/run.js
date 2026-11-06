'use strict';
const { env } = require('../../lib/config');
const { sendJson, HttpError, handle } = require('../../lib/http');
const { safeEqual } = require('../../lib/crypto');
const { kvEnabled, scheduledSessionIds, loadBySid, saveSession } = require('../../lib/session');
const publisher = require('../../lib/publisher');

// GET /api/cron/run
// Publishes scheduled videos that are due. Protected by CRON_SECRET:
//   Authorization: Bearer <CRON_SECRET>
// Vercel Cron sends this header automatically when the CRON_SECRET env variable exists.
module.exports = handle(async (req, res) => {
  const secret = env('CRON_SECRET');
  if (!secret) throw new HttpError(503, 'CRON_SECRET is not configured.');
  const auth = String(req.headers.authorization || '');
  if (!safeEqual(auth, 'Bearer ' + secret)) throw new HttpError(401, 'Unauthorized');
  if (!kvEnabled()) throw new HttpError(503, 'Scheduling requires Vercel KV / Upstash Redis.');

  const deadline = Date.now() + 40 * 1000; // leave headroom under the 60s function limit
  const ids = await scheduledSessionIds();
  let processed = 0;

  for (const sid of ids) {
    if (Date.now() > deadline) break;
    const s = await loadBySid(sid);
    if (!s) continue;
    await publisher.processScheduled(s.data, deadline);
    await saveSession(null, null, s);
    processed += 1;
  }

  sendJson(res, 200, { ok: true, sessions: ids.length, processed });
});
