# 部署到 Sealos 云端（7×24 不中断）

> 目标：让监控不依赖你的电脑，关机也持续采集，并从公网访问。
> 方案：GitHub 免费云构建生成镜像 → Sealos 按量计费运行容器（实测约 **¥0.11/天 ≈ ¥3.3/月**）。

---

## 整体流程

```
① 建 GitHub 仓库 → ② 推送代码 → ③ Actions 自动构建镜像（约 2 分钟）
                                            ↓
④ 在 Sealos 填镜像地址 → ⑤ 挂持久卷 + 配环境变量 → ⑥ 公网访问 ✅
```

本机**不需要安装 Docker**，构建在 GitHub 的免费服务器上完成。

---

## 第 1 步：在 GitHub 建一个空仓库

1. 打开 https://github.com/new
2. 填写：
   - **Repository name**：`reelshort-monitor`
   - **Visibility**：选 **Public**（公开仓库的 Actions 免费额度无限；私有仓库镜像是私有的，Sealos 拉取需要额外配置凭据）
   - **不要**勾选 "Add a README file"（保持空仓库）
3. 点 **Create repository**

---

## 第 2 步：把代码推上去

在 PowerShorse 里执行（把 `你的用户名` 换成你的 GitHub 用户名）：

```powershell
cd E:\DSH\work\MY\monitor

# 初始化仓库
git init
git add .
git commit -m "ReelShort 剧集实时监控看板"

# 关联远程仓库并推送
git branch -M main
git remote add origin https://github.com/你的用户名/reelshort-monitor.git
git push -u origin main
```

推送时会弹出 GitHub 登录窗口，登录授权即可。

> 如果提示 `remote origin already exists`，改用：
> `git remote set-url origin https://github.com/你的用户名/reelshort-monitor.git`

---

## 第 3 步：等 Actions 自动构建

1. 打开 `https://github.com/你的用户名/reelshort-monitor/actions`
2. 会看到 **Build and Publish Image** 正在运行（黄色圆点）
3. 等约 **2-3 分钟** 变成绿色勾 ✅
4. 构建完成后，镜像地址固定为：

```
ghcr.io/你的用户名/reelshort-monitor:latest
```

**⚠️ 重要：首次构建完，必须把 GHCR 包设为公开**，否则 Sealos 拉不到（报 unauthorized）：

1. 打开 `https://github.com/你的用户名?tab=packages`
2. 点进 `reelshort-monitor`
3. 右侧 **Package settings** → 拉到底 **Danger Zone**
4. **Change visibility** → 选 **Public** → 确认

---

## 第 4 步：在 Sealos 创建应用

回到 Sealos 的「应用部署」页面，按下面填写：

### 基本信息

| 字段 | 填什么 |
|---|---|
| **应用名称** | `reelshort-monitor` （必须小写字母开头，只能小写字母/数字/连字符，≤25 字符） |
| **镜像源** | 选「公开」 |
| **镜像名** | `ghcr.io/你的用户名/reelshort-monitor:latest` |

### 资源配额（左侧滑块）

| 项 | 给多少 | 说明 |
|---|---|---|
| **CPU** | **0.2 核** | 实测只用了 1.2 秒/小时，0.2 核绰绰有余 |
| **内存** | **256 MiB** | 实测峰值 51.5 MB，给 256MiB 有 5 倍余量 |
| **存储卷** | **1 GiB** | 按 60s 采样约 11 MB/天，1GiB 能存 ~90 天；嫌少可给 2GiB |
| **副本数** | **1** | ⚠️ 绝对不能设 >1，否则多个实例会重复采样、数据错乱 |

### 网络配置

| 字段 | 填什么 |
|---|---|
| **容器暴露端口** | `8899` （注意：不是 80！你的应用监听 8899） |
| **公网访问** | 打开「已启用」开关 |
| **域名** | 用它自动分配的 `xxxxx.sealoshzh.site` 即可 |

### 高级配置 → 启动命令 / 环境变量

**启动命令**：留空（用 Dockerfile 里的默认 `node server.mjs`）

**环境变量**：点「+ 新增」，逐条添加：

| 变量名 | 值 | 必填 |
|---|---|---|
| `HOST` | `0.0.0.0` | ✅ 必须（否则公网访问不到） |
| `PORT` | `8899` | ✅ 必须 |
| `DATA_DIR` | `/data` | ✅ 必须（指向持久卷） |
| `POLL_MS` | `60000` | 建议（采样间隔毫秒，60000 = 1 分钟） |
| `HISTORY_MAX` | `5000` | 建议 |

