# 停止 ReelShort 剧集实时监控服务
$conns = Get-NetTCPConnection -LocalPort 8899 -State Listen -ErrorAction SilentlyContinue
if (-not $conns) {
    Write-Host "监控服务未在运行。" -ForegroundColor Yellow
    return
}
foreach ($c in $conns) {
    try {
        Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop
        Write-Host ("已停止监控服务 (pid={0})" -f $c.OwningProcess) -ForegroundColor Green
    } catch {
        Write-Host ("停止失败: " + $_.Exception.Message) -ForegroundColor Red
    }
}
