// monitor/lib/metrics.mjs
// 严格按 CONTRACT.md §3 的公式实现派生指标。
// 约定：所有 *Rate / *Level 类指标均为 ratio（0-1），前端展示百分比时自行 *100；
//       heatIndex 为 0-100 的一位小数（契约 §3 固定算法）。

export const GROWTH_WINDOWS = [
  ["1m", 60],
  ["5m", 300],
  ["15m", 900],
  ["1h", 3600],
  ["24h", 86400],
];

// /api/latest 里 delta / ratePerMin 覆盖的数值型 key
export const DELTA_KEYS = [
  "readCount",
  "collectCount",
  "likeCount",
  "engagementRate",
  "collectRate",
  "likeRate",
  "heatIndex",
];

// ratePerMin 默认窗口：最近 5 分钟（不足则用首末两点）
export const RATE_WINDOW_SEC = 300;

// meta.metrics：前端 tooltip 用，key/name/formula/unit 必须与 §3 表格一致
export const METRIC_DEFS = [
  { key: "readCount", name: "播放量", formula: "read_count", unit: "次" },
  { key: "collectCount", name: "收藏数", formula: "collect_count", unit: "次" },
  { key: "likeCount", name: "点赞数", formula: "sum(online_base[].like_count)", unit: "次" },
  { key: "engagementRate", name: "互动率", formula: "(collectCount + likeCount) / readCount", unit: "ratio(0-1)" },
  { key: "collectRate", name: "收藏转化率", formula: "collectCount / readCount", unit: "ratio(0-1)" },
  { key: "likeRate", name: "点赞转化率", formula: "likeCount / readCount", unit: "ratio(0-1)" },
  { key: "paidRatio", name: "付费章节占比", formula: "(total - paidStart + 1) / total", unit: "ratio(0-1)" },
  { key: "freeLikes", name: "免费集点赞合计", formula: "sum(episodes[n < paidStart].likes)", unit: "次" },
  { key: "paidLikes", name: "付费集点赞合计", formula: "sum(episodes[n >= paidStart].likes)", unit: "次" },
  {
    key: "conversionProxy",
    name: "付费墙留存估算",
    formula: "min(1, paidAvgLikes / freeAvgLikes)",
    unit: "ratio(0-1)",
    proxy: true,
    note:
      "≈1 表示付费墙前后每集点赞热度持平（无明显衰减），越小表示衰减越明显；" +
      "clamp 到 [0,1]，配合 paidAvgLikes / freeAvgLikes 可解释。ReelShort 未公开真实付费数据，此为估算（代理指标）",
  },
  {
    key: "completionProxy",
    name: "追剧完成度估算",
    formula: "episodeLikes[last] / episodeLikes[first]",
    unit: "ratio(0-1)",
    proxy: true,
    note: "用最后一集/第一集点赞比估算追剧留存，非官方数据（估算）",
  },
  {
    key: "heatIndex",
    name: "热度指数",
    formula:
      "round((0.45 * likeRate * 100 + 0.35 * collectRate * 100 + 0.20 * min(readCount / 1e6, 1) * 100) * 10) / 10",
    unit: "指数(0-100)",
    note: "单一时刻计算，保留 1 位小数",
  },
];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const rate = (a, b) => (b > 0 ? a / b : 0);

// 比值型代理指标统一 clamp 到 [0,1]（负数/超 1 都不合语义）
const clamp01 = (v) => {
  if (!Number.isFinite(v)) return 0;
  return Math.round(Math.min(1, Math.max(0, v)) * 1e6) / 1e6;
};

const round = (v, digits = 6) => {
  if (!Number.isFinite(v)) return 0;
  const p = Math.pow(10, digits);
  return Math.round(v * p) / p;
};

const round1 = (v) => {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 10) / 10;
};

function splitEpisodes(snapshot) {
  const s = snapshot || {};
  const episodes = Array.isArray(s.episodes) ? s.episodes : [];
  const paidStart = num(s.paidStart);
  const free = [];
  const paid = [];
  for (const e of episodes) {
    const n = num(e && e.n);
    const likes = num(e && e.likes);
    if (paidStart > 0 && n >= paidStart) paid.push({ n, likes });
    else free.push({ n, likes });
  }
  return { episodes, paidStart, free, paid };
}

