/* =========================================================
   LOCAL CSV LOGGER — drop-in, no-backend progress logging for a
   static (e.g. GitHub Pages) HTML game.

   Extracted and generalized from Word Quest after several rounds of
   real-world bugs. Pitfalls this file already fixes, so you don't
   re-discover them the hard way in a new project — see the README
   that comes with this file for the full story on each one:

     1. GitHub Pages / browser caching can serve a stale copy of your
        page for days after you push a fix. Put a visible version
        string somewhere in your UI and bump it on every deploy, or
        you will burn hours debugging a "bug" that's just an old file.
     2. Writing two CSV rows back-to-back without awaiting each one
        can race on file size/position and silently clobber a row.
        This file serializes every write through one queue.
     3. Relying only on an explicit "End Session" button to flush a
        summary row means the row never gets written if the user just
        closes the tab (the overwhelmingly common case). This file
        flushes on visibilitychange + pagehide AND on a periodic
        timer, so no single failure mode loses the whole log.
     4. The File System Access API (the thing that lets a static page
        write directly to a folder on disk) is Chrome/Edge only, over
        HTTPS or localhost. There is no workaround for Safari/Firefox
        — detect support and tell the user, don't pretend it works.

   HOW TO USE
   ----------
   <script src="local-csv-logger.js"></script>
   <script>
     const logger = LocalCsvLogger.init({
       dbName: 'my-app-fs',              // unique per app, used for IndexedDB
       files: {
         progress: {
           name: 'MyApp_Progress_Log.csv',
           header: ['timestamp','skill','correct','xp_earned']   // your columns
         },
         session: {
           name: 'MyApp_Session_Log.csv',
           header: ['timestamp','duration_minutes','total_xp']
         }
       }
     });

     // Ask the user to pick/connect a folder (call this from a button tap —
     // showDirectoryPicker requires a user gesture, it cannot be called on load)
     document.getElementById('connectBtn').onclick = () => logger.chooseFolder();

     // Log one row any time something happens (e.g. one answer)
     logger.logRow('progress', { timestamp: new Date().toISOString(), skill: 'Addition', correct: true, xp_earned: 10 });

     // Log a rolled-up row (e.g. at the end of a session) — logger.flush() is the
     // "try to write a session summary now" entry point; wire your own summary
     // builder to it (see setupAutoFlush below for why you call this instead of
     // only tying it to an explicit "End Session" button).
     function buildSessionSummary(){
       return { timestamp: new Date().toISOString(), duration_minutes: 5, total_xp: state.xp };
     }
     logger.setFlushSource('session', buildSessionSummary);
     LocalCsvLogger.setupAutoFlush(() => logger.flush('session'));
   ========================================================= */
