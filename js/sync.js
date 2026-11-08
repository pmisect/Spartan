/* Family sync for the Spartan Race Tracker.
 * Keeps races, profile, suggestions and photos in step across the family's phones
 * through a small Supabase database (see supabase/setup.sql).
 * Each family shares one long random sync code; the website talks to the database
 * only through functions that require that code.
 * Exposes window.TrackerSync. The app wires it up with TrackerSync.init(hooks).
 */
(() => {
  'use strict';

  const cfg = window.SPARTAN_CONFIG || {};
  const URL_BASE = (cfg.supabaseUrl || '').replace(/\/+$/, '');
  const KEY = cfg.supabaseKey || '';
  const LS_KEY = 'spartanTracker.sync';
  const TOMB_TTL = 400 * 86400000;   // forget deletions after ~13 months
  const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

  let hooks = null;
  let local = loadLocal();
  let status = { state: 'off', message: '', lastSync: local.lastSync || null };
  let running = null, again = false, timer = null, interval = null;

  function loadLocal() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveLocal() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(local)); } catch (e) { /* ignore */ }
  }

  const configured = () => !!(URL_BASE && KEY);
  const connected = () => configured() && !!local.code;

  function setStatus(state, message = '') {
    status = { state, message, lastSync: local.lastSync || null };
    if (hooks && hooks.onStatus) hooks.onStatus(Object.assign({ connected: connected(), configured: configured() }, status));
  }

  // ---------- API ----------
  async function rpc(fn, args) {
    const headers = { 'Content-Type': 'application/json', apikey: KEY };
    // New "sb_publishable_" keys go only in the apikey header; legacy anon JWTs go in both.
    if (!KEY.startsWith('sb_')) headers.Authorization = `Bearer ${KEY}`;
    const res = await fetch(`${URL_BASE}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { msg = JSON.parse(text).message || text; } catch (e) { /* keep text */ }
      const err = new Error(msg || `Sync request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }

  // ---------- Merge ----------
  function canon(x) {
    if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
    if (x && typeof x === 'object') {
      return '{' + Object.keys(x).filter(k => x[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}';
    }
    return JSON.stringify(x === undefined ? null : x);
  }
  const byId = (a, b) => String(a.id).localeCompare(String(b.id));

  function mergeTombs(a = {}, b = {}) {
    const out = {};
    const now = Date.now();
    for (const kind of ['races', 'feedback', 'photos']) {
      const m = Object.assign({}, (b && b[kind]) || {});
      for (const [id, t] of Object.entries((a && a[kind]) || {})) m[id] = Math.max(m[id] || 0, t || 0);
      for (const id of Object.keys(m)) if (now - m[id] > TOMB_TTL) delete m[id];
      out[kind] = m;
    }
    return out;
  }

  /** Combine this phone's copy (a) with the family copy (b). Newest edit of each race wins; deletions win over older edits. */
  function merge(a, b) {
    b = b || {};
    const tomb = mergeTombs(a.tomb, b.tomb);
    const races = new Map();
    for (const r of b.races || []) races.set(r.id, r);
    for (const r of a.races || []) {
      const o = races.get(r.id);
      if (!o || (r.updatedAt || 0) > (o.updatedAt || 0)) races.set(r.id, r);
    }
    const fb = new Map();
    for (const f of b.feedback || []) fb.set(f.id, f);
    for (const f of a.feedback || []) if (!fb.has(f.id) || f.sent) fb.set(f.id, f);
    const profileFromA = (a.profileUpdatedAt || 0) > (b.profileUpdatedAt || 0);
    return {
      v: 1,
      races: [...races.values()].filter(r => !((tomb.races[r.id] || 0) >= (r.updatedAt || 0))).sort(byId),
      feedback: [...fb.values()].filter(f => !tomb.feedback[f.id]).sort(byId),
      profile: profileFromA ? (a.profile || {}) : (b.profile || a.profile || {}),
      profileUpdatedAt: Math.max(a.profileUpdatedAt || 0, b.profileUpdatedAt || 0),
      tomb,
    };
  }

  // ---------- Sync ----------
  function newCode() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, x => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
  }
  function parseCode(input) {
    const s = String(input || '').trim();
    const m = s.match(/join=([a-z0-9]{20,64})/i) || s.match(/^([a-z0-9]{20,64})$/i);
    return m ? m[1].toLowerCase() : null;
  }
  function inviteLink() {
    if (!local.code) return '';
    return `${location.origin}${location.pathname}#join=${local.code}`;
  }

  async function syncData() {
    for (let attempt = 0; attempt < 4; attempt++) {
      const remote = await rpc('tracker_get', { p_code: local.code });
      if (!remote && !local.creating) {
        const err = new Error('That sync code was not found. Check the invite link.');
        err.notFound = true;
        throw err;
      }
      const mine = hooks.getDoc();
      const merged = merge(mine, remote ? remote.data : null);
      if (canon(merged) !== canon(mine)) hooks.applyDoc(merged);
      if (remote && canon(merged) === canon(remote.data)) { local.rev = remote.rev; return; }
      const res = await rpc('tracker_put', { p_code: local.code, p_data: merged, p_rev: remote ? remote.rev : 0 });
      if (res && res.ok) { local.rev = res.rev; local.creating = false; return; }
      // Someone else saved first: loop, merge with theirs and try again.
    }
    throw new Error('Sync is busy — will try again shortly.');
  }

  async function syncPhotos() {
    const PS = window.PhotoStore;
    if (!PS) return;
    const doc = hooks.getDoc();
    const tomb = (doc.tomb && doc.tomb.photos) || {};
    const raceIds = new Set((doc.races || []).map(r => r.id));
    const pending = new Set(hooks.pendingPhotoIds ? hooks.pendingPhotoIds() : []);
    const [remoteList, localList] = await Promise.all([rpc('photo_list', { p_code: local.code }), PS.listAll()]);
    const remoteIds = new Set((remoteList || []).map(p => p.id));
    const localIds = new Set(localList.map(p => p.id));
    let changed = false;

    // Deleted somewhere: remove here and on the server.
    const goneHere = localList.filter(p => tomb[p.id]).map(p => p.id);
    if (goneHere.length) { await PS.remove(goneHere); changed = true; }
    for (const p of remoteList || []) if (tomb[p.id]) await rpc('photo_delete', { p_code: local.code, p_id: p.id });

    // New on this phone: upload.
    for (const p of localList) {
      if (remoteIds.has(p.id) || tomb[p.id] || pending.has(p.id) || !raceIds.has(p.raceId)) continue;
      const rec = await PS.getRecord(p.id);
      if (!rec || !rec.blob) continue;
      setStatus('syncing', 'Uploading photos…');
      await rpc('photo_put', {
        p_code: local.code, p_id: rec.id, p_race_id: rec.raceId, p_thumb: rec.thumb,
        p_data: await PS.blobToDataUrl(rec.blob), p_added_at: rec.addedAt || null,
      });
    }

    // New elsewhere: download.
    for (const p of remoteList || []) {
      if (localIds.has(p.id) || tomb[p.id] || !raceIds.has(p.race_id)) continue;
      setStatus('syncing', 'Downloading photos…');
      const full = await rpc('photo_get', { p_code: local.code, p_id: p.id });
      if (!full || !full.data) continue;
      await PS.putRecord({
        id: full.id, raceId: full.race_id, thumb: full.thumb, blob: await PS.dataUrlToBlob(full.data),
        addedAt: full.added_at || new Date().toISOString(), takenAt: null, name: '',
      });
      changed = true;
    }
    if (changed && hooks.onPhotosChanged) await hooks.onPhotosChanged();
  }

  async function runSync() {
    if (!connected() || !hooks) return;
    if (running) { again = true; return running; }
    if (navigator.onLine === false) { setStatus('offline', 'Offline — will sync when back online'); return; }
    running = (async () => {
      setStatus('syncing', 'Syncing…');
      try {
        await syncData();
        await syncPhotos();
        local.lastSync = Date.now();
        saveLocal();
        setStatus('ok', '');
      } catch (e) {
        if (e.notFound) { setStatus('error', e.message); }
        else if (e instanceof TypeError) setStatus('offline', 'Can’t reach the sync server — will retry');
        else setStatus('error', e.message || 'Sync failed — will retry');
      } finally {
        running = null;
        if (again) { again = false; schedule(500); }
      }
    })();
    return running;
  }

  function schedule(ms = 1500) {
    if (!connected()) return;
    clearTimeout(timer);
    timer = setTimeout(runSync, ms);
  }

  // ---------- Public ----------
  async function start() {
    if (!configured()) throw new Error('Sync is not set up on this site yet.');
    local = { code: newCode(), creating: true, rev: 0, lastSync: null };
    saveLocal();
    await runSync();
    if (status.state === 'error') { const msg = status.message; disconnect(); throw new Error(msg); }
    return inviteLink();
  }

  async function join(input) {
    if (!configured()) throw new Error('Sync is not set up on this site yet.');
    const code = parseCode(input);
    if (!code) throw new Error('That doesn’t look like a sync code or invite link.');
    const prev = local;
    local = { code, creating: false, rev: 0, lastSync: null };
    saveLocal();
    await runSync();
    if (status.state === 'error') {
      const msg = status.message;
      local = prev && prev.code ? prev : {};
      saveLocal();
      setStatus(connected() ? 'ok' : 'off');
      throw new Error(msg);
    }
  }

  function disconnect() {
    local = {};
    saveLocal();
    setStatus('off');
  }

  function init(h) {
    hooks = h;
    setStatus(connected() ? 'idle' : 'off');
    if (!configured()) return;
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(300); });
    window.addEventListener('online', () => schedule(300));
    window.addEventListener('focus', () => schedule(300));
    clearInterval(interval);
    interval = setInterval(() => { if (document.visibilityState === 'visible') runSync(); }, 60000);
    if (connected()) schedule(200);
  }

  window.TrackerSync = {
    init, start, join, disconnect, inviteLink, parseCode,
    syncNow: runSync, changed: () => schedule(1500),
    isConfigured: configured, isConnected: connected, status: () => Object.assign({ connected: connected(), configured: configured() }, status),
    _merge: merge, _canon: canon,
  };
})();