/**
 * §3 派生指标（/api/latest 的 derived 与 /api/history 的点值都基于它）
 */
export function derive(snapshot) {
  const s = snapshot || {};
  const { episodes, paidStart, free, paid } = splitEpisodes(s);
  const readCount = num(s.readCount);
  const collectCount = num(s.collectCount);
  const likeCount = num(s.likeCount);
  const total = num(s.total) || episodes.length;

  const engagementRate = round(rate(collectCount + likeCount, readCount));
  const collectRate = round(rate(collectCount, readCount));
  const likeRate = round(rate(likeCount, readCount));
  const paidRatio = total > 0 && paidStart > 0 ? round((total - paidStart + 1) / total) : 0;

  let freeLikes = 0;
  for (const e of free) freeLikes += e.likes;
  let paidLikes = 0;
  for (const e of paid) paidLikes += e.likes;

  const freeAvgLikes = free.length > 0 ? freeLikes / free.length : 0;
  const paidAvgLikes = paid.length > 0 ? paidLikes / paid.length : 0;
  const conversionProxy = clamp01(rate(paidAvgLikes, freeAvgLikes));

  const firstLikes = episodes.length > 0 ? num(episodes[0].likes) : 0;
  const lastLikes = episodes.length > 0 ? num(episodes[episodes.length - 1].likes) : 0;
  const completionProxy = firstLikes > 0 ? round(lastLikes / firstLikes) : 0;

  const raw =
    0.45 * likeRate * 100 +
    0.35 * collectRate * 100 +
    0.2 * Math.min(readCount / 1e6, 1) * 100;
  const heatIndex = round1(raw);

  return {
    readCount,
    collectCount,
    likeCount,
    engagementRate,
    collectRate,
    likeRate,
    paidRatio,
    freeLikes,
    paidLikes,
    conversionProxy,
    completionProxy,
    heatIndex,
    // 以下为便于前端展示的辅助值（非契约必需）
    total,
    paidStart,
    freeEpisodes: free.length,
    paidEpisodes: paid.length,
    freeAvgLikes: round(freeAvgLikes),
    paidAvgLikes: round(paidAvgLikes),
    firstEpisodeLikes: firstLikes,
    lastEpisodeLikes: lastLikes,
  };
}

/**
 * §5 /api/episodes 的 data
 */
export function episodeStats(snapshot) {
  const s = snapshot || {};
  const episodes = Array.isArray(s.episodes) ? s.episodes : [];
  const paidStart = num(s.paidStart);
  const total = num(s.total) || episodes.length;
  const firstLikes = episodes.length > 0 ? num(episodes[0].likes) : 0;

  const list = episodes.map((e) => {
    const n = num(e && e.n);
    const likes = num(e && e.likes);
    return {
      n,
      id: (e && e.id) || null,
      likes,
      dur: e && e.dur != null ? num(e.dur) : null,
      pic: (e && e.pic) || null,
      likeRateVsFirst: firstLikes > 0 ? round(likes / firstLikes) : 0,
      isPaid: paidStart > 0 && n >= paidStart,
    };
  });

  const free = list.filter((e) => !e.isPaid);
  const paid = list.filter((e) => e.isPaid);
  const freeLikes = free.reduce((a, e) => a + e.likes, 0);
  const paidLikes = paid.reduce((a, e) => a + e.likes, 0);
  const freeAvgLikes = free.length > 0 ? freeLikes / free.length : 0;
  const paidAvgLikes = paid.length > 0 ? paidLikes / paid.length : 0;
  const conversionProxy = clamp01(rate(paidAvgLikes, freeAvgLikes));
  const lastLikes = list.length > 0 ? list[list.length - 1].likes : 0;
  const completionProxy = firstLikes > 0 ? round(lastLikes / firstLikes) : 0;

  return {
    paidStart,
    total,
    episodes: list,
    funnel: {
      freeAvgLikes: round(freeAvgLikes),
      paidAvgLikes: round(paidAvgLikes),
      conversionProxy,
      completionProxy,
      // freeTotal / paidTotal = 免费集数 / 付费集数
      freeTotal: free.length,
      paidTotal: paid.length,
      // 附加：两组点赞总量，方便前端展示
      freeLikesTotal: freeLikes,
      paidLikesTotal: paidLikes,
      firstEpisodeLikes: firstLikes,
      lastEpisodeLikes: lastLikes,
      // conversionProxy = min(1, paidAvgLikes / freeAvgLikes)：1 表示付费墙前后持平，越小衰减越明显
      conversionNote:
        "conversionProxy = min(1, paidAvgLikes / freeAvgLikes)；≈1 表示付费墙前后每集点赞热度持平，越小说明衰减越明显",
      note: "ReelShort 未公开真实付费率/付费人数，付费相关数字均为基于公开点赞分布的估算（代理指标）",
    },
  };
}

