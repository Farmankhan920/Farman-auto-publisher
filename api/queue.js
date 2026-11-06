'use strict';
const { handle, sendJson, requirePost, body, HttpError } = require('../lib/http');
const { randomId } = require('../lib/crypto');
const { env } = require('../lib/config');
const { loadSession, saveSession } = require('../lib/session');
const google = require('../lib/google');
const publisher = require('../lib/publisher');

const MAX_QUEUE_KV = 50;
const MAX_QUEUE_COOKIE = 4;

function hashtags(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/);
  const out = [];
  raw.forEach((t) => {
    const tag = String(t).replace(/^#+/, '').trim();
    if (tag && tag.length <= 100 && /^[\p{L}\p{N}_]+$/u.test(tag) && out.indexOf(tag) === -1) out.push(tag);
  });
  return out.slice(0, 30);
}

function parseSchedule(value, s) {
  if (!value) return null;
  if (s.mode !== 'kv' || !env('CRON_SECRET')) {
    throw new HttpError(400, 'Scheduling needs Vercel KV / Upstash Redis and the CRON_SECRET variable. See the README.');
  }
  const ts = Date.parse(value);
  if (isNaN(ts)) throw new HttpError(400, 'Invalid schedule date.');
  if (ts < Date.now() - 60 * 1000) throw new HttpError(400, 'The schedule time is in the past.');
  if (ts > Date.now() + 366 * 24 * 3600 * 1000) throw new HttpError(400, 'Schedule is too far in the future.');
  return new Date(ts).toISOString();
}

function find(s, id) {
  const item = s.data.queue.find((i) => i.id === String(id));
  if (!item) throw new HttpError(404, 'Queue item not found.');
  return item;
}

// POST /api/queue  { action: 'create' | 'remove' | 'retry' | 'reschedule', ... }
module.exports = handle(async (req, res) => {
  requirePost(req);
  const b = body(req);
  const s = await loadSession(req, res);
  const q = s.data.queue;

  if (b.action === 'create') {
    const items = Array.isArray(b.items) ? b.items.slice(0, 20) : [];
    if (!items.length) throw new HttpError(400, 'No videos selected.');
    const max = s.mode === 'kv' ? MAX_QUEUE_KV : MAX_QUEUE_COOKIE;
    if (q.length + items.length > max) throw new HttpError(400, 'The queue is limited to ' + max + ' videos' + (s.mode === 'kv' ? '.' : ' without Vercel KV / Upstash Redis.'));
    const gtoken = await google.ensureAccess(s.data);

    const created = [];
    for (const it of items) {
      const fileId = google.validId(it.fileId);
      if (q.some((x) => x.fileId === fileId && x.status !== 'failed') || created.some((x) => x.fileId === fileId)) {
        throw new HttpError(409, 'A video is already in the queue.');
      }
      const meta = await google.getFile(gtoken, fileId);
      if (publisher.ALLOWED_MIME.indexOf(meta.mimeType) === -1) {
        throw new HttpError(400, '"' + meta.name + '" is not MP4, MOV or WebM.');
      }
      const mode = it.mode === 'direct' ? 'direct' : 'draft';
      const privacy = mode === 'direct' ? String(it.privacy || '') : null;
      if (mode === 'direct' && publisher.PRIVACY.indexOf(privacy) === -1) {
        throw new HttpError(400, 'Choose a privacy level for direct publishing.');
      }
      const caption = String(it.caption || '').slice(0, 2200);
      const o = it.opts || {};
      const scheduledAt = parseSchedule(it.scheduledAt, s);
      if (scheduledAt && b.confirmed !== true) {
        throw new HttpError(400, 'Please confirm automatic publishing for scheduled videos.');
      }
      const item = {
        id: randomId(9), fileId, name: String(meta.name).slice(0, 150), size: Number(meta.size) || 0,
        mimeType: meta.mimeType, caption, hashtags: hashtags(it.hashtags), mode, privacy,
        opts: {
          allowComment: !!o.allowComment, allowDuet: !!o.allowDuet, allowStitch: !!o.allowStitch,
          brandContent: !!o.brandContent, brandOrganic: !!o.brandOrganic
        },
        scheduledAt, auto: !!scheduledAt, status: scheduledAt ? 'scheduled' : 'pending',
        createdAt: new Date().toISOString()
      };
      if (publisher.captionText(item).length > 2200) throw new HttpError(400, 'Caption plus hashtags exceeds 2200 characters.');
      created.push(item);
    }
    created.forEach((i) => q.push(i));
  } else if (b.action === 'remove') {
    const item = find(s, b.id);
    if (item.status === 'uploading' && !item.auto) throw new HttpError(409, 'Wait for the upload to finish.');
    s.data.queue = q.filter((i) => i.id !== item.id);
  } else if (b.action === 'retry') {
    const item = find(s, b.id);
    if (item.status !== 'failed') throw new HttpError(409, 'Only failed videos can be retried.');
    item.status = 'pending';
    item.error = null;
    item.upload = null;
    item.auto = false;
    item.scheduledAt = null;
  } else if (b.action === 'reschedule') {
    const item = find(s, b.id);
    if (item.status !== 'pending' && item.status !== 'scheduled') throw new HttpError(409, 'This video can no longer be rescheduled.');
    const when = parseSchedule(b.scheduledAt, s);
    if (when && b.confirmed !== true) throw new HttpError(400, 'Please confirm automatic publishing.');
    item.scheduledAt = when;
    item.auto = !!when;
    item.status = when ? 'scheduled' : 'pending';
  } else {
    throw new HttpError(400, 'Unknown action.');
  }

  await saveSession(req, res, s);
  sendJson(res, 200, { ok: true, queue: s.data.queue.map(publisher.publicItem) });
});
