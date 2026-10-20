// monitor/server.mjs
// ReelShort 剧集实时监控后端 —— 纯 Node 22 内置模块，无任何 npm 依赖。
// 严格实现 monitor/CONTRACT.md §1-§5。
//
// 运行：node monitor/server.mjs            （默认 http://127.0.0.1:8899）
// 环境变量：
//   PORT(8899) HOST(127.0.0.1) POLL_MS(60000) HISTORY_MAX(5000) POLL_INITIAL_DELAY_MS(0)
//   SELFTEST_FAKE=1            离线合成采样（不落盘）——仅自测用
//   SELFTEST_START_EMPTY=1     启动时忽略已有历史（不写盘）——仅自测用
//   DATA_DIR                   数据目录覆盖（默认 monitor/data）——仅自测用
//   SSE_PING_IDLE_MS(15000)    SSE 空闲 ping 间隔覆盖——仅自测用
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { BOOK_ID, SOURCE, collectWithRetry, fakeNextSnapshot } from "./lib/collector.mjs";
import { Store, downsample } from "./lib/store.mjs";
import {
  METRIC_DEFS,
  deltaFromPoints,
  episodeStats,
  growth,
  ratePerMinFromPoints,
} from "./lib/metrics.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : resolve(__dirname, "data");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8899);
const POLL_MS = Math.max(1000, Number(process.env.POLL_MS || 60000));
const HISTORY_MAX = Math.max(2, Number(process.env.HISTORY_MAX || 5000));
const POLL_INITIAL_DELAY_MS = Math.max(0, Number(process.env.POLL_INITIAL_DELAY_MS || 0));
const FAKE = process.env.SELFTEST_FAKE === "1";
const START_EMPTY = process.env.SELFTEST_START_EMPTY === "1";
const COLLECT_RATE_LIMIT_MS = 2000;
// 契约 §5：每 15s 未更新时发 ping。可用 SSE_PING_IDLE_MS 覆盖（仅自测用）
const SSE_PING_IDLE_MS = Math.max(500, Number(process.env.SSE_PING_IDLE_MS || 15000));

const startedAtMs = Date.now();
const startedAtIso = new Date(startedAtMs).toISOString();

const log = (...args) => console.log(new Date().toISOString(), ...args);

// ---------------------------------------------------------------- 运行时状态
const state = {
  polls: 0, // 成功采样次数
  pollsFailed: 0,
  consecutiveErrors: 0,
  lastError: null,
  lastTs: null,
  lastIso: null,
  lastCollectAt: 0, // ms，用于 /api/collect 限流
  collecting: null,
};

const store = new Store({
  dataDir: DATA_DIR,
  historyMax: HISTORY_MAX,
  disabled: FAKE || START_EMPTY,
  log,
});

const sseClients = new Set();
let server = null;

// ---------------------------------------------------------------- 组装响应
function buildMeta() {
  const entry = store.latestEntry;
  const snap = entry ? entry.snap : null;
  const drama = snap
    ? {
        bookId: snap.bookId || BOOK_ID,
        title: snap.title || "",
        cover: snap.cover || "",
        desc: snap.desc || "",
        tags: Array.isArray(snap.tags) ? snap.tags : [],
        total: snap.total,
        paidStart: snap.paidStart,
        publishAt: snap.publishAt,
        onlineAt: snap.onlineAt,
        lang: snap.lang,
        isAi: snap.isAi,
        bookMark: snap.bookMark || null,
      }
    : null;
  return { drama, metrics: METRIC_DEFS, pollMs: POLL_MS, startedAt: startedAtIso, source: SOURCE };
}

function buildLatest() {
  const entry = store.latestEntry;
  if (!entry) {
    return {
      snapshot: null,
      derived: null,
      growth: {},
      delta: deltaFromPoints([]),
      ratePerMin: ratePerMinFromPoints([]),
      firstTs: null,
      sampleCount: 0,
    };
  }
  const points = store.points;
  return {
    snapshot: entry.snap,
    derived: entry.derived,
    growth: growth(points),
    delta: deltaFromPoints(points),
    ratePerMin: ratePerMinFromPoints(points),
    firstTs: points.length ? points[0].ts : entry.ts,
    sampleCount: points.length,
  };
}

