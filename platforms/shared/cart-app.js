/*
  Generic cartridge-based web player (SNES/GBA) built on top of Nostalgist.

  Forked from app.js (NES) but made configurable via window.GAMEWEB_SYSTEM.

  Supported systems:
  - snes: core snes9x, extensions .sfc/.smc
  - gba:  core mgba, extensions .gba

  Notes:
  - ROM/BIOS are not provided.
  - Drive links can be FILE or FOLDER. Folder listing uses server.js proxy by default.
*/

(() => {
  "use strict";

  // === SYSTEM CONFIG ===

  const SYSTEMS = Object.freeze({
    snes: {
      id: "snes",
      title: "SNES Web Player",
      core: "snes9x",
      romExtensions: [".sfc", ".smc"],
      defaultRomExtension: ".sfc",
      canvasSize: { width: 512, height: 448 },
      // Controls: SNES has more buttons; we expose the common RetroArch inputs.
      defaultKeybinds: Object.freeze({
        up: "up",
        down: "down",
        left: "left",
        right: "right",
        a: "x",
        b: "z",
        x: "s",
        y: "a",
        l: "q",
        r: "e",
        start: "enter",
        select: "shift",
      }),
      keyActions: [
        { id: "up", label: "Lên" },
        { id: "down", label: "Xuống" },
        { id: "left", label: "Trái" },
        { id: "right", label: "Phải" },
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "x", label: "X" },
        { id: "y", label: "Y" },
        { id: "l", label: "L" },
        { id: "r", label: "R" },
        { id: "start", label: "Start" },
        { id: "select", label: "Select" },
      ],
      keyHint: (b) =>
        `Phím: ←→↑↓ | ${fmt(b.y)}=Y | ${fmt(b.x)}=X | ${fmt(b.b)}=B | ${fmt(
          b.a
        )}=A | ${fmt(b.l)}/${fmt(b.r)}=L/R | ${fmt(b.start)}=Start | ${fmt(
          b.select
        )}=Select`,
      platformMatch: (platformsRaw) => {
        const p = String(platformsRaw || "").toLowerCase();
        return (
          /(^|[\s,;|\/]+)snes($|[\s,;|\/]+)/i.test(p) ||
          /(^|[\s,;|\/]+)sfc($|[\s,;|\/]+)/i.test(p) ||
          p.includes("super nintendo") ||
          p.includes("super famicom")
        );
      },
    },

    gba: {
      id: "gba",
      title: "GBA Web Player",
      core: "mgba",
      romExtensions: [".gba"],
      defaultRomExtension: ".gba",
      canvasSize: { width: 480, height: 320 },
      defaultKeybinds: Object.freeze({
        up: "up",
        down: "down",
        left: "left",
        right: "right",
        a: "z",
        b: "x",
        l: "q",
        r: "e",
        start: "enter",
        select: "shift",
      }),
      keyActions: [
        { id: "up", label: "Lên" },
        { id: "down", label: "Xuống" },
        { id: "left", label: "Trái" },
        { id: "right", label: "Phải" },
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "l", label: "L" },
        { id: "r", label: "R" },
        { id: "start", label: "Start" },
        { id: "select", label: "Select" },
      ],
      keyHint: (b) =>
        `Phím: ←→↑↓ | ${fmt(b.a)}=A | ${fmt(b.b)}=B | ${fmt(b.l)}/${fmt(
          b.r
        )}=L/R | ${fmt(b.start)}=Start | ${fmt(b.select)}=Select`,
      platformMatch: (platformsRaw) => {
        const p = String(platformsRaw || "").toLowerCase();
        return (
          /(^|[\s,;|\/]+)gba($|[\s,;|\/]+)/i.test(p) ||
          p.includes("game boy advance")
        );
      },
    },
  });

  const requestedSystem = String(window.GAMEWEB_SYSTEM || "snes")
    .trim()
    .toLowerCase();
  const system = SYSTEMS[requestedSystem] || SYSTEMS.snes;

  // Update <title> if present
  try {
    document.title = system.title;
  } catch {
    // ignore
  }

  // === CONFIG ===

  const SHEET_ID = "1K2gbc06V4UxFcZWOZGk1ML7zUUc6-vzT_CaPB2Cx4Q4";
  const SHEET_TAB_NAME = "Sheet1";

  // Drive API key (client-side) — DO NOT put secrets here.
  // Use server.js proxy instead and set DRIVE_API_KEY in .env / env variables.
  const DRIVE_API_KEY = "";

  // Default: use server.js proxy (/api/drive/*) to keep API key private.
  // - false: browser gọi Drive API trực tiếp (KHÔNG khuyến nghị vì lộ key)
  // - true: đi qua server.js proxy (/api/drive/*)
  const USE_DRIVE_PROXY = true;
  const DRIVE_PROXY_BASE = "";

  const DRIVE_API_MIN_INTERVAL_MS = 800;
  const DRIVE_API_MAX_RETRIES = 4;
  const DRIVE_FOLDER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

  // FPS cap
  const TARGET_FPS = 60;

  // === UI ===

  const els = {
    gameList: document.getElementById("gameList"),
    status: document.getElementById("status"),
    sourceStatus: document.getElementById("sourceStatus"),
    nowPlaying: document.getElementById("nowPlaying"),
    btnReload: document.getElementById("btnReload"),
    btnStop: document.getElementById("btnStop"),
    btnKeySettings: document.getElementById("btnKeySettings"),
    btnPickRomFolder: document.getElementById("btnPickRomFolder"),
    btnDownloadRom: document.getElementById("btnDownloadRom"),
    keyHint: document.getElementById("keyHint"),
    keySettingsModal: document.getElementById("keySettingsModal"),
    keySettingsList: document.getElementById("keySettingsList"),
    keySettingsNote: document.getElementById("keySettingsNote"),
    btnKeySettingsClose: document.getElementById("btnKeySettingsClose"),
    btnKeySettingsReset: document.getElementById("btnKeySettingsReset"),
    btnKeySettingsSave: document.getElementById("btnKeySettingsSave"),
    btnSaveState: document.getElementById("btnSaveState"),
    btnLoadState: document.getElementById("btnLoadState"),
    fileLoadState: document.getElementById("fileLoadState"),
    canvas: document.getElementById("screen"),
    search: document.getElementById("search"),
    pager: document.getElementById("pager"),
    btnFullscreen: document.getElementById("btnFullscreen"),
    screenWrap: document.getElementById("screenWrap"),

    // Loading overlay
    loadingOverlay: document.getElementById("loadingOverlay"),
    loadingTitle: document.getElementById("loadingTitle"),
    loadingBarFill: document.getElementById("loadingBarFill"),
    loadingMetaLeft: document.getElementById("loadingMetaLeft"),
    loadingPct: document.getElementById("loadingPct"),
  };

  // === Performance panel (optional UI) ===

  function mountPerfPanel() {
    const meta = document.querySelector(".sidebar__meta");
    if (!meta) return null;
    const existing = meta.querySelector("#perfFps");
    if (existing) {
      return {
        fpsEl: meta.querySelector("#perfFps"),
      };
    }

    function makeRow(labelText, id) {
      const row = document.createElement("div");
      row.className = "row perfRow";

      const label = document.createElement("span");
      label.className = "label";
      label.textContent = labelText;

      const value = document.createElement("span");
      value.className = "value";
      value.id = id;
      value.textContent = "—";

      row.appendChild(label);
      row.appendChild(value);
      return row;
    }

    meta.appendChild(makeRow("FPS:", "perfFps"));

    return {
      fpsEl: meta.querySelector("#perfFps"),
    };
  }

  function startPerfPanel() {
    const ui = mountPerfPanel();
    if (!ui) return;

    let fps = 0;
    let frames = 0;
    let last = performance.now();

    function onFrame(ts) {
      frames += 1;
      const dt = ts - last;
      if (dt >= 1000) {
        fps = (frames * 1000) / dt;
        frames = 0;
        last = ts;
      }
      requestAnimationFrame(onFrame);
    }
    requestAnimationFrame(onFrame);

    setInterval(() => {
      if (ui.fpsEl) ui.fpsEl.textContent = fps ? `${fps.toFixed(0)}` : "—";
    }, 500);
  }

  // === Helpers ===

  function setStatus(text) {
    if (els.status) els.status.textContent = text || "";
  }

  function setNowPlaying(text) {
    if (els.nowPlaying) els.nowPlaying.textContent = text || "(chưa chọn)";
  }

  function setButtonsRunning(running) {
    const on = !!running;
    if (els.btnStop) els.btnStop.disabled = !on;
    if (els.btnSaveState) els.btnSaveState.disabled = !on;
    if (els.btnLoadState) els.btnLoadState.disabled = !on;
  }

  function setDownloadButtonEnabled(enabled) {
    if (!els.btnDownloadRom) return;
    els.btnDownloadRom.disabled = !enabled;
  }

  function setLoadingVisible(visible) {
    if (!els.loadingOverlay) return;
    els.loadingOverlay.hidden = !visible;
  }

  function setLoadingProgress({ title, metaLeft, pct }) {
    if (els.loadingTitle && typeof title === "string") {
      els.loadingTitle.textContent = title;
    }
    if (els.loadingMetaLeft && typeof metaLeft === "string") {
      els.loadingMetaLeft.textContent = metaLeft;
    }

    const clamped = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
    if (els.loadingPct) els.loadingPct.textContent = `${Math.round(clamped)}%`;
    if (els.loadingBarFill) els.loadingBarFill.style.width = `${clamped}%`;
  }

  function safeFilePart(s) {
    return String(s || "")
      .trim()
      .replaceAll(/[\\/:*?"<>|]/g, "-")
      .replaceAll(/\s+/g, " ")
      .slice(0, 80);
  }

  function formatBytes(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"]; // enough
    let x = v;
    let i = 0;
    while (x >= 1024 && i < units.length - 1) {
      x /= 1024;
      i++;
    }
    const digits = i === 0 ? 0 : i === 1 ? 0 : 1;
    return `${x.toFixed(digits)} ${units[i]}`;
  }

  function fileExtension(name) {
    const s = String(name || "");
    const m = s.match(/(\.[a-z0-9]{1,6})$/i);
    return m ? m[1].toLowerCase() : "";
  }

  function hasAnyRomExtension(linkOrName) {
    const s = String(linkOrName || "").toLowerCase();
    return system.romExtensions.some((ext) => s.includes(ext));
  }

  function pickFirstMatchingFile(files, exts) {
    const list = Array.isArray(files) ? files : [];
    for (const ext of exts) {
      const found = list.find(
        (f) =>
          f &&
          typeof f.name === "string" &&
          f.name.toLowerCase().endsWith(ext.toLowerCase())
      );
      if (found) return found;
    }
    return null;
  }

  function assertNotEmptyRom(bytes, sourceUrl) {
    if (bytes && bytes.length > 0) return;
    throw new Error(`ROM tải về rỗng/không hợp lệ. URL: ${sourceUrl}`);
  }

  // === Key bindings (user settings) ===

  const KEYBINDS_STORAGE_KEY = `gameweb.${system.id}.keybinds.v1`;
  const DEFAULT_KEYBINDS = system.defaultKeybinds;
  const KEY_ACTIONS = system.keyActions;

  function formatKeyForDisplay(key) {
    const k = String(key || "").toLowerCase();
    if (k === "up") return "↑";
    if (k === "down") return "↓";
    if (k === "left") return "←";
    if (k === "right") return "→";
    if (k === "enter") return "Enter";
    if (k === "shift") return "Shift";
    if (k === "escape") return "Esc";
    if (k === "space") return "Space";
    if (k === "tab") return "Tab";
    if (k === "backspace") return "Backspace";
    if (k === "delete") return "Delete";
    if (k === "control" || k === "ctrl") return "Ctrl";
    if (k === "alt") return "Alt";
    if (k === "meta") return "Meta";
    if (k.length === 1) return k.toUpperCase();
    return k.replace(/^./, (c) => c.toUpperCase());
  }

  // Small helper for system.keyHint template
  function fmt(k) {
    return formatKeyForDisplay(k);
  }

  function normalizeKeyEventToRetroarchKey(e) {
    const raw = (e && e.key != null ? String(e.key) : "").trim();
    if (!raw) return "";
    if (raw === " ") return "space";
    const k = raw.toLowerCase();
    if (k === "arrowup") return "up";
    if (k === "arrowdown") return "down";
    if (k === "arrowleft") return "left";
    if (k === "arrowright") return "right";
    if (k === "esc") return "escape";
    if (k === "control") return "ctrl";
    if (k === "del") return "delete";
    return k;
  }

  function loadKeybinds() {
    try {
      const raw = localStorage.getItem(KEYBINDS_STORAGE_KEY);
      if (!raw) return { ...DEFAULT_KEYBINDS };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return { ...DEFAULT_KEYBINDS };

      const out = { ...DEFAULT_KEYBINDS };
      for (const k of Object.keys(DEFAULT_KEYBINDS)) {
        const v = parsed[k];
        if (typeof v === "string" && v.trim()) out[k] = v.trim();
      }
      return out;
    } catch {
      return { ...DEFAULT_KEYBINDS };
    }
  }

  function saveKeybinds(binds) {
    localStorage.setItem(KEYBINDS_STORAGE_KEY, JSON.stringify(binds));
  }

  function keybindsToRetroarchConfig(binds) {
    const c = {
      input_player1_up: binds.up,
      input_player1_down: binds.down,
      input_player1_left: binds.left,
      input_player1_right: binds.right,
      input_player1_a: binds.a,
      input_player1_b: binds.b,
      input_player1_start: binds.start,
      input_player1_select: binds.select,
    };
    if ("x" in binds) c.input_player1_x = binds.x;
    if ("y" in binds) c.input_player1_y = binds.y;
    if ("l" in binds) c.input_player1_l = binds.l;
    if ("r" in binds) c.input_player1_r = binds.r;
    return c;
  }

  function renderKeyHint(binds) {
    if (!els.keyHint) return;
    els.keyHint.textContent = system.keyHint(binds);
  }

  let keybinds = loadKeybinds();
  renderKeyHint(keybinds);

  let keySettingsPendingAction = null;
  let keySettingsDraft = { ...keybinds };

  function setKeySettingsNote(text) {
    if (!els.keySettingsNote) return;
    els.keySettingsNote.textContent = text || "";
  }

  function renderKeySettingsList() {
    if (!els.keySettingsList) return;
    els.keySettingsList.innerHTML = "";

    const frag = document.createDocumentFragment();
    for (const a of KEY_ACTIONS) {
      const row = document.createElement("div");
      row.className = "keyRow";

      const label = document.createElement("div");
      label.className = "keyRow__label";
      label.textContent = a.label;

      const value = document.createElement("div");
      value.className = "keyRow__value";
      value.textContent = formatKeyForDisplay(keySettingsDraft[a.id]);
      value.dataset.action = a.id;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Đổi";
      btn.addEventListener("click", () => {
        keySettingsPendingAction = a.id;
        setKeySettingsNote(`Đang đổi: ${a.label}. Nhấn phím mới (Esc để hủy).`);
      });

      row.appendChild(label);
      row.appendChild(value);
      row.appendChild(btn);
      frag.appendChild(row);
    }

    els.keySettingsList.appendChild(frag);
  }

  function openKeySettings() {
    if (!els.keySettingsModal) return;
    keySettingsPendingAction = null;
    keySettingsDraft = { ...keybinds };
    renderKeySettingsList();
    setKeySettingsNote("Bấm 'Đổi' rồi nhấn phím bạn muốn dùng.");
    els.keySettingsModal.hidden = false;
  }

  function closeKeySettings() {
    if (!els.keySettingsModal) return;
    keySettingsPendingAction = null;
    els.keySettingsModal.hidden = true;
    setKeySettingsNote("");
  }

  function isKeySettingsOpen() {
    return !!els.keySettingsModal && !els.keySettingsModal.hidden;
  }

  function findActionUsingKey(binds, key, excludeAction) {
    for (const a of KEY_ACTIONS) {
      if (a.id === excludeAction) continue;
      if (String(binds[a.id] || "").toLowerCase() === key) return a;
    }
    return null;
  }

  // === Local ROM folder (File System Access API) ===

  const FS_DB_NAME = "gameweb.fs.v1";
  const FS_STORE = "handles";
  const FS_KEY_ROM_FOLDER = `romFolder.${system.id}`;

  let romFolderHandle = null; // FileSystemDirectoryHandle
  let lastSelectedGame = null; // { name, link }

  function supportsFileSystemAccess() {
    return typeof window.showDirectoryPicker === "function";
  }

  function openFsDb() {
    if (!("indexedDB" in window)) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(FS_DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(FS_STORE)) {
            db.createObjectStore(FS_STORE, { keyPath: "key" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async function fsGetHandle(key) {
    try {
      const db = await openFsDb();
      if (!db) return null;
      return await new Promise((resolve) => {
        const tx = db.transaction(FS_STORE, "readonly");
        const store = tx.objectStore(FS_STORE);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result?.handle || null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  async function fsSetHandle(key, handle) {
    try {
      const db = await openFsDb();
      if (!db) return;
      await new Promise((resolve) => {
        const tx = db.transaction(FS_STORE, "readwrite");
        const store = tx.objectStore(FS_STORE);
        store.put({ key, handle, t: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    } catch {
      // ignore
    }
  }

  async function ensureDirPermission(dir, writable) {
    try {
      if (!dir) return false;
      const mode = writable ? "readwrite" : "read";
      if (dir.queryPermission && dir.requestPermission) {
        const q = await dir.queryPermission({ mode });
        if (q === "granted") return true;
        const r = await dir.requestPermission({ mode });
        return r === "granted";
      }
      return true;
    } catch {
      return false;
    }
  }

  async function writeFileToDir(dir, filename, blob) {
    const fh = await dir.getFileHandle(filename, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
  }

  async function readFileFromDir(dir, filename) {
    const fh = await dir.getFileHandle(filename);
    return await fh.getFile();
  }

  function localFilenameForTitle(title) {
    const base = safeFilePart(title) || "game";
    return `${base}${system.defaultRomExtension}`;
  }

  async function loadSavedRomFolderHandle() {
    romFolderHandle = await fsGetHandle(FS_KEY_ROM_FOLDER);
  }

  async function pickRomFolder() {
    if (!supportsFileSystemAccess()) {
      setStatus(
        "Trình duyệt không hỗ trợ chọn thư mục (File System Access). Dùng Chrome/Edge."
      );
      return;
    }
    try {
      const dir = await window.showDirectoryPicker();
      romFolderHandle = dir;
      await fsSetHandle(FS_KEY_ROM_FOLDER, dir);
      setStatus("Đã chọn thư mục ROM.");
      setDownloadButtonEnabled(!!lastSelectedGame);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }

  async function tryLoadRomFromFolder(title) {
    try {
      if (!romFolderHandle) return null;
      const ok = await ensureDirPermission(romFolderHandle, false);
      if (!ok) return null;

      // Prefer the default extension filename.
      const mainName = localFilenameForTitle(title);
      let file = null;
      try {
        file = await readFileFromDir(romFolderHandle, mainName);
      } catch {
        // fallback: try other extensions
      }

      if (!file) {
        const base = safeFilePart(title) || "game";
        for (const ext of system.romExtensions) {
          const tryName = `${base}${ext}`;
          try {
            file = await readFileFromDir(romFolderHandle, tryName);
            break;
          } catch {
            // keep trying
          }
        }
      }

      if (!file) return null;
      const buf = await file.arrayBuffer();
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  }

  async function downloadCurrentRomToFolder() {
    if (!lastSelectedGame) {
      setStatus("Chọn 1 game trước.");
      return false;
    }
    if (!romFolderHandle) {
      await pickRomFolder();
      if (!romFolderHandle) return false;
    }

    const ok = await ensureDirPermission(romFolderHandle, true);
    if (!ok) {
      setStatus("Chưa được cấp quyền ghi vào thư mục.");
      return false;
    }

    const { name, link } = lastSelectedGame;
    try {
      cancelActiveRomLoad();
      setStatus("Đang tải ROM về thư mục...");

      const loadingId = beginLoadingUi({
        title: "Đang tải ROM...",
        metaLeft: "0 B",
      });

      const romUrl = await resolveRomUrl(link);
      const controller = new AbortController();
      activeRomLoad = { abort: () => controller.abort() };

      let lastShownPct = -1;
      let lastMetaLeft = "";
      const bytes = await xhrFetchBytesWithProgress(romUrl, {
        signal: controller.signal,
        onProgress: ({ loaded, total, lengthComputable }) => {
          const pct =
            lengthComputable && total > 0 ? (loaded / total) * 100 : 0;
          const rounded = Math.round(pct);
          if (rounded === lastShownPct) return;
          lastShownPct = rounded;
          const metaLeft =
            lengthComputable && total > 0
              ? `${formatBytes(loaded)} / ${formatBytes(total)}`
              : formatBytes(loaded);
          lastMetaLeft = metaLeft;
          setLoadingProgress({
            title: "Đang tải ROM...",
            metaLeft,
            pct: rounded,
          });
        },
      });

      assertNotEmptyRom(bytes, romUrl);

      const filename = localFilenameForTitle(name);
      await writeFileToDir(romFolderHandle, filename, new Blob([bytes]));
      activeRomLoad = null;

      await finishLoadingUi(loadingId, { metaLeft: lastMetaLeft || "" });
      setStatus(`Đã tải xong vào thư mục: ${filename}`);
      return true;
    } catch (err) {
      cancelActiveRomLoad();
      setStatus(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // === Emulator setup ===

  let nostalgist = null;
  let activeRomLoad = null; // { abort: () => void }
  let loadingOpId = 0;

  function cancelActiveRomLoad() {
    loadingOpId++;
    if (activeRomLoad && typeof activeRomLoad.abort === "function") {
      try {
        activeRomLoad.abort();
      } catch {
        // ignore
      }
    }
    activeRomLoad = null;
    setLoadingVisible(false);
  }

  function assertNostalgistLoaded() {
    if (!window.Nostalgist) {
      throw new Error(
        "Chưa load được Nostalgist. Hãy kiểm tra mạng/CDN (https://unpkg.com/nostalgist)."
      );
    }
  }

  function stopEmulator({ cancelRomLoad = true } = {}) {
    if (cancelRomLoad) cancelActiveRomLoad();
    if (!nostalgist) {
      setButtonsRunning(false);
      return;
    }

    try {
      nostalgist.exit({ removeCanvas: false });
    } catch {
      // ignore
    }
    nostalgist = null;
    setButtonsRunning(false);
  }

  function beginLoadingUi({ title, metaLeft } = {}) {
    loadingOpId++;
    const id = loadingOpId;
    setLoadingVisible(true);
    setLoadingProgress({
      title: typeof title === "string" ? title : "Đang tải...",
      metaLeft: typeof metaLeft === "string" ? metaLeft : "0 B",
      pct: 0,
    });
    return id;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function finishLoadingUi(id, { metaLeft } = {}) {
    if (id !== loadingOpId) return;
    setLoadingProgress({
      title: "Đang tải ROM...",
      metaLeft: typeof metaLeft === "string" ? metaLeft : "",
      pct: 100,
    });
    await sleep(150);
    if (id !== loadingOpId) return;
    setLoadingVisible(false);
  }

  async function saveStateToFile() {
    if (!nostalgist) {
      setStatus("Chưa chạy game để Save.");
      return;
    }

    try {
      setStatus("Đang save state...");
      const result = await nostalgist.saveState();
      const stateBlob = result?.state;
      if (!stateBlob) throw new Error("Save state thất bại.");

      const name = safeFilePart(els.nowPlaying?.textContent) || system.id;
      const ts = new Date();
      const stamp = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(
        2,
        "0"
      )}${String(ts.getDate()).padStart(2, "0")}-${String(
        ts.getHours()
      ).padStart(2, "0")}${String(ts.getMinutes()).padStart(2, "0")}${String(
        ts.getSeconds()
      ).padStart(2, "0")}`;

      downloadBlob(stateBlob, `${name}-${stamp}.state`);
      setStatus("Đã tải file save (.state). Bấm Load để nạp lại.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadStateFromFile(file) {
    if (!nostalgist) {
      setStatus("Chưa chạy game để Load.");
      return;
    }
    if (!file) return;

    try {
      setStatus("Đang load state...");
      await nostalgist.loadState(file);
      setStatus("Đã load state.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  // === Google Sheet loading + list UI ===

  const PAGE_SIZE = 10;

  let allGames = [];
  let filteredGames = [];
  let currentPage = 1;

  const DOWNLOADED_STORAGE_KEY = `gameweb.${system.id}.downloaded.v1`;

  function loadDownloadedSet() {
    try {
      const raw = localStorage.getItem(DOWNLOADED_STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return new Set();
      return new Set(arr.filter((x) => typeof x === "string"));
    } catch {
      return new Set();
    }
  }

  function saveDownloadedSet(set) {
    try {
      localStorage.setItem(DOWNLOADED_STORAGE_KEY, JSON.stringify([...set]));
    } catch {
      // ignore
    }
  }

  let downloadedSet = loadDownloadedSet();

  function makeGameKey({ name, link }) {
    return `${name}__${link}`;
  }

  function isDownloaded(key) {
    return downloadedSet.has(key);
  }

  function markDownloaded(key) {
    downloadedSet.add(key);
    saveDownloadedSet(downloadedSet);
  }

  function clearDownloadedForCurrent() {
    // no-op here
  }

  function applyFilter() {
    const q = String(els.search?.value || "")
      .trim()
      .toLowerCase();
    if (!q) {
      filteredGames = allGames;
    } else {
      filteredGames = allGames.filter((g) =>
        String(g.name || "")
          .toLowerCase()
          .includes(q)
      );
    }

    const totalPages = Math.max(1, Math.ceil(filteredGames.length / PAGE_SIZE));
    currentPage = Math.min(currentPage, totalPages);
  }

  function totalPages() {
    return Math.max(1, Math.ceil(filteredGames.length / PAGE_SIZE));
  }

  function setPage(p) {
    const tp = totalPages();
    currentPage = Math.max(1, Math.min(tp, p));
    renderCurrentPage();
  }

  function renderPager() {
    if (!els.pager) return;
    els.pager.innerHTML = "";

    const tp = totalPages();
    if (tp <= 1) return;

    const frag = document.createDocumentFragment();

    function addBtn(label, page, current) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pageBtn";
      b.textContent = label;
      if (current) b.setAttribute("aria-current", "page");
      b.addEventListener("click", () => setPage(page));
      frag.appendChild(b);
    }

    const maxBtns = 9;
    const center = currentPage;
    let start = Math.max(1, center - Math.floor(maxBtns / 2));
    let end = Math.min(tp, start + maxBtns - 1);
    start = Math.max(1, end - maxBtns + 1);

    if (start > 1) addBtn("1", 1, currentPage === 1);
    if (start > 2) {
      const e = document.createElement("div");
      e.className = "pageEllipsis";
      e.textContent = "…";
      frag.appendChild(e);
    }

    for (let p = start; p <= end; p++) {
      addBtn(String(p), p, p === currentPage);
    }

    if (end < tp - 1) {
      const e = document.createElement("div");
      e.className = "pageEllipsis";
      e.textContent = "…";
      frag.appendChild(e);
    }
    if (end < tp) addBtn(String(tp), tp, currentPage === tp);

    els.pager.appendChild(frag);
  }

  function renderCurrentPage() {
    applyFilter();
    if (!els.gameList) return;
    els.gameList.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "listInner";

    const start = (currentPage - 1) * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, filteredGames.length);

    for (let i = start; i < end; i++) {
      const game = filteredGames[i];
      const row = document.createElement("div");
      row.className = "itemRow";

      const btnPlay = document.createElement("button");
      btnPlay.type = "button";
      btnPlay.className = "item itemRow__play";
      btnPlay.addEventListener("click", () => {
        playFromLink(game.name, game.link);
      });

      const title = document.createElement("span");
      title.className = "item__title";
      title.textContent = `${i + 1}. ${game.name}`;

      btnPlay.appendChild(title);

      const btnDl = document.createElement("button");
      btnDl.type = "button";
      btnDl.className = "itemRow__dl";
      btnDl.title = "Tải ROM vào thư mục đã chọn";

      const key = makeGameKey(game);
      if (isDownloaded(key)) btnDl.classList.add("itemRow__dl--done");
      btnDl.textContent = isDownloaded(key) ? "✓" : "↓";

      btnDl.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();

        lastSelectedGame = { name: game.name, link: game.link };
        setDownloadButtonEnabled(true);

        const ok = await downloadCurrentRomToFolder();
        if (ok) {
          markDownloaded(key);
          btnDl.classList.add("itemRow__dl--done");
          btnDl.textContent = "✓";
        }
      });

      row.appendChild(btnPlay);
      row.appendChild(btnDl);
      wrap.appendChild(row);
    }

    els.gameList.appendChild(wrap);
    renderPager();

    setStatus(
      `Đã tải ${allGames.length} game • ${
        filteredGames.length
      } khớp • Trang ${currentPage}/${totalPages()}`
    );
  }

  function sheetCsvUrl() {
    return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(
      SHEET_TAB_NAME
    )}`;
  }

  function parseCsvLine(line) {
    const out = [];
    let cur = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          cur += ch;
        }
      } else {
        if (ch === ",") {
          out.push(cur);
          cur = "";
        } else if (ch === '"') {
          inQuotes = true;
        } else {
          cur += ch;
        }
      }
    }

    out.push(cur);
    return out;
  }

  function parseCsv(text) {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);

    if (lines.length === 0) return [];

    let headerRowIndex = -1;
    let nameIdx = -1;
    let linkIdx = -1;
    let platformIdx = -1;

    const maxScan = Math.min(lines.length, 25);
    for (let i = 0; i < maxScan; i++) {
      const header = parseCsvLine(lines[i]).map((h) => h.trim().toLowerCase());
      const nIdx = header.indexOf("name");
      const lIdx = header.indexOf("link");
      const pIdx =
        header.indexOf("platforms") !== -1
          ? header.indexOf("platforms")
          : header.indexOf("platform");
      if (nIdx !== -1 && lIdx !== -1) {
        headerRowIndex = i;
        nameIdx = nIdx;
        linkIdx = lIdx;
        platformIdx = pIdx;
        break;
      }
    }

    if (headerRowIndex === -1) {
      throw new Error(
        "Sheet cần có cột 'Name' và 'Link' (header). Hiện không tìm thấy trong CSV."
      );
    }

    const rows = [];
    for (let i = headerRowIndex + 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      const name = (cols[nameIdx] || "").trim();
      const link = (cols[linkIdx] || "").trim();
      if (!name || !link) continue;

      // Filtering by platform column (preferred): Drive links often don't include extensions.
      if (platformIdx !== -1) {
        const platformsRaw = (cols[platformIdx] || "").trim().toLowerCase();

        // User request: SNES page should show only entries tagged as SMC in the sheet.
        if (system.id === "snes") {
          const isSmc = /(^|[\s,;|\/]+)smc($|[\s,;|\/]+)/i.test(platformsRaw);
          if (!isSmc) continue;
        } else {
          if (!system.platformMatch(platformsRaw)) continue;
        }
      } else if (system.id === "snes") {
        // Fallback when the sheet has no Platforms column.
        // Keep only links that visibly reference .smc.
        const s = link.toLowerCase();
        if (!s.includes(".smc")) continue;
      }

      rows.push({ name, link });
    }

    return rows;
  }

  async function loadGameList() {
    setStatus("Đang tải danh sách...");
    if (els.gameList) els.gameList.innerHTML = "";

    const url = sheetCsvUrl();
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Không fetch được sheet (${res.status})`);

    const csv = await res.text();
    const rows = parseCsv(csv);
    allGames = rows;
    filteredGames = rows;
    currentPage = 1;
    renderCurrentPage();
  }

  // === Drive link handling ===

  function extractDriveId(link) {
    const s = String(link || "");
    const fileMatch = s.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (fileMatch) return { kind: "file", id: fileMatch[1] };

    const folderMatch = s.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (folderMatch) return { kind: "folder", id: folderMatch[1] };

    return null;
  }

  const DRIVE_CACHE_PREFIX = `gameweb.${system.id}.drivecache.v1.`;
  let driveApiQueue = Promise.resolve();
  let driveApiLastStartMs = 0;

  function looksLikeGoogleSorryHtml(text) {
    const t = String(text || "").toLowerCase();
    return (
      t.includes("<html") &&
      (t.includes("we're sorry") ||
        t.includes("we\u2019re sorry") ||
        t.includes("unusual traffic") ||
        t.includes("/sorry/") ||
        t.includes("google.com/sorry"))
    );
  }

  function isRetryableStatus(status) {
    return status === 0 || status === 429 || status === 503;
  }

  function backoffMs(attempt) {
    const base = 700;
    const max = 8000;
    const jitter = Math.floor(Math.random() * 250);
    const ms = Math.min(max, base * Math.pow(2, attempt));
    return ms + jitter;
  }

  function sleepDrive(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function enqueueDrive(task) {
    const next = driveApiQueue.then(task, task);
    driveApiQueue = next.catch(() => {});
    return next;
  }

  async function waitDriveSlot() {
    const now = Date.now();
    const wait = Math.max(
      0,
      DRIVE_API_MIN_INTERVAL_MS - (now - driveApiLastStartMs)
    );
    if (wait) await sleepDrive(wait);
    driveApiLastStartMs = Date.now();
  }

  function cacheKeyForFolder(folderId) {
    return `${DRIVE_CACHE_PREFIX}${folderId}`;
  }

  function readCachedFolder(folderId) {
    try {
      const raw = localStorage.getItem(cacheKeyForFolder(folderId));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      if (typeof parsed.t !== "number" || !Array.isArray(parsed.files))
        return null;
      if (Date.now() - parsed.t > DRIVE_FOLDER_CACHE_TTL_MS) return null;
      return parsed.files;
    } catch {
      return null;
    }
  }

  function writeCachedFolder(folderId, files) {
    try {
      localStorage.setItem(
        cacheKeyForFolder(folderId),
        JSON.stringify({
          t: Date.now(),
          files: Array.isArray(files) ? files : [],
        })
      );
    } catch {
      // ignore
    }
  }

  async function driveFetchJson(url, { signal } = {}) {
    return enqueueDrive(async () => {
      let lastErr;
      for (let attempt = 0; attempt <= DRIVE_API_MAX_RETRIES; attempt++) {
        await waitDriveSlot();

        try {
          const res = await fetch(url, { cache: "no-store", signal });
          const text = await res.text();

          const blockedHtml = looksLikeGoogleSorryHtml(text);
          if (res.ok && !blockedHtml) {
            try {
              return JSON.parse(text);
            } catch {
              throw new Error("Drive API trả về JSON không hợp lệ.");
            }
          }

          const retryable = isRetryableStatus(res.status) || blockedHtml;
          let detail = "";
          if (!blockedHtml && text) {
            try {
              const j = JSON.parse(text);
              if (j && typeof j.error === "string" && j.error.trim()) {
                detail = j.error.trim();
              }
            } catch {
              // ignore
            }
          }

          const baseMsg = blockedHtml
            ? "Google đang chặn tạm thời (We're sorry / unusual traffic)."
            : `Drive API lỗi (${res.status}).`;
          lastErr = new Error(detail ? `${baseMsg} ${detail}` : baseMsg);

          if (!retryable || attempt === DRIVE_API_MAX_RETRIES) throw lastErr;
          await sleepDrive(backoffMs(attempt));
        } catch (e) {
          lastErr = e instanceof Error ? e : new Error(String(e));
          if (attempt === DRIVE_API_MAX_RETRIES) throw lastErr;
          await sleepDrive(backoffMs(attempt));
        }
      }
      throw lastErr || new Error("Drive API lỗi.");
    });
  }

  function driveProxyUrlFolder(folderId) {
    const base = DRIVE_PROXY_BASE || "";
    return `${base}/api/drive/folder/${encodeURIComponent(folderId)}`;
  }

  function driveProxyUrlFile(fileId) {
    const base = DRIVE_PROXY_BASE || "";
    return `${base}/api/drive/file/${encodeURIComponent(fileId)}`;
  }

  async function listDriveFolder(folderId, { signal } = {}) {
    const cached = readCachedFolder(folderId);
    if (cached) return cached;

    if (USE_DRIVE_PROXY) {
      const json = await driveFetchJson(driveProxyUrlFolder(folderId), {
        signal,
      });
      const files = Array.isArray(json?.files) ? json.files : [];
      writeCachedFolder(folderId, files);
      return files;
    }

    if (!DRIVE_API_KEY) {
      throw new Error(
        "Thiếu DRIVE_API_KEY. Hãy dán DRIVE_API_KEY vào cart-app.js (hoặc bật USE_DRIVE_PROXY=true và set key ở server)."
      );
    }

    const url = `https://www.googleapis.com/drive/v3/files?q='${encodeURIComponent(
      folderId
    )}'+in+parents&fields=files(id,name,mimeType)&pageSize=1000&key=${encodeURIComponent(
      DRIVE_API_KEY
    )}`;

    const json = await driveFetchJson(url, { signal });
    const files = Array.isArray(json?.files) ? json.files : [];
    writeCachedFolder(folderId, files);
    return files;
  }

  async function resolveRomUrl(link) {
    const s = String(link || "").trim();

    // If link already points to a rom extension, treat as direct URL.
    if (hasAnyRomExtension(s)) return s;

    const drive = extractDriveId(s);
    if (!drive) return s;

    if (drive.kind === "file") {
      if (USE_DRIVE_PROXY) return driveProxyUrlFile(drive.id);
      if (!DRIVE_API_KEY) {
        // Public Drive file fallback via uc export=download
        return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(
          drive.id
        )}`;
      }
      return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        drive.id
      )}?alt=media&key=${encodeURIComponent(DRIVE_API_KEY)}`;
    }

    // Folder: list files, pick first matching extension.
    const files = await listDriveFolder(drive.id);
    const picked = pickFirstMatchingFile(files, system.romExtensions);
    if (!picked) {
      throw new Error(
        `Folder Drive không có ROM phù hợp (${system.romExtensions.join(
          ", "
        )}) hoặc không truy cập được. Hãy đảm bảo ROM trong folder là public.`
      );
    }

    if (USE_DRIVE_PROXY) return driveProxyUrlFile(picked.id);

    if (!DRIVE_API_KEY) {
      return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(
        picked.id
      )}`;
    }

    return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      picked.id
    )}?alt=media&key=${encodeURIComponent(DRIVE_API_KEY)}`;
  }

  function xhrFetchBytesWithProgress(url, { onProgress, signal } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.responseType = "arraybuffer";
      xhr.setRequestHeader("Cache-Control", "no-store");

      xhr.onprogress = (e) => {
        if (!onProgress) return;
        const loaded = e.loaded || 0;
        const total = e.lengthComputable ? e.total || 0 : 0;
        onProgress({ loaded, total, lengthComputable: !!e.lengthComputable });
      };

      xhr.onload = () => {
        const ok = xhr.status >= 200 && xhr.status < 300;
        if (!ok) {
          reject(new Error(`Không tải ROM (${xhr.status})`));
          return;
        }
        const buf = xhr.response;
        resolve(new Uint8Array(buf));
      };

      xhr.onerror = () => reject(new Error("Lỗi mạng khi tải ROM."));
      xhr.onabort = () => reject(new Error("Đã hủy tải ROM."));

      if (signal) {
        if (signal.aborted) {
          xhr.abort();
        } else {
          signal.addEventListener(
            "abort",
            () => {
              try {
                xhr.abort();
              } catch {
                // ignore
              }
            },
            { once: true }
          );
        }
      }

      xhr.send();
    });
  }

  async function playFromLink(name, link) {
    try {
      cancelActiveRomLoad();
      setStatus("Đang chuẩn bị ROM...");
      setNowPlaying(name);

      lastSelectedGame = { name, link };
      setDownloadButtonEnabled(true);

      assertNostalgistLoaded();

      // If user has selected a local ROM folder and the file exists, load from disk.
      const localBytes = await tryLoadRomFromFolder(name);
      if (localBytes) {
        setStatus("Đang load từ thư mục ROM...");
        const key = makeGameKey({ name, link });
        if (!isDownloaded(key)) {
          markDownloaded(key);
          renderCurrentPage();
        }
        const loadingId = beginLoadingUi({
          title: "Đang tải ROM...",
          metaLeft: formatBytes(localBytes.length),
        });
        setLoadingProgress({
          title: "Đang tải ROM...",
          metaLeft: formatBytes(localBytes.length),
          pct: 100,
        });

        setStatus("Đang khởi chạy...");
        stopEmulator({ cancelRomLoad: false });

        nostalgist = await window.Nostalgist.launch({
          element: els.canvas,
          core: system.core,
          rom: localBytes,
          size: system.canvasSize,
          retroarchConfig: keybindsToRetroarchConfig(keybinds),
        });

        setButtonsRunning(true);
        setStatus("Đang chạy...");
        activeRomLoad = null;
        await finishLoadingUi(loadingId, {
          metaLeft: formatBytes(localBytes.length),
        });
        return;
      }

      const loadingId = beginLoadingUi({
        title: "Đang tải ROM...",
        metaLeft: "0 B",
      });

      const romUrl = await resolveRomUrl(link);
      setStatus("Đang tải ROM...");

      const controller = new AbortController();
      activeRomLoad = { abort: () => controller.abort() };

      let lastShownPct = -1;
      let lastMetaLeft = "";
      const bytes = await xhrFetchBytesWithProgress(romUrl, {
        signal: controller.signal,
        onProgress: ({ loaded, total, lengthComputable }) => {
          const pct =
            lengthComputable && total > 0 ? (loaded / total) * 100 : 0;
          const rounded = Math.round(pct);
          if (rounded === lastShownPct) return;
          lastShownPct = rounded;
          const metaLeft =
            lengthComputable && total > 0
              ? `${formatBytes(loaded)} / ${formatBytes(total)}`
              : formatBytes(loaded);
          lastMetaLeft = metaLeft;
          setLoadingProgress({
            title: "Đang tải ROM...",
            metaLeft,
            pct: rounded,
          });
        },
      });

      assertNotEmptyRom(bytes, romUrl);

      setStatus("Đang khởi chạy...");
      stopEmulator({ cancelRomLoad: false });

      nostalgist = await window.Nostalgist.launch({
        element: els.canvas,
        core: system.core,
        rom: bytes,
        size: system.canvasSize,
        retroarchConfig: keybindsToRetroarchConfig(keybinds),
      });

      setButtonsRunning(true);
      setStatus("Đang chạy...");
      activeRomLoad = null;
      await finishLoadingUi(loadingId, { metaLeft: lastMetaLeft });
    } catch (err) {
      stopEmulator();
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  function enterFullscreen() {
    const el = els.screenWrap || els.canvas;
    if (!el) return;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (typeof req === "function") {
      try {
        req.call(el);
      } catch {
        // ignore
      }
    }
  }

  // === Wire up ===

  if (els.btnKeySettings) {
    els.btnKeySettings.addEventListener("click", openKeySettings);
  }

  if (els.btnKeySettingsClose) {
    els.btnKeySettingsClose.addEventListener("click", closeKeySettings);
  }

  if (els.keySettingsModal) {
    els.keySettingsModal.addEventListener("click", (e) => {
      if (e.target === els.keySettingsModal) closeKeySettings();
    });
  }

  if (els.btnKeySettingsReset) {
    els.btnKeySettingsReset.addEventListener("click", () => {
      keySettingsPendingAction = null;
      keySettingsDraft = { ...DEFAULT_KEYBINDS };
      renderKeySettingsList();
      setKeySettingsNote("Đã đặt về mặc định.");
    });
  }

  if (els.btnKeySettingsSave) {
    els.btnKeySettingsSave.addEventListener("click", () => {
      keySettingsPendingAction = null;
      keybinds = { ...keySettingsDraft };
      saveKeybinds(keybinds);
      renderKeyHint(keybinds);
      closeKeySettings();
      setStatus("Đã lưu cài đặt nút.");
    });
  }

  document.addEventListener(
    "keydown",
    (e) => {
      if (!isKeySettingsOpen()) return;

      e.preventDefault();
      e.stopPropagation();

      if (!keySettingsPendingAction) return;

      const k = normalizeKeyEventToRetroarchKey(e);
      if (!k) return;

      if (k === "escape") {
        setKeySettingsNote("Đã hủy đổi phím.");
        keySettingsPendingAction = null;
        return;
      }

      const conflict = findActionUsingKey(
        keySettingsDraft,
        k,
        keySettingsPendingAction
      );
      if (conflict) {
        setKeySettingsNote(
          `Phím ${formatKeyForDisplay(k)} đang dùng cho: ${
            conflict.label
          }. Hãy chọn phím khác.`
        );
        return;
      }

      keySettingsDraft[keySettingsPendingAction] = k;
      const v = els.keySettingsList?.querySelector(
        `.keyRow__value[data-action="${keySettingsPendingAction}"]`
      );
      if (v) v.textContent = formatKeyForDisplay(k);
      setKeySettingsNote("Đã đổi. Bấm Lưu để áp dụng.");
      keySettingsPendingAction = null;
    },
    { capture: true }
  );

  if (els.btnPickRomFolder) {
    els.btnPickRomFolder.addEventListener("click", pickRomFolder);
  }

  if (els.btnDownloadRom) {
    els.btnDownloadRom.addEventListener("click", async () => {
      const ok = await downloadCurrentRomToFolder();
      if (ok && lastSelectedGame) {
        markDownloaded(makeGameKey(lastSelectedGame));
        renderCurrentPage();
      }
    });
  }

  if (els.btnStop) {
    els.btnStop.addEventListener("click", () => {
      stopEmulator();
      setStatus("Đã dừng.");
      setNowPlaying("(chưa chọn)");
    });
  }

  if (els.btnSaveState) {
    els.btnSaveState.addEventListener("click", () => saveStateToFile());
  }

  if (els.btnLoadState) {
    els.btnLoadState.addEventListener("click", () => {
      if (!els.fileLoadState) return;
      els.fileLoadState.value = "";
      els.fileLoadState.click();
    });
  }

  if (els.fileLoadState) {
    els.fileLoadState.addEventListener("change", () => {
      const f = els.fileLoadState.files && els.fileLoadState.files[0];
      if (f) loadStateFromFile(f);
    });
  }

  if (els.search) {
    els.search.addEventListener("input", () => {
      currentPage = 1;
      renderCurrentPage();
    });
  }

  if (els.btnReload) {
    els.btnReload.addEventListener("click", () => {
      loadGameList().catch((e) => {
        setStatus(e instanceof Error ? e.message : String(e));
      });
    });
  }

  if (els.btnFullscreen) {
    els.btnFullscreen.addEventListener("click", () => enterFullscreen());
  }

  // === Touch controls (mobile/iPad) ===

  function retroarchKeyToBrowserKey(raKey) {
    const k = String(raKey || "").trim();
    if (!k) return "";
    const s = k.toLowerCase();

    if (s === "up") return "ArrowUp";
    if (s === "down") return "ArrowDown";
    if (s === "left") return "ArrowLeft";
    if (s === "right") return "ArrowRight";

    if (s === "enter") return "Enter";
    if (s === "shift") return "Shift";
    if (s === "space") return " ";
    if (s === "escape") return "Escape";
    if (s === "tab") return "Tab";
    if (s === "backspace") return "Backspace";
    if (s === "delete") return "Delete";
    if (s === "ctrl" || s === "control") return "Control";
    if (s === "alt") return "Alt";
    if (s === "meta") return "Meta";

    // Letters/digits
    if (s.length === 1) return s;
    return k;
  }

  const touchPressedKeys = new Set();

  function dispatchSyntheticKey(type, key) {
    if (!key) return;
    const ev = new KeyboardEvent(type, {
      key,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(ev);
  }

  function pressBrowserKey(key) {
    if (!key || touchPressedKeys.has(key)) return;
    touchPressedKeys.add(key);
    dispatchSyntheticKey("keydown", key);
  }

  function releaseBrowserKey(key) {
    if (!key || !touchPressedKeys.has(key)) return;
    touchPressedKeys.delete(key);
    dispatchSyntheticKey("keyup", key);
  }

  function bindTouchButton(btn, getRetroarchKey) {
    let activePointerId = null;
    let activeBrowserKey = "";

    const onDown = (e) => {
      if (!e || (e.pointerType && e.pointerType === "mouse")) return;
      e.preventDefault();
      e.stopPropagation();

      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }

      activePointerId = e.pointerId;
      const raKey = getRetroarchKey();
      activeBrowserKey = retroarchKeyToBrowserKey(raKey);
      pressBrowserKey(activeBrowserKey);
      btn.classList.add("touchBtn--active");
    };

    const onUp = (e) => {
      if (activePointerId == null) return;
      if (e && e.pointerId != null && e.pointerId !== activePointerId) return;
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      releaseBrowserKey(activeBrowserKey);
      activePointerId = null;
      activeBrowserKey = "";
      btn.classList.remove("touchBtn--active");
    };

    btn.addEventListener("pointerdown", onDown);
    btn.addEventListener("pointerup", onUp);
    btn.addEventListener("pointercancel", onUp);
    btn.addEventListener("lostpointercapture", onUp);
  }

  function ensureCartTouchControls() {
    if (!els.screenWrap) return;
    if (els.screenWrap.querySelector(".touchControls")) return;

    const root = document.createElement("div");
    root.className = "touchControls";

    if (system.id === "snes") {
      root.innerHTML = `
        <div class="touchControls__left">
          <div class="dpad" aria-label="D-pad">
            <span class="touchSpacer"></span>
            <button type="button" class="touchBtn" data-action="up">↑</button>
            <span class="touchSpacer"></span>
            <button type="button" class="touchBtn" data-action="left">←</button>
            <span class="touchSpacer"></span>
            <button type="button" class="touchBtn" data-action="right">→</button>
            <span class="touchSpacer"></span>
            <button type="button" class="touchBtn" data-action="down">↓</button>
            <span class="touchSpacer"></span>
          </div>
        </div>
        <div class="touchControls__right">
          <div class="touchRow">
            <button type="button" class="touchBtn touchBtn--wide" data-action="l">L</button>
            <button type="button" class="touchBtn touchBtn--wide" data-action="r">R</button>
          </div>
          <div class="touchAB" aria-label="Buttons">
            <button type="button" class="touchBtn" data-action="y">Y</button>
            <button type="button" class="touchBtn" data-action="x">X</button>
            <button type="button" class="touchBtn" data-action="b">B</button>
            <button type="button" class="touchBtn" data-action="a">A</button>
          </div>
          <div class="touchRow">
            <button type="button" class="touchBtn touchBtn--wide" data-action="select">Select</button>
            <button type="button" class="touchBtn touchBtn--wide" data-action="start">Start</button>
          </div>
        </div>
      `;
    } else {
      // GBA
      root.innerHTML = `
        <div class="touchControls__left">
          <div class="dpad" aria-label="D-pad">
            <span class="touchSpacer"></span>
            <button type="button" class="touchBtn" data-action="up">↑</button>
            <span class="touchSpacer"></span>
            <button type="button" class="touchBtn" data-action="left">←</button>
            <span class="touchSpacer"></span>
            <button type="button" class="touchBtn" data-action="right">→</button>
            <span class="touchSpacer"></span>
            <button type="button" class="touchBtn" data-action="down">↓</button>
            <span class="touchSpacer"></span>
          </div>
        </div>
        <div class="touchControls__right">
          <div class="touchRow">
            <button type="button" class="touchBtn touchBtn--wide" data-action="l">L</button>
            <button type="button" class="touchBtn touchBtn--wide" data-action="r">R</button>
          </div>
          <div class="touchRow" aria-label="Buttons">
            <button type="button" class="touchBtn" data-action="b">B</button>
            <button type="button" class="touchBtn" data-action="a">A</button>
          </div>
          <div class="touchRow">
            <button type="button" class="touchBtn touchBtn--wide" data-action="select">Select</button>
            <button type="button" class="touchBtn touchBtn--wide" data-action="start">Start</button>
          </div>
        </div>
      `;
    }

    els.screenWrap.appendChild(root);

    const buttons = root.querySelectorAll("button[data-action]");
    buttons.forEach((btn) => {
      const action = btn.getAttribute("data-action");
      bindTouchButton(btn, () => String(keybinds[action] || ""));
    });
  }

  ensureCartTouchControls();

  startPerfPanel();

  // === Boot ===

  (async () => {
    try {
      if (els.sourceStatus) els.sourceStatus.textContent = "Google Sheet";
      setButtonsRunning(false);
      setNowPlaying("(chưa chọn)");
      setDownloadButtonEnabled(false);

      await loadSavedRomFolderHandle();
      await loadGameList();

      // Adjust canvas element size attributes to something reasonable.
      if (els.canvas) {
        els.canvas.width = system.canvasSize.width;
        els.canvas.height = system.canvasSize.height;
      }

      // Ensure we are near the target frame rate (best effort).
      try {
        if (
          window.Nostalgist &&
          typeof window.Nostalgist.configure === "function"
        ) {
          window.Nostalgist.configure({ fps: TARGET_FPS });
        }
      } catch {
        // ignore
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  })();
})();
