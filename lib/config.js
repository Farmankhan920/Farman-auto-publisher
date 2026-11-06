'use strict';

const env = (name) => (process.env[name] || '').trim();

const TIKTOK_SCOPES = ['user.info.basic', 'video.upload', 'video.publish'];
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/userinfo.email'
];

function appOrigin() {
  try { return new URL(env('TIKTOK_REDIRECT_URI')).origin; } catch (e) { return ''; }
}

function googleRedirectUri() {
  return env('GOOGLE_REDIRECT_URI') || (appOrigin() ? appOrigin() + '/api/google/callback' : '');
}

// Server-side storage: Vercel KV or Upstash Redis (REST). Optional.
function kvConfig() {
  const url = env('KV_REST_API_URL') || env('UPSTASH_REDIS_REST_URL');
  const token = env('KV_REST_API_TOKEN') || env('UPSTASH_REDIS_REST_TOKEN');
  return url && token ? { url, token } : null;
}

function missingTikTok() {
  return ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REDIRECT_URI'].filter((n) => !env(n));
}

function missingGoogle() {
  const m = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'].filter((n) => !env(n));
  if (!googleRedirectUri()) m.push('GOOGLE_REDIRECT_URI');
  return m;
}

module.exports = {
  env, TIKTOK_SCOPES, GOOGLE_SCOPES, appOrigin, googleRedirectUri,
  kvConfig, missingTikTok, missingGoogle
};