(function(global){

  function csvField(v){
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csvRow(header, fields){
    return header.map(k => csvField(fields[k])).join(',') + '\n';
  }

  function idbOpen(dbName, storeName){
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(storeName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbSet(dbName, storeName, key, val){
    const db = await idbOpen(dbName, storeName);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbGet(dbName, storeName, key){
    const db = await idbOpen(dbName, storeName);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function init(config){
    const supportsFolderLogging = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
    const dbName = config.dbName || 'app-fs';
    const storeName = 'handles';
    const fileConfigs = config.files || {};
    const fileHandles = {};     // key -> FileSystemFileHandle
    const flushSources = {};    // key -> () => rowObject | rowObject[] | null
    let dirHandle = null;
    let pendingHandle = null;   // set when we have a remembered handle but need permission re-granted
    const onStatusChange = config.onStatusChange || function(){};

    // Every write goes through this one queue, across ALL files, so two writes
    // fired close together (e.g. a progress row and a session row at the same
    // moment) can never race on file size/position and clobber each other.
    let writeQueue = Promise.resolve();
    function queueWrite(taskFn){
      writeQueue = writeQueue.then(taskFn, taskFn);
      return writeQueue;
    }

    async function ensureFileHandle(key){
      if(!dirHandle) return null;
      if(!fileHandles[key]){
        const fc = fileConfigs[key];
        if(!fc) throw new Error(`LocalCsvLogger: no file config for "${key}"`);
        fileHandles[key] = await dirHandle.getFileHandle(fc.name, {create: true});
      }
      return fileHandles[key];
    }

    async function appendRows(key, rows){
      const handle = await ensureFileHandle(key);
      if(!handle) return;
      const header = fileConfigs[key].header;
      const file = await handle.getFile();
      let text = file.size === 0 ? header.join(',') + '\n' : '';
      for(const r of rows) text += csvRow(header, r);
      const writable = await handle.createWritable({keepExistingData: true});
      await writable.write({type: 'write', position: file.size, data: text});
      await writable.close();
    }

    function logRow(key, row){
      if(!dirHandle) return Promise.resolve();
      return queueWrite(async () => {
        try{ await appendRows(key, [row]); }
        catch(e){ console.warn(`LocalCsvLogger: could not write "${key}"`, e); }
      });
    }

    // Register a function that produces the row to write when flush(key) is
    // called with no explicit row — lets you say "flush whatever the current
    // session summary is" without rebuilding that summary at every call site.
    function setFlushSource(key, fn){ flushSources[key] = fn; }

    let lastFlushSignature = {};
    function flush(key, row){
      if(!dirHandle) return Promise.resolve();
      const data = row !== undefined ? row : (flushSources[key] ? flushSources[key]() : null);
      if(data == null) return Promise.resolve();
      const rows = Array.isArray(data) ? data : [data];
      // Skip a duplicate write if nothing changed since the last flush of this
      // key — the caller's data should include something that changes with
      // real progress (e.g. a total-attempts count); we compare its JSON.
      const sig = JSON.stringify(rows);
      if(lastFlushSignature[key] === sig) return Promise.resolve();
      lastFlushSignature[key] = sig;
      return queueWrite(async () => {
        try{ await appendRows(key, rows); }
        catch(e){ console.warn(`LocalCsvLogger: could not flush "${key}"`, e); }
      });
    }

    async function chooseFolder(){
      if(!supportsFolderLogging) return false;
      try{
        const handle = await window.showDirectoryPicker({mode: 'readwrite'});
        dirHandle = handle;
        for(const k in fileHandles) delete fileHandles[k];
        await idbSet(dbName, storeName, 'dir', handle);
        onStatusChange({connected: true, folderName: handle.name});
        return true;
      } catch(e){
        if(e && e.name !== 'AbortError') onStatusChange({connected: false, error: e});
        return false;
      }
    }

    async function reconnectFolder(){
      if(pendingHandle){
        try{
          const perm = await pendingHandle.requestPermission({mode: 'readwrite'});
          if(perm === 'granted'){
            dirHandle = pendingHandle;
            onStatusChange({connected: true, folderName: dirHandle.name});
            return true;
          }
        } catch(e){ /* fall through to re-picking a folder */ }
      }
      return chooseFolder();
    }

    async function restoreFromLastVisit(){
      if(!supportsFolderLogging){ onStatusChange({connected: false, unsupported: true}); return; }
      try{
        const handle = await idbGet(dbName, storeName, 'dir');
        if(handle){
          const perm = await handle.queryPermission({mode: 'readwrite'});
          if(perm === 'granted'){
            dirHandle = handle;
            onStatusChange({connected: true, folderName: handle.name});
          } else {
            pendingHandle = handle;
            onStatusChange({connected: false, needsReconnect: true, folderName: handle.name});
          }
        } else {
          onStatusChange({connected: false});
        }
      } catch(e){ onStatusChange({connected: false, error: e}); }
    }

    restoreFromLastVisit();

    return {
      supportsFolderLogging,
      chooseFolder,
      reconnectFolder,
      logRow,
      setFlushSource,
      flush,
      isConnected: () => !!dirHandle
    };
  }

  // Belt-and-suspenders session flush: don't rely on any single browser event.
  // Some devices/OSes never fire 'visibilitychange' or 'pagehide' reliably (a
  // tablet just left open on the page, a laptop that sleeps without the tab
  // losing focus) — this is the exact bug that cost real data in Word Quest.
  // Call flushFn() on tab-hide, on pagehide, AND on a periodic timer so no
  // single failure mode is the only thing standing between "it works" and
  // "it silently stopped working three days ago."
  function setupAutoFlush(flushFn, opts){
    opts = opts || {};
    const intervalMs = opts.intervalMs || 5 * 60 * 1000; // every 5 minutes by default
    if(typeof document !== 'undefined' && typeof document.addEventListener === 'function'){
      document.addEventListener('visibilitychange', () => {
        if(document.visibilityState === 'hidden') flushFn();
      });
    }
    if(typeof window !== 'undefined' && typeof window.addEventListener === 'function'){
      window.addEventListener('pagehide', flushFn);
    }
    if(typeof setInterval === 'function'){
      setInterval(flushFn, intervalMs);
    }
  }

  global.LocalCsvLogger = { init, setupAutoFlush };

})(typeof window !== 'undefined' ? window : globalThis);
