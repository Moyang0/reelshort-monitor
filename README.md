# ReelShort 剧集实时数据监控看板

> 监控对象：**The Tempted DILF Is My Professor**
> 剧集页：https://www.reelshort.com/episodes/episode-1-the-tempted-dilf-is-my-professor-6ad02fe293e1dedf6b0c1bd7-hepttkkgph?play_time=1
> book_id：`6ad02fe293e1dedf6b0c1bd7` · t_book_id：`201000000000006502`

一个**纯本地、零依赖、实时**的看板：每 60 秒真实抓取一次 ReelShort 公开数据，
落盘成 JSONL 时序，通过 SSE 推给前端，用图表展示播放量 / 收藏 / 点赞 / 付费相关指标的
当前值与变化量。

---

## 一、怎么启动

```powershell
cd E:\DSH\work\MY\monitor
.\start.ps1          # 启动服务并自动打开浏览器（推荐）
# 或者手动
node server.mjs
```

浏览器打开 **http://127.0.0.1:8899**

停止：

```powershell
.\stop.ps1
```

不想要 PowerShell 脚本也可以直接 `node monitor/server.mjs`，然后自己开浏览器。

### 环境变量（可选）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8899 | 监听端口 |
| `HOST` | 127.0.0.1 | 监听地址 |
| `POLL_MS` | 60000 | 采样间隔（毫秒），最小 10000 |
| `HISTORY_MAX` | 5000 | 内存中保留的最大历史点数 |
| `DATA_DIR` | ./data | 数据目录 |

例：`$env:POLL_MS=30000; node server.mjs`（30 秒一采）

---

## 二、界面上都有什么

| 模块 | 内容 |
|---|---|
| **顶部** | 剧名、封面、标签、总集数 56、付费起始第 12 集、样本数、采样间隔、最近采样时间；SSE 连接状态灯（绿=实时 / 红=重连中）；时间范围切换（实时 / 1h / 6h / 24h / 全部）；手动刷新 |
| **KPI 卡片 ×6** | 播放量、收藏、点赞、互动率、收藏转化率、热度指数。每张卡含**当前值 + 增量 + 增速 + 迷你趋势线** |
| **指标趋势** | 播放量 / 收藏 / 点赞 多指标折线（量级模式双 Y 轴，比率模式看比率曲线），可自由勾选指标 |
| **每分钟增量** | 柱状图展示 Δ播放量 ÷ 间隔分钟，直观看出"现在涨得多快" |
| **56 集点赞分布** | 逐集 `like_count` 柱状图，第 12 集付费墙用金色 markLine 标出，免费集粉色 / 付费集灰色 |
| **付费章节热度比（估算）** | 免费集均赞 vs 付费集均赞、付费墙前后热度比、追剧完成度，以及逐集留存衰减曲线 |
| **实时采样明细** | 最近 20 条采样记录，含时间、播放量、Δ播放、收藏、Δ收藏、点赞、互动率、热度 |
| **页脚** | 全部指标公式（鼠标悬停可看） |

### 关于"付费率"的说明（重要）

**ReelShort 官方不公开真实的付费率 / 付费人数 / 付费金额。** 公开页面和 API 里只有
播放量、收藏、各集点赞、总集数、付费起始集这些数据。

所以本看板的付费维度用的是**基于公开数据的估算 / 代理指标**，UI 上全部标注了「估算」：

| 指标 | 含义 |
|---|---|
| 付费章节占比 | `(总集数 - 付费起始集 + 1) / 总集数` = 45/56 ≈ 80.4%，这是客观的剧集结构，不是用户付费率 |
| 付费章节热度比 | `min(1, 付费集均赞 / 免费集均赞)`，≈100% 表示付费墙前后每集点赞热度持平（无明显衰减） |
| 追剧完成度 | `最后一集点赞 / 第一集点赞`，反映追到大结局的留存比例 |
| 付费墙留存曲线 | 逐集点赞相对第 1 集的百分比，第 12 集处画付费墙分隔线 |

这些数字**能反映趋势**（比如付费墙后热度掉多少），但**不能等同于真实付费率**。

---

## 三、数据从哪来

后台采集这两支公开接口（带浏览器 UA）：

```
GET https://www.reelshort.com/api/video/book/getBookInfo?book_id=6ad02fe293e1dedf6b0c1bd7
GET https://www.reelshort.com/api/video/book/getChapterList?book_id=...&page=1&page_size=100
```

