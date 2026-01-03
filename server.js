/*
  Minimal Drive proxy + static server

  Why:
  - Avoid calling googleapis.com directly from browser (CORS + "We're sorry" blocks)
  - Keep Drive API key on server side

  Endpoints:
  - GET /api/drive/folder/:id   -> JSON { files: [{id,name,mimeType}], cached }
  - GET /api/drive/file/:id     -> streams file bytes (alt=media)

  Env:
  - DRIVE_API_KEY   (required for folder listing + drive v3 alt=media)
  - PORT            (default 5173)
*/

const express = require("express");
const fs = require("fs");
const path = require("path");

// Minimal .env loader (avoids extra dependencies)
// - Loads .env from project root if present
// - Does not override existing process.env values
try {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const s = String(line || "").trim();
      if (!s || s.startsWith("#")) continue;
      const eq = s.indexOf("=");
      if (eq < 0) continue;
      const key = s.slice(0, eq).trim();
      let val = s.slice(eq + 1).trim();
      if (!key) continue;
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
      if (process.env[key] == null) process.env[key] = val;
    }
  }
} catch {
  // ignore
}

const app = express();

app.disable("x-powered-by");

const PORT = Number(process.env.PORT) || 5173;
const DRIVE_API_KEY = String(process.env.DRIVE_API_KEY || "").trim();

function isLoopbackIp(ip) {
  const s = String(ip || "").trim();
  if (!s) return false;
  if (s === "127.0.0.1" || s === "::1") return true;
  // Express may return ipv6-mapped ipv4 addresses
  if (s.startsWith("::ffff:")) {
    const v4 = s.slice("::ffff:".length);
    if (v4 === "127.0.0.1") return true;
  }
  return false;
}

function getDriveApiKeyForRequest(req) {
  if (DRIVE_API_KEY) return DRIVE_API_KEY;

  // Local-only fallback: allow passing key via query/header when calling from localhost.
  // This is meant for local dev so users don't have to restart server after editing .env.
  if (!isLoopbackIp(req.ip)) return "";

  const fromQuery = typeof req.query?.key === "string" ? req.query.key : "";
  const fromHeader =
    typeof req.headers["x-drive-api-key"] === "string"
      ? req.headers["x-drive-api-key"]
      : "";

  return String(fromQuery || fromHeader || "").trim();
}

// If deployed behind a reverse proxy (Cloudflare/Nginx/Vercel/etc.), enable this.
// NOTE: Only set this when you actually have a trusted proxy in front.
const TRUST_PROXY = String(process.env.TRUST_PROXY || "").trim();
if (TRUST_PROXY === "1" || TRUST_PROXY.toLowerCase() === "true") {
  app.set("trust proxy", 1);
}

function parseCsvSet(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

// CORS allowlist (optional).
// - If empty: do not add CORS headers (same-origin only).
// - If set: only allow listed origins.
const ALLOWED_ORIGINS = parseCsvSet(process.env.ALLOWED_ORIGINS);

// Drive proxy allowlists (strongly recommended for public deployments).
// - If these are set, the proxy will only serve those folders/files.
const ALLOWED_DRIVE_FOLDER_IDS = parseCsvSet(
  process.env.ALLOWED_DRIVE_FOLDER_IDS
);
const ALLOWED_DRIVE_FILE_IDS = parseCsvSet(process.env.ALLOWED_DRIVE_FILE_IDS);

// If true, block requests when allowlists are set and id isn't allowed.
// Default: true when any allowlist is present.
const STRICT_DRIVE_ALLOWLIST = (() => {
  const raw = String(process.env.STRICT_DRIVE_ALLOWLIST || "").trim();
  if (!raw) {
    return ALLOWED_DRIVE_FOLDER_IDS.size > 0 || ALLOWED_DRIVE_FILE_IDS.size > 0;
  }
  return raw === "1" || raw.toLowerCase() === "true";
})();

// Simple in-memory rate limit for public proxy abuse prevention.
const RATE_LIMIT_WINDOW_MS = Number(
  process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000
);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 180);

function isValidDriveId(id) {
  // Drive ids are typically base64url-ish: letters/digits/_-
  return /^[A-Za-z0-9_-]{10,}$/.test(String(id || ""));
}

function isAllowedFolderId(folderId) {
  if (ALLOWED_DRIVE_FOLDER_IDS.size === 0) return true;
  return ALLOWED_DRIVE_FOLDER_IDS.has(folderId);
}

