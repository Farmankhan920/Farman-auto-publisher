'use strict';
const { handle, sendJson, requirePost, requireGet, body, HttpError } = require('../../lib/http');
const { loadSession, saveSession } = require('../../lib/session');
const google = require('../../lib/google');

// GET  /api/drive/list?folderId=root|<id>&pageToken=  - sub-folders + videos of a folder
// GET  /api/drive/count                               - number of videos in the selected folder
// POST /api/drive/folder  {id, name}                  - select the video folder (id=null clears it)
module.exports = handle(async (req, res) => {
  const action = req.query.action;
  const s = await loadSession(req, res);

  if (action === 'list') {
    requireGet(req);
    const token = await google.ensureAccess(s.data);
    const folderId = google.validId(req.query.folderId || 'root');
    const pageToken = req.query.pageToken || null;
    const [folders, videos] = await Promise.all([
      pageToken ? Promise.resolve([]) : google.listFolders(token, folderId),
      google.listVideos(token, folderId, pageToken)
    ]);
    await saveSession(req, res, s);
    return sendJson(res, 200, {
      folderId, folders,
      videos: videos.files.map((f) => ({
        id: f.id, name: f.name, mimeType: f.mimeType, size: Number(f.size) || 0,
        modifiedTime: f.modifiedTime,
        durationSec: f.videoMediaMetadata && f.videoMediaMetadata.durationMillis
          ? Math.round(Number(f.videoMediaMetadata.durationMillis) / 1000) : null
      })),
      nextPageToken: videos.nextPageToken
    });
  }

  if (action === 'count') {
    requireGet(req);
    if (!s.data.folder) return sendJson(res, 200, { count: 0 });
    const token = await google.ensureAccess(s.data);
    const count = await google.countVideos(token, s.data.folder.id);
    await saveSession(req, res, s);
    return sendJson(res, 200, { count });
  }

  if (action === 'folder') {
    requirePost(req);
    const b = body(req);
    if (b.id === null) {
      delete s.data.folder;
    } else {
      s.data.folder = { id: google.validId(b.id), name: String(b.name || 'Folder').slice(0, 120) };
    }
    await saveSession(req, res, s);
    return sendJson(res, 200, { folder: s.data.folder || null });
  }

  throw new HttpError(404, 'Unknown action');
});
