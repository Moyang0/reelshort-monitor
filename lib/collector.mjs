// monitor/lib/collector.mjs
// 按 CONTRACT.md §1 采集 ReelShort getBookInfo（+ getChapterList 取每集时长），产出 §4 Snapshot。
// 纯 Node 22 内置 fetch。失败抛错，由调用方决定是否落盘（绝不写坏数据）。

export const BOOK_ID = "6ad02fe293e1dedf6b0c1bd7";
export const SOURCE = "reelshort.com";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const BOOK_INFO_URL = "https://www.reelshort.com/api/video/book/getBookInfo?book_id=" + BOOK_ID;
const CHAPTER_LIST_URL =
  "https://www.reelshort.com/api/video/book/getChapterList?book_id=" + BOOK_ID + "&page=1&page_size=100";

const REQUEST_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 15000);

const iso = (ts) => new Date(ts * 1000).toISOString();

async function getJSON(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": UA,
        accept: "application/json, text/plain, */*",
        "accept-language": "en-US,en;q=0.9",
        referer: "https://www.reelshort.com/",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("HTTP " + res.status + " " + url);
    const body = await res.json();
    if (!body || body.code !== 0) {
      throw new Error("API code " + (body && body.code) + " " + ((body && body.msg) || ""));
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// 集时长（可选，失败不影响采集）
async function fetchDurations() {
  const map = Object.create(null);
  try {
    const cl = await getJSON(CHAPTER_LIST_URL);
    const list = (cl && cl.data && cl.data.chapter_list) || [];
    for (const c of list) {
      if (c && c.chapter_id) map[c.chapter_id] = c.duration == null ? null : Number(c.duration);
    }
  } catch (err) {
    // 时长拿不到不算失败
  }
  return map;
}

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 采集一次，返回 §4 的 Snapshot。任何字段缺失都抛错（不产出坏数据）。
 */
export async function collectOnce() {
  const [info, durations] = [await getJSON(BOOK_INFO_URL), await fetchDurations()];
  const d = info && info.data;
  if (!d || typeof d !== "object") throw new Error("getBookInfo: empty data");
  if (!Array.isArray(d.online_base) || d.online_base.length === 0) {
    throw new Error("getBookInfo: online_base missing/empty");
  }

  const episodes = d.online_base
    .filter((e) => e && e.serial_number != null)
    .map((e) => ({
      n: toNum(e.serial_number),
      id: e.chapter_id || null,
      likes: toNum(e.like_count),
      dur: durations[e.chapter_id] == null ? null : toNum(durations[e.chapter_id]),
      pic: e.video_pic || null,
    }))
    .sort((a, b) => a.n - b.n);

  const ts = toNum(info.server_time) || Math.floor(Date.now() / 1000);
  const bm = d.book_mark || {};
  const likeCount = episodes.reduce((acc, e) => acc + e.likes, 0);

  return {
    ts,
    iso: iso(ts),
    bookId: d.book_id || BOOK_ID,
    title: d.book_title || "",
    cover: d.book_pic || "",
    desc: d.special_desc || "",
    tags: Array.isArray(d.tag_list) ? d.tag_list.map((t) => (t && t.text) || String(t || "")).filter(Boolean) : [],
    lang: d.lang || "",
    isAi: toNum(d.is_ai),
    updateStatus: toNum(d.update_status),
    bookMark: {
      type: bm.type,
      color: bm.color,
      textColor: bm.text_color,
      text: bm.text,
    },
    total: toNum(d.total) || episodes.length,
    paidStart: toNum(d.paid_start),
    publishAt: toNum(d.publish_at),
    onlineAt: toNum(d.online_at),
    readCount: toNum(d.read_count),
    collectCount: toNum(d.collect_count),
    likeCount,
    episodes,
    ok: true,
  };
}

/**
 * 带重试的采集（指数退避）。全部失败则抛出最后一个错误，不落盘。
 */
export async function collectWithRetry({ retries = 2, baseDelayMs = 1200, log = () => {} } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await collectOnce();
    } catch (err) {
      lastErr = err;
      log("collect attempt " + (attempt + 1) + "/" + (retries + 1) + " failed: " + err.message);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr || new Error("collect failed");
}

/**
 * 离线合成快照（仅 SELFTEST_FAKE=1 时由 server 用来模拟"数据变化"，绝不落盘到 jsonl）
 */
export function fakeNextSnapshot(prev) {
  const base = prev || {
    ts: Math.floor(Date.now() / 1000),
    bookId: BOOK_ID,
    title: "The Tempted DILF Is My Professor",
    cover: "",
    desc: "",
    tags: [],
    lang: "en",
    isAi: 1,
    updateStatus: 1,
    bookMark: { type: 3, color: "#FFE52E2E", textColor: "#FFFFFFFF", text: "New" },
    total: 56,
    paidStart: 12,
    publishAt: 0,
    onlineAt: 0,
    readCount: 445720,
    collectCount: 13224,
    likeCount: 243359,
    episodes: Array.from({ length: 56 }, (_, i) => ({
      n: i + 1,
      id: "fake" + (i + 1),
      likes: i === 0 ? 5437 : Math.round(5437 * Math.pow(0.985, i)),
      dur: 90,
      pic: null,
    })),
    ok: true,
  };
  const jitter = () => Math.floor(Math.random() * 40);
  const episodes = (base.episodes || []).map((e) => ({
    ...e,
    likes: toNum(e.likes) + Math.floor(Math.random() * 3),
  }));
  const ts = Math.max(toNum(base.ts) + 1, Math.floor(Date.now() / 1000));
  return {
    ...base,
    ts,
    iso: iso(ts),
    readCount: toNum(base.readCount) + 17 + jitter(),
    collectCount: toNum(base.collectCount) + 3,
    likeCount: episodes.reduce((a, e) => a + e.likes, 0),
    episodes,
    ok: true,
  };
}