字段映射：

| 看板指标 | 来源字段 |
|---|---|
| 播放量 | `data.read_count` |
| 收藏 | `data.collect_count` |
| 点赞 | `sum(data.online_base[].like_count)`（56 集合计） |
| 总集数 | `data.total` |
| 付费起始集 | `data.paid_start` |
| 逐集点赞 / 封面 | `data.online_base[].like_count / video_pic` |
| 集时长 | `getChapterList.data.chapter_list[].duration` |

---

## 四、数据怎么存

```
monitor/data/
  seed.jsonl         ← 首次部署时的预采样（不会被运行时改动）
  snapshots.jsonl    ← 服务运行时逐条追加
  latest.json        ← 最新一次快照
```

- 每行一个 JSON（Snapshot），追加写，重启不丢
- 启动时**读取 data/ 下所有 `*.jsonl`**，按 `ts` 升序合并、同 `ts` 去重，取最后 `HISTORY_MAX` 条进内存
- 想重置历史：停服务、删 `data/snapshots.jsonl`、重启
- 想导出数据：`snapshots.jsonl` 就是标准 JSONL，可直接 `pandas.read_json(lines=True)` 分析

---

## 五、HTTP 接口

| 端点 | 说明 |
|---|---|
| `GET /api/health` | 存活、采样次数、错误计数、恢复了多少历史 |
| `GET /api/meta` | 剧集元信息 + 全部指标定义（含公式） |
| `GET /api/latest` | 最新快照 + 派生指标 + 相对首次的增量 + 各时间窗口增长 |
| `GET /api/history?minutes=1440&max=2000` | 时序点（自动降采样，保留首尾） |
| `GET /api/episodes` | 56 集点赞 + 付费漏斗数据 |
| `GET /api/stream` | **SSE**：`hello` / `snapshot` / `ping` 事件 |
| `POST /api/collect` | 立刻触发一次采样（2 秒限流） |
| 其它路径 | 静态文件（`public/`） |

完整字段定义见 [CONTRACT.md](CONTRACT.md)。

---

## 六、目录结构

```
monitor/
  server.mjs              HTTP + SSE 服务、静态文件
  lib/collector.mjs       抓取 ReelShort、组装 Snapshot
  lib/metrics.mjs         全部派生指标与增量计算
  lib/store.mjs           JSONL 读写、合并去重、降采样
  public/index.html       看板页面
  public/app.js           前端逻辑（原生 JS + ECharts）
  public/styles.css       深色主题
  public/vendor/echarts.min.js   ECharts 5.5.1（本地，离线可用）
  data/                   运行时数据
  tests/                  QA 验收脚本与报告
  CONTRACT.md             接口契约（前后端唯一依据）
  start.ps1 / stop.ps1    一键启停
```

---

## 七、技术约束

- **纯 Node.js 内置模块**，无 npm 依赖，`node server.mjs` 直接跑
- 前端**原生 JS**，图表用本地 ECharts，无框架、无外网 CDN，断网也能用
- 采样间隔 60s 可调；数据只在本地，不外传

---

## 八、常见问题

**Q：图表一开始只有几个点，很难看？**
A：历史每分钟累积一个点。运行满 1 小时后 1h 视图就有完整曲线；满 24 小时后 24h 视图完整。
时间窗口样本覆盖不足 60% 时会显示「样本不足」而不是画一条假线——这是故意的。

**Q：播放量曲线是"台阶状"的？**
A：真实数据就是这样。ReelShort 的 `read_count` 是分块更新的，几分钟不动然后跳一下，不是平滑增长。我们没有做任何平滑美化。

**Q：为什么 conversionProxy 显示 100%？**
A：实测这部剧付费墙前后每集点赞热度基本持平（免费集均赞 ≈ 付费集均赞），按公式 `min(1, 付费集均赞/免费集均赞)` 会被截断在 1。这是真实数据的反映。

**Q：抓不到数据了怎么办？**
A：看 `/api/health` 的 `consecutiveErrors` 和 `lastError`。常见原因是网络不通或 ReelShort 改了接口/加了风控。服务本身不会崩，恢复网络后会自动继续采。

**Q：想监控别的剧？**
A：改 `lib/collector.mjs` 里的 `BOOK_ID`（从剧集页 URL 里 `movie/` 后面那串 24 位 ID 就是），清空 `data/snapshots.jsonl` 后重启即可。
