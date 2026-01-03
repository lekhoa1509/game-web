(() => {
  "use strict";

  // === CONFIG (mirrors PSX) ===

  const SHEET_ID = "1K2gbc06V4UxFcZWOZGk1ML7zUUc6-vzT_CaPB2Cx4Q4";
  const SHEET_TAB_NAME = "Sheet1";

  // Drive API key (client-side)
  const DRIVE_API_KEY = "REDACTED";

  // Old mode default: call Drive API directly from browser.
  const USE_DRIVE_PROXY = false;
  const DRIVE_PROXY_BASE = ""; // same-origin (e.g. "" or "http://localhost:5173")

  const USE_DRIVE_API = true;

  // Drive API anti-spam settings
  const DRIVE_API_MIN_INTERVAL_MS = 800;
  const DRIVE_API_MAX_RETRIES = 4;
  const DRIVE_FOLDER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

  const els = {
    btnReload: document.getElementById("btnReload"),
    btnStop: document.getElementById("btnStop"),
    btnFullscreen: document.getElementById("btnFullscreen"),
    btnDownloadRom: document.getElementById("btnDownloadRom"),
    status: document.getElementById("status"),
    sourceStatus: document.getElementById("sourceStatus"),
    player: document.getElementById("player"),
    screenWrap: document.getElementById("screenWrap"),
    nowPlaying: document.getElementById("nowPlaying"),
    search: document.getElementById("search"),
    gameList: document.getElementById("gameList"),
    pager: document.getElementById("pager"),
  };

  /** @type {string[]} */
  let objectUrls = [];
  /** @type {HTMLScriptElement|null} */
  let loaderScript = null;

  const DEFAULT_BIOS_FILES = [
    { url: "bios/bios7.bin", label: "BIOS7" },
    { url: "bios/bios9.bin", label: "BIOS9" },
    { url: "bios/firmware.bin", label: "Firmware" },
  ];

  /** @type {string[]} */
  let defaultBiosUrls = [];

  function setStatus(text) {
    if (els.status) els.status.textContent = text || "";
  }

  function setNowPlaying(text) {
    if (els.nowPlaying) els.nowPlaying.textContent = text || "";
  }

  function revokeAll() {
    for (const u of objectUrls) {
      try {
        URL.revokeObjectURL(u);
      } catch {
        // ignore
      }
    }
    objectUrls = [];
  }

  function clearLoader() {
    if (loaderScript) {
      try {
        loaderScript.remove();
      } catch {
        // ignore
      }
      loaderScript = null;
    }
  }

  function stop() {
    try {
      if (
        window.EJS_emulator &&
        typeof window.EJS_emulator.destroy === "function"
      ) {
        window.EJS_emulator.destroy();
      }
    } catch {
      // ignore
    }

    // Clear globals used by EmulatorJS
    try {
      delete window.EJS_emulator;
    } catch {
      window.EJS_emulator = undefined;
    }

    if (els.player) els.player.innerHTML = "";
    clearLoader();
    revokeAll();

    if (els.btnStop) els.btnStop.disabled = true;
    setStatus("Đã dừng.");
  }

  // === List state (search + pagination) ===

  const PAGE_SIZE = 30;
  let allGames = []; // [{ name, link, platforms? }]
  let filteredGames = [];
  let currentPage = 1;
  let activeGameKey = null;
  let lastSelectedGame = null; // { name, link }

  function makeGameKey(game) {
    return `${game.name}||${game.link}`;
  }

  function setDownloadButtonEnabled(enabled) {
    if (!els.btnDownloadRom) return;
    els.btnDownloadRom.disabled = !enabled;
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

  async function downloadCurrentRom() {
    if (!lastSelectedGame) {
      setStatus("Chưa chọn game để tải ROM.");
      return;
    }

    const { name, link } = lastSelectedGame;
    setDownloadButtonEnabled(false);
    try {
      setStatus("Đang chuẩn bị tải ROM...");
      const romUrl = await resolveRomUrl(link);

      setStatus("Đang tải ROM...");
      const res = await fetch(romUrl, { cache: "no-store" });
      if (!res.ok) throw new Error(`Không tải được ROM (${res.status})`);
      const blob = await res.blob();
      const filename = `${safeFilePart(name) || "game"}.nds`;
      downloadBlob(blob, filename);
      setStatus("Đã tải ROM (.nds). ");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloadButtonEnabled(true);
    }
  }

  async function urlExists(url) {
    try {
      const head = await fetch(url, { method: "HEAD", cache: "no-store" });
      if (head.ok) return true;
      // Some servers don't support HEAD properly.
      if (head.status === 405 || head.status === 501) {
        const get = await fetch(url, { cache: "no-store" });
        return get.ok;
      }
      return false;
    } catch {
      try {
        const get = await fetch(url, { cache: "no-store" });
        return get.ok;
      } catch {
        return false;
      }
    }
  }

  async function tryLoadDefaultBios() {
    const found = [];
    for (const f of DEFAULT_BIOS_FILES) {
      const ok = await urlExists(f.url);
      if (ok) found.push(f.url);
    }
    defaultBiosUrls = found;
  }

  function buildBiosList() {
    // Default: auto-load from local folder platforms/nds/bios/
    return defaultBiosUrls.length ? [...defaultBiosUrls] : [];
  }

  // === Google Sheet loading (CSV) ===

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
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = false;
          }
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

  function isNdsPlatformsCell(platformsRaw) {
    const p = String(platformsRaw || "")
      .trim()
      .toLowerCase();
    if (!p) return false;

    return (
      /(^|[\s,;|\/]+)(nds|nintendo\s*ds|ds)($|[\s,;|\/]+)/i.test(p) ||
      /(^|[\s,;|\/]+)\.nds($|[\s,;|\/]+)/i.test(p)
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

      const platformsRaw = platformIdx !== -1 ? cols[platformIdx] : "";
      const hasPlatforms =
        platformIdx !== -1 && String(platformsRaw || "").trim();

      const okByPlatforms = hasPlatforms
        ? isNdsPlatformsCell(platformsRaw)
        : null;
      const okByLink = /\.nds(\?|#|$)/i.test(link);

      const ok = okByPlatforms === null ? okByLink : okByPlatforms || okByLink;
      if (!ok) continue;

      rows.push({ name, link, platforms: platformsRaw });
    }

    return rows;
  }

  async function loadGameList() {
    if (els.sourceStatus) {
      els.sourceStatus.textContent = `Google Sheet: ${SHEET_TAB_NAME}`;
    }

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

  function normalizeForSearch(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function applyFilter() {
    const q = normalizeForSearch(els.search ? els.search.value : "");
    if (!q) {
      filteredGames = allGames;
      return;
    }
    filteredGames = allGames.filter((g) =>
      normalizeForSearch(g.name).includes(q)
    );
  }

  function getTotalPages() {
    return Math.max(1, Math.ceil(filteredGames.length / PAGE_SIZE));
  }

  function renderPager() {
    if (!els.pager) return;
    els.pager.innerHTML = "";
    const totalPages = getTotalPages();

    function addBtn(label, page, disabled) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pageBtn";
      b.textContent = label;
      if (page === currentPage) b.setAttribute("aria-current", "page");
      b.disabled = !!disabled;
      b.addEventListener("click", () => {
        currentPage = page;
        renderCurrentPage();
      });
      els.pager.appendChild(b);
    }

    function addEllipsis() {
      const s = document.createElement("span");
      s.className = "pageEllipsis";
      s.textContent = "…";
      els.pager.appendChild(s);
    }

    addBtn("<", Math.max(1, currentPage - 1), currentPage === 1);

    const windowSize = 2;
    const pages = new Set([1, totalPages]);
    for (let p = currentPage - windowSize; p <= currentPage + windowSize; p++) {
      if (p >= 1 && p <= totalPages) pages.add(p);
    }

    const sorted = Array.from(pages).sort((a, b) => a - b);
    let last = 0;
    for (const p of sorted) {
      if (last && p - last > 1) addEllipsis();
      addBtn(String(p), p, false);
      last = p;
    }

    addBtn(
      ">",
      Math.min(totalPages, currentPage + 1),
      currentPage === totalPages
    );
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
      playBtn.dataset.key = key;

      const title = document.createElement("span");
      title.className = "item__title";
      title.textContent = `${i + 1}. ${game.name}`;
      playBtn.appendChild(title);

      if (activeGameKey === key) playBtn.classList.add("item--active");

      playBtn.addEventListener("click", () => {
        void playFromLink(game.name, game.link);
      });

      row.appendChild(playBtn);
      frag.appendChild(row);
    }

    els.gameList.appendChild(frag);

    const totalPages = getTotalPages();
    setStatus(
      `Đã tải ${allGames.length} game • ${filteredGames.length} khớp • Trang ${currentPage}/${totalPages}`
    );
  }

  // === Drive link handling (simplified from PSX) ===

  function extractDriveId(link) {
    const fileMatch = String(link || "").match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (fileMatch) return { kind: "file", id: fileMatch[1] };

    const folderMatch = String(link || "").match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (folderMatch) return { kind: "folder", id: folderMatch[1] };

    return null;
  }

  const DRIVE_CACHE_PREFIX = "ndsweb.drivecache.v1.";
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

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function enqueueDriveApiTask(task) {
    const next = driveApiQueue.then(task, task);
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
      // ignore
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

  async function driveApiFetchText(url) {
    return enqueueDriveApiTask(async () => {
      let lastErr;
      for (let attempt = 0; attempt <= DRIVE_API_MAX_RETRIES; attempt++) {
        await driveApiWaitDelay();
        try {
          const res = await fetch(url, { cache: "no-store" });
          const text = await res.text();
          if (!res.ok) {
            if (looksLikeGoogleSorryHtml(text)) {
              throw new Error(
                "Google đang chặn tạm thời (We're sorry). Hãy thử lại sau hoặc giảm tần suất."
              );
            }
            if (isRetryableDriveStatus(res.status)) {
              await sleep(driveBackoffMs(attempt));
              continue;
            }
            throw new Error(`Drive API lỗi (${res.status}).`);
          }
          if (looksLikeGoogleSorryHtml(text)) {
            throw new Error(
              "Google đang chặn tạm thời (We're sorry). Hãy thử lại sau hoặc giảm tần suất."
            );
          }
          return { res, text };
        } catch (e) {
          lastErr = e;
          await sleep(driveBackoffMs(attempt));
        }
      }
      throw lastErr || new Error("Drive API lỗi.");
    });
  }

  async function driveApiFetchJson(url) {
    const { text } = await driveApiFetchText(url);
    try {
      return JSON.parse(text);
    } catch {
      if (looksLikeGoogleSorryHtml(text)) {
        throw new Error(
          "Google đang chặn tạm thời (We're sorry). Hãy thử lại sau hoặc giảm tần suất."
        );
      }
      throw new Error("Drive API trả về JSON không hợp lệ.");
    }
  }

  async function listDriveFolderFiles(folderId) {
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

        const data = await driveApiFetchJson(listUrl);
        const files = Array.isArray(data.files) ? data.files : [];
        all.push(...files);

        if (
          typeof data.nextPageToken === "string" &&
          data.nextPageToken.trim()
        ) {
          pageToken = data.nextPageToken;
        } else {
          break;
        }
      }

      if (all.length) driveApiCacheSet(cacheKey, { t: now, files: all });
      return all;
    } catch (e) {
      if (cached && Array.isArray(cached.files) && cached.files.length)
        return cached.files;
      throw e;
    }
  }

  function looksLikeDirectNdsRomUrl(link) {
    return /\.nds(\?|#|$)/i.test(String(link || ""));
  }

  async function resolveRomUrl(link) {
    if (looksLikeDirectNdsRomUrl(link)) return link;

    const drive = extractDriveId(link);
    if (!drive) return link;

    if (drive.kind === "file") {
      if (USE_DRIVE_PROXY) {
        return `${DRIVE_PROXY_BASE}/api/drive/file/${encodeURIComponent(
          drive.id
        )}`;
      }

      if (USE_DRIVE_API && DRIVE_API_KEY) {
        return `https://www.googleapis.com/drive/v3/files/${
          drive.id
        }?alt=media&key=${encodeURIComponent(DRIVE_API_KEY)}`;
      }

      return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(
        drive.id
      )}`;
    }

    // folder
    if (USE_DRIVE_PROXY) {
      const listUrl = `${DRIVE_PROXY_BASE}/api/drive/folder/${encodeURIComponent(
        drive.id
      )}`;
      const res = await fetch(listUrl, { cache: "no-store" });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Không list được folder qua proxy (${res.status}).`);
      }
      const data = text ? JSON.parse(text) : {};
      const files = Array.isArray(data.files) ? data.files : [];
      const roms = files
        .filter((f) => typeof f.name === "string" && /\.nds$/i.test(f.name))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      if (!roms.length) {
        throw new Error(
          "Folder Drive không có ROM .nds (hoặc không truy cập được)."
        );
      }
      return `${DRIVE_PROXY_BASE}/api/drive/file/${encodeURIComponent(
        roms[0].id
      )}`;
    }

    if (!USE_DRIVE_API || !DRIVE_API_KEY) {
      throw new Error(
        "Link là Google Drive dạng folder. Không thể load folder nếu thiếu Drive API key."
      );
    }

    const files = await listDriveFolderFiles(drive.id);
    const roms = files
      .filter((f) => typeof f.name === "string" && /\.nds$/i.test(f.name))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (!roms.length) {
      throw new Error(
        "Folder Drive không có ROM .nds (hoặc không truy cập được)."
      );
    }
    return `https://www.googleapis.com/drive/v3/files/${
      roms[0].id
    }?alt=media&key=${encodeURIComponent(DRIVE_API_KEY)}`;
  }

  async function playFromLink(name, link) {
    try {
      stop();
      setNowPlaying(name);
      setStatus("Đang chuẩn bị ROM...");

      lastSelectedGame = { name, link };
      setDownloadButtonEnabled(true);

      const romUrl = await resolveRomUrl(link);

      setStatus("Đang tải EmulatorJS...");

      window.EJS_player = "#player";
      window.EJS_core = "nds";
      window.EJS_gameName = name;
      window.EJS_gameUrl = romUrl;

      const biosList = buildBiosList();
      window.EJS_biosUrl = biosList.length ? biosList : undefined;
      window.EJS_pathtodata = "https://cdn.emulatorjs.org/stable/data/";
      window.EJS_startOnLoaded = true;

      if (els.player) els.player.innerHTML = "";

      loaderScript = document.createElement("script");
      loaderScript.src = "https://cdn.emulatorjs.org/stable/data/loader.js";
      loaderScript.async = true;
      loaderScript.onload = () => {
        setStatus(
          biosList.length
            ? "Đã khởi chạy (có BIOS)."
            : "Đã khởi chạy. Nếu game báo lỗi, hãy chọn thêm BIOS/firmware."
        );
      };
      loaderScript.onerror = () => {
        setStatus("Không tải được EmulatorJS từ CDN. Hãy thử lại.");
      };
      document.head.appendChild(loaderScript);

      if (els.btnStop) els.btnStop.disabled = false;

      activeGameKey = `${name}||${link}`;
      renderCurrentPage();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggleFullscreen() {
    const el = els.screenWrap;
    if (!el) return;

    const isFs = document.fullscreenElement != null;
    try {
      if (!isFs) {
        await el.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      // If fullscreen API fails, we still keep the CSS class in sync via event below.
    }
  }

  function syncFullscreenClass() {
    if (!els.screenWrap) return;
    const on = document.fullscreenElement === els.screenWrap;
    els.screenWrap.classList.toggle("isFullscreen", on);
  }

  if (els.btnReload) {
    els.btnReload.addEventListener("click", () => {
      void loadGameList().catch((e) => {
        setStatus(e instanceof Error ? e.message : String(e));
      });
    });
  }

  if (els.btnStop) {
    els.btnStop.addEventListener("click", () => stop());
  }

  if (els.btnDownloadRom) {
    els.btnDownloadRom.addEventListener("click", () => {
      void downloadCurrentRom();
    });
  }

  if (els.btnFullscreen) {
    els.btnFullscreen.addEventListener("click", () => void toggleFullscreen());
  }

  document.addEventListener("fullscreenchange", () => syncFullscreenClass());

  // Best effort: auto-detect local BIOS files.
  void tryLoadDefaultBios().finally(() => {
    setStatus("Chưa tải");
    setNowPlaying("(chưa chọn)");
    syncFullscreenClass();
    setDownloadButtonEnabled(false);
  });

  if (els.search) {
    els.search.addEventListener("input", () => {
      currentPage = 1;
      renderCurrentPage();
    });
  }

  // Auto load list on open
  void loadGameList().catch((e) => {
    setStatus(e instanceof Error ? e.message : String(e));
  });
})();
