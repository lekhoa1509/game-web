/*
  NES Web Player

  - Loads game list from Google Sheet (Name, Link)
  - Link can be:
      * A direct .nes URL (recommended)
      * Google Drive FILE link
      * Google Drive FOLDER link (requires Drive API key)

  Notes about Google Drive:
  - Browsers cannot "run a ROM directly from a folder" unless you can:
      (1) list files in that folder (Drive API), then
      (2) download the .nes bytes (alt=media)
  - Folder listing with Drive API requires an API key and the ROM files must be publicly accessible.
*/

// === CONFIG ===

// Your Google Sheet id (from the provided URL)
const SHEET_ID = "1K2gbc06V4UxFcZWOZGk1ML7zUUc6-vzT_CaPB2Cx4Q4";

// Sheet tab name (usually "Sheet1")
const SHEET_TAB_NAME = "Sheet1";

// Drive API key (client-side) — DO NOT put secrets here.
// Use server.js proxy instead and set DRIVE_API_KEY in .env / env variables.
const DRIVE_API_KEY = "";

// Default: use server.js proxy (/api/drive/*) to keep API key private.
// - false: browser gọi Drive API trực tiếp (KHÔNG khuyến nghị vì lộ key)
// - true: đi qua server.js proxy (/api/drive/*)
const USE_DRIVE_PROXY = true;
const DRIVE_PROXY_BASE = ""; // same-origin (e.g. "" or "http://localhost:5173")

// Drive API anti-spam settings (reduce Google "We're sorry" blocks)
const DRIVE_API_MIN_INTERVAL_MS = 800;
const DRIVE_API_MAX_RETRIES = 4;
const DRIVE_FOLDER_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

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

  if (ui.fpsEl) ui.fpsEl.textContent = "—";

  // FPS (render loop approximation)
  let frames = 0;
  let last = performance.now();

  function onFrame(ts) {
    frames += 1;
    const dt = ts - last;
    if (dt >= 1000) {
      const fps = (frames * 1000) / dt;
      frames = 0;
      last = ts;
      if (ui.fpsEl) ui.fpsEl.textContent = `${fps.toFixed(0)}`;
    }
    requestAnimationFrame(onFrame);
  }

  requestAnimationFrame(onFrame);
}

// === Key bindings (user settings) ===

const KEYBINDS_STORAGE_KEY = "nesweb.keybinds.v1";

const DEFAULT_KEYBINDS = Object.freeze({
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  a: "z",
  b: "x",
  start: "enter",
  select: "shift",
});

const KEY_ACTIONS = [
  { id: "up", label: "Lên" },
  { id: "down", label: "Xuống" },
  { id: "left", label: "Trái" },
  { id: "right", label: "Phải" },
  { id: "a", label: "A" },
  { id: "b", label: "B" },
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
  // Nostalgist/libretro uses RetroArch key names (common ones are lowercase).
  // We store and pass these normalized strings.
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

  // Keep common keys as-is (letters, digits, enter, shift, etc.)
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
    input_player1_start: binds.start,
    input_player1_select: binds.select,
  };
}

