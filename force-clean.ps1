# 强制清理release目录
Write-Host "Forcing cleanup of release directory..." -ForegroundColor Yellow

$releasePath = Join-Path $PSScriptRoot "release"

if (Test-Path $releasePath) {
    Write-Host "Stopping any processes that might be using files in release..." -ForegroundColor Cyan
    
    # 尝试结束可能占用文件的进程
    Get-Process | Where-Object {
        $_.Path -and $_.Path.StartsWith($releasePath)
    } | ForEach-Object {
        Write-Host "  Stopping process: $($_.Name) (PID: $($_.Id))" -ForegroundColor Gray
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
    
    Start-Sleep -Milliseconds 500
    
    Write-Host "Removing release directory..." -ForegroundColor Cyan
    
    # 使用robocopy清空目录（比Remove-Item更可靠）
    $emptyDir = Join-Path $env:TEMP "empty_$(Get-Random)"
    New-Item -ItemType Directory -Path $emptyDir -Force | Out-Null
    
    robocopy $emptyDir $releasePath /MIR /NFL /NDL /NJH /NJS /NC /NS /NP
    
    Remove-Item $emptyDir -Force -ErrorAction SilentlyContinue
    Remove-Item $releasePath -Recurse -Force -ErrorAction SilentlyContinue
    
    Write-Host "Release directory cleaned!" -ForegroundColor Green
} else {
    Write-Host "Release directory does not exist, nothing to clean." -ForegroundColor Gray
}

Write-Host "Done!" -ForegroundColor Green

