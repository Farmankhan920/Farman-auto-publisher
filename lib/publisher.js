'use strict';
const tiktok = require('./tiktok');
const google = require('./google');
const { HttpError } = require('./http');

const CHUNK = 10 * 1024 * 1024; // 10 MB (TikTok allows 5-64 MB, last chunk up to 128 MB)
const ALLOWED_MIME = ['video/mp4', 'video/quicktime', 'video/webm'];
const MAX_SIZE = 4 * 1024 * 1024 * 1024;
const PRIVACY = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];

function plan(size) {
  if (size < CHUNK) return { chunk: size, total: 1 };
  return { chunk: CHUNK, total: Math.floor(size / CHUNK) };
}

function captionText(item) {
  const tags = (item.hashtags || []).map((t) => '#' + t);
  return [item.caption || '', tags.join(' ')].filter(Boolean).join(' ').trim().slice(0, 2200);
}

function publicItem(item) {
  const u = item.upload;
  const progress = u && item.size ? Math.min(100, Math.round((u.sent / item.size) * 100)) : (item.status === 'processing' || item.status === 'published' || item.status === 'draft_sent' ? 100 : 0);
  return {
    id: item.id, fileId: item.fileId, name: item.name, size: item.size, caption: item.caption,
    hashtags: item.hashtags, mode: item.mode, privacy: item.privacy, opts: item.opts,
    scheduledAt: item.scheduledAt || null, auto: !!item.auto, status: item.status,
    error: item.error || null, progress, createdAt: item.createdAt
  };
}

function computeStats(data) {
  const q = data.queue || [];
  const h = data.history || [];
  return {
    pending: q.filter((i) => i.status !== 'failed').length,
    published: h.filter((x) => x.status === 'published').length,
    drafts: h.filter((x) => x.status === 'draft_sent').length,
    failed: q.filter((i) => i.status === 'failed').length
  };
}

function record(data, item, status, error) {
  data.history.unshift({
    id: item.id, name: item.name, caption: String(item.caption || '').slice(0, 120),
    mode: item.mode, status, at: new Date().toISOString(),
    publishId: item.upload && item.upload.publishId || item.publishId || null,
    error: error ? String(error).slice(0, 300) : null
  });
}

function failItem(data, item, message) {
  item.status = 'failed';
  item.error = String(message || 'Unknown error').slice(0, 300);
  if (item.upload) item.publishId = item.upload.publishId;
  item.upload = null;
  item.auto = false;
  record(data, item, 'failed', item.error);
}

function completeItem(data, item, status) {
  record(data, item, status, null);
  data.queue = data.queue.filter((i) => i.id !== item.id);
}

// Step 1: validate, query creator info and initialize the upload at TikTok.
async function startUpload(data, item) {
  const gtoken = await google.ensureAccess(data);
  const meta = await google.getFile(gtoken, item.fileId);
  if (meta.trashed) throw new HttpError(404, 'The video is in the Drive trash.');
  const size = Number(meta.size);
  if (!size || size > MAX_SIZE) throw new HttpError(400, 'Unsupported video size.');
  if (ALLOWED_MIME.indexOf(meta.mimeType) === -1) {
    throw new HttpError(400, 'TikTok accepts MP4, MOV or WebM only (this file is ' + meta.mimeType + ').');
  }
  item.size = size;
  item.mimeType = meta.mimeType;
  item.durationSec = meta.videoMediaMetadata && meta.videoMediaMetadata.durationMillis
    ? Math.round(Number(meta.videoMediaMetadata.durationMillis) / 1000) : null;

  const token = await tiktok.ensureAccess(data);
  const p = plan(size);
  const body = {
    source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: p.chunk, total_chunk_count: p.total }
  };
  let path = '/v2/post/publish/inbox/video/init/';

  if (item.mode === 'direct') {
    const info = await tiktok.creatorInfo(token);
    const options = info.privacy_level_options || [];
    if (options.indexOf(item.privacy) === -1) {
      throw new HttpError(400, 'The selected privacy level is not available for this TikTok account right now.');
    }
    if (info.max_video_post_duration_sec && item.durationSec && item.durationSec > info.max_video_post_duration_sec) {
      throw new HttpError(400, 'This video is longer than the ' + info.max_video_post_duration_sec + 's maximum for this creator.');
    }
    const o = item.opts || {};
    if (o.brandContent && item.privacy === 'SELF_ONLY') {
      throw new HttpError(400, 'Branded content cannot be posted with "Only me" visibility.');
    }
    body.post_info = {
      title: captionText(item),
      privacy_level: item.privacy,
      disable_comment: !!info.comment_disabled || !o.allowComment,
      disable_duet: !!info.duet_disabled || !o.allowDuet,
      disable_stitch: !!info.stitch_disabled || !o.allowStitch,
      brand_content_toggle: !!o.brandContent,
      brand_organic_toggle: !!o.brandOrganic
    };
    path = '/v2/post/publish/video/init/';
  }

  const out = await tiktok.api(path, token, { body });
  if (!out.publish_id || !out.upload_url) throw new HttpError(502, 'TikTok did not return an upload URL.');
  item.upload = {
    publishId: out.publish_id, uploadUrl: out.upload_url,
    chunkSize: p.chunk, total: p.total, next: 0, sent: 0
  };
  item.status = 'uploading';
  item.error = null;
}

