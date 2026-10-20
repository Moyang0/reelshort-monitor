# ReelShort 剧集数据实时监控 — 接口契约 v1
（本文件由 Lead 维护，是前后端唯一的对接依据。任何字段变更必须先改本文件并通知对方。）

## 0. 目标
对 ReelShort 剧集 **The Tempted DILF Is My Professor**（book_id: `6ad02fe293e1dedf6b0c1bd7`）
做**真实数据的实时监控**：播放量 / 收藏 / 点赞 / 付费相关指标，按固定间隔采样、落盘、
通过 HTTP + SSE 推给前端，前端做成可视化看板（图表 + 数值 + 增量变化）。

## 1. 数据源（已由 Lead 实测可用，禁止臆造字段）
```
GET https://www.reelshort.com/api/video/book/getBookInfo?book_id=6ad02fe293e1dedf6b0c1bd7
Header: user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/126.0 Safari/537.36
```
返回 `{code:0, msg, server_time, data:{...}}`，data 里可用字段：
- `read_count`      播放量/阅读量（整数）
- `collect_count`   收藏数
- `online_base[]`   每集：{chapter_id, serial_number, like_count, publish_at, video_pic, chapter_weight, status}
  → 全剧点赞 = sum(online_base[].like_count)
- `total`           总集数（56）
- `paid_start`      付费起始集（12，即 1-11 免费，12-56 付费）
- `book_title` `book_pic` `special_desc` `tag_list[]` `update_status` `online_at` `publish_at` `is_ai` `book_mark` `lang` `duration`
- `server_time`     采样时刻（unix 秒），用它当 ts，避免本地时钟漂移

辅助：
```
GET https://www.reelshort.com/api/video/book/getChapterList?book_id=...&page=1&page_size=100
  → data.chapter_list[]: {chapter_id, serial_number, duration, video_pic, desc}
```
（用于集时长；点赞仍以 getBookInfo.online_base 为准）

**重要：ReelShort 不公开"真实付费率/付费人数"。** 所以付费维度只能用**可公开计算的代理指标**，
UI 上必须明确标注"估算 / 代理指标"，不得伪造成官方付费率。见 §3。

## 2. 采样与存储
- 目录：`monitor/`
- 采样间隔：默认 60s（`POLL_MS` 环境变量可改），启动即立刻采一次
- 落盘：`monitor/data/snapshots.jsonl`（每行一个 Snapshot JSON，追加写）
  - **启动时读取 `monitor/data/` 下所有 `*.jsonl`**（含 Lead 预先用 `build/seed_collect.mjs`
    采集的 `seed.jsonl`），按 ts 升序合并、同一 ts 去重（后出现的覆盖先出现的），
    再取最后 `HISTORY_MAX`（默认 5000）条进内存缓存
  - 运行时写入只写 `snapshots.jsonl`，不得改动 `seed.jsonl`
- 失败：记录错误但不写坏数据；连续失败在 /api/health 暴露 consecutiveErrors
- 采样成功时同步更新 `monitor/data/latest.json`

## 3. 指标定义（前后端必须一致）
| key | 名称 | 公式 |
|---|---|---|
| readCount | 播放量 | read_count |
| collectCount | 收藏 | collect_count |
| likeCount | 点赞 | sum(online_base[].like_count) |
| engagementRate | 互动率 | (collectCount + likeCount) / readCount |
| collectRate | 收藏转化率 | collectCount / readCount |
| likeRate | 点赞转化率 | likeCount / readCount |
| paidRatio | 付费章节占比 | (total - paid_start + 1) / total |
| freeLikes | 免费集点赞合计 | sum(n < paid_start) |
| paidLikes | 付费集点赞合计 | sum(n >= paid_start) |
| conversionProxy | 付费章节热度比（估算） | `min(1, paidAvgLikes / freeAvgLikes)`，取值 [0,1]，≈1 表示付费墙前后每集点赞热度持平（无衰减）；同时输出 paidAvgLikes / freeAvgLikes 供前端解释 |
| completionProxy | 追剧完成度估算 | episode_likes[最后一集] / episode_likes[第一集] |
| heatIndex | 热度指数 | 见下方固定算法 |

heatIndex（0-100，让曲线好看且稳定可解释）：
```
raw  = 0.45 * likeRate*100 + 0.35 * collectRate*100 + 0.20 * min(readCount / 1e6, 1)*100   // 单一时刻
heatIndex = round(raw * 10) / 10
```
（必须在 meta.metrics 里把每个指标的 formula 文本一起发给前端，UI 上做 tooltip 用）

增量类指标（前端算或后端算均可，后端在 /api/latest 里给出，前端也可用 history 自算）：
- `delta`：相对"首次采样"的累计增量
- `ratePerMin`：基于窗口（默认最近 5 分钟，不足则用首末两点）的每分钟增量
- `growth`：{ "1m": {...}, "5m": {...}, "15m": {...}, "1h": {...}, "24h": {...} }
  每个窗口形如 `{readCount, collectCount, likeCount, samples, spanSec}`（窗口内首末差）；
  **样本覆盖时长 spanSec < 窗口时长 60% 时，该窗口返回 null**，前端显示「样本不足」而不是假的"近1小时"。
