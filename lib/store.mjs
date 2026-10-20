// monitor/lib/store.mjs
// 按 CONTRACT.md §2 实现采样落盘与启动恢复：
//  - 启动读取 monitor/data/ 下所有 *.jsonl（含 Lead 预采样的 seed.jsonl），
//    按 ts 升序合并、同一 ts 去重（后出现的覆盖先出现的），取最后 HISTORY_MAX 条进内存
//  - 运行时只追加写 snapshots.jsonl（绝不改 seed.jsonl）
//  - 每次成功采样同步更新 latest.json
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { derive } from "./metrics.mjs";

export const SNAPSHOTS_FILE = "snapshots.jsonl";
export const LATEST_FILE = "latest.json";

// 运行时管理文件，不参与历史载入
const IGNORED_FILES = new Set(["latest.json", "state.json", "health.json"]);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function safeJSONParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** 校验一行是否为可用的 Snapshot（§4） */
export function isSnapshot(v) {
  if (!v || typeof v !== "object") return false;
  if (!Number.isFinite(Number(v.ts)) || Number(v.ts) <= 0) return false;
  if (!Number.isFinite(Number(v.readCount))) return false;
  if (!Array.isArray(v.episodes)) return false;
  return true;
}

/** Snapshot -> /api/history 的点（§5） */
export function toPoint(snap, derived) {
  const d = derived || derive(snap);
  return {
    ts: num(snap.ts),
    iso: snap.iso || new Date(num(snap.ts) * 1000).toISOString(),
    readCount: d.readCount,
    collectCount: d.collectCount,
    likeCount: d.likeCount,
    engagementRate: d.engagementRate,
    collectRate: d.collectRate,
    likeRate: d.likeRate,
    heatIndex: d.heatIndex,
  };
}

export class Store {
  constructor({ dataDir, historyMax = 5000, disabled = false, log = () => {} }) {
    this.dataDir = dataDir;
    this.historyMax = Math.max(2, Number(historyMax) || 5000);
    this.disabled = Boolean(disabled);
    this.log = log;
    this.entries = []; // [{ts, snap, derived}] 按 ts 升序，长度 <= historyMax
    this.points = []; // /api/history 点
    this.loadStats = { files: [], lines: 0, parsed: 0, invalid: 0, duplicates: 0, dropped: 0, seedLines: 0 };
    this.restored = { total: 0, seed: 0, files: [], loadedAt: null };
  }

  get snapshotsPath() {
    return join(this.dataDir, SNAPSHOTS_FILE);
  }

  get latestPath() {
    return join(this.dataDir, LATEST_FILE);
  }

  ensureDir() {
    mkdirSync(this.dataDir, { recursive: true });
  }

  /** 启动恢复：读 dataDir 下所有 *.jsonl */
  load() {
    this.ensureDir();
    const byTs = new Map();
    const order = [];
    let files = [];
    try {
      files = readdirSync(this.dataDir).filter((f) => f.toLowerCase().endsWith(".jsonl") && !IGNORED_FILES.has(f));
    } catch (err) {
      this.log("store: readdir failed: " + err.message);
    }
    files.sort();

    for (const file of files) {
      const full = join(this.dataDir, file);
      let text = "";
      try {
        text = readFileSync(full, "utf8");
      } catch (err) {
        this.log("store: read " + file + " failed: " + err.message);
        continue;
      }
      const lines = text.split("\n");
      let parsedHere = 0;
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        this.loadStats.lines++;
        const obj = safeJSONParse(line);
        if (!isSnapshot(obj)) {
          this.loadStats.invalid++;
          continue;
        }
        parsedHere++;
        this.loadStats.parsed++;
        if (file === "seed.jsonl") this.loadStats.seedLines++;
        const ts = num(obj.ts);
        if (byTs.has(ts)) this.loadStats.duplicates++;
        else order.push(ts);
        // 后出现的覆盖先出现的（同名 ts 去重）
        byTs.set(ts, { ts, snap: obj, derived: derive(obj) });
      }
      this.loadStats.files.push({ file, lines: parsedHere });
    }

    let entries = order
      .sort((a, b) => a - b)
      .map((ts) => byTs.get(ts))
      .filter(Boolean);

