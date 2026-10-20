# ReelShort 剧集实时监控 - 启动脚本
# 用法：在 PowerShell 里执行  .\start.ps1    （或右键"使用 PowerShell 运行"）

$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$url  = "http://127.0.0.1:8899"

# ---- 1. 已在运行则直接打开浏览器 ----
$existing = Get-NetTCPConnection -LocalPort 8899 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "监控服务已在运行：$url" -ForegroundColor Green
    Start-Process $url
    return
}

# ---- 2. 环境自检 ----
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "未找到 node，请先安装 Node.js 18+ 并加入 PATH。" -ForegroundColor Red
    return
}
$ver = (& node -v) -replace '^v',''
$major = [int]($ver.Split('.')[0])
if ($major -lt 18) {
    Write-Host "Node.js 版本过低（当前 $ver），需要 18 或更高。" -ForegroundColor Red
    return
}
if (-not (Test-Path (Join-Path $here "server.mjs"))) {
    Write-Host "找不到 server.mjs，请在 monitor 目录内运行本脚本。" -ForegroundColor Red
    return
}

# ---- 3. 启动服务 ----
# 注意：这里故意用 cmd /c 启动，而不是 Start-Process -RedirectStandardOutput。
# 某些环境里 PowerShell 的 ProcessStartInfo 会因 NO_PROXY / no_proxy 大小写重复键报
# "Item has already been added. Key in dictionary" 而启动失败。
# 用 cmd 启动可以完全绕开这个进程环境变量字典问题。
$logDir = Join-Path $here "data"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
$outLog = Join-Path $logDir "server.out.log"
$errLog = Join-Path $logDir "server.err.log"

Write-Host "正在启动监控服务..." -ForegroundColor Cyan
$cmdLine = '/c cd /d "' + $here + '" && node server.mjs >> "' + $outLog + '" 2>> "' + $errLog + '"'
$proc = Start-Process -FilePath "cmd.exe" -ArgumentList $cmdLine -WindowStyle Hidden -PassThru

# ---- 4. 等待就绪 ----
$ready = $false
$h = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 700
    try {
        $h = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 3
        if ($h.ok) { $ready = $true; break }
    } catch { }
}

if ($ready) {
    $restored = 0
    if ($h.data.seedLoaded) { $restored = $h.data.seedLoaded.restored }
    $secs = [int]($h.data.pollMs / 1000)
    Write-Host ("服务已就绪：{0}  (采样间隔 {1}s，恢复历史 {2} 条)" -f $url, $secs, $restored) -ForegroundColor Green
    Start-Sleep -Milliseconds 300
    Start-Process $url
} else {
    Write-Host "服务启动失败，最近日志：" -ForegroundColor Red
    if (Test-Path $errLog) { Get-Content $errLog -Tail 25 -ErrorAction SilentlyContinue }
    if (Test-Path $outLog) { Get-Content $outLog -Tail 25 -ErrorAction SilentlyContinue }
}
