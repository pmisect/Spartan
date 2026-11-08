/* Photo storage for the Spartan Race Tracker.
 * Photos are resized in the browser and kept in IndexedDB on this device.
 * Exposes window.PhotoStore.
 */
(() => {
  'use strict';

  const DB_NAME = 'spartanTrackerPhotos';
  const STORE = 'photos';
  const FULL_MAX = 1600;   // longest edge in px for the saved photo
  const THUMB_MAX = 360;   // longest edge for thumbnails
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('Photo storage is not available in this browser.')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('raceId', 'raceId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Could not open photo storage.'));
    });
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
  }

  async function tx(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const os = t.objectStore(STORE);
      let result;
      Promise.resolve(fn(os)).then(r => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Photo storage was interrupted.'));
    });
  }
  const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

  async function loadImage(file) {
    if ('createImageBitmap' in window) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* fall back */ }
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a photo this browser can open.')); };
      img.src = url;
    });
  }

  function draw(img, max) {
    const w0 = img.width, h0 = img.height;
    const scale = Math.min(1, max / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    return c;
  }
  const toBlob = (canvas, q) => new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('Could not process photo.')), 'image/jpeg', q));

  const newId = () => 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  /** Resize a picked file and save it for a race. Returns the stored record (without the blob). */
  async function add(raceId, file) {
    const img = await loadImage(file);
    const full = await toBlob(draw(img, FULL_MAX), 0.82);
    const thumbCanvas = draw(img, THUMB_MAX);
    const thumb = thumbCanvas.toDataURL('image/jpeg', 0.75);
    if (img.close) img.close();
    const rec = {
      id: newId(), raceId, blob: full, thumb,
      width: thumbCanvas.width, height: thumbCanvas.height,
      name: file.name || '', addedAt: new Date().toISOString(),
      takenAt: file.lastModified ? new Date(file.lastModified).toISOString() : null,
    };
    await tx('readwrite', os => os.put(rec));
    requestPersist();
    const { blob, ...meta } = rec;
    return meta;
  }

  async function listForRace(raceId) {
    return tx('readonly', os => reqP(os.index('raceId').getAll(raceId)))
      .then(rows => (rows || []).map(({ blob, ...meta }) => meta).sort((a, b) => a.addedAt.localeCompare(b.addedAt)));
  }

  async function listAll() {
    return tx('readonly', os => reqP(os.getAll()))
      .then(rows => (rows || []).map(({ blob, ...meta }) => meta));
  }

  async function getBlob(id) {
    const rec = await tx('readonly', os => reqP(os.get(id)));
    return rec ? rec.blob : null;
  }

  async function remove(ids) {
    if (!ids || !ids.length) return;
    await tx('readwrite', os => { ids.forEach(id => os.delete(id)); });
  }

  async function removeForRace(raceId) {
    const rows = await listForRace(raceId);
    await remove(rows.map(r => r.id));
  }

  async function clear() {
    await tx('readwrite', os => os.clear());
  }

  const blobToDataUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
  async function dataUrlToBlob(url) { const r = await fetch(url); return r.blob(); }

  /** All photos with their image data as data URLs, for backups. */
  async function exportAll() {
    const rows = await tx('readonly', os => reqP(os.getAll()));
    const out = [];
    for (const r of rows || []) {
      const { blob, ...meta } = r;
      out.push(Object.assign(meta, { data: await blobToDataUrl(blob) }));
    }
    return out;
  }

  /** Replace all photos with the ones from a backup. */
  async function importAll(list) {
    const recs = [];
    for (const p of list || []) {
      if (!p || !p.id || !p.raceId || !p.data || !/^data:image\//.test(p.data)) continue;
      const { data, ...meta } = p;
      recs.push(Object.assign(meta, { blob: await dataUrlToBlob(data) }));
    }
    await tx('readwrite', os => { os.clear(); recs.forEach(r => os.put(r)); });
    return recs.length;
  }

  /** Full stored record (including the image blob), or null. */
  async function getRecord(id) {
    return (await tx('readonly', os => reqP(os.get(id)))) || null;
  }
  /** Store a complete record as-is (used by sync). */
  async function putRecord(rec) {
    await tx('readwrite', os => os.put(rec));
  }

  let persistAsked = false;
  function requestPersist() {
    if (persistAsked) return;
    persistAsked = true;
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* ignore */ }
  }

  window.PhotoStore = { add, listForRace, listAll, getBlob, getRecord, putRecord, remove, removeForRace, clear, exportAll, importAll, blobToDataUrl, dataUrlToBlob };
})();
