/*
  PSX Web Player

  Mirrors NES page UX (nes.html/app.js):
  - Loads game list from Google Sheet (Name, Link)
  - Filters rows by Platforms/Platform containing PSX/PS1/PlayStation
  - Link can be:
      * Direct ROM URL (.chd/.cue/.bin/.iso/.img/.pbp)
      * Google Drive FILE link
      * Google Drive FOLDER link (requires Drive API key)
  - Auto-load BIOS from bios/SCPH1001.bin (user-provided)
*/

(() => {
  "use strict";

  // === CONFIG ===

  // Keep these in sync with app.js (NES) unless you want different sources.
  const SHEET_ID = "1K2gbc06V4UxFcZWOZGk1ML7zUUc6-vzT_CaPB2Cx4Q4";
  const SHEET_TAB_NAME = "Sheet1";

  // Drive API key (client-side) — DO NOT put secrets here.
  // Use server.js proxy instead and set DRIVE_API_KEY in .env / env variables.
  const DRIVE_API_KEY = "";

  // Default: use server.js proxy (/api/drive/*) to keep API key private.
  // - false: browser gọi Drive API trực tiếp (KHÔNG khuyến nghị vì lộ key)
  // - true: đi qua server.js proxy (/api/drive/*)
  const USE_DRIVE_PROXY = true;
  const DRIVE_PROXY_BASE = ""; // same-origin (e.g. "" or "http://localhost:5173")

  // Client-side Drive API fallback (only used when USE_DRIVE_PROXY=false)
  // - false: supports PUBLIC Drive *file* links via uc?export=download (no folder listing)
  // - true: uses Drive API for folder listing + file download
  const USE_DRIVE_API = true;

  // Drive API anti-spam settings
  const DRIVE_API_MIN_INTERVAL_MS = 800; // delay between Drive API requests
  const DRIVE_API_MAX_RETRIES = 4; // retries for 429/503/Google "We're sorry" HTML
  const DRIVE_FOLDER_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

  // BIOS must exist at this relative path when served.
  // pcsx_rearmed expects lowercase bios names (case-sensitive in the web FS).
  const BIOS_URLS = ["bios/scph1001.bin", "bios/SCPH1001.bin"];
  const BIOS_FILENAME = "scph1001.bin";

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
    notice: document.getElementById("notice"),

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

  // === Local ROM folder (File System Access API) ===

  const FS_DB_NAME = "gameweb.fs.v1";
  const FS_STORE = "handles";
  const FS_KEY_ROM_FOLDER = "romFolder";

  let romFolderHandle = null; // FileSystemDirectoryHandle
  let lastSelectedGame = null; // { name, link }

  function setDownloadButtonEnabled(enabled) {
    if (!els.btnDownloadRom) return;
    els.btnDownloadRom.disabled = !enabled;
  }

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

  async function loadSavedRomFolderHandle() {
    romFolderHandle = await fsGetHandle(FS_KEY_ROM_FOLDER);
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

  async function tryReadFileFromDir(dir, filename) {
    try {
      return await readFileFromDir(dir, filename);
    } catch {
      return null;
    }
  }

  function safeFilenameForFs(name) {
    return String(name || "")
      .trim()
      .replaceAll(/[\\/:*?"<>|]/g, "-")
      .replaceAll(/\s+/g, " ");
  }

  function fileExtension(name) {
    const s = String(name || "");
    const m = s.match(/(\.[a-z0-9]{1,5})$/i);
    return m ? m[1].toLowerCase() : "";
  }

  function psxLocalBaseForTitle(title) {
    const groupKey = normalizeDiscGroupTitle(title);
    const base = safeFilePart(groupKey || title) || "game";
    return base;
  }

  function parseM3u(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  }

  function parseCueReferencedFiles(text) {
    const out = [];
    const s = String(text || "");
    const re = /^\s*FILE\s+"([^"]+)"/gim;
    let m;
    while ((m = re.exec(s))) {
      const name = String(m[1] || "").trim();
      if (name && !out.includes(name)) out.push(name);
    }
    return out;
  }

  function rewriteCueContent(cueText, nameMap) {
    let out = String(cueText || "");
    for (const [orig, renamed] of Object.entries(nameMap || {})) {
      if (!orig || !renamed || orig === renamed) continue;
      out = out.replaceAll(`"${orig}"`, `"${renamed}"`);
    }
    return out;
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

  async function tryLoadPsxFromFolder(title) {
    try {
      if (!romFolderHandle) return null;
      const ok = await ensureDirPermission(romFolderHandle, false);
      if (!ok) return null;

      const base = psxLocalBaseForTitle(title);

      // Playlist (.m3u) takes precedence
      const m3uName = `${base}.m3u`;
      const m3uFile = await tryReadFileFromDir(romFolderHandle, m3uName);
      if (m3uFile) {
        const text = await m3uFile.text();
        const names = parseM3u(text);
        const files = [];
        for (const n of names) {
          const f = await tryReadFileFromDir(romFolderHandle, n);
          if (!f) return null;
          files.push(f);
        }
        return [m3uFile, ...files];
      }

      // Multi-file via .cue
      const cueName = `${base}.cue`;
      const cueFile = await tryReadFileFromDir(romFolderHandle, cueName);
      if (cueFile) {
        const cueText = await cueFile.text();
        const refs = parseCueReferencedFiles(cueText);
        const files = [cueFile];
        for (const ref of refs) {
          const f = await tryReadFileFromDir(romFolderHandle, ref);
          if (!f) return null;
          files.push(f);
        }
        return files;
      }

      // Single-file fallback
      const exts = [".chd", ".pbp", ".iso", ".bin", ".img"]; // common
      for (const ext of exts) {
        const f = await tryReadFileFromDir(romFolderHandle, `${base}${ext}`);
        if (f) return f;
      }

      return null;
    } catch {
      return null;
    }
  }

  async function downloadCurrentPsxToFolder() {
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
    const base = psxLocalBaseForTitle(name);

    try {
      cancelActiveRomLoad();
      setStatus("Đang tải ROM về thư mục...");

      const loadingId = beginLoadingUi({
        title: "Đang tải ROM...",
        metaLeft: "0 B",
      });

      // Match playFromLink's multi-disc group behavior
      const groupKey = normalizeDiscGroupTitle(name);
      const group = groupKey
        ? allGames.filter((g) => normalizeDiscGroupTitle(g.name) === groupKey)
        : [];

      let romInput;
      if (group.length >= 2) {
        const sortedGroup = [...group].sort((a, b) => {
          const ad = extractDiscNumber(a.name);
          const bd = extractDiscNumber(b.name);
          if (ad != null && bd != null) return ad - bd;
          if (ad != null) return -1;
          if (bd != null) return 1;
          return a.name.localeCompare(b.name);
        });

        const files = [];
        for (const g of sortedGroup) {
          const one = await resolveRomInput(g.link);
          if (!one || one.kind !== "single") {
            throw new Error(
              "Multi-disc hiện chỉ hỗ trợ khi mỗi Disc là 1 link FILE (không phải folder)."
            );
          }
          files.push({ url: one.url, name: safeFilePart(g.name) || "disc" });
        }

        romInput = {
          kind: "playlist",
          playlistName: groupKey,
          files,
        };
      } else {
        romInput = await resolveRomInput(link);
      }

      const controller = new AbortController();
      activeRomLoad = { abort: () => controller.abort() };

      const fileProgress = new Map();
      let lastMetaLeft = "";

      function updateAggregateProgress() {
        let loadedSum = 0;
        let totalSum = 0;
        let anyTotal = false;
        for (const v of fileProgress.values()) {
          loadedSum += v.loaded || 0;
          if (v.lengthComputable && v.total > 0) {
            totalSum += v.total;
            anyTotal = true;
          }
        }

        const pct = anyTotal && totalSum > 0 ? (loadedSum / totalSum) * 100 : 0;
        const metaLeft =
          anyTotal && totalSum > 0
            ? `${formatBytes(loadedSum)} / ${formatBytes(totalSum)}`
            : formatBytes(loadedSum);

        lastMetaLeft = metaLeft;
        setLoadingProgress({ title: "Đang tải ROM...", metaLeft, pct });
      }

      async function downloadOne({ url, name: fileName }) {
        const progressKey = safeFilePart(
          fileName || filenameFromUrl(url, "rom")
        );
        fileProgress.set(progressKey, {
          loaded: 0,
          total: 0,
          lengthComputable: false,
        });
        updateAggregateProgress();

        if (
          USE_DRIVE_API &&
          /^https:\/\/www\.googleapis\.com\/drive\/v3\//i.test(url)
        ) {
          await driveApiReserveSlot();
        }

        const buf = await xhrFetchArrayBuffer(url, {
          signal: controller.signal,
          onProgress: ({ loaded, total, lengthComputable }) => {
            fileProgress.set(progressKey, {
              loaded,
              total,
              lengthComputable,
            });
            updateAggregateProgress();
          },
        });

        const bytes = new Uint8Array(buf);
        const finalName = ensureFilenameHasExtension(progressKey, bytes);
        return { bytes, finalName };
      }

      if (
        romInput &&
        romInput.kind === "playlist" &&
        Array.isArray(romInput.files)
      ) {
        const savedNames = [];
        let i = 1;
        for (const f of romInput.files) {
          const d = await downloadOne(f);
          const ext = fileExtension(d.finalName) || ".chd";
          const diskName = safeFilenameForFs(`${base}-disc${i}${ext}`);
          await writeFileToDir(romFolderHandle, diskName, new Blob([d.bytes]));
          savedNames.push(diskName);
          i++;
        }

        const m3uText = `${savedNames.join("\n")}\n`;
        await writeFileToDir(
          romFolderHandle,
          `${base}.m3u`,
          new Blob([m3uText], { type: "text/plain" })
        );
      } else if (
        romInput &&
        romInput.kind === "multi" &&
        Array.isArray(romInput.files)
      ) {
        // CUE + BIN/IMG
        const downloads = [];
        for (const f of romInput.files) {
          downloads.push({ srcName: f.name, ...(await downloadOne(f)) });
        }

        const cue = downloads.find((d) => fileExtension(d.srcName) === ".cue");
        const others = downloads.filter((d) => d !== cue);

        const nameMap = {};
        let j = 1;
        for (const d of others) {
          const ext =
            fileExtension(d.srcName) || fileExtension(d.finalName) || ".bin";
          const newName = safeFilenameForFs(`${base}-${j}${ext}`);
          nameMap[String(d.srcName || "")] = newName;
          j++;
        }

        // Write non-cue files first
        j = 1;
        for (const d of others) {
          const ext =
            fileExtension(d.srcName) || fileExtension(d.finalName) || ".bin";
          const newName = safeFilenameForFs(`${base}-${j}${ext}`);
          await writeFileToDir(romFolderHandle, newName, new Blob([d.bytes]));
          j++;
        }

        // Rewrite cue to match renamed files
        if (cue) {
          const cueText = new TextDecoder("utf-8").decode(cue.bytes);
          let rewritten = cueText;
          for (const [orig, renamed] of Object.entries(nameMap)) {
            if (!orig || !renamed || orig === renamed) continue;
            rewritten = rewritten.replaceAll(`"${orig}"`, `"${renamed}"`);
          }
          await writeFileToDir(
            romFolderHandle,
            `${base}.cue`,
            new Blob([rewritten], { type: "text/plain" })
          );
        }
      } else {
        // Single file
        const d = await downloadOne(romInput);
        const ext = fileExtension(d.finalName) || ".bin";
        const outName = safeFilenameForFs(`${base}${ext}`);
        await writeFileToDir(romFolderHandle, outName, new Blob([d.bytes]));
      }

      activeRomLoad = null;
      await finishLoadingUi(loadingId, { metaLeft: lastMetaLeft });
      setStatus("Đã tải ROM vào thư mục.");
      return true;
    } catch (err) {
      cancelActiveRomLoad();
      setStatus(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  // === Key bindings (user settings) ===

  const KEYBINDS_STORAGE_KEY = "psxweb.keybinds.v1";

  const DEFAULT_KEYBINDS = Object.freeze({
    up: "up",
    down: "down",
    left: "left",
    right: "right",

    // PSX (RetroPad) mapping:
    // Cross -> a, Circle -> b, Triangle -> x, Square -> y
    a: "z", // Cross
    b: "x", // Circle
    x: "s", // Triangle
    y: "a", // Square
    l: "q",
    r: "e",
    start: "enter",
    select: "shift",
  });

  const KEY_ACTIONS = [
    { id: "up", label: "Lên" },
    { id: "down", label: "Xuống" },
    { id: "left", label: "Trái" },
    { id: "right", label: "Phải" },
    { id: "a", label: "Cross (X)" },
    { id: "b", label: "Circle (O)" },
    { id: "y", label: "Square" },
    { id: "x", label: "Triangle" },
    { id: "l", label: "L1" },
    { id: "r", label: "R1" },
    { id: "start", label: "Start" },
    { id: "select", label: "Select" },
  ];

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

  function keybindsToRetroarchConfig(binds) {
    return {
      input_player1_up: binds.up,
      input_player1_down: binds.down,
      input_player1_left: binds.left,
      input_player1_right: binds.right,
      input_player1_a: binds.a,
      input_player1_b: binds.b,
      input_player1_x: binds.x,
      input_player1_y: binds.y,
      input_player1_l: binds.l,
      input_player1_r: binds.r,
      input_player1_start: binds.start,
      input_player1_select: binds.select,
    };
  }

  function renderKeyHint(binds) {
    if (!els.keyHint) return;
    els.keyHint.textContent = `Phím: ←→↑↓ | ${formatKeyForDisplay(
      binds.a
    )}=Cross | ${formatKeyForDisplay(binds.b)}=Circle | ${formatKeyForDisplay(
      binds.y
    )}=Square | ${formatKeyForDisplay(
      binds.x
    )}=Triangle | ${formatKeyForDisplay(binds.l)}/${formatKeyForDisplay(
      binds.r
    )}=L/R | ${formatKeyForDisplay(binds.start)}=Start | ${formatKeyForDisplay(
      binds.select
    )}=Select`;
  }

  let keybinds = loadKeybinds();
  renderKeyHint(keybinds);

  function syncGamepadKeybinds(binds) {
    try {
      if (
        window.GameWebGamepad &&
        typeof window.GameWebGamepad.setBinds === "function"
      ) {
        window.GameWebGamepad.setBinds(binds);
      }
    } catch {
      // ignore
    }
  }

  syncGamepadKeybinds(keybinds);

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
      if (
        String(binds[a.id] || "").toLowerCase() ===
        String(key || "").toLowerCase()
      ) {
        return a;
      }
    }
    return null;
  }

  // === List state (search + pagination) ===

  const PAGE_SIZE = 10;
  let allGames = []; // [{name, link}]
  let filteredGames = [];
  let currentPage = 1; // 1-based
  let activeGameKey = null; // `${name}||${link}`

  function makeGameKey(game) {
    return `${game.name}||${game.link}`;
  }

  // === Downloaded state (per game) ===

  const DOWNLOADED_STORAGE_KEY = "psxweb.downloaded.v1";

  function loadDownloadedMap() {
    try {
      const raw = localStorage.getItem(DOWNLOADED_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveDownloadedMap(map) {
    try {
      localStorage.setItem(DOWNLOADED_STORAGE_KEY, JSON.stringify(map || {}));
    } catch {
      // ignore
    }
  }

  let downloadedMap = loadDownloadedMap();

  function isDownloaded(key) {
    return !!(key && downloadedMap && downloadedMap[key]);
  }

  function markDownloadedKeys(keys) {
    const now = Date.now();
    for (const k of keys) {
      if (!k) continue;
      downloadedMap[k] = now;
    }
    saveDownloadedMap(downloadedMap);
  }

  function clearDownloadedKeys(keys) {
    let changed = false;
    for (const k of keys) {
      if (!k) continue;
      if (downloadedMap && downloadedMap[k]) {
        delete downloadedMap[k];
        changed = true;
      }
    }
    if (changed) saveDownloadedMap(downloadedMap);
  }

  async function hasDirPermissionNoPrompt(dir, writable) {
    try {
      if (!dir) return false;
      const mode = writable ? "readwrite" : "read";
      if (dir.queryPermission) {
        const q = await dir.queryPermission({ mode });
        return q === "granted";
      }
      return true;
    } catch {
      return false;
    }
  }

  async function psxExistsInFolder(title) {
    try {
      if (!romFolderHandle) return null;
      const ok = await hasDirPermissionNoPrompt(romFolderHandle, false);
      if (!ok) return null;

      const base = psxLocalBaseForTitle(title);

      // Prefer markers first
      const m3u = await tryReadFileFromDir(romFolderHandle, `${base}.m3u`);
      if (m3u) return true;

      const cue = await tryReadFileFromDir(romFolderHandle, `${base}.cue`);
      if (cue) return true;

      const exts = [".chd", ".pbp", ".iso", ".bin", ".img"];
      for (const ext of exts) {
        const f = await tryReadFileFromDir(romFolderHandle, `${base}${ext}`);
        if (f) return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  function setDlBtnState(btn, done) {
    if (!btn) return;
    btn.classList.toggle("itemRow__dl--done", !!done);
    btn.disabled = !!done;
    btn.textContent = done ? "✓" : "↓";
    btn.title = done ? "Đã tải" : "Tải ROM";
  }

  function keysForPsxDownloadMark(game) {
    const name = game?.name;
    const groupKey = normalizeDiscGroupTitle(name);
    if (groupKey) {
      const group = allGames.filter(
        (g) => normalizeDiscGroupTitle(g.name) === groupKey
      );
      if (group.length >= 2) return group.map(makeGameKey);
    }
    return [makeGameKey(game)];
  }

  function normalizeForSearch(s) {
    return (s || "").toLowerCase();
  }

  function applyFilter() {
    const q = normalizeForSearch(els.search?.value);
    if (!q) {
      filteredGames = allGames;
    } else {
      filteredGames = allGames.filter((g) =>
        normalizeForSearch(g.name).includes(q)
      );
    }
  }

  function getTotalPages() {
    return Math.max(1, Math.ceil(filteredGames.length / PAGE_SIZE));
  }

  function renderPager() {
    if (!els.pager) return;
    els.pager.innerHTML = "";

    const totalPages = getTotalPages();
    const frag = document.createDocumentFragment();

    function addBtn(label, page, disabled) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pageBtn";
      btn.textContent = label;
      btn.disabled = !!disabled;
      if (page === currentPage && label !== "<" && label !== ">") {
        btn.setAttribute("aria-current", "page");
      }
      btn.addEventListener("click", () => {
        currentPage = page;
        renderCurrentPage();
      });
      frag.appendChild(btn);
    }

    function addEllipsis() {
      const span = document.createElement("span");
      span.className = "pageEllipsis";
      span.textContent = "…";
      frag.appendChild(span);
    }

    // Prev
    addBtn("<", Math.max(1, currentPage - 1), currentPage === 1);

    // Windowed pages
    const windowSize = 2;
    const pages = new Set([1, totalPages]);
    for (let p = currentPage - windowSize; p <= currentPage + windowSize; p++) {
      if (p >= 1 && p <= totalPages) pages.add(p);
    }

    const sorted = Array.from(pages).sort((a, b) => a - b);
    let last = 0;
    for (const p of sorted) {
      if (last && p > last + 1) addEllipsis();
      addBtn(String(p), p, false);
      last = p;
    }

    // Next
    addBtn(
      ">",
      Math.min(totalPages, currentPage + 1),
      currentPage === totalPages
    );

    els.pager.appendChild(frag);
  }

  function renderCurrentPage() {
    applyFilter();
    renderPager();

    if (!els.gameList) return;
    els.gameList.innerHTML = "";

    const start = (currentPage - 1) * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, filteredGames.length);
    const frag = document.createDocumentFragment();

    for (let i = start; i < end; i++) {
      const game = filteredGames[i];
      const key = makeGameKey(game);

      const row = document.createElement("div");
      row.className = "itemRow";

      const playBtn = document.createElement("button");
      playBtn.type = "button";
      playBtn.className = "item itemRow__play";
      if (activeGameKey && key === activeGameKey)
        playBtn.classList.add("item--active");

      const title = document.createElement("span");
      title.className = "item__title";
      title.textContent = `${i + 1}. ${game.name}`;
      playBtn.appendChild(title);

      playBtn.addEventListener("click", async () => {
        activeGameKey = key;
        renderCurrentPage();
        lastSelectedGame = { name: game.name, link: game.link };
        setDownloadButtonEnabled(true);
        await playFromLink(game.name, game.link);
      });

      const dlBtn = document.createElement("button");
      dlBtn.type = "button";
      dlBtn.className = "itemRow__dl";
      dlBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (dlBtn.disabled) return;

        lastSelectedGame = { name: game.name, link: game.link };
        setDownloadButtonEnabled(true);
        const ok = await downloadCurrentPsxToFolder();
        if (ok) {
          markDownloadedKeys(keysForPsxDownloadMark(game));
          renderCurrentPage();
        }
      });

      // Initial UI state from stored map
      setDlBtnState(dlBtn, isDownloaded(key));

      // Verify actual folder contents and clear stale ticks when files were deleted.
      void (async () => {
        const exists = await psxExistsInFolder(game.name);
        if (exists == null) return;
        const keys = keysForPsxDownloadMark(game);
        if (exists) {
          markDownloadedKeys(keys);
          setDlBtnState(dlBtn, true);
        } else {
          clearDownloadedKeys(keys);
          setDlBtnState(dlBtn, false);
        }
      })();

      row.appendChild(playBtn);
      row.appendChild(dlBtn);
      frag.appendChild(row);
    }

    els.gameList.appendChild(frag);

    const totalPages = getTotalPages();
    setStatus(
      `Đã tải ${allGames.length} game • ${filteredGames.length} khớp • Trang ${currentPage}/${totalPages}`
    );
  }

  function setStatus(text) {
    if (els.status) els.status.textContent = text;
  }

  function setNowPlaying(text) {
    if (els.nowPlaying) els.nowPlaying.textContent = text;
  }

  function setButtonsRunning(isRunning) {
    if (els.btnStop) els.btnStop.disabled = !isRunning;
    if (els.btnSaveState) els.btnSaveState.disabled = !isRunning;
    if (els.btnLoadState) els.btnLoadState.disabled = !isRunning;
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

  // === PSX (Nostalgist / libretro pcsx_rearmed) setup ===

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
    if (!nostalgist) return;
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

  function filenameFromUrl(url, fallbackName) {
    try {
      const u = new URL(url, window.location.href);
      const last = (u.pathname || "").split("/").filter(Boolean).pop();
      if (last) return decodeURIComponent(last);
    } catch {
      // ignore
    }
    return fallbackName || "rom.bin";
  }

  function xhrFetchArrayBuffer(url, { onProgress, signal } = {}) {
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
        resolve(xhr.response);
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

  async function saveStateToFile() {
    if (!nostalgist) {
      setStatus("Chưa chạy game để Save.");
      return;
    }

    try {
      setStatus("Đang save state...");
      const result = await nostalgist.saveState();
      const stateMaybe =
        result && typeof result === "object" && "state" in result
          ? result.state
          : result;

      let stateBlob;
      if (stateMaybe instanceof Blob) {
        stateBlob = stateMaybe;
      } else if (stateMaybe instanceof ArrayBuffer) {
        stateBlob = new Blob([stateMaybe], {
          type: "application/octet-stream",
        });
      } else if (ArrayBuffer.isView(stateMaybe)) {
        stateBlob = new Blob([stateMaybe], {
          type: "application/octet-stream",
        });
      } else if (typeof stateMaybe === "string") {
        stateBlob = new Blob([stateMaybe], {
          type: "application/octet-stream",
        });
      } else {
        throw new Error("Save state thất bại.");
      }

      const name = safeFilePart(els.nowPlaying?.textContent || "psx");
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

  // === Google Sheet loading ===

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

  function isPsxPlatformsCell(platformsRaw) {
    const p = String(platformsRaw || "")
      .trim()
      .toLowerCase();
    if (!p) return false;

    return (
      // Your sheet uses file extensions in Platforms (e.g. chd for PSX)
      /(^|[\s,;|\/]+)(chd|cue|bin|iso|img|pbp)($|[\s,;|\/]+)/i.test(p) ||
      // Backward compatible: allow "psx/ps1/playstation" too
      /(^|[\s,;|\/]+)psx($|[\s,;|\/]+)/i.test(p) ||
      /(^|[\s,;|\/]+)ps1($|[\s,;|\/]+)/i.test(p) ||
      p.includes("playstation")
    );
  }

  function parseCsv(text) {
    const lines = text
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

      if (platformIdx !== -1) {
        const platformsRaw = (cols[platformIdx] || "").trim();
        if (!isPsxPlatformsCell(platformsRaw)) continue;
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
    const fileMatch = link.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (fileMatch) return { kind: "file", id: fileMatch[1] };

    const folderMatch = link.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (folderMatch) return { kind: "folder", id: folderMatch[1] };

    return null;
  }

  const DRIVE_CACHE_PREFIX = "psxweb.drivecache.v1.";
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

  function isRetryableDriveStatus(status) {
    return status === 0 || status === 429 || status === 503;
  }

  function driveBackoffMs(attempt) {
    const base = 700;
    const max = 8000;
    const jitter = Math.floor(Math.random() * 250);
    const ms = Math.min(max, base * Math.pow(2, attempt));
    return ms + jitter;
  }

  function enqueueDriveApiTask(task) {
    const next = driveApiQueue.then(task, task);
    // Keep the chain alive even if a task fails.
    driveApiQueue = next.catch(() => {});
    return next;
  }

  function driveApiCacheGet(key) {
    try {
      const raw = localStorage.getItem(DRIVE_CACHE_PREFIX + key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? obj : null;
    } catch {
      return null;
    }
  }

  function driveApiCacheSet(key, value) {
    try {
      localStorage.setItem(DRIVE_CACHE_PREFIX + key, JSON.stringify(value));
    } catch {
      // ignore quota errors
    }
  }

  async function driveApiWaitDelay() {
    const now = Date.now();
    const wait = Math.max(
      0,
      DRIVE_API_MIN_INTERVAL_MS - (now - driveApiLastStartMs)
    );
    if (wait) await sleep(wait);
    driveApiLastStartMs = Date.now();
  }

  // Use this before non-fetch requests (like XHR downloads) so they still get throttled.
  function driveApiReserveSlot() {
    return enqueueDriveApiTask(driveApiWaitDelay);
  }

  async function driveApiFetchText(url, { signal } = {}) {
    return enqueueDriveApiTask(async () => {
      let lastErr;
      for (let attempt = 0; attempt <= DRIVE_API_MAX_RETRIES; attempt++) {
        await driveApiWaitDelay();

        try {
          const res = await fetch(url, { cache: "no-store", signal });
          const text = await res.text();

          const blockedHtml = looksLikeGoogleSorryHtml(text);
          if (res.ok && !blockedHtml) return { res, text };

          const retryable = isRetryableDriveStatus(res.status) || blockedHtml;
          lastErr = new Error(
            blockedHtml
              ? "Google đang chặn tạm thời (We're sorry / unusual traffic)."
              : `Drive API lỗi (${res.status}).`
          );

          if (!retryable || attempt === DRIVE_API_MAX_RETRIES) throw lastErr;
          await sleep(driveBackoffMs(attempt));
        } catch (e) {
          lastErr = e instanceof Error ? e : new Error(String(e));
          if (attempt === DRIVE_API_MAX_RETRIES) throw lastErr;
          await sleep(driveBackoffMs(attempt));
        }
      }

      throw lastErr || new Error("Drive API lỗi.");
    });
  }

  async function driveApiFetchJson(url, { signal } = {}) {
    const { text } = await driveApiFetchText(url, { signal });
    try {
      return JSON.parse(text);
    } catch {
      if (looksLikeGoogleSorryHtml(text)) {
        throw new Error(
          "Google đang chặn tạm thời (We're sorry). Hãy thử lại sau hoặc giảm tần suất bấm load."
        );
      }
      throw new Error("Drive API trả về JSON không hợp lệ.");
    }
  }

  async function listDriveFolderFiles(folderId, { signal } = {}) {
    const cacheKey = `folder.${folderId}`;
    const cached = driveApiCacheGet(cacheKey);
    const now = Date.now();
    if (
      cached &&
      typeof cached.t === "number" &&
      now - cached.t < DRIVE_FOLDER_CACHE_TTL_MS &&
      Array.isArray(cached.files)
    ) {
      return cached.files;
    }

    try {
      const all = [];
      let pageToken = "";
      for (let page = 0; page < 10; page++) {
        const q = encodeURIComponent(
          `'${folderId}' in parents and trashed=false`
        );
        const fields = encodeURIComponent(
          "nextPageToken,files(id,name,mimeType)"
        );
        const pageSize = 1000;
        const tokenPart = pageToken
          ? `&pageToken=${encodeURIComponent(pageToken)}`
          : "";
        const listUrl = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=${pageSize}${tokenPart}&key=${encodeURIComponent(
          DRIVE_API_KEY
        )}`;

        const data = await driveApiFetchJson(listUrl, { signal });
        const files = Array.isArray(data.files) ? data.files : [];
        all.push(...files);

        if (
          typeof data.nextPageToken === "string" &&
          data.nextPageToken.trim()
        ) {
          pageToken = data.nextPageToken.trim();
        } else {
          pageToken = "";
          break;
        }
      }

      if (all.length) {
        driveApiCacheSet(cacheKey, { t: now, files: all });
      }

      return all;
    } catch (e) {
      if (cached && Array.isArray(cached.files) && cached.files.length) {
        return cached.files;
      }
      throw e;
    }
  }

  function looksLikeDirectPsxRomUrl(link) {
    return /\.(chd|cue|pbp|iso|bin|img)(\?|#|$)/i.test(link);
  }

  function scorePsxFilename(name) {
    const n = String(name || "").toLowerCase();
    if (n.endsWith(".chd")) return 0;
    if (n.endsWith(".pbp")) return 1;
    if (n.endsWith(".cue")) return 2;
    if (n.endsWith(".bin") || n.endsWith(".img") || n.endsWith(".iso"))
      return 3;
    return 9;
  }

  function guessM3uBaseNameFromFilename(filename) {
    const raw = String(filename || "").trim();
    if (!raw) return "game";

    // Drop extension
    let base = raw.replace(/\.[a-z0-9]{1,5}$/i, "");

    // Remove common disc markers
    base = base
      .replace(/\s*\(\s*(disc|cd)\s*\d+\s*\)\s*$/i, "")
      .replace(/\s*\[\s*(disc|cd)\s*\d+\s*\]\s*$/i, "")
      .replace(/\s*[-_ ]+(disc|cd)\s*\d+\s*$/i, "")
      .replace(/\s*(disc|cd)\s*\d+\s*$/i, "");

    base = base.replace(/[\s\-_]+$/g, "").trim();
    return base || "game";
  }

  function normalizeDiscGroupTitle(title) {
    let s = String(title || "").trim();
    if (!s) return "";
    s = s
      .replace(/\s*\(\s*(disc|cd)\s*\d+\s*\)/gi, "")
      .replace(/\s*\[\s*(disc|cd)\s*\d+\s*\]/gi, "")
      .replace(/\s*[-_ ]+(disc|cd)\s*\d+\b/gi, "")
      .replace(/\b(disc|cd)\s*\d+\b/gi, "")
      .replace(/[\s\-_]+/g, " ")
      .trim();
    return s.toLowerCase();
  }

  function extractDiscNumber(title) {
    const s = String(title || "");
    const m = s.match(/\b(?:disc|cd)\s*(\d+)\b/i);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }

  function inferPsxExtension(bytes) {
    // CHD: ASCII 'MComprHD'
    if (
      bytes.length >= 8 &&
      bytes[0] === 0x4d &&
      bytes[1] === 0x43 &&
      bytes[2] === 0x6f &&
      bytes[3] === 0x6d &&
      bytes[4] === 0x70 &&
      bytes[5] === 0x72 &&
      bytes[6] === 0x48 &&
      bytes[7] === 0x44
    ) {
      return ".chd";
    }

    // PBP: 'PBP\0'
    if (
      bytes.length >= 4 &&
      bytes[0] === 0x50 &&
      bytes[1] === 0x42 &&
      bytes[2] === 0x50 &&
      bytes[3] === 0x00
    ) {
      return ".pbp";
    }

    return "";
  }

  function ensureFilenameHasExtension(filename, bytes) {
    const base = String(filename || "").trim() || "rom";
    if (/\.[a-z0-9]{2,5}$/i.test(base)) return base;
    const ext = inferPsxExtension(bytes);
    if (ext) return `${base}${ext}`;
    return `${base}.bin`;
  }

  async function resolveRomInput(link) {
    if (looksLikeDirectPsxRomUrl(link)) {
      return {
        kind: "single",
        url: link,
        name: filenameFromUrl(link, "rom.bin"),
      };
    }

    const drive = extractDriveId(link);
    if (!drive) {
      return {
        kind: "single",
        url: link,
        name: filenameFromUrl(link, "rom.bin"),
      };
    }

    if (drive.kind === "file") {
      if (USE_DRIVE_PROXY) {
        return {
          kind: "single",
          url: `${DRIVE_PROXY_BASE}/api/drive/file/${encodeURIComponent(
            drive.id
          )}`,
          name: `rom-${drive.id}`,
        };
      }

      if (USE_DRIVE_API && DRIVE_API_KEY) {
        return {
          kind: "single",
          url: `https://www.googleapis.com/drive/v3/files/${
            drive.id
          }?alt=media&key=${encodeURIComponent(DRIVE_API_KEY)}`,
          // Avoid extra metadata request (reduces Drive API spam). Extension is inferred from bytes.
          name: `rom-${drive.id}`,
        };
      }

      // No Drive API: use uc download URL for PUBLIC files.
      return {
        kind: "single",
        url: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(
          drive.id
        )}`,
        name: "rom",
      };
    }

    if (USE_DRIVE_PROXY) {
      const listUrl = `${DRIVE_PROXY_BASE}/api/drive/folder/${encodeURIComponent(
        drive.id
      )}`;
      const res = await fetch(listUrl, { cache: "no-store" });
      const text = await res.text();
      if (!res.ok) {
        let detail = "";
        try {
          const j = JSON.parse(text);
          if (j && typeof j.error === "string" && j.error.trim()) {
            detail = j.error.trim();
          }
        } catch {
          // ignore
        }
        const suffix = detail ? ` ${detail}` : "";
        throw new Error(
          `Không list được folder qua proxy (${res.status}).${suffix}`
        );
      }
      const data = text ? JSON.parse(text) : {};
      const files = Array.isArray(data.files) ? data.files : [];

      const romFiles = files.filter(
        (f) =>
          typeof f.name === "string" &&
          /\.(chd|cue|pbp|iso|bin|img)$/i.test(f.name)
      );

      if (romFiles.length === 0) {
        throw new Error(
          "Folder Drive không có file ROM (.chd/.cue/.pbp/.iso/.bin/.img) (hoặc không truy cập được)."
        );
      }

      const chdFiles = romFiles
        .filter(
          (f) =>
            typeof f.name === "string" && f.name.toLowerCase().endsWith(".chd")
        )
        .sort((a, b) => a.name.localeCompare(b.name));

      if (chdFiles.length >= 2) {
        const playlistBase = guessM3uBaseNameFromFilename(chdFiles[0].name);
        return {
          kind: "playlist",
          playlistName: playlistBase,
          files: chdFiles.map((f) => ({
            url: `${DRIVE_PROXY_BASE}/api/drive/file/${encodeURIComponent(
              f.id
            )}`,
            name: f.name,
          })),
        };
      }

      const chd = romFiles.find((f) => f.name.toLowerCase().endsWith(".chd"));
      if (chd) {
        return {
          kind: "single",
          url: `${DRIVE_PROXY_BASE}/api/drive/file/${encodeURIComponent(
            chd.id
          )}`,
          name: chd.name,
        };
      }

      const pbp = romFiles.find((f) => f.name.toLowerCase().endsWith(".pbp"));
      if (pbp) {
        return {
          kind: "single",
          url: `${DRIVE_PROXY_BASE}/api/drive/file/${encodeURIComponent(
            pbp.id
          )}`,
          name: pbp.name,
        };
      }

      const cue = romFiles.find((f) => f.name.toLowerCase().endsWith(".cue"));
      if (cue) {
        const related = romFiles
          .filter((f) => /\.(cue|bin|img)$/i.test(f.name))
          .sort((a, b) => {
            const aCue = a.name.toLowerCase().endsWith(".cue");
            const bCue = b.name.toLowerCase().endsWith(".cue");
            if (aCue && !bCue) return -1;
            if (!aCue && bCue) return 1;
            return (
              scorePsxFilename(a.name) - scorePsxFilename(b.name) ||
              a.name.localeCompare(b.name)
            );
          });

        return {
          kind: "multi",
          files: related.map((f) => ({
            url: `${DRIVE_PROXY_BASE}/api/drive/file/${encodeURIComponent(
              f.id
            )}`,
            name: f.name,
          })),
        };
      }

      const sorted = [...romFiles].sort(
        (a, b) =>
          scorePsxFilename(a.name) - scorePsxFilename(b.name) ||
          a.name.localeCompare(b.name)
      );
      return {
        kind: "multi",
        files: sorted.map((f) => ({
          url: `${DRIVE_PROXY_BASE}/api/drive/file/${encodeURIComponent(f.id)}`,
          name: f.name,
        })),
      };
    }

    if (!USE_DRIVE_API || !DRIVE_API_KEY) {
      throw new Error(
        "Link là Google Drive dạng folder. Không thể load folder nếu thiếu Drive API key. " +
          "Hãy dán DRIVE_API_KEY vào psx-app.js (cách cũ), hoặc bật USE_DRIVE_PROXY=true và set key ở server (.env), hoặc dùng link FILE public."
      );
    }

    const files = await listDriveFolderFiles(drive.id);
    const romFiles = files.filter(
      (f) =>
        typeof f.name === "string" &&
        /\.(chd|cue|pbp|iso|bin|img)$/i.test(f.name)
    );

    if (romFiles.length === 0) {
      throw new Error(
        "Folder Drive không có file ROM (.chd/.cue/.pbp/.iso/.bin/.img) (hoặc không truy cập được)."
      );
    }

    // Multi-disc support: if folder has multiple .chd files, load via .m3u playlist
    // so Disc 1/2 share the same save path (memory card) and swapping works better.
    const chdFiles = romFiles
      .filter(
        (f) =>
          typeof f.name === "string" && f.name.toLowerCase().endsWith(".chd")
      )
      .sort((a, b) => a.name.localeCompare(b.name));

    if (chdFiles.length >= 2) {
      const playlistBase = guessM3uBaseNameFromFilename(chdFiles[0].name);
      return {
        kind: "playlist",
        playlistName: playlistBase,
        files: chdFiles.map((f) => ({
          url: `https://www.googleapis.com/drive/v3/files/${
            f.id
          }?alt=media&key=${encodeURIComponent(DRIVE_API_KEY)}`,
          name: f.name,
        })),
      };
    }

    // Prefer 1-file formats first
    const chd = romFiles.find((f) => f.name.toLowerCase().endsWith(".chd"));
    if (chd) {
      return {
        kind: "single",
        url: `https://www.googleapis.com/drive/v3/files/${
          chd.id
        }?alt=media&key=${encodeURIComponent(DRIVE_API_KEY)}`,
        name: chd.name,
      };
    }

    const pbp = romFiles.find((f) => f.name.toLowerCase().endsWith(".pbp"));
    if (pbp) {
      return {
        kind: "single",
        url: `https://www.googleapis.com/drive/v3/files/${
          pbp.id
        }?alt=media&key=${encodeURIComponent(DRIVE_API_KEY)}`,
        name: pbp.name,
      };
    }

    // Multi-file: cue + bin/img
    const cue = romFiles.find((f) => f.name.toLowerCase().endsWith(".cue"));
    if (cue) {
      const related = romFiles
        .filter((f) => /\.(cue|bin|img)$/i.test(f.name))
        .sort((a, b) => {
          const aCue = a.name.toLowerCase().endsWith(".cue");
          const bCue = b.name.toLowerCase().endsWith(".cue");
          if (aCue && !bCue) return -1;
          if (!aCue && bCue) return 1;
          return (
            scorePsxFilename(a.name) - scorePsxFilename(b.name) ||
            a.name.localeCompare(b.name)
          );
        });

      return {
        kind: "multi",
        files: related.map((f) => ({
          url: `https://www.googleapis.com/drive/v3/files/${
            f.id
          }?alt=media&key=${encodeURIComponent(DRIVE_API_KEY)}`,
          name: f.name,
        })),
      };
    }

    // Fallback: give all as multi-file
    const sorted = [...romFiles].sort(
      (a, b) =>
        scorePsxFilename(a.name) - scorePsxFilename(b.name) ||
        a.name.localeCompare(b.name)
    );
    return {
      kind: "multi",
      files: sorted.map((f) => ({
        url: `https://www.googleapis.com/drive/v3/files/${
          f.id
        }?alt=media&key=${encodeURIComponent(DRIVE_API_KEY)}`,
        name: f.name,
      })),
    };
  }

  async function fetchBiosFile() {
    for (const url of BIOS_URLS) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) continue;
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        if (!bytes.length) continue;
        // Provide the BIOS with a known lowercase filename.
        return new File([bytes], BIOS_FILENAME, {
          type: "application/octet-stream",
        });
      } catch {
        // try next
      }
    }
    return null;
  }

  async function playFromLink(name, link) {
    try {
      cancelActiveRomLoad();
      setStatus("Đang chuẩn bị ROM...");
      setNowPlaying(name);

      lastSelectedGame = { name, link };
      setDownloadButtonEnabled(true);

      assertNostalgistLoaded();

      const bios = await fetchBiosFile();
      if (!bios) {
        if (els.notice) {
          els.notice.innerHTML =
            "Thiếu BIOS: đặt file <code>bios/scph1001.bin</code> (hoặc <code>bios/SCPH1001.bin</code>) rồi thử lại.";
        }
        throw new Error("Thiếu BIOS: bios/scph1001.bin");
      }

      // If user has selected a local ROM folder and the file(s) exist, load from disk.
      const localRom = await tryLoadPsxFromFolder(name);
      if (localRom) {
        // Reflect local availability in the list UI.
        const groupKey = normalizeDiscGroupTitle(name);
        if (groupKey) {
          const group = allGames.filter(
            (g) => normalizeDiscGroupTitle(g.name) === groupKey
          );
          if (group.length >= 2) {
            markDownloadedKeys(group.map(makeGameKey));
          } else {
            markDownloadedKeys([makeGameKey({ name, link })]);
          }
        } else {
          markDownloadedKeys([makeGameKey({ name, link })]);
        }
        renderCurrentPage();

        const localFiles = Array.isArray(localRom) ? localRom : [localRom];
        const totalBytes = localFiles.reduce(
          (sum, f) => sum + (f?.size || 0),
          0
        );

        // Large multi-disc packs (e.g. 4x CHD) can exceed browser memory if we preload
        // every disc into the emulator FS. In that case, boot using Disc 1 only.
        const MAX_PRELOAD_BYTES = 900 * 1024 * 1024; // ~900MB
        let romToUse = localRom;
        let shownBytes = totalBytes;

        if (Array.isArray(localRom) && localRom.length >= 3) {
          // localRom = [m3u, disc1, disc2, ...]
          const isPlaylist =
            typeof localRom[0]?.name === "string" &&
            localRom[0].name.toLowerCase().endsWith(".m3u");

          if (isPlaylist && totalBytes > MAX_PRELOAD_BYTES) {
            const disc1 = localRom[1];
            const m3uName = localRom[0].name;
            const m3uText = `${disc1.name}\n`;
            const smallM3u = new File([m3uText], m3uName, {
              type: "text/plain",
            });
            romToUse = [smallM3u, disc1];
            shownBytes = (disc1?.size || 0) + (smallM3u?.size || 0);
            setStatus("Multi-disc quá lớn: chỉ nạp Disc 1 để tránh lỗi.");
          }
        }

        const loadingId = beginLoadingUi({
          title: "Đang tải ROM...",
          metaLeft: formatBytes(shownBytes),
        });
        setLoadingProgress({
          title: "Đang tải ROM...",
          metaLeft: formatBytes(shownBytes),
          pct: 100,
        });

        setStatus("Đang khởi chạy...");
        stopEmulator({ cancelRomLoad: false });

        nostalgist = await window.Nostalgist.launch({
          element: els.canvas,
          core: "pcsx_rearmed",
          rom: romToUse,
          bios: [bios],
          size: { width: 1600, height: 900 },
          retroarchConfig: keybindsToRetroarchConfig(keybinds),
        });

        setButtonsRunning(true);
        setStatus("Đang chạy...");
        activeRomLoad = null;
        await finishLoadingUi(loadingId, { metaLeft: formatBytes(shownBytes) });
        return;
      }

      const loadingId = beginLoadingUi({
        title: "Đang tải ROM...",
        metaLeft: "0 B",
      });

      // Multi-disc without Drive API: if multiple rows share the same base title,
      // build a playlist (.m3u) so Disc 1/2 share save path.
      const groupKey = normalizeDiscGroupTitle(name);
      const group = groupKey
        ? allGames.filter((g) => normalizeDiscGroupTitle(g.name) === groupKey)
        : [];

      let romInput;
      if (group.length >= 2) {
        const sortedGroup = [...group].sort((a, b) => {
          const ad = extractDiscNumber(a.name);
          const bd = extractDiscNumber(b.name);
          if (ad != null && bd != null) return ad - bd;
          if (ad != null) return -1;
          if (bd != null) return 1;
          return a.name.localeCompare(b.name);
        });

        const files = [];
        for (const g of sortedGroup) {
          const one = await resolveRomInput(g.link);
          if (!one || one.kind !== "single") {
            throw new Error(
              "Multi-disc hiện chỉ hỗ trợ khi mỗi Disc là 1 link FILE (không phải folder)."
            );
          }
          files.push({ url: one.url, name: safeFilePart(g.name) || "disc" });
        }

        romInput = {
          kind: "playlist",
          playlistName: groupKey,
          files,
        };
      } else {
        romInput = await resolveRomInput(link);
      }

      const controller = new AbortController();
      activeRomLoad = { abort: () => controller.abort() };

      const fileProgress = new Map(); // name -> { loaded, total, lengthComputable }

      let lastMetaLeft = "";

      function updateAggregateProgress() {
        let loadedSum = 0;
        let totalSum = 0;
        let anyTotal = false;
        for (const v of fileProgress.values()) {
          loadedSum += v.loaded || 0;
          if (v.lengthComputable && v.total > 0) {
            totalSum += v.total;
            anyTotal = true;
          }
        }

        const pct = anyTotal && totalSum > 0 ? (loadedSum / totalSum) * 100 : 0;
        const metaLeft =
          anyTotal && totalSum > 0
            ? `${formatBytes(loadedSum)} / ${formatBytes(totalSum)}`
            : formatBytes(loadedSum);

        lastMetaLeft = metaLeft;

        setLoadingProgress({
          title: "Đang tải ROM...",
          metaLeft,
          pct,
        });
      }

      async function downloadOne({ url, name: fileName }) {
        const safeName = safeFilePart(fileName || filenameFromUrl(url, "rom"));
        fileProgress.set(safeName, {
          loaded: 0,
          total: 0,
          lengthComputable: false,
        });
        updateAggregateProgress();

        if (
          USE_DRIVE_API &&
          /^https:\/\/www\.googleapis\.com\/drive\/v3\//i.test(url)
        ) {
          await driveApiReserveSlot();
        }

        const buf = await xhrFetchArrayBuffer(url, {
          signal: controller.signal,
          onProgress: ({ loaded, total, lengthComputable }) => {
            fileProgress.set(safeName, {
              loaded,
              total,
              lengthComputable,
            });
            updateAggregateProgress();
          },
        });

        const bytes = new Uint8Array(buf);
        const finalName = ensureFilenameHasExtension(safeName, bytes);
        return new File([bytes], finalName, {
          type: "application/octet-stream",
        });
      }

      let rom;
      if (
        romInput &&
        (romInput.kind === "multi" || romInput.kind === "playlist") &&
        Array.isArray(romInput.files)
      ) {
        const files = [];
        // Sequential downloads to keep UI responsive and avoid saturating.
        for (const f of romInput.files) {
          files.push(await downloadOne(f));
        }

        if (romInput.kind === "playlist") {
          const playlistBase =
            safeFilePart(romInput.playlistName || "game") || "game";
          const m3uText = `${files.map((f) => f.name).join("\n")}\n`;
          const m3uFile = new File([m3uText], `${playlistBase}.m3u`, {
            type: "text/plain",
          });
          rom = [m3uFile, ...files];
        } else {
          rom = files;
        }
      } else {
        rom = await downloadOne(romInput);
      }

      setStatus("Đang khởi chạy...");
      // Stop any currently running emulator without affecting the current loading UI.
      stopEmulator({ cancelRomLoad: false });

      nostalgist = await window.Nostalgist.launch({
        element: els.canvas,
        core: "pcsx_rearmed",
        rom,
        bios: [bios],
        // Fullscreen will scale to 1920x1080 on a 1080p display.
        // Keeping a 1080p canvas backing store also avoids an extra upscale step.
        size: { width: 1920, height: 1080 },
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

  // === Wire up ===

  // Key settings modal
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
      syncGamepadKeybinds(keybinds);
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

      if (!keySettingsPendingAction) {
        if (e.key === "Escape") closeKeySettings();
        return;
      }

      if (e.key === "Escape") {
        keySettingsPendingAction = null;
        setKeySettingsNote("Đã hủy đổi phím.");
        return;
      }

      const newKey = normalizeKeyEventToRetroarchKey(e);
      if (!newKey) return;

      const conflict = findActionUsingKey(
        keySettingsDraft,
        newKey,
        keySettingsPendingAction
      );
      if (conflict) {
        setKeySettingsNote(
          `Phím '${formatKeyForDisplay(newKey)}' đang dùng cho '${
            conflict.label
          }'. (Vẫn đổi được)`
        );
      } else {
        const actionLabel = KEY_ACTIONS.find(
          (a) => a.id === keySettingsPendingAction
        )?.label;
        setKeySettingsNote(
          `Đã đặt '${actionLabel}' = '${formatKeyForDisplay(newKey)}'.`
        );
      }

      keySettingsDraft[keySettingsPendingAction] = newKey;
      keySettingsPendingAction = null;
      renderKeySettingsList();
    },
    true
  );

  if (els.btnReload) {
    els.btnReload.addEventListener("click", async () => {
      try {
        await loadGameList();
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
      }
    });
  }

  if (els.btnStop) {
    els.btnStop.addEventListener("click", () => {
      stopEmulator();
      setStatus("Đã dừng");
    });
  }

  // Local ROM folder buttons
  if (els.btnPickRomFolder) {
    els.btnPickRomFolder.addEventListener("click", pickRomFolder);
  }

  if (els.btnDownloadRom) {
    els.btnDownloadRom.addEventListener("click", downloadCurrentPsxToFolder);
  }

  // Save/Load state
  if (els.btnSaveState) {
    els.btnSaveState.addEventListener("click", saveStateToFile);
  }

  if (els.btnLoadState && els.fileLoadState) {
    els.btnLoadState.addEventListener("click", () => {
      els.fileLoadState.value = "";
      els.fileLoadState.click();
    });

    els.fileLoadState.addEventListener("change", async () => {
      const f = els.fileLoadState.files && els.fileLoadState.files[0];
      await loadStateFromFile(f);
    });
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

  function ensurePsxTouchControls() {
    if (!els.screenWrap) return;
    if (els.screenWrap.querySelector(".touchControls")) return;

    const root = document.createElement("div");
    root.className = "touchControls";
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
          <button type="button" class="touchBtn touchBtn--wide" data-action="l">L1</button>
          <button type="button" class="touchBtn touchBtn--wide" data-action="r">R1</button>
        </div>
        <div class="touchAB" aria-label="Buttons">
          <button type="button" class="touchBtn" data-action="y">□</button>
          <button type="button" class="touchBtn" data-action="x">△</button>
          <button type="button" class="touchBtn" data-action="a">X</button>
          <button type="button" class="touchBtn" data-action="b">O</button>
        </div>
        <div class="touchRow">
          <button type="button" class="touchBtn touchBtn--wide" data-action="select">Select</button>
          <button type="button" class="touchBtn touchBtn--wide" data-action="start">Start</button>
        </div>
      </div>
    `;

    els.screenWrap.appendChild(root);

    const buttons = root.querySelectorAll("button[data-action]");
    buttons.forEach((btn) => {
      const action = btn.getAttribute("data-action");
      bindTouchButton(btn, () => String(keybinds[action] || ""));
    });
  }

  ensurePsxTouchControls();

  // === Fullscreen ===

  async function toggleFullscreen() {
    if (!els.screenWrap) return;

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await els.screenWrap.requestFullscreen();
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }

  function syncFullscreenClass() {
    if (!els.screenWrap) return;
    const on = !!document.fullscreenElement;
    els.screenWrap.classList.toggle("isFullscreen", on);
    if (els.btnFullscreen) {
      els.btnFullscreen.textContent = on ? "Thoát toàn màn" : "Toàn màn";
    }
  }

  if (els.btnFullscreen) {
    els.btnFullscreen.addEventListener("click", toggleFullscreen);
  }

  if (els.screenWrap) {
    els.screenWrap.addEventListener("dblclick", toggleFullscreen);
  }

  document.addEventListener("fullscreenchange", syncFullscreenClass);
  syncFullscreenClass();

  startPerfPanel();

  if (els.search) {
    let t = null;
    const onChange = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        currentPage = 1;
        renderCurrentPage();
      }, 120);
    };

    els.search.addEventListener("input", onChange);
    els.search.addEventListener("search", onChange);
  }

  (async function boot() {
    try {
      if (els.sourceStatus) {
        els.sourceStatus.textContent = `Google Sheet: ${SHEET_TAB_NAME}`;
      }
      renderKeyHint(keybinds);
      setButtonsRunning(false);
      await loadSavedRomFolderHandle();
      await loadGameList();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  })();
})();