function renderKeyHint(binds) {
  if (!els.keyHint) return;
  els.keyHint.textContent = `Phím: ←→↑↓ | ${formatKeyForDisplay(
    binds.a
  )}=A | ${formatKeyForDisplay(binds.b)}=B | ${formatKeyForDisplay(
    binds.start
  )}=Start | ${formatKeyForDisplay(binds.select)}=Select`;
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

const DOWNLOADED_STORAGE_KEY = "nesweb.downloaded.v1";

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

function markDownloaded(key) {
  if (!key) return;
  downloadedMap[key] = Date.now();
  saveDownloadedMap(downloadedMap);
}

function clearDownloaded(key) {
  if (!key) return;
  if (!downloadedMap || !downloadedMap[key]) return;
  delete downloadedMap[key];
  saveDownloadedMap(downloadedMap);
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

async function nesExistsInFolder(title) {
  try {
    if (!romFolderHandle) return null;
    const ok = await hasDirPermissionNoPrompt(romFolderHandle, false);
    if (!ok) return null;
    await romFolderHandle.getFileHandle(nesLocalFilenameForTitle(title));
    return true;
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

  const totalPages = Math.max(1, Math.ceil(filteredGames.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;
}

function setPage(page) {
  currentPage = page;
  renderCurrentPage();
}

function getTotalPages() {
  return Math.max(1, Math.ceil(filteredGames.length / PAGE_SIZE));
}

function renderPager() {
  if (!els.pager) return;
  const totalPages = getTotalPages();
  els.pager.innerHTML = "";

  const frag = document.createDocumentFragment();

  const addBtn = (label, page, disabled = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pageBtn";
    b.textContent = label;
    b.disabled = disabled;
    if (page === currentPage) b.setAttribute("aria-current", "page");
    b.addEventListener("click", () => setPage(page));
    frag.appendChild(b);
  };

  const addEllipsis = () => {
    const s = document.createElement("span");
    s.className = "pageEllipsis";
    s.textContent = "…";
    frag.appendChild(s);
  };

  // Prev
  addBtn("<", Math.max(1, currentPage - 1), currentPage === 1);

  // Windowed pages: 1 ... (p-2..p+2) ... last
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

      // If currently marked done, do nothing.
      if (dlBtn.disabled) return;

      lastSelectedGame = { name: game.name, link: game.link };
      setDownloadButtonEnabled(true);
      const ok = await downloadCurrentNesToFolder();
      if (ok) {
        markDownloaded(key);
        renderCurrentPage();
      }
    });

    // Initial UI state from stored map
    setDlBtnState(dlBtn, isDownloaded(key));

    // If we have folder access, verify actual file existence and clear stale ticks.
    void (async () => {
      const exists = await nesExistsInFolder(game.name);
      if (exists == null) return; // no permission or no folder
      if (exists) {
        if (!isDownloaded(key)) markDownloaded(key);
        setDlBtnState(dlBtn, true);
      } else {
        clearDownloaded(key);
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
  els.status.textContent = text;
}

function setNowPlaying(text) {
  els.nowPlaying.textContent = text;
}

function setButtonsRunning(isRunning) {
  els.btnStop.disabled = !isRunning;
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

function nesLocalFilenameForTitle(title) {
  const base = safeFilePart(title) || "game";
  return `${base}.nes`;
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
    // user cancelled
    setStatus(e instanceof Error ? e.message : String(e));
  }
}

async function tryLoadNesFromFolder(title) {
  try {
    if (!romFolderHandle) return null;
    const ok = await ensureDirPermission(romFolderHandle, false);
    if (!ok) return null;
    const file = await readFileFromDir(
      romFolderHandle,
      nesLocalFilenameForTitle(title)
    );
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

async function downloadCurrentNesToFolder() {
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
        const pct = lengthComputable && total > 0 ? (loaded / total) * 100 : 0;
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

    assertIsNesRom(bytes, romUrl);

    const filename = nesLocalFilenameForTitle(name);
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

// === NES (Nostalgist / libretro fceumm) setup ===

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
    throw new Error("Không tải được thư viện Nostalgist từ CDN.");
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

    const name = safeFilePart(els.nowPlaying?.textContent) || "game";
    const ts = new Date();
    const stamp = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(
      2,
      "0"
    )}${String(ts.getDate()).padStart(2, "0")}-${String(ts.getHours()).padStart(
      2,
      "0"
    )}${String(ts.getMinutes()).padStart(2, "0")}${String(
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
  // Using Google Visualization API to fetch as CSV without publishing the sheet.
  // This works for many public sheets.
  // NOTE: Don't "select" specific columns here; your sheet may have extra columns
  // (e.g. Id, Platforms, Create_at). We fetch the full CSV and then auto-detect
  // the Name/Link columns from the header row.
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(
    SHEET_TAB_NAME
  )}`;
}

function parseCsvLine(line) {
  // Basic CSV parser for a single line.
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
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return [];

  // Find the header row that contains Name + Link (case-insensitive).
  // Some sheets may contain leading empty lines.
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
      const platformsRaw = (cols[platformIdx] || "").trim().toLowerCase();
      // Accept common aliases for NES.
      // Use word-boundary matching so values like "NES)" / "NES." still match,
      // and avoid false-positives like "snes".
      const isNes =
        /\bnes\b/i.test(platformsRaw) ||
        /\bfc\b/i.test(platformsRaw) ||
        platformsRaw.includes("famicom") ||
        platformsRaw.includes("nintendo entertainment system");

      // If Platforms column exists but this row left it blank, don't hide valid .nes links.
      if (platformsRaw) {
        if (!isNes) continue;
      } else {
        const s = link.toLowerCase();
        if (!s.includes(".nes")) continue;
      }
    }
    rows.push({ name, link });
  }
  return rows;
}

async function loadGameList() {
  setStatus("Đang tải danh sách...");
  els.gameList.innerHTML = "";

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
  // file: https://drive.google.com/file/d/<id>/view
  // folder: https://drive.google.com/drive/folders/<id>
  const fileMatch = link.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) return { kind: "file", id: fileMatch[1] };

  const folderMatch = link.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch) return { kind: "folder", id: folderMatch[1] };

  return null;
}

const DRIVE_CACHE_PREFIX = "nesweb.drivecache.v1.";
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
  driveApiQueue = next.catch(() => {});
  return next;
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

function driveApiReserveSlot() {
  return enqueueDriveApiTask(driveApiWaitDelay);
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
    // ignore
  }
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

      if (typeof data.nextPageToken === "string" && data.nextPageToken.trim()) {
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

async function resolveRomUrl(link) {
  // If link already points to .nes or any direct URL
  if (/\.nes(\?|#|$)/i.test(link)) return link;

  const drive = extractDriveId(link);
  if (!drive) return link; // maybe direct download URL of some other host

  if (drive.kind === "file") {
    if (USE_DRIVE_PROXY) {
      return `${DRIVE_PROXY_BASE}/api/drive/file/${encodeURIComponent(
        drive.id
      )}`;
    }

    // Best option: Drive API (reliable CORS). Fallback: uc?export=download (may fail due to CORS/confirm).
    if (DRIVE_API_KEY) {
      return `https://www.googleapis.com/drive/v3/files/${
        drive.id
      }?alt=media&key=${encodeURIComponent(DRIVE_API_KEY)}`;
    }

    return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(
      drive.id
    )}`;
  }

  // Folder: list files, pick first .nes
  let files;
  if (USE_DRIVE_PROXY) {
    const listUrl = `${DRIVE_PROXY_BASE}/api/drive/folder/${encodeURIComponent(
      drive.id
    )}`;
    const res = await fetch(listUrl, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`Không list được folder qua proxy (${res.status}).`);
    }
    const data = await res.json();
    files = Array.isArray(data.files) ? data.files : [];
  } else {
    // Folder links REQUIRE Drive API to list files.
    if (!DRIVE_API_KEY) {
      throw new Error(
        "Link là Google Drive dạng folder. Bạn đang chạy chế độ client. " +
          "Hãy dán DRIVE_API_KEY vào app.js (cách cũ), hoặc bật USE_DRIVE_PROXY=true và set DRIVE_API_KEY ở server (.env), hoặc dùng link FILE direct."
      );
    }
    files = await listDriveFolderFiles(drive.id);
  }
  const nesFile = files.find(
    (f) => typeof f.name === "string" && f.name.toLowerCase().endsWith(".nes")
  );

  if (!nesFile) {
    throw new Error(
      "Folder Drive không có file .nes (hoặc không truy cập được). Hãy đảm bảo ROM trong folder là public."
    );
  }

  if (USE_DRIVE_PROXY) {
    return `${DRIVE_PROXY_BASE}/api/drive/file/${encodeURIComponent(
      nesFile.id
    )}`;
  }

  return `https://www.googleapis.com/drive/v3/files/${
    nesFile.id
  }?alt=media&key=${encodeURIComponent(DRIVE_API_KEY)}`;
}

async function fetchRomBytes(url) {
  // Keep backwards compatibility: no progress.
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Không tải ROM (${res.status})`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
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

async function xhrFetchBytesWithProgress(url, { onProgress, signal } = {}) {
  if (
    DRIVE_API_KEY &&
    /^https:\/\/www\.googleapis\.com\/drive\/v3\//i.test(url)
  ) {
    await driveApiReserveSlot();
  }

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

function assertIsNesRom(bytes, sourceUrl) {
  // iNES header is: 4E 45 53 1A ("NES\x1A")
  const ok =
    bytes.length >= 16 &&
    bytes[0] === 0x4e &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x53 &&
    bytes[3] === 0x1a;

  if (ok) return;

  throw new Error(
    "File tải về không phải ROM .nes hợp lệ (thiếu header NES\\x1A). " +
      "Nếu bạn dùng Google Drive, hãy dùng link FILE trực tiếp hoặc cấu hình DRIVE_API_KEY. URL: " +
      sourceUrl
  );
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
    const localBytes = await tryLoadNesFromFolder(name);
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

      nostalgist = await window.Nostalgist.nes({
        element: els.canvas,
        rom: localBytes,
        size: { width: 256, height: 240 },
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
        const pct = lengthComputable && total > 0 ? (loaded / total) * 100 : 0;
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
    assertIsNesRom(bytes, romUrl);

    setStatus("Đang khởi chạy...");
    // Stop any currently running emulator without affecting the current loading UI.
    stopEmulator({ cancelRomLoad: false });

    // Match Nostalgist default look/colors (libretro fceumm), and keep your control hint.
    nostalgist = await window.Nostalgist.nes({
      element: els.canvas,
      rom: bytes,
      size: { width: 256, height: 240 },
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
    // click outside panel closes
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

    // Don't let the emulator react while editing keys.
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

els.btnReload.addEventListener("click", async () => {
  try {
    await loadGameList();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err));
  }
});

els.btnStop.addEventListener("click", () => {
  stopEmulator();
  setStatus("Đã dừng");
});

// Local ROM folder buttons
if (els.btnPickRomFolder) {
  els.btnPickRomFolder.addEventListener("click", pickRomFolder);
}

if (els.btnDownloadRom) {
  els.btnDownloadRom.addEventListener("click", downloadCurrentNesToFolder);
}

// Save/Load state (download/upload)
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

function ensureNesTouchControls() {
  if (!els.screenWrap) return;

  const isMobile =
    !!(window.GameWebDevice && window.GameWebDevice.isMobile) ||
    document.documentElement.classList.contains("isMobile");

  if (!isMobile) {
    try {
      els.screenWrap.querySelector(".touchControls")?.remove();
    } catch {
      // ignore
    }
    return;
  }

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
        <button type="button" class="touchBtn touchBtn--wide" data-action="select">Select</button>
        <button type="button" class="touchBtn touchBtn--wide" data-action="start">Start</button>
      </div>
      <div class="touchRow">
        <button type="button" class="touchBtn" data-action="b">B</button>
        <button type="button" class="touchBtn" data-action="a">A</button>
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

ensureNesTouchControls();

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
    // Some browsers block fullscreen without user gesture
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
    els.sourceStatus.textContent = `Google Sheet: ${SHEET_TAB_NAME}`;
    // Ensure hint matches saved settings on load
    renderKeyHint(keybinds);
    await loadSavedRomFolderHandle();
    await loadGameList();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err));
  }
})();