- /api/health 额外包含 `seedLoaded: {total, fromSeedFile, fromRuntimeFile}`，标明启动时从 jsonl 恢复的样本数

## 4. Snapshot 结构（写进 jsonl 的原始记录）
```json
{
  "ts": 1792492195,
  "iso": "2026-10-20T18:29:55.000Z",
  "bookId": "6ad02fe293e1dedf6b0c1bd7",
  "title": "The Tempted DILF Is My Professor",
  "cover": "https://...jpg",
  "desc": "...",
  "tags": ["Playing Dumb", "..."],
  "lang": "en",
  "isAi": 1,
  "updateStatus": 1,
  "bookMark": {"type":3,"color":"#FFE52E2E","textColor":"#FFFFFFFF","text":"New"},
  "total": 56,
  "paidStart": 12,
  "publishAt": 1792479607,
  "onlineAt": 1792479000,
  "readCount": 445720,
  "collectCount": 13224,
  "likeCount": 243359,
  "episodes": [{"n":1,"id":"hepttkkgph","likes":5437,"dur":154,"pic":"https://..."}],
  "ok": true
}
```

## 5. REST API（端口 8899，主机 127.0.0.1）
所有响应统一：`{"ok":true,"data":...}` 或 `{"ok":false,"error":"..."}`；JSON UTF-8。

- `GET /api/health` → `{ok, uptimeSec, pollMs, polls, lastTs, lastIso, consecutiveErrors, source:"reelshort.com"}`
- `GET /api/meta` → `{drama:{bookId,title,cover,desc,tags,total,paidStart,publishAt,onlineAt,lang,isAi,bookMark}, metrics:[{key,name,formula,unit}], pollMs, startedAt}`
- `GET /api/latest` → `{snapshot: Snapshot, derived: {...}, growth:{...}, delta:{...}, firstTs, sampleCount}`
  - derived = 上表全部派生指标 + `heatIndex`
- `GET /api/history?minutes=1440&max=2000`
  → `{points:[{ts,iso,readCount,collectCount,likeCount,engagementRate,collectRate,likeRate,heatIndex}], count, from, to, pollMs}`
  - 若点过多按等距降采样到 <= max（保留首尾点）
- `GET /api/episodes` → `{paidStart,total,episodes:[{n,id,likes,dur,pic,likeRateVsFirst,isPaid}], funnel:{freeAvgLikes,paidAvgLikes,conversionProxy,completionProxy,freeTotal,paidTotal}}`
- `GET /api/stream` → **SSE**，`text/event-stream`，事件：
  - `event: hello`  data = `{meta, latest}`
  - `event: snapshot` data = `{.../api/latest 的 data}`
  - 每 15s 未更新时发 `event: ping` data=`{"ts":...}`
- `POST /api/collect` → 立即触发一次采样，返回最新 latest data（2s 内限流一次）
- 其它路径 → 静态文件服务 `monitor/public/`（`/` → index.html）

## 6. 目录与归属（写作用域，避免冲突）
```
monitor/
  CONTRACT.md          <- Lead 所有，禁止改
  server.mjs           <- backend-dev
  lib/collector.mjs    <- backend-dev
  lib/metrics.mjs      <- backend-dev
  lib/store.mjs        <- backend-dev
  data/                <- backend-dev（运行时产物）
  public/index.html    <- frontend-dev
  public/app.js        <- frontend-dev
  public/styles.css    <- frontend-dev
  public/vendor/echarts.min.js  <- Lead 已放，禁止改
  tests/               <- qa-verifier
  README.md            <- Lead
```

## 7. 运行方式
```
node monitor/server.mjs            # 监听 http://127.0.0.1:8899
```
纯 Node 22 内置模块，**不允许 npm install、不允许新增依赖**。
ECharts 已本地化：`/vendor/echarts.min.js`（全局 `echarts`）。

## 8. 前端硬性要求
- 中文界面、深色高级质感、ReelShort 红/粉强调色；1440px 与 1920px 都好看
- 必须包含：KPI 卡片（带增量 + 迷你 sparkline）、多指标趋势折线（双 Y 轴）、
  每分钟增量柱状图、56 集点赞分布柱状图（标出付费墙第 12 集）、付费漏斗/留存衰减图、
  实时采样明细表、SSE 连接状态灯、时间范围切换（实时/1h/6h/24h/全部）、手动刷新
- 所有"付费"相关数字旁边必须有"估算/代理指标"说明（info tooltip 或脚注）
- 断线自动重连（3s），断线时状态灯变红并显示"重连中"
- 首屏渲染 < 2s；无 console error；不依赖外网 CDN
