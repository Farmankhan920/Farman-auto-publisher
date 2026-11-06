'use strict';
const { handle, sendJson, requirePost, body, HttpError } = require('../../lib/http');
const { loadSession, saveSession } = require('../../lib/session');
const publisher = require('../../lib/publisher');

function findItem(s, id) {
  const item = s.data.queue.find((i) => i.id === String(id));
  if (!item) throw new HttpError(404, 'Queue item not found (it may already be finished).');
  return item;
}

// All three steps are POST + JSON and run on the server. Tokens never reach the browser.
//   POST /api/publish/start   { id, confirmed:true } - validate, creator-info check, init upload at TikTok
//   POST /api/publish/chunk   { id }                  - copy the next chunk from Google Drive to TikTok
//   POST /api/publish/status  { id }                  - fetch the publish status from TikTok
module.exports = handle(async (req, res) => {
  requirePost(req);
  const action = req.query.action;
  const b = body(req);
  const s = await loadSession(req, res);
  const item = findItem(s, b.id);

  try {
    if (action === 'start') {
      if (b.confirmed !== true) throw new HttpError(400, 'Publishing must be confirmed by the user.');
      if (['pending', 'scheduled'].indexOf(item.status) === -1) throw new HttpError(409, 'This video is already being processed.');
      item.auto = false; // a manual run replaces the schedule
      item.scheduledAt = null;
      await publisher.startUpload(s.data, item);
    } else if (action === 'chunk') {
      await publisher.sendNextChunk(s.data, item);
    } else if (action === 'status') {
      await publisher.pollStatus(s.data, item);
    } else {
      throw new HttpError(404, 'Unknown action');
    }
  } catch (e) {
    if (action === 'start' || action === 'chunk') {
      // Auth/validation problems before anything was sent leave the item pending.
      if (action === 'start' && e.status && e.status < 500 && e.status !== 401 && e.status !== 502) {
        await saveSession(req, res, s);
        throw e;
      }
      publisher.failItem(s.data, item, e.message);
      await saveSession(req, res, s);
      throw e.status ? e : new HttpError(500, 'Publishing failed.');
    }
    throw e;
  }

  await saveSession(req, res, s);
  const still = s.data.queue.find((i) => i.id === item.id);
  sendJson(res, 200, {
    item: publisher.publicItem(still || Object.assign({}, item, {
      status: (s.data.history[0] && s.data.history[0].id === item.id) ? s.data.history[0].status : item.status
    }))
  });
});