function buildHealth() {
  return {
    ok: true,
    uptimeSec: Math.round((Date.now() - startedAtMs) / 1000),
    pollMs: POLL_MS,
    polls: state.polls,
    pollsFailed: state.pollsFailed,
    lastTs: state.lastTs,
    lastIso: state.lastIso,
    consecutiveErrors: state.consecutiveErrors,
    source: SOURCE,
    bookId: BOOK_ID,
    sampleCount: store.points.length,
    firstTs: store.firstTs,
    // 启动时从 jsonl 恢复的明细：polls 只统计本次进程内采样，不代表总点数
    seedLoaded: {
      restored: store.restored.total,
      fromSeed: store.restored.seed,
      fromRuntime: store.restored.runtime,
      files: store.restored.files,
      invalidLines: store.restored.invalid,
      duplicateTs: store.restored.duplicates,
      historyMax: store.restored.historyMax,
      loadedAt: store.restored.loadedAt,
    },
    lastError: state.lastError,
    sseClients: sseClients.size,
    startedAt: startedAtIso,
    fake: FAKE || undefined,
  };
}

function buildHistory(query) {
  const minutesRaw = query.get("minutes");
  const maxRaw = query.get("max");
  let minutes = minutesRaw === null ? 1440 : Number(minutesRaw);
  if (minutesRaw === "all" || (!Number.isFinite(minutes) && minutesRaw !== null)) minutes = 0;
  if (!Number.isFinite(minutes)) minutes = 1440;
  let max = maxRaw === null ? 2000 : Number(maxRaw);
  if (!Number.isFinite(max) || max <= 0) max = 2000;

  const win = store.windowPoints(minutes);
  const points = downsample(win, max);
  return {
    points,
    count: points.length,
    total: win.length,
    from: points.length ? points[0].ts : null,
    to: points.length ? points[points.length - 1].ts : null,
    fromIso: points.length ? points[0].iso : null,
    toIso: points.length ? points[points.length - 1].iso : null,
    minutes,
    max,
    pollMs: POLL_MS,
  };
}

function buildEpisodes() {
  const entry = store.latestEntry;
  if (!entry) {
    return { paidStart: 0, total: 0, episodes: [], funnel: null };
  }
  return episodeStats(entry.snap);
}

// ---------------------------------------------------------------- SSE
function sseSend(res, event, data) {
  try {
    res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
    return true;
  } catch (err) {
    return false;
  }
}

function broadcast(event, data) {
  const now = Date.now();
  for (const client of sseClients) {
    if (!sseSend(client.res, event, data)) {
      sseClients.delete(client);
      continue;
    }
    client.lastAt = now;
  }
}

