'use strict';
const { env, TIKTOK_SCOPES } = require('./config');
const { HttpError } = require('./http');

const API = 'https://open.tiktokapis.com';

const FRIENDLY = {
  unaudited_client_can_only_post_to_private_accounts:
    'Your TikTok app has not passed TikTok\'s audit yet, so posts can only be published privately (Only me).',
  spam_risk_too_many_posts: 'TikTok reports the daily posting limit was reached. Try again later.',
  spam_risk_user_banned_from_posting: 'TikTok has blocked this account from posting.',
  reached_active_user_cap: 'TikTok\'s daily cap on active publishers for this app was reached.',
  scope_not_authorized: 'Missing permission. Disconnect and reconnect TikTok, approving all requested permissions.',
  access_token_invalid: 'TikTok authorization expired. Please reconnect TikTok.',
  invalid_file_upload: 'TikTok rejected the video file (format, size or duration).',
  file_format_check_failed: 'TikTok rejected the video format. Use MP4, MOV or WebM (H.264 recommended).',
  duration_check_failed: 'The video duration is not allowed for this creator.',
  privacy_level_option_mismatch: 'The chosen privacy level is not available for this creator.'
};

async function postForm(path, params) {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams(params).toString()
  });
  let j = {};
  try { j = await r.json(); } catch (e) { /* ignore */ }
  if (!r.ok || j.error) {
    throw new HttpError(502, 'TikTok: ' + (j.error_description || j.error || 'HTTP ' + r.status));
  }
  return j;
}

function buildAuthUrl(state) {
  const p = new URLSearchParams({
    client_key: env('TIKTOK_CLIENT_KEY'),
    scope: TIKTOK_SCOPES.join(','),
    response_type: 'code',
    redirect_uri: env('TIKTOK_REDIRECT_URI'),
    state
  });
  return 'https://www.tiktok.com/v2/auth/authorize/?' + p.toString();
}

function exchangeCode(code) {
  return postForm('/v2/oauth/token/', {
    client_key: env('TIKTOK_CLIENT_KEY'),
    client_secret: env('TIKTOK_CLIENT_SECRET'),
    code,
    grant_type: 'authorization_code',
    redirect_uri: env('TIKTOK_REDIRECT_URI')
  });
}

function refreshTokens(refreshToken) {
  return postForm('/v2/oauth/token/', {
    client_key: env('TIKTOK_CLIENT_KEY'),
    client_secret: env('TIKTOK_CLIENT_SECRET'),
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });
}

async function revoke(token) {
  try {
    await postForm('/v2/oauth/revoke/', {
      client_key: env('TIKTOK_CLIENT_KEY'),
      client_secret: env('TIKTOK_CLIENT_SECRET'),
      token
    });
  } catch (e) { /* best effort: local tokens are deleted regardless */ }
}

function applyTokens(data, j) {
  const now = Date.now();
  const prev = data.tiktok || {};
  data.tiktok = Object.assign({}, prev, {
    openId: j.open_id || prev.openId,
    accessToken: j.access_token,
    accessExpiresAt: now + (Number(j.expires_in) || 86400) * 1000,
    refreshToken: j.refresh_token || prev.refreshToken,
    refreshExpiresAt: j.refresh_expires_in ? now + Number(j.refresh_expires_in) * 1000 : prev.refreshExpiresAt,
    scope: j.scope || prev.scope,
    connectedAt: prev.connectedAt || now
  });
}

// Returns a valid access token, refreshing it when it is about to expire.
// The caller must save the session afterwards (tokens may have changed).
async function ensureAccess(data) {
  const t = data.tiktok;
  if (!t || !t.accessToken) throw new HttpError(401, 'TikTok is not connected.');
  if (t.accessExpiresAt && t.accessExpiresAt > Date.now() + 60 * 1000) return t.accessToken;
  if (!t.refreshToken || (t.refreshExpiresAt && t.refreshExpiresAt < Date.now())) {
    data.tiktok = null;
    throw new HttpError(401, 'TikTok authorization expired. Please reconnect TikTok.');
  }
  try {
    applyTokens(data, await refreshTokens(t.refreshToken));
  } catch (e) {
    data.tiktok = null;
    throw new HttpError(401, 'TikTok authorization could not be refreshed. Please reconnect TikTok.');
  }
  return data.tiktok.accessToken;
}

async function api(path, token, opts) {
  const o = opts || {};
  const r = await fetch(API + path, {
    method: o.method || 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=UTF-8' },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined
  });
  let j = {};
  try { j = await r.json(); } catch (e) { /* ignore */ }
  const e = j.error;
  if (!r.ok || (e && e.code && e.code !== 'ok')) {
    const code = e && e.code;
    const err = new HttpError(r.status === 401 ? 401 : 502,
      FRIENDLY[code] || 'TikTok: ' + ((e && (e.message || e.code)) || 'HTTP ' + r.status));
    err.tiktokCode = code;
    throw err;
  }
  return j.data || {};
}

async function userInfo(token) {
  const d = await api('/v2/user/info/?fields=open_id,avatar_url,display_name', token, { method: 'GET' });
  return d.user || {};
}

function creatorInfo(token) {
  return api('/v2/post/publish/creator_info/query/', token);
}

module.exports = {
  buildAuthUrl, exchangeCode, refreshTokens, revoke, applyTokens, ensureAccess,
  api, userInfo, creatorInfo
};
