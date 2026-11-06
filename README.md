# Farman Auto Publisher

Static website plus Vercel serverless API. TikTok Login Kit + Content Posting API, Google Drive as the video source.
No npm dependencies, no build step.

## Project structure

```
index.html, terms-of-service/, privacy-policy/, data-deletion/, contact/   (existing site, unchanged design)
dashboard/index.html            Dashboard UI
assets/css/style.css            Site styles
assets/css/dashboard.css        Dashboard styles
assets/js/main.js               Site JS
assets/js/dashboard.js          Dashboard JS (talks to /api only, never sees tokens)
api/tiktok/auth.js              GET  /api/tiktok/auth        -> redirect to TikTok
api/tiktok/callback.js          GET  /api/tiktok/callback    -> OAuth callback (state check, code exchange)
api/tiktok/[action].js          POST /api/tiktok/disconnect, GET /api/tiktok/creator
api/google/[action].js          GET  /api/google/auth, /api/google/callback, POST /api/google/disconnect
api/drive/[action].js           GET  /api/drive/list, /api/drive/count, POST /api/drive/folder
api/dashboard.js                GET  /api/dashboard          (safe status snapshot)
api/queue.js                    POST /api/queue              (create / remove / retry / reschedule)
api/publish/[action].js         POST /api/publish/start | chunk | status
api/cron/run.js                 GET  /api/cron/run           (scheduler, protected by CRON_SECRET)
lib/                            Shared server code (not routed)
scripts/smoke-test.js           Offline test of every endpoint: node scripts/smoke-test.js
vercel.json, package.json, .env.example, robots.txt, sitemap.xml
```

That is 9 serverless functions (Vercel Hobby allows 12).

## 1. Environment variables (Vercel > Project > Settings > Environment Variables)

| Name | Required | Value |
|---|---|---|
| `TIKTOK_CLIENT_KEY` | yes | From TikTok Developer Portal |
| `TIKTOK_CLIENT_SECRET` | yes | From TikTok Developer Portal |
| `TIKTOK_REDIRECT_URI` | yes | `https://auto-three-cyan.vercel.app/api/tiktok/callback` (exactly) |
| `GOOGLE_CLIENT_ID` | for Drive | Google Cloud OAuth client |
| `GOOGLE_CLIENT_SECRET` | for Drive | Google Cloud OAuth client |
| `GOOGLE_REDIRECT_URI` | optional | Defaults to `https://auto-three-cyan.vercel.app/api/google/callback` |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | recommended | Added automatically by Vercel Storage (Upstash Redis). `UPSTASH_REDIS_REST_URL/TOKEN` also work |
| `CRON_SECRET` | for scheduling | Any long random string |
| `SESSION_SECRET` | optional | Encryption key for stored tokens. If empty, one is derived from `TIKTOK_CLIENT_SECRET` |

Only the three TikTok variables are needed to test "Connect TikTok". Everything else unlocks more features.
After adding or changing variables you must **redeploy** (Deployments > ... > Redeploy).

## 2. TikTok Developer Portal

1. Your app > **Add products**: **Login Kit** and **Content Posting API**.
2. Login Kit > **Redirect URI**: add `https://auto-three-cyan.vercel.app/api/tiktok/callback`.
3. Scopes: `user.info.basic`, `video.upload`, `video.publish`.
4. Content Posting API: enable **Direct Post** for `video.publish`. Upload-as-draft works with `video.upload`.
5. Website URL, Terms of Service URL and Privacy Policy URL point to your existing pages.
6. Until TikTok audits the app, direct posts are forced to private ("Only me") and only your **Sandbox target users** can log in. Add your TikTok account as a target user while in Sandbox.

## 3. Google Cloud (Drive)

1. console.cloud.google.com > create a project > **APIs & Services > Library** > enable **Google Drive API**.
2. **OAuth consent screen**: External, add your email as a **Test user**.
3. **Credentials > Create credentials > OAuth client ID > Web application**.
   Authorized redirect URI: `https://auto-three-cyan.vercel.app/api/google/callback`
4. Copy the Client ID and Client Secret into Vercel.

The app requests `drive.readonly` (needed to browse folders) and `userinfo.email`. `drive.readonly` is a Google *restricted* scope: it works for test users immediately, but making the app public requires Google's verification.

## 4. Server-side storage (Vercel KV / Upstash Redis)

1. Vercel project > **Storage** > **Create / Connect** > Upstash Redis (free tier is enough).
2. Connect it to this project. The `KV_REST_API_*` variables are added automatically. Redeploy.

All sessions (including TikTok/Google tokens) are encrypted with AES-256-GCM before they are stored. Without KV, the app falls back to an encrypted HttpOnly cookie ("limited mode": small queue, short history, **no scheduling**).

## 5. Deploy

1. Upload everything in this folder to your GitHub repository (replace the old files; keep your TikTok verification file in the root).
2. Vercel auto-deploys the push. Framework preset: **Other**, no build command, no output directory.
3. Open `https://auto-three-cyan.vercel.app/dashboard/`.

## 6. Scheduling

Scheduled posts are published by `/api/cron/run`. It needs KV + `CRON_SECRET`.

- `vercel.json` registers a **daily** Vercel Cron (04:00 UTC), the maximum frequency allowed on the Hobby plan. On Pro you can change it to e.g. `*/15 * * * *`.
- For a frequent schedule on the free plan, use Google Apps Script (your automation platform): create a project, add this function, and add a time-driven trigger every 5 or 15 minutes:

```javascript
function runScheduler() {
  UrlFetchApp.fetch('https://auto-three-cyan.vercel.app/api/cron/run', {
    headers: { Authorization: 'Bearer PASTE_YOUR_CRON_SECRET' },
    muteHttpExceptions: true
  });
}
```

A scheduled post is published at the first scheduler run after its time.

## 7. How publishing works

1. **Start**: server verifies the Drive file, queries TikTok creator info (allowed privacy levels, duration limit), and initializes the upload.
2. **Chunks**: the browser calls `/api/publish/chunk`; each call copies one 10 MB chunk from Google Drive straight to TikTok (the file never passes through your browser). This keeps every request short and gives real progress.
3. **Status**: `/api/publish/status` asks TikTok for the result (`PUBLISH_COMPLETE`, `SEND_TO_USER_INBOX`, `FAILED`).

The user must tick a confirmation in the dashboard before anything is published or scheduled, and the server rejects start requests without `confirmed: true`.

## Security notes

- Client secret and tokens exist only in server code/environment and encrypted storage; the dashboard API never returns them.
- OAuth `state` is random, single-use, bound to the session, and expires after 10 minutes.
- State-changing endpoints require POST, a custom header and a same-origin check (CSRF).
- Cookies are `HttpOnly; Secure; SameSite=Lax`.
- Drive IDs are validated before use in queries.

## Known limits

- TikTok draft uploads (`video.upload`) do not accept captions through the API; the user adds them in the TikTok app.
- Videos must be MP4, MOV or WebM.
- Each function call is limited to 60 seconds; large files are therefore transferred in 10 MB chunks.
- The TikTok verification file stays in the repository root, untouched. Do not add `cleanUrls` to `vercel.json`.