const HEARTBEAT_MS = Math.max(250, Math.min(5000, Math.floor(SSE_PING_IDLE_MS / 2)));
const heartbeat = setInterval(() => {
  const now = Date.now();
  for (const client of sseClients) {
    if (now - client.lastAt >= SSE_PING_IDLE_MS) {
      if (!sseSend(client.res, "ping", { ts: Math.floor(now / 1000) })) {
        sseClients.delete(client);
        continue;
      }
      client.lastAt = now;
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref?.();

// ---------------------------------------------------------------- 采集
async function doCollect(trigger) {
  if (state.collecting) return state.collecting;
  state.collecting = (async () => {
    const beganAt = Date.now();
    state.lastCollectAt = beganAt;
    try {
      const snap = FAKE
        ? fakeNextSnapshot(store.latestEntry ? store.latestEntry.snap : null)
        : await collectWithRetry({ retries: 2, log });

      const prev = store.latestEntry;
      const sameTs = Boolean(prev && Number(prev.ts) === Number(snap.ts));
      store.append(snap, { write: !sameTs });

      state.polls++;
      state.consecutiveErrors = 0;
      state.lastError = null;
      state.lastTs = snap.ts;
      state.lastIso = snap.iso;

      const latest = buildLatest();
      broadcast("snapshot", latest);
      log(
        "collect[" + trigger + "] ok ts=" + snap.ts + " read=" + snap.readCount + " collect=" + snap.collectCount +
          " like=" + snap.likeCount + (sameTs ? " (same ts, replaced)" : "") + " points=" + store.points.length
      );
      return latest;
    } catch (err) {
      state.pollsFailed++;
      state.consecutiveErrors++;
      state.lastError = String((err && err.message) || err);
      log("collect[" + trigger + "] FAILED: " + state.lastError + " (consecutive=" + state.consecutiveErrors + ")");
      throw err;
    } finally {
      state.collecting = null;
    }
  })();
  return state.collecting;
}

// 启动时已立刻采过一次，因此周期任务第一次触发应在一个 POLL_MS 之后
// （POLL_INITIAL_DELAY_MS 仅用于自测时把首次周期采样提前）
function schedule() {
  const delay = Number.isFinite(POLL_INITIAL_DELAY_MS) && POLL_INITIAL_DELAY_MS > 0 ? POLL_INITIAL_DELAY_MS : POLL_MS;
  const tick = () => {
    doCollect("poll").catch(() => {}).finally(() => {
      const timer = setTimeout(tick, POLL_MS);
      timer.unref?.();
    });
  };
  const first = setTimeout(tick, delay);
  first.unref?.();
}

// ---------------------------------------------------------------- HTTP 工具
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...CORS_HEADERS,
  });
  res.end(body);
}

const ok = (res, data) => sendJSON(res, 200, { ok: true, data });
const fail = (res, status, error) => sendJSON(res, status, { ok: false, error: String(error) });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

function serveStatic(req, res, pathname) {
  let rel = pathname;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return fail(res, 400, "bad path");
  }
  if (rel.endsWith("/")) rel += "index.html";
  const full = resolve(PUBLIC_DIR, "." + rel);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + sep)) {
    return fail(res, 403, "forbidden");
  }
  let target = full;
  try {
    if (existsSync(target) && statSync(target).isDirectory()) target = resolve(target, "index.html");
    if (!existsSync(target) || !statSync(target).isFile()) {
      return fail(res, 404, "not found: " + rel);
    }
    const buf = readFileSync(target);
    res.writeHead(200, {
      "content-type": MIME[extname(target).toLowerCase()] || "application/octet-stream",
      "content-length": buf.length,
      "cache-control": "no-cache, no-store, must-revalidate",
      ...CORS_HEADERS,
    });
    res.end(req.method === "HEAD" ? undefined : buf);
  } catch (err) {
    return fail(res, 500, "static error: " + ((err && err.message) || err));
  }
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolvePromise) => {
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) req.destroy();
    });
    req.on("end", () => resolvePromise(true));
    req.on("error", () => resolvePromise(false));
  });
}