### 存储挂载（关键！）

在「存储卷」配置里：

| 字段 | 填什么 |
|---|---|
| **挂载路径** | `/data` |
| **容量** | 1 GiB |

> ⚠️ **不挂存储卷 = 容器每次重启历史数据全部丢失。** 这是整个部署里最容易踩的坑。

点 **部署 / 创建**。

---

## 第 5 步：验证

容器启动约 30-60 秒后，访问：

```
https://你分配到的域名.sealoshzh.site
```

### 必查清单

| # | 检查项 | 怎么验 | 期望 |
|---|---|---|---|
| 1 | 服务活着 | 打开 `/api/health` | `{"ok":true,...}` |
| 2 | 监听正确 | 看 health 里 `pollMs` | 60000 |
| 3 | **实时推送正常** | 看页面右上角状态灯 | 🟢 绿色「实时连接」 |
| 4 | **数据在增长** | 刷新页面看 KPI 数字 | 播放量随时间变大 |
| 5 | **持久化生效** | 看 health 的 `seedLoaded.restored` | > 0（说明读到了初始历史） |
| 6 | 采样正常 | 等 2 分钟后看 `/api/health` 的 `polls` | 递增，`consecutiveErrors`=0 |

### 关于 SSE 实时推送（重点排查）

如果第 3 项状态灯是**红色「重连中」**或页面数字不自动更新，说明 Sealos 的反向代理**缓冲了 SSE 流**。

排查方法：浏览器按 F12 → Network → 找 `stream` 请求 → 看 Type 是不是 `eventsource`，以及有没有持续收到数据。

如果确实被缓冲，告诉我，我给前端加一个**轮询降级模式**（每 15 秒拉一次 `/api/latest`，效果几乎一样，但不走 SSE）。

---

## 第 6 步：验证「关机也持续采集」

这是整个方案的**核心目标**，务必验证：

1. 记住当前 `/api/health` 的 `sampleCount` 和 `lastTs`
2. **把你的电脑关机 / 断网**
3. 用**手机 4G** 打开那个公网域名
4. 看数字是否还在增长、状态灯是否还是绿色
5. 隔 10 分钟再打开一次，看 `/api/health` 的 `polls` 是否增加了

✅ 都正常 = 目标达成，从此不受开关机影响。

---

## 常见问题

**Q：构建失败 / Actions 报错？**
A：点进失败的 workflow 看日志。最常见是 `seed.jsonl` 没被提交（检查 `git status` 里有没有它），或仓库不是 Public。

**Q：Sealos 报 unauthorized 拉不到镜像？**
A：GHCR 包还是私有。回到第 3 步最后，把 Package visibility 改成 Public。

**Q：打开域名是 502 / 连接被拒？**
A：按顺序查：① 容器暴露端口是不是 `8899`（写成 80 就废了）② 环境变量 `PORT=8899` 有没有配 ③ 看 Sealos 日志里有没有 `listening on http://0.0.0.0:8899`。

**Q：数据没保存，重启就丢？**
A：`DATA_DIR` 没设成 `/data`，或存储卷没挂载到 `/data`。两个必须同时正确。

**Q：费用会不会失控？**
A：按量计费，0.2核/256MiB/1GiB 大约 **¥0.11/天**。Sealos 有余额提醒，建议先充 10 元能跑 3 个月。随时可在控制台停掉应用。

**Q：能改采样间隔吗？**
A：改 `POLL_MS` 环境变量，改完重新部署即可。300000 = 5 分钟（数据量降到 1/5）。

---

## 成本与容量参考

| 采样间隔 | 数据量/天 | 1GiB 能用 | 月成本 |
|---|---|---|---|
| 60 秒（默认） | ~11 MB | ~90 天 | ~¥3.3 |
| 5 分钟 | ~2.2 MB | ~1.5 年 | ~¥3.3 |

> 存储和计算分开计费，采样频率不影响 CPU/内存开销，只影响磁盘占用。

---

## 附：本地和云端并存

部署到云端后，本地这套**可以继续留着**当备份/开发环境，两者互不影响（各自的 `data/` 目录独立）。

想让本地也用云端数据，直接访问云端域名即可，不用本地再跑一份。