    if (entries.length > this.historyMax) {
      this.loadStats.dropped = entries.length - this.historyMax;
      entries = entries.slice(entries.length - this.historyMax);
    }
    this.entries = entries;
    this.points = entries.map((e) => toPoint(e.snap, e.derived));
    // 供 /api/health 的 seedLoaded 使用：从 jsonl 恢复的总点数 / 其中来自 seed.jsonl 的点数
    const seedTs = new Set();
    try {
      const seedPath = join(this.dataDir, "seed.jsonl");
      if (existsSync(seedPath)) {
        for (const raw of readFileSync(seedPath, "utf8").split("\n")) {
          const line = raw.trim();
          if (!line) continue;
          const obj = safeJSONParse(line);
          if (isSnapshot(obj)) seedTs.add(num(obj.ts));
        }
      }
    } catch {
      /* 统计失败不影响主流程 */
    }
    this.restored = {
      total: entries.length,
      seed: this.points.filter((p) => seedTs.has(p.ts)).length,
      runtime: this.points.filter((p) => !seedTs.has(p.ts)).length,
      files: this.loadStats.files,
      invalid: this.loadStats.invalid,
      duplicates: this.loadStats.duplicates,
      dropped: this.loadStats.dropped,
      historyMax: this.historyMax,
      loadedAt: new Date().toISOString(),
    };
    this.log(
      "store: loaded " +
        this.points.length +
        " points from " +
        files.length +
        " file(s) [" +
        files.join(", ") +
        "]" +
        (this.loadStats.invalid ? ", invalid lines=" + this.loadStats.invalid : "")
    );
    return this.points.length;
  }

  get firstTs() {
    return this.points.length ? this.points[0].ts : null;
  }

  get lastTs() {
    return this.points.length ? this.points[this.points.length - 1].ts : null;
  }

  get latestEntry() {
    return this.entries.length ? this.entries[this.entries.length - 1] : null;
  }

  /**
   * 追加一条采样：写 snapshots.jsonl + 更新内存 + latest.json
   * @param {object} snap  §4 Snapshot
   * @param {{write?: boolean}} [opts]  write:false 时不落盘（同一 ts 覆盖场景）
   */
  append(snap, opts = {}) {
    const derived = derive(snap);
    const entry = { ts: num(snap.ts), snap, derived };
    const shouldWrite = opts.write !== false && !this.disabled;

    if (shouldWrite) {
      try {
        this.ensureDir();
        appendFileSync(this.snapshotsPath, JSON.stringify(snap) + "\n", "utf8");
      } catch (err) {
        this.log("store: append failed: " + err.message);
        throw err;
      }
    }

    const last = this.entries.length ? this.entries[this.entries.length - 1] : null;
    if (last && last.ts === entry.ts) {
      // 同一 ts 覆盖（保持去重语义）
      this.entries[this.entries.length - 1] = entry;
      this.points[this.points.length - 1] = toPoint(snap, derived);
    } else if (!last || entry.ts > last.ts) {
      this.entries.push(entry);
      this.points.push(toPoint(snap, derived));
      if (this.entries.length > this.historyMax) {
        this.entries.splice(0, this.entries.length - this.historyMax);
        this.points.splice(0, this.points.length - this.historyMax);
      }
    } else {
      // 乱序（极少见：server_time 回退）→ 插入并排序
      this.entries.push(entry);
      this.entries.sort((a, b) => a.ts - b.ts);
      this.points = this.entries.map((e) => toPoint(e.snap, e.derived));
    }

    this.writeLatest(snap, shouldWrite);
    return entry;
  }

  writeLatest(snap, shouldWrite = true) {
    if (!shouldWrite || this.disabled) return;
    try {
      this.ensureDir();
      writeFileSync(this.latestPath, JSON.stringify(snap, null, 2), "utf8");
    } catch (err) {
      this.log("store: write latest.json failed: " + err.message);
    }
  }

  /** 取窗口内的点（minutes<=0 表示全部） */
  windowPoints(minutes) {
    const pts = this.points;
    if (!minutes || minutes <= 0) return pts.slice();
    const last = pts.length ? pts[pts.length - 1].ts : 0;
    const from = last - minutes * 60;
    return pts.filter((p) => p.ts >= from);
  }
}

/**
 * 等距降采样到 <= max（保留首尾点）。max<=2 时直接返回首尾。
 */
export function downsample(points, max) {
  const pts = points || [];
  const cap = Math.floor(Number(max) || 0);
  if (cap <= 0 || pts.length <= cap) return pts.slice();
  if (cap === 1) return [pts[0]];
  if (cap === 2) return [pts[0], pts[pts.length - 1]];
  const out = [pts[0]];
  const step = (pts.length - 1) / (cap - 1);
  let lastIdx = 0;
  for (let i = 1; i < cap - 1; i++) {
    const idx = Math.round(i * step);
    if (idx > lastIdx && idx < pts.length - 1) {
      out.push(pts[idx]);
      lastIdx = idx;
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