function handleSSE(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...CORS_HEADERS,
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  res.write("retry: 3000\n\n");

  const client = { res, lastAt: Date.now(), openedAt: Date.now() };
  sseClients.add(client);

  sseSend(res, "hello", { meta: buildMeta(), latest: buildLatest() });
  client.lastAt = Date.now();
  log("sse +1 (total=" + sseClients.size + ")");

  const cleanup = () => {
    if (sseClients.delete(client)) log("sse -1 (total=" + sseClients.size + ")");
  };
  req.on("close", cleanup);
  req.on("aborted", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
}

// ---------------------------------------------------------------- 路由
async function handleApi(req, res, pathname, query) {
  const method = req.method || "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, { ...CORS_HEADERS, "cache-control": "no-store" });
    return res.end();
  }

  if (pathname === "/api/health" && (method === "GET" || method === "HEAD")) return ok(res, buildHealth());
  if (pathname === "/api/meta" && (method === "GET" || method === "HEAD")) return ok(res, buildMeta());
  if (pathname === "/api/latest" && (method === "GET" || method === "HEAD")) return ok(res, buildLatest());
  if (pathname === "/api/history" && (method === "GET" || method === "HEAD")) return ok(res, buildHistory(query));
  if (pathname === "/api/episodes" && (method === "GET" || method === "HEAD")) return ok(res, buildEpisodes());

  if (pathname === "/api/stream") {
    if (method !== "GET") return fail(res, 405, "method not allowed: " + method);
    return handleSSE(req, res);
  }

  if (pathname === "/api/collect") {
    if (method !== "POST" && method !== "GET") return fail(res, 405, "method not allowed: " + method);
    await readBody(req);
    const since = Date.now() - state.lastCollectAt;
    if (state.collecting) {
      // 已有采集在飞行中：等它结束。成功返回最新数据，失败必须如实返回 502
      try {
        const latest = await state.collecting;
        return ok(res, latest);
      } catch (err) {
        return sendJSON(res, 502, {
          ok: false,
          error: "collect failed: " + ((err && err.message) || err),
          data: buildLatest(),
        });
      }
    }
    if (since < COLLECT_RATE_LIMIT_MS && store.latestEntry) {
      return sendJSON(res, 200, {
        ok: true,
        data: buildLatest(),
        note: "rate-limited: 2s 内最多触发一次采样，返回当前最新数据",
        rateLimited: true,
        retryAfterMs: COLLECT_RATE_LIMIT_MS - since,
      });
    }
    try {
      const latest = await doCollect("api");
      return ok(res, latest);
    } catch (err) {
      return sendJSON(res, 502, {
        ok: false,
        error: "collect failed: " + ((err && err.message) || err),
        data: buildLatest(),
      });
    }
  }

  return fail(res, 404, "unknown api: " + pathname);
}

const serverInstance = createServer((req, res) => {
  (async () => {
    let url;
    try {
      url = new URL(req.url || "/", "http://" + (req.headers.host || HOST + ":" + PORT));
    } catch {
      return fail(res, 400, "bad url");
    }
    const pathname = url.pathname;
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return handleApi(req, res, pathname, url.searchParams);
    }
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, pathname);
    return fail(res, 405, "method not allowed: " + req.method);
  })().catch((err) => {
    log("request error:", (err && err.stack) || err);
    try {
      if (!res.headersSent) fail(res, 500, "internal error: " + ((err && err.message) || err));
      else res.end();
    } catch {
      /* noop */
    }
  });
});

serverInstance.on("clientError", (err, socket) => {
  try {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  } catch {
    /* noop */
  }
});

// ---------------------------------------------------------------- 启动
function shutdown(signal) {
  log("shutting down (" + signal + ")");
  clearInterval(heartbeat);
  for (const client of sseClients) {
    try {
      client.res.end();
    } catch {
      /* noop */
    }
  }
  sseClients.clear();
  serverInstance.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref?.();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => log("uncaughtException:", (err && err.stack) || err));
process.on("unhandledRejection", (err) => log("unhandledRejection:", (err && err.stack) || err));

async function main() {
  if (FAKE || START_EMPTY) log("WARN: self-test mode — 不读/不写 monitor/data/*.jsonl (FAKE=" + FAKE + ", START_EMPTY=" + START_EMPTY + ")");
  const loaded = store.load();
  // 历史恢复后，health 的 lastTs/lastIso 必须反映恢复后的最新采样（而不是 null）
  const restored = store.latestEntry;
  if (restored) {
    state.lastTs = restored.ts;
    state.lastIso = restored.snap.iso || new Date(restored.ts * 1000).toISOString();
  }
  log(
    "history loaded: " + loaded + " points" +
      (store.firstTs ? " (from " + store.firstTs + " to " + store.lastTs + ")" : "") +
      (store.loadStats.dropped ? ", dropped " + store.loadStats.dropped : "")
  );

  await new Promise((resolvePromise, reject) => {
    serverInstance.once("error", reject);
    serverInstance.listen(PORT, HOST, () => resolvePromise());
  });
  log("listening on http://" + HOST + ":" + PORT + "  (poll=" + POLL_MS + "ms, historyMax=" + HISTORY_MAX + ")");

  // 启动立刻采一次（不阻塞服务可用）
  doCollect("startup")
    .catch(() => {})
    .finally(() => schedule());
}

main().catch((err) => {
  log("fatal:", (err && err.stack) || err);
  process.exit(1);
});