/**
 * 窗口"样本充足"判定：窗口内实际跨度必须达到窗口时长的 COVERAGE_MIN，
 * 否则后端返回 null，前端据此显示"—（样本不足）"，避免把 577s 的历史误标成"近 1 小时"。
 */
export const COVERAGE_MIN = 0.6;

/**
 * §3 growth：各窗口内首末差。
 * 样本不足（<2 点，或窗口实际跨度 < 窗口时长 * COVERAGE_MIN）返回 null。
 */
export function growth(points) {
  const out = {};
  const pts = Array.isArray(points) ? points : [];
  for (const [key, sec] of GROWTH_WINDOWS) {
    if (pts.length < 2) {
      out[key] = null;
      continue;
    }
    const last = pts[pts.length - 1];
    const win = pts.filter((p) => p.ts >= last.ts - sec);
    if (win.length < 2) {
      out[key] = null;
      continue;
    }
    const a = win[0];
    const b = win[win.length - 1];
    const spanSec = b.ts - a.ts;
    // 实际跨度不足窗口 60% -> 视为样本不足
    if (spanSec < sec * COVERAGE_MIN) {
      out[key] = null;
      continue;
    }
    out[key] = {
      readCount: num(b.readCount) - num(a.readCount),
      collectCount: num(b.collectCount) - num(a.collectCount),
      likeCount: num(b.likeCount) - num(a.likeCount),
      samples: win.length,
      spanSec,
      // 便于前端判断覆盖度（1 = 窗口被完全覆盖）
      coverage: round(spanSec / sec, 4),
      windowSec: sec,
    };
  }
  return out;
}

const zerosDelta = (samples) => {
  const out = {};
  for (const k of DELTA_KEYS) out[k] = 0;
  out.spanSec = 0;
  out.samples = samples;
  return out;
};

/**
 * §3 delta：相对首次采样的累计增量
 */
export function deltaFromPoints(points) {
  const pts = Array.isArray(points) ? points : [];
  if (pts.length === 0) return zerosDelta(0);
  if (pts.length === 1) return zerosDelta(1);
  const a = pts[0];
  const b = pts[pts.length - 1];
  const out = {};
  for (const k of DELTA_KEYS) out[k] = round(num(b[k]) - num(a[k]));
  out.spanSec = b.ts - a.ts;
  out.samples = pts.length;
  return out;
}

/**
 * §3 ratePerMin：窗口（默认最近 5 分钟，不足则用首末两点）的每分钟增量
 */
export function ratePerMinFromPoints(points, windowSec = RATE_WINDOW_SEC) {
  const pts = Array.isArray(points) ? points : [];
  if (pts.length === 0) return zerosDelta(0);
  const last = pts[pts.length - 1];
  let win = pts.filter((p) => p.ts >= last.ts - windowSec);
  if (win.length < 2) win = [pts[0], last];
  const a = win[0];
  const b = win[win.length - 1];
  const spanSec = b.ts - a.ts;
  const minutes = spanSec > 0 ? spanSec / 60 : 0;
  const out = {};
  for (const k of DELTA_KEYS) {
    const diff = num(b[k]) - num(a[k]);
    out[k] = minutes > 0 ? round(diff / minutes) : 0;
  }
  out.spanSec = spanSec;
  out.samples = win.length;
  return out;
}