const DRIVE_MIN_INTERVAL_MS = Number(process.env.DRIVE_MIN_INTERVAL_MS || 800);
const DRIVE_MAX_RETRIES = Number(process.env.DRIVE_MAX_RETRIES || 4);
const DRIVE_FOLDER_CACHE_TTL_MS = Number(
  process.env.DRIVE_FOLDER_CACHE_TTL_MS || 6 * 60 * 60 * 1000
);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

// Basic security headers (keep minimal to avoid breaking emulator/CDN scripts)
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader(
    "Permissions-Policy",
    "geolocation=(), microphone=(), camera=()"
  );
  next();
});

// CORS (optional). If you serve frontend from the same server, you usually don't need this.
app.use((req, res, next) => {
  const origin = String(req.headers.origin || "").trim();

  if (ALLOWED_ORIGINS.size === 0) {
    // Same-origin only: do not add CORS headers.
    // Still reply to OPTIONS quickly.
    if (req.method === "OPTIONS") return res.sendStatus(204);
    return next();
  }

  // If an Origin header exists, enforce allowlist.
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return res.status(403).send("Origin not allowed");
  }

  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range"
  );
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

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

let queue = Promise.resolve();
let lastStartMs = 0;

function enqueue(task) {
  const next = queue.then(task, task);
  queue = next.catch(() => {});
  return next;
}

async function waitSlot() {
  const now = Date.now();
  const wait = Math.max(0, DRIVE_MIN_INTERVAL_MS - (now - lastStartMs));
  if (wait) await sleep(wait);
  lastStartMs = Date.now();
}

async function driveFetchText(url, { signal } = {}) {
  return enqueue(async () => {
    let lastErr;
    for (let attempt = 0; attempt <= DRIVE_MAX_RETRIES; attempt++) {
      await waitSlot();

      try {
        const res = await fetch(url, { cache: "no-store", signal });
        const text = await res.text();

        const blockedHtml = looksLikeGoogleSorryHtml(text);
        if (res.ok && !blockedHtml) return { res, text };

        const retryable = isRetryableStatus(res.status) || blockedHtml;
        lastErr = new Error(
          blockedHtml
            ? "Google đang chặn tạm thời (We're sorry / unusual traffic)."
            : `Drive API lỗi (${res.status}).`
        );

        if (!retryable || attempt === DRIVE_MAX_RETRIES) throw lastErr;
        await sleep(backoffMs(attempt));
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        if (attempt === DRIVE_MAX_RETRIES) throw lastErr;
        await sleep(backoffMs(attempt));
      }
    }
    throw lastErr || new Error("Drive API lỗi.");
  });
}

async function driveFetchJson(url, { signal } = {}) {
  const { text } = await driveFetchText(url, { signal });
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

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    driveKeyConfigured: !!DRIVE_API_KEY,
    localQueryKeySupported: true,
  });
});

const folderCache = new Map(); // folderId -> { t, files }
const allowedDiscoveredFileIds = new Set(ALLOWED_DRIVE_FILE_IDS);

function rateLimitKey(req) {
  // Keep it simple: IP only.
  // If TRUST_PROXY is enabled, Express will use X-Forwarded-For.
  return String(req.ip || "");
}

const rateState = new Map(); // key -> { resetAt, count }

function rateLimit(req, res, next) {
  if (!RATE_LIMIT_MAX || RATE_LIMIT_MAX <= 0) return next();

  const key = rateLimitKey(req);
  const now = Date.now();
  const cur = rateState.get(key);

  if (!cur || now >= cur.resetAt) {
    rateState.set(key, { resetAt: now + RATE_LIMIT_WINDOW_MS, count: 1 });
    return next();
  }

  cur.count += 1;
  if (cur.count <= RATE_LIMIT_MAX) return next();

  const retryAfterSec = Math.max(1, Math.ceil((cur.resetAt - now) / 1000));
  res.setHeader("Retry-After", String(retryAfterSec));
  return res.status(429).send("Too many requests");
}

