/* Farman Auto Publisher - dashboard (vanilla JS).
   All TikTok / Google tokens stay on the server. This file only talks to /api/* endpoints. */
(function () {
  'use strict';

  var PRIVACY = {
    PUBLIC_TO_EVERYONE: 'Everyone (public)',
    MUTUAL_FOLLOW_FRIENDS: 'Friends (mutual follows)',
    FOLLOWER_OF_CREATOR: 'Followers only',
    SELF_ONLY: 'Only me (private)'
  };
  var STATUS = {
    pending: 'Pending', scheduled: 'Scheduled', uploading: 'Uploading', processing: 'Processing at TikTok',
    published: 'Published', draft_sent: 'Sent to TikTok drafts', failed: 'Failed'
  };

  var S = { dash: null, creator: null, creatorErr: '', path: [{ id: 'root', name: 'My Drive' }], browse: null, selected: {}, count: null, busyId: null };

  function $(id) { return document.getElementById(id); }

  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === false || v == null) return;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) {
      if (c == null) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  async function api(url, opt) {
    opt = opt || {};
    var init = { method: opt.method || 'GET', credentials: 'same-origin', headers: {} };
    if (init.method === 'POST') {
      init.headers['Content-Type'] = 'application/json';
      init.headers['X-Requested-With'] = 'fetch';
      init.body = JSON.stringify(opt.body || {});
    }
    var r = await fetch(url, init);
    var j = {};
    try { j = await r.json(); } catch (e) { /* not json */ }
    if (!r.ok) throw new Error(j.error || 'Request failed (' + r.status + ')');
    return j;
  }
  function post(url, body) { return api(url, { method: 'POST', body: body }); }

  var toastTimer;
  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 5000);
  }

  function fmtSize(n) {
    if (!n) return '';
    var u = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(i ? 1 : 0) + ' ' + u[i];
  }
  function fmtDur(s) {
    if (!s) return '';
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function fmtDate(iso) { return iso ? new Date(iso).toLocaleString() : ''; }
  function toLocalInput(iso) {
    var d = new Date(iso);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function tagsFrom(str) {
    return String(str || '').split(/[\s,]+/).map(function (t) { return t.replace(/^#+/, ''); }).filter(Boolean);
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---------- banners ---------- */
  function banner(kind, text) {
    var b = $('banner');
    clear(b);
    if (text) b.appendChild(h('div', { class: 'banner ' + kind, text: text }));
  }

  /* ---------- confirmation dialog ---------- */
  function confirmDialog(title, rows, checkLabel, okLabel) {
    return new Promise(function (resolve) {
      var dlg = $('confirm-dialog');
      $('dlg-title').textContent = title;
      var body = $('dlg-body');
      clear(body);
      var dl = h('dl');
      rows.forEach(function (r) { dl.appendChild(h('dt', { text: r[0] })); dl.appendChild(h('dd', { text: r[1] })); });
      body.appendChild(dl);
      var chk = $('dlg-check');
      var ok = $('dlg-ok');
      chk.checked = false;
      ok.disabled = true;
      ok.textContent = okLabel || 'Confirm';
      $('dlg-check-label').textContent = checkLabel;
      chk.onchange = function () { ok.disabled = !chk.checked; };
      ok.onclick = function () { dlg.close(); resolve(true); };
      $('dlg-cancel').onclick = function () { dlg.close(); resolve(false); };
      dlg.oncancel = function () { resolve(false); };
      dlg.showModal();
    });
  }

  /* ---------- connections ---------- */
  function renderConnections() {
    var d = S.dash;
    var tt = $('tiktok-card');
    clear(tt);
    var head = h('div', { class: 'conn' });
    if (d.tiktok.connected) {
      var name = (S.creator && (S.creator.nickname || S.creator.username)) || d.tiktok.displayName || 'TikTok account';
      var av = (S.creator && S.creator.avatarUrl) || d.tiktok.avatarUrl;
      head.appendChild(av ? h('img', { class: 'avatar', src: av, alt: '', referrerpolicy: 'no-referrer', width: 52, height: 52 }) : h('div', { class: 'avatar', text: name.charAt(0).toUpperCase() }));
      head.appendChild(h('div', {}, [h('h2', { text: 'TikTok' }), h('span', { class: 'pill on', text: 'Connected' }), ' ', h('span', { class: 'muted', text: name })]));
      tt.appendChild(head);
      tt.appendChild(h('p', { class: 'muted', text: 'Permissions: ' + (d.tiktok.scope || '').replace(/,/g, ', ') }));
      if (d.tiktok.refreshExpiresAt) tt.appendChild(h('p', { class: 'muted', text: 'Authorization valid until ' + new Date(d.tiktok.refreshExpiresAt).toLocaleDateString() + ' (renewed automatically while you use the app).' }));
      tt.appendChild(h('button', { class: 'btn danger small', type: 'button', onclick: disconnectTikTok, text: 'Disconnect TikTok' }));
    } else {
      head.appendChild(h('div', { class: 'avatar', text: 'T' }));
      head.appendChild(h('div', {}, [h('h2', { text: 'TikTok' }), h('span', { class: 'pill off', text: 'Not connected' })]));
      tt.appendChild(head);
      tt.appendChild(h('p', { class: 'muted', text: 'Sign in on TikTok and approve posting permissions. We never see your password.' }));
      if (!d.config.tiktok) tt.appendChild(h('div', { class: 'banner warn', text: 'Server setup needed: missing environment variables ' + d.config.tiktokMissing.join(', ') + '.' }));
      tt.appendChild(h('a', { class: 'btn btn-primary', href: '/api/tiktok/auth', text: 'Connect TikTok' }));
    }

    var gc = $('google-card');
    clear(gc);
    var gh = h('div', { class: 'conn' });
    if (d.google.connected) {
      gh.appendChild(h('div', { class: 'avatar', text: 'G' }));
      gh.appendChild(h('div', {}, [h('h2', { text: 'Google Drive' }), h('span', { class: 'pill on', text: 'Connected' }), ' ', h('span', { class: 'muted', text: d.google.email || '' })]));
      gc.appendChild(gh);
      gc.appendChild(h('p', { class: 'muted', text: 'Read-only access to browse and copy the videos you select.' }));
      gc.appendChild(h('button', { class: 'btn danger small', type: 'button', onclick: disconnectGoogle, text: 'Disconnect Google Drive' }));
    } else {
      gh.appendChild(h('div', { class: 'avatar', text: 'G' }));
      gh.appendChild(h('div', {}, [h('h2', { text: 'Google Drive' }), h('span', { class: 'pill off', text: 'Not connected' })]));
      gc.appendChild(gh);
      gc.appendChild(h('p', { class: 'muted', text: 'Connect Google Drive to choose the folder that holds your videos.' }));
      if (!d.config.google) gc.appendChild(h('div', { class: 'banner warn', text: 'Server setup needed: missing environment variables ' + d.config.googleMissing.join(', ') + '.' }));
      gc.appendChild(h('a', { class: 'btn btn-primary', href: '/api/google/auth', text: 'Connect Google Drive' }));
    }
  }

  async function disconnectTikTok() {
    if (!window.confirm('Disconnect TikTok? Stored tokens will be revoked and deleted. Scheduled posts will be paused.')) return;
    try { await post('/api/tiktok/disconnect'); S.creator = null; toast('TikTok disconnected.'); await loadDash(); } catch (e) { toast(e.message, true); }
  }
  async function disconnectGoogle() {
    if (!window.confirm('Disconnect Google Drive? Stored tokens will be revoked and deleted. Scheduled posts will be paused.')) return;
    try { await post('/api/google/disconnect'); S.browse = null; S.selected = {}; S.count = null; toast('Google Drive disconnected.'); await loadDash(); } catch (e) { toast(e.message, true); }
  }

  /* ---------- stats ---------- */
  function renderStats() {
    var st = S.dash.stats;
    var items = [
      ['Total videos', S.count === null ? '—' : S.count, ''],
      ['Pending', st.pending, 'gold'],
      ['Published', st.published, ''],
      ['Sent as drafts', st.drafts, ''],
      ['Failed uploads', st.failed, 'red']
    ];
    var el = $('stats');
    clear(el);
    items.forEach(function (i) {
      el.appendChild(h('div', { class: 'glass stat ' + i[2] }, [h('b', { text: String(i[1]) }), h('span', { text: i[0] })]));
    });
  }

  /* ---------- Drive browser ---------- */
  async function loadFolder(id, pageToken) {
    try {
      var q = '/api/drive/list?folderId=' + encodeURIComponent(id) + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
      var r = await api(q);
      if (pageToken && S.browse && S.browse.folderId === id) {
        S.browse.videos = S.browse.videos.concat(r.videos);
        S.browse.next = r.nextPageToken;
      } else {
        S.browse = { folderId: id, folders: r.folders, videos: r.videos, next: r.nextPageToken };
      }
      renderDrive();
    } catch (e) { toast(e.message, true); }
  }

  function renderDrive() {
    var body = $('drive-body');
    clear(body);
    var d = S.dash;
    $('folder-label').textContent = d.folder ? 'Selected folder: ' + d.folder.name : '';
    if (!d.google.connected) { body.appendChild(h('p', { class: 'muted', text: 'Connect Google Drive to browse your videos.' })); return; }
    if (!S.browse) { body.appendChild(h('p', { class: 'muted', text: 'Loading Drive…' })); return; }

    var crumbs = h('div', { class: 'crumbs' });
    S.path.forEach(function (p, i) {
      if (i) crumbs.appendChild(document.createTextNode('/'));
      crumbs.appendChild(h('button', { type: 'button', text: p.name, onclick: function () { S.path = S.path.slice(0, i + 1); loadFolder(p.id); } }));
    });
    body.appendChild(crumbs);

    var cur = S.path[S.path.length - 1];
    var isSel = d.folder && d.folder.id === cur.id;
    body.appendChild(h('div', { class: 'folder-row' + (isSel ? ' selected-folder' : '') }, [
      h('span', { class: 'open', text: (isSel ? '✓ ' : '') + 'Current folder: ' + cur.name }),
      h('button', { type: 'button', class: 'btn btn-ghost small', disabled: isSel, text: isSel ? 'Selected as video folder' : 'Use as video folder', onclick: function () { selectFolder(cur); } })
    ]));
    if (d.folder && !isSel) {
      body.appendChild(h('div', { style: 'margin:8px 0' }, [h('button', { type: 'button', class: 'btn btn-ghost small', text: 'Go to selected folder (' + d.folder.name + ')', onclick: function () { S.path = [{ id: d.folder.id, name: d.folder.name }]; loadFolder(d.folder.id); } })]));
    }

    if (S.browse.folders.length) {
      var fl = h('div', { class: 'folder-list', style: 'margin-top:12px' });
      S.browse.folders.forEach(function (f) {
        fl.appendChild(h('div', { class: 'folder-row' }, [
          h('button', { type: 'button', class: 'open', text: '📁 ' + f.name, onclick: function () { S.path.push({ id: f.id, name: f.name }); loadFolder(f.id); } })
        ]));
      });
      body.appendChild(fl);
    }

    if (!S.browse.videos.length) {
      body.appendChild(h('p', { class: 'muted', text: 'No videos in this folder.' }));
    } else {
      var list = h('div', { class: 'folder-list' });
      S.browse.videos.forEach(function (v) {
        var cb = h('input', { type: 'checkbox', id: 'v-' + v.id });
        cb.checked = !!S.selected[v.id];
        cb.addEventListener('change', function () { toggleVideo(v, cb.checked); });
        var inQueue = S.dash.queue.some(function (q) { return q.fileId === v.id && q.status !== 'failed'; });
        if (inQueue) { cb.disabled = true; }
        list.appendChild(h('label', { class: 'video-row', for: 'v-' + v.id }, [
          cb, h('span', { class: 'vname', text: v.name }),
          h('small', { text: [fmtDur(v.durationSec), fmtSize(v.size), inQueue ? 'in queue' : ''].filter(Boolean).join(' · ') })
        ]));
      });
      body.appendChild(h('p', { class: 'muted', text: 'Tick the videos you want to publish. MP4, MOV and WebM are supported by TikTok.' }));
      body.appendChild(list);
    }
    if (S.browse.next) {
      body.appendChild(h('button', { type: 'button', class: 'btn btn-ghost small', text: 'Load more videos', onclick: function () { loadFolder(S.browse.folderId, S.browse.next); } }));
    }
  }

  async function selectFolder(f) {
    try {
      await post('/api/drive/folder', { id: f.id, name: f.name });
      S.dash.folder = { id: f.id, name: f.name };
      toast('Video folder set to "' + f.name + '".');
      await loadCount();
      renderDrive();
      renderStats();
    } catch (e) { toast(e.message, true); }
  }

  async function loadCount() {
    try {
      if (S.dash.google.connected && S.dash.folder) S.count = (await api('/api/drive/count')).count;
      else S.count = null;
    } catch (e) { S.count = null; }
  }

  /* ---------- compose ---------- */
  function toggleVideo(v, on) {
    if (on) S.selected[v.id] = S.selected[v.id] || { id: v.id, name: v.name, size: v.size, caption: $('default-caption').value, tags: $('default-tags').value };
    else delete S.selected[v.id];
    renderCompose();
  }

  function currentMode() { return document.querySelector('input[name="mode"]:checked').value; }

  function renderCreator() {
    var sel = $('privacy');
    var keep = sel.value;
    clear(sel);
    sel.appendChild(h('option', { value: '', text: 'Select privacy level…' }));
    var c = S.creator;
    var note = $('creator-note');
    if (!S.dash.tiktok.connected) { note.textContent = 'Connect TikTok to see the privacy options available to your account.'; return; }
    if (!c) { note.textContent = S.creatorErr || 'Loading your TikTok creator settings…'; return; }
    c.privacyOptions.forEach(function (o) { sel.appendChild(h('option', { value: o, text: PRIVACY[o] || o })); });
    if (keep && c.privacyOptions.indexOf(keep) !== -1) sel.value = keep;
    note.textContent = 'Posting as ' + (c.nickname || c.username || 'your TikTok account') + (c.maxDurationSec ? ' · max video length ' + Math.round(c.maxDurationSec / 60) + ' min' : '') + '. Apps that have not passed TikTok\'s audit can only post privately.';
    [['allow-comment', c.commentDisabled], ['allow-duet', c.duetDisabled], ['allow-stitch', c.stitchDisabled]].forEach(function (p) {
      var el = $(p[0]);
      el.disabled = !!p[1];
      if (p[1]) el.checked = false;
    });
  }

  function renderCompose() {
    var ids = Object.keys(S.selected);
    $('compose-section').hidden = ids.length === 0;
    $('selected-count').textContent = ids.length + ' selected';
    var direct = currentMode() === 'direct';
    $('direct-fields').hidden = !direct;
    $('draft-note').hidden = direct;
    var sched = S.dash.config.scheduling;
    $('schedule-at').disabled = !sched;
    $('schedule-note').textContent = sched
      ? 'Scheduled videos are published automatically by the server at the chosen time (checked by the scheduler job – see the README for its frequency).'
      : 'Scheduling is not enabled on this server (needs Vercel KV / Upstash Redis and CRON_SECRET). You can still add videos to the queue and publish them manually.';

    var list = $('selected-list');
    clear(list);
    ids.forEach(function (id) {
      var s = S.selected[id];
      var cap = h('textarea', { rows: 2, maxlength: 2200, 'aria-label': 'Caption for ' + s.name, placeholder: 'Caption' });
      cap.value = s.caption || '';
      cap.addEventListener('input', function () { s.caption = cap.value; });
      var tags = h('input', { type: 'text', 'aria-label': 'Hashtags for ' + s.name, placeholder: '#hashtags' });
      tags.value = s.tags || '';
      tags.addEventListener('input', function () { s.tags = tags.value; });
      list.appendChild(h('div', { class: 'sel-item' }, [
        h('div', { class: 'top' }, [h('span', { text: s.name }), h('button', { type: 'button', class: 'btn btn-ghost small', text: 'Remove', onclick: function () { delete S.selected[id]; var cb = $('v-' + id); if (cb) cb.checked = false; renderCompose(); } })]),
        cap, tags
      ]));
    });
  }

  function privacyLabel(v) { return PRIVACY[v] || v || '—'; }

  async function submitCompose(ev) {
    ev.preventDefault();
    var ids = Object.keys(S.selected);
    if (!ids.length) return;
    var mode = currentMode();
    var privacy = $('privacy').value;
    if (mode === 'direct') {
      if (!S.dash.tiktok.connected) return toast('Connect TikTok first.', true);
      if (!privacy) return toast('Choose who can view the video.', true);
      if ($('commercial').checked && !$('brand-organic').checked && !$('brand-content').checked) return toast('Select at least one commercial content option, or untick the disclosure.', true);
      if ($('brand-content').checked && $('commercial').checked && privacy === 'SELF_ONLY') return toast('Branded content cannot be private. Choose another visibility.', true);
    }
    var when = $('schedule-at').value;
    var iso = null;
    if (when) {
      var t = new Date(when);
      if (isNaN(t.getTime()) || t.getTime() < Date.now()) return toast('Pick a schedule time in the future.', true);
      iso = t.toISOString();
    }
    var commercial = $('commercial').checked;
    var opts = {
      allowComment: $('allow-comment').checked, allowDuet: $('allow-duet').checked, allowStitch: $('allow-stitch').checked,
      brandContent: commercial && $('brand-content').checked, brandOrganic: commercial && $('brand-organic').checked
    };
    var confirmed = false;
    if (iso) {
      confirmed = await confirmDialog('Confirm scheduled publishing', [
        ['Videos', ids.length + ' video(s)'],
        ['When', new Date(iso).toLocaleString()],
        ['Mode', mode === 'direct' ? 'Publish directly (' + privacyLabel(privacy) + ')' : 'Upload to TikTok drafts']
      ], 'I authorize Farman Auto Publisher to post these videos to my TikTok account automatically at this time.', 'Schedule');
      if (!confirmed) return;
    }
    var btn = $('add-queue');
    btn.disabled = true;
    try {
      await post('/api/queue', {
        action: 'create', confirmed: confirmed,
        items: ids.map(function (id) {
          var s = S.selected[id];
          return { fileId: id, caption: s.caption, hashtags: tagsFrom(s.tags), mode: mode, privacy: mode === 'direct' ? privacy : null, opts: opts, scheduledAt: iso };
        })
      });
      S.selected = {};
      toast(iso ? 'Videos scheduled.' : 'Added to the queue.');
      await loadDash();
    } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
  }

  /* ---------- queue ---------- */
  function updateItem(item) {
    var q = S.dash.queue;
    for (var i = 0; i < q.length; i++) if (q[i].id === item.id) { q[i] = item; return; }
    q.push(item);
  }

  async function runPublish(id, resume) {
    var item = S.dash.queue.filter(function (i) { return i.id === id; })[0];
    if (!item) return;
    if (!resume) {
      var rows = [
        ['Account', (S.creator && (S.creator.nickname || S.creator.username)) || 'Your TikTok account'],
        ['Video', item.name],
        ['Mode', item.mode === 'direct' ? 'Publish directly' : 'Upload to TikTok drafts']
      ];
      if (item.mode === 'direct') {
        rows.push(['Caption', ((item.caption || '') + ' ' + (item.hashtags || []).map(function (t) { return '#' + t; }).join(' ')).trim() || '(none)']);
        rows.push(['Visibility', privacyLabel(item.privacy)]);
        rows.push(['Interactions', ['Comments ' + (item.opts.allowComment ? 'on' : 'off'), 'Duet ' + (item.opts.allowDuet ? 'on' : 'off'), 'Stitch ' + (item.opts.allowStitch ? 'on' : 'off')].join(', ')]);
        rows.push(['Commercial', item.opts.brandContent ? 'Branded content' : item.opts.brandOrganic ? 'Your brand' : 'No disclosure']);
        rows.push(['Notice', item.opts.brandContent ? 'By posting, you agree to TikTok\'s Branded Content Policy and Music Usage Confirmation.' : 'By posting, you agree to TikTok\'s Music Usage Confirmation.']);
      }
      var ok = await confirmDialog(item.mode === 'direct' ? 'Publish to TikTok?' : 'Send to TikTok drafts?', rows,
        item.mode === 'direct' ? 'I confirm I want this video published to my TikTok account now.' : 'I confirm I want this video uploaded to my TikTok drafts.',
        item.mode === 'direct' ? 'Publish now' : 'Upload draft');
      if (!ok) return;
    }
    S.busyId = id;
    renderQueue();
    try {
      if (!resume && item.status !== 'processing') {
        item = (await post('/api/publish/start', { id: id, confirmed: true })).item;
        updateItem(item); renderQueue();
      }
      while (item.status === 'uploading') {
        item = (await post('/api/publish/chunk', { id: id })).item;
        updateItem(item); renderQueue();
      }
      for (var n = 0; n < 45 && item.status === 'processing'; n++) {
        await sleep(4000);
        item = (await post('/api/publish/status', { id: id })).item;
        updateItem(item); renderQueue();
      }
      if (item.status === 'published') toast('Published to TikTok.');
      else if (item.status === 'draft_sent') toast('Sent to your TikTok drafts. Open the TikTok app to finish the post.');
      else if (item.status === 'processing') toast('TikTok is still processing the video. Use "Check status" in a minute.');
    } catch (e) { toast(e.message, true); }
    S.busyId = null;
    await loadDash();
  }

  async function checkStatus(id) {
    try {
      var item = (await post('/api/publish/status', { id: id })).item;
      updateItem(item);
      toast('Status: ' + (STATUS[item.status] || item.status));
    } catch (e) { toast(e.message, true); }
    await loadDash();
  }

  async function queueAction(body, okMsg) {
    try { await post('/api/queue', body); if (okMsg) toast(okMsg); await loadDash(); } catch (e) { toast(e.message, true); }
  }

  async function setSchedule(item, value) {
    if (!value) return toast('Pick a date and time first.', true);
    var t = new Date(value);
    if (isNaN(t.getTime()) || t.getTime() < Date.now()) return toast('Pick a time in the future.', true);
    var ok = await confirmDialog('Confirm scheduled publishing', [['Video', item.name], ['When', t.toLocaleString()], ['Mode', item.mode === 'direct' ? 'Publish directly (' + privacyLabel(item.privacy) + ')' : 'Upload to TikTok drafts']],
      'I authorize Farman Auto Publisher to post this video to my TikTok account automatically at this time.', 'Schedule');
    if (ok) queueAction({ action: 'reschedule', id: item.id, scheduledAt: t.toISOString(), confirmed: true }, 'Schedule saved.');
  }

  function renderQueue() {
    var body = $('queue-body');
    clear(body);
    var q = S.dash.queue;
    if (!q.length) { body.appendChild(h('p', { class: 'muted', text: 'Nothing in the queue yet. Select videos above and add them to the queue.' })); return; }
    var table = h('table', { class: 'dtable' }, [h('thead', {}, [h('tr', {}, ['Video', 'Mode', 'Schedule', 'Status', 'Actions'].map(function (t) { return h('th', { text: t }); }))])]);
    var tb = h('tbody');
    q.forEach(function (it) {
      var busy = S.busyId === it.id;
      var anyBusy = !!S.busyId;
      var st = h('td', {}, [h('span', { class: 'badge ' + it.status, text: STATUS[it.status] || it.status })]);
      if (it.status === 'uploading' || it.status === 'processing') st.appendChild(h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': it.progress }, [h('i', { style: 'width:' + it.progress + '%' })]));
      if (it.error) st.appendChild(h('div', { class: 'err-text', text: it.error }));

      var sched = h('td');
      if (it.status === 'pending' || it.status === 'scheduled') {
        var inp = h('input', { type: 'datetime-local', 'aria-label': 'Schedule time for ' + it.name });
        if (it.scheduledAt) inp.value = toLocalInput(it.scheduledAt);
        var box = h('div', { class: 'sched' }, [inp]);
        if (S.dash.config.scheduling) {
          box.appendChild(h('button', { type: 'button', class: 'btn btn-ghost small', disabled: anyBusy, text: it.scheduledAt ? 'Update' : 'Schedule', onclick: function () { setSchedule(it, inp.value); } }));
          if (it.scheduledAt) box.appendChild(h('button', { type: 'button', class: 'btn btn-ghost small', disabled: anyBusy, text: 'Clear', onclick: function () { queueAction({ action: 'reschedule', id: it.id, scheduledAt: null }, 'Schedule cleared.'); } }));
        } else { inp.disabled = true; }
        sched.appendChild(box);
      } else { sched.textContent = it.scheduledAt ? fmtDate(it.scheduledAt) : '—'; }

      var act = h('div', { class: 'actions' });
      if (it.status === 'pending' || it.status === 'scheduled') act.appendChild(h('button', { type: 'button', class: 'btn btn-primary small', disabled: anyBusy, text: it.mode === 'direct' ? 'Publish now' : 'Upload draft', onclick: function () { runPublish(it.id, false); } }));
      if (it.status === 'uploading' && !it.auto && !busy) act.appendChild(h('button', { type: 'button', class: 'btn btn-primary small', disabled: anyBusy, text: 'Resume upload', onclick: function () { runPublish(it.id, true); } }));
      if (it.status === 'processing' && !busy) act.appendChild(h('button', { type: 'button', class: 'btn btn-ghost small', disabled: anyBusy, text: 'Check status', onclick: function () { checkStatus(it.id); } }));
      if (it.status === 'failed') act.appendChild(h('button', { type: 'button', class: 'btn btn-ghost small', disabled: anyBusy, text: 'Retry', onclick: function () { queueAction({ action: 'retry', id: it.id }, 'Ready to retry.'); } }));
      if (!(it.status === 'uploading' && !it.auto) && !busy) act.appendChild(h('button', { type: 'button', class: 'btn danger small', disabled: anyBusy, text: 'Remove', onclick: function () { queueAction({ action: 'remove', id: it.id }, 'Removed.'); } }));

      tb.appendChild(h('tr', {}, [
        h('td', { class: 'vn', text: it.name }),
        h('td', { text: it.mode === 'direct' ? 'Direct · ' + privacyLabel(it.privacy) : 'Draft' }),
        sched, st, h('td', {}, [act])
      ]));
    });
    table.appendChild(tb);
    body.appendChild(h('div', { class: 'table-wrap' }, [table]));
  }

  function renderHistory() {
    var body = $('history-body');
    clear(body);
    var hs = S.dash.history;
    if (!hs.length) { body.appendChild(h('p', { class: 'muted', text: 'No publishing history yet.' })); return; }
    var table = h('table', { class: 'dtable' }, [h('thead', {}, [h('tr', {}, ['When', 'Video', 'Mode', 'Result'].map(function (t) { return h('th', { text: t }); }))])]);
    var tb = h('tbody');
    hs.forEach(function (x) {
      tb.appendChild(h('tr', {}, [
        h('td', { text: fmtDate(x.at) }),
        h('td', { class: 'vn', text: x.name }),
        h('td', { text: x.mode === 'direct' ? 'Direct' : 'Draft' }),
        h('td', {}, [h('span', { class: 'badge ' + x.status, text: STATUS[x.status] || x.status }), x.error ? h('div', { class: 'err-text', text: x.error }) : null])
      ]));
    });
    table.appendChild(tb);
    body.appendChild(h('div', { class: 'table-wrap' }, [table]));
  }

  /* ---------- load ---------- */
  async function loadCreator() {
    if (!S.dash.tiktok.connected) { S.creator = null; return; }
    try { S.creator = await api('/api/tiktok/creator'); S.creatorErr = ''; } catch (e) { S.creator = null; S.creatorErr = e.message; }
  }

  async function loadDash() {
    try {
      S.dash = await api('/api/dashboard');
    } catch (e) {
      banner('err', e.message);
      return;
    }
    if (S.dash.storage === 'cookie') {
      banner('warn', 'Limited mode: no server-side database is configured, so data lives in an encrypted cookie. Add Vercel KV / Upstash Redis to enable scheduling, larger queues and longer history.');
    }
    if (S.dash.tiktok.connected && !S.creator) await loadCreator();
    await loadCount();
    renderConnections();
    renderStats();
    renderCreator();
    renderDrive();
    renderCompose();
    renderQueue();
    renderHistory();
    if (S.dash.google.connected && !S.browse) {
      var start = S.dash.folder ? { id: S.dash.folder.id, name: S.dash.folder.name } : { id: 'root', name: 'My Drive' };
      S.path = [start];
      loadFolder(start.id);
    }
  }

  function init() {
    var p = new URLSearchParams(location.search);
    var pre = null;
    if (p.get('tiktok') === 'connected') pre = ['ok', 'TikTok connected successfully.'];
    else if (p.get('google') === 'connected') pre = ['ok', 'Google Drive connected successfully.'];
    else if (p.get('error')) pre = ['err', p.get('error')];
    if (pre) history.replaceState(null, '', location.pathname);

    document.querySelectorAll('input[name="mode"]').forEach(function (r) { r.addEventListener('change', renderCompose); });
    $('commercial').addEventListener('change', function () { $('commercial-fields').hidden = !$('commercial').checked; });
    $('compose-form').addEventListener('submit', submitCompose);
    $('clear-selection').addEventListener('click', function () { S.selected = {}; renderCompose(); renderDrive(); });
    $('apply-defaults').addEventListener('click', function () {
      Object.keys(S.selected).forEach(function (id) { S.selected[id].caption = $('default-caption').value; S.selected[id].tags = $('default-tags').value; });
      renderCompose();
    });

    loadDash().then(function () { if (pre) banner(pre[0], pre[1]); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
