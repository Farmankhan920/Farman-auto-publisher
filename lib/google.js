'use strict';
const { env, GOOGLE_SCOPES, googleRedirectUri } = require('./config');
const { HttpError } = require('./http');

const ID_RE = /^(root|[A-Za-z0-9_-]{5,120})$/;
const DRIVE = 'https://www.googleapis.com/drive/v3';

function validId(id) {
  if (!ID_RE.test(String(id || ''))) throw new HttpError(400, 'Invalid Drive ID.');
  return String(id);
}

function buildAuthUrl(state) {
  const p = new URLSearchParams({
    client_id: env('GOOGLE_CLIENT_ID'),
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}

async function tokenPost(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  });
  let j = {};
  try { j = await r.json(); } catch (e) { /* ignore */ }
  if (!r.ok || j.error) throw new HttpError(502, 'Google: ' + (j.error_description || j.error || 'HTTP ' + r.status));
  return j;
}

function exchangeCode(code) {
  return tokenPost({
    code,
    client_id: env('GOOGLE_CLIENT_ID'),
    client_secret: env('GOOGLE_CLIENT_SECRET'),
    redirect_uri: googleRedirectUri(),
    grant_type: 'authorization_code'
  });
}

function applyTokens(data, j) {
  const prev = data.google || {};
  data.google = Object.assign({}, prev, {
    accessToken: j.access_token,
    accessExpiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000,
    refreshToken: j.refresh_token || prev.refreshToken,
    scope: j.scope || prev.scope,
    connectedAt: prev.connectedAt || Date.now()
  });
}

async function ensureAccess(data) {
  const g = data.google;
  if (!g || !g.accessToken) throw new HttpError(401, 'Google Drive is not connected.');
  if (g.accessExpiresAt && g.accessExpiresAt > Date.now() + 60 * 1000) return g.accessToken;
  if (!g.refreshToken) {
    data.google = null;
    throw new HttpError(401, 'Google authorization expired. Please reconnect Google Drive.');
  }
  try {
    applyTokens(data, await tokenPost({
      client_id: env('GOOGLE_CLIENT_ID'),
      client_secret: env('GOOGLE_CLIENT_SECRET'),
      refresh_token: g.refreshToken,
      grant_type: 'refresh_token'
    }));
  } catch (e) {
    data.google = null;
    throw new HttpError(401, 'Google authorization could not be refreshed. Please reconnect Google Drive.');
  }
  return data.google.accessToken;
}

async function revoke(token) {
  try {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString()
    });
  } catch (e) { /* best effort */ }
}

async function userEmail(token) {
  const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return '';
  const j = await r.json();
  return j.email || '';
}

async function driveJson(token, path, params) {
  const r = await fetch(DRIVE + path + '?' + new URLSearchParams(params).toString(), {
    headers: { Authorization: 'Bearer ' + token }
  });
  let j = {};
  try { j = await r.json(); } catch (e) { /* ignore */ }
  if (!r.ok) {
    const msg = (j.error && j.error.message) || 'HTTP ' + r.status;
    throw new HttpError(r.status === 401 ? 401 : r.status === 404 ? 404 : 502, 'Google Drive: ' + msg);
  }
  return j;
}

const COMMON = { supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' };

async function listFolders(token, parent) {
  const id = validId(parent);
  const j = await driveJson(token, '/files', Object.assign({
    q: "'" + id + "' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false",
    fields: 'files(id,name)', pageSize: '100', orderBy: 'name'
  }, COMMON));
  return j.files || [];
}

async function listVideos(token, parent, pageToken) {
  const id = validId(parent);
  const params = Object.assign({
    q: "'" + id + "' in parents and mimeType contains 'video/' and trashed=false",
    fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,videoMediaMetadata(durationMillis))',
    pageSize: '100', orderBy: 'name'
  }, COMMON);
  if (pageToken) params.pageToken = String(pageToken).slice(0, 500);
  const j = await driveJson(token, '/files', params);
  return { files: j.files || [], nextPageToken: j.nextPageToken || null };
}

async function countVideos(token, parent) {
  const id = validId(parent);
  let total = 0;
  let pageToken = null;
  for (let i = 0; i < 10; i++) {
    const params = Object.assign({
      q: "'" + id + "' in parents and mimeType contains 'video/' and trashed=false",
      fields: 'nextPageToken,files(id)', pageSize: '1000'
    }, COMMON);
    if (pageToken) params.pageToken = pageToken;
    const j = await driveJson(token, '/files', params);
    total += (j.files || []).length;
    pageToken = j.nextPageToken;
    if (!pageToken) break;
  }
  return total;
}

async function getFile(token, fileId) {
  const id = validId(fileId);
  return driveJson(token, '/files/' + id, Object.assign({
    fields: 'id,name,mimeType,size,trashed,videoMediaMetadata(durationMillis)'
  }, { supportsAllDrives: 'true' }));
}

// Downloads bytes [start, end] (inclusive) of a Drive file.
async function downloadRange(token, fileId, start, end) {
  const id = validId(fileId);
  const r = await fetch(DRIVE + '/files/' + id + '?alt=media&supportsAllDrives=true', {
    headers: { Authorization: 'Bearer ' + token, Range: 'bytes=' + start + '-' + end }
  });
  if (r.status !== 206 && !(r.status === 200 && start === 0)) {
    throw new HttpError(502, 'Google Drive download failed (HTTP ' + r.status + ').');
  }
  const buf = Buffer.from(await r.arrayBuffer());
  return r.status === 200 ? buf.subarray(0, end - start + 1) : buf;
}

module.exports = {
  validId, buildAuthUrl, exchangeCode, applyTokens, ensureAccess, revoke, userEmail,
  listFolders, listVideos, countVideos, getFile, downloadRange
};