// Step 2 (repeated): copy one chunk from Google Drive to TikTok.
async function sendNextChunk(data, item) {
  const u = item.upload;
  if (!u || item.status !== 'uploading') throw new HttpError(409, 'This video is not uploading.');
  const gtoken = await google.ensureAccess(data);
  const start = u.next * u.chunkSize;
  const last = u.next === u.total - 1;
  const end = last ? item.size - 1 : start + u.chunkSize - 1;
  const buf = await google.downloadRange(gtoken, item.fileId, start, end);
  if (buf.length !== end - start + 1) throw new HttpError(502, 'Google Drive returned an unexpected amount of data.');

  const ctype = ALLOWED_MIME.indexOf(item.mimeType) !== -1 ? item.mimeType : 'video/mp4';
  const r = await fetch(u.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': ctype, 'Content-Range': 'bytes ' + start + '-' + end + '/' + item.size },
    body: buf
  });
  if (!r.ok) throw new HttpError(502, 'TikTok upload failed (HTTP ' + r.status + ').');

  u.next += 1;
  u.sent = end + 1;
  if (last) {
    item.status = 'processing';
    u.uploadUrl = null;
  }
}

// Step 3: ask TikTok what happened to the upload / post.
async function pollStatus(data, item) {
  const publishId = item.upload && item.upload.publishId || item.publishId;
  if (!publishId) throw new HttpError(409, 'No publish ID for this video.');
  const token = await tiktok.ensureAccess(data);
  const d = await tiktok.api('/v2/post/publish/status/fetch/', token, { body: { publish_id: publishId } });
  const st = d.status;
  if (st === 'PUBLISH_COMPLETE') {
    completeItem(data, item, 'published');
  } else if (st === 'SEND_TO_USER_INBOX' && item.mode === 'draft') {
    completeItem(data, item, 'draft_sent');
  } else if (st === 'FAILED') {
    failItem(data, item, 'TikTok: ' + (d.fail_reason || 'processing failed'));
  }
  return st;
}

// Used by the scheduler: runs due items until the deadline.
async function processScheduled(data, deadline) {
  const items = data.queue.filter((i) => i.auto).slice();
  for (const item of items) {
    if (Date.now() > deadline) break;
    try {
      if (item.status === 'scheduled' && Date.parse(item.scheduledAt) <= Date.now()) {
        await startUpload(data, item);
      }
      while (item.status === 'uploading' && Date.now() < deadline) {
        await sendNextChunk(data, item);
      }
      if (item.status === 'processing') {
        await new Promise((r) => setTimeout(r, 3000));
        await pollStatus(data, item);
      }
    } catch (e) {
      failItem(data, item, e && e.message);
    }
  }
}

module.exports = {
  PRIVACY, ALLOWED_MIME, startUpload, sendNextChunk, pollStatus, failItem,
  publicItem, computeStats, processScheduled, captionText
};
