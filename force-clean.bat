@echo off
chcp 65001 >nul
echo.
echo ========================================
echo 强制清理 release 目录
echo ========================================
echo.

if exist "release" (
    echo 正在清理 release 目录...
    
    REM 使用 robocopy 清空目录（比 rmdir 更可靠）
    mkdir "%TEMP%\empty_%RANDOM%" 2>nul
    robocopy "%TEMP%\empty_%RANDOM%" "release" /MIR /NFL /NDL /NJH /NJS /NC /NS /NP >nul 2>&1
    rmdir /s /q "%TEMP%\empty_%RANDOM%" 2>nul
    rmdir /s /q "release" 2>nul
    
    echo [OK] release 目录已清理
) else (
    echo [INFO] release 目录不存在，无需清理
)

echo.
echo 完成！
echo.
pause