app.get("/api/drive/folder/:id", rateLimit, async (req, res) => {
  try {
    const key = getDriveApiKeyForRequest(req);
    if (!key) {
      res.status(500).json({
        error:
          "Thiếu DRIVE_API_KEY trên server. Cách 1: tạo file .env và set DRIVE_API_KEY=YOUR_KEY rồi restart server. Cách 2 (localhost): gọi /api/drive/*?key=YOUR_KEY.",
      });
      return;
    }

    const folderId = String(req.params.id || "").trim();
    if (!folderId || !isValidDriveId(folderId)) {
      res.status(400).json({ error: "Missing folder id" });
      return;
    }

    if (STRICT_DRIVE_ALLOWLIST && !isAllowedFolderId(folderId)) {
      res.status(403).json({ error: "Folder not allowed" });
      return;
    }

    const cached = folderCache.get(folderId);
    const now = Date.now();
    if (cached && now - cached.t < DRIVE_FOLDER_CACHE_TTL_MS) {
      res.json({ files: cached.files, cached: true });
      return;
    }

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
        key
      )}`;

      const data = await driveFetchJson(listUrl);
      const files = Array.isArray(data.files) ? data.files : [];
      all.push(...files);

      if (typeof data.nextPageToken === "string" && data.nextPageToken.trim()) {
        pageToken = data.nextPageToken.trim();
      } else {
        pageToken = "";
        break;
      }
    }

    folderCache.set(folderId, { t: now, files: all });

    // Remember file IDs we discovered from allowed folders so /file can be validated.
    if (isAllowedFolderId(folderId)) {
      for (const f of all) {
        if (f && typeof f.id === "string" && isValidDriveId(f.id)) {
          allowedDiscoveredFileIds.add(f.id);
        }
      }
    }

    res.json({ files: all, cached: false });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/drive/file/:id", rateLimit, async (req, res) => {
  try {
    const key = getDriveApiKeyForRequest(req);
    if (!key) {
      res
        .status(500)
        .send(
          "Thiếu DRIVE_API_KEY trên server. Cách 1: tạo file .env và set DRIVE_API_KEY=YOUR_KEY rồi restart server. Cách 2 (localhost): gọi /api/drive/*?key=YOUR_KEY."
        );
      return;
    }

    const fileId = String(req.params.id || "").trim();
    if (!fileId || !isValidDriveId(fileId)) {
      res.status(400).send("Missing file id");
      return;
    }

    if (STRICT_DRIVE_ALLOWLIST) {
      const allowed =
        ALLOWED_DRIVE_FILE_IDS.size === 0
          ? allowedDiscoveredFileIds.has(fileId)
          : ALLOWED_DRIVE_FILE_IDS.has(fileId) ||
            allowedDiscoveredFileIds.has(fileId);
      if (!allowed) {
        res.status(403).send("File not allowed");
        return;
      }
    }

    // Throttle these too
    await enqueue(waitSlot);

    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${encodeURIComponent(
      key
    )}`;

    const upstream = await fetch(url, { cache: "no-store" });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      if (looksLikeGoogleSorryHtml(text)) {
        res
          .status(429)
          .send("Google đang chặn tạm thời (We're sorry). Thử lại sau.");
        return;
      }
      res
        .status(upstream.status)
        .send(text || `Drive download failed (${upstream.status})`);
      return;
    }

    const contentType =
      upstream.headers.get("content-type") || "application/octet-stream";
    if (contentType.toLowerCase().includes("text/html")) {
      const text = await upstream.text().catch(() => "");
      if (looksLikeGoogleSorryHtml(text)) {
        res
          .status(429)
          .send("Google đang chặn tạm thời (We're sorry). Thử lại sau.");
        return;
      }
      res.status(502).send("Upstream returned HTML (not ROM bytes).");
      return;
    }

    res.setHeader("Content-Type", contentType);

    const cl = upstream.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);

    // Stream through
    if (!upstream.body) {
      res.status(502).send("No upstream body");
      return;
    }

    await upstream.body
      .pipeTo(
        new WritableStream({
          write(chunk) {
            res.write(Buffer.from(chunk));
          },
          close() {
            res.end();
          },
          abort(err) {
            try {
              res.destroy(err);
            } catch {
              // ignore
            }
          },
        })
      )
      .catch((err) => {
        try {
          res.destroy(err);
        } catch {
          // ignore
        }
      });
  } catch (e) {
    res.status(500).send(e instanceof Error ? e.message : String(e));
  }
});

// Serve static files from repo root
app.use(
  express.static(__dirname, {
    dotfiles: "deny",
    index: ["index.html"],
  })
);

const server = app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
  console.log(`Health:        http://localhost:${PORT}/api/health`);
});

server.on("error", (err) => {
  const code = err && typeof err === "object" ? err.code : "";
  if (code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Set PORT in .env or stop the other process.`
    );
    process.exit(1);
  }
});
