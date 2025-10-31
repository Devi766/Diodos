@echo off
chcp 65001 >nul
echo.
echo ========================================
echo 安全编译脚本 - 自动处理文件锁定
echo ========================================
echo.

REM 1. 停止可能占用文件的Node进程
echo [1/4] 停止相关Node进程...
taskkill /F /IM node.exe /FI "WINDOWTITLE eq *flycast-ui*" 2>nul
timeout /t 1 /nobreak >nul

REM 2. 强制清理release目录
echo [2/4] 清理release目录...
if exist "release" (
    REM 使用robocopy清空（比rmdir更可靠）
    mkdir "%TEMP%\empty_%RANDOM%" 2>nul
    robocopy "%TEMP%\empty_%RANDOM%" "release" /MIR /NFL /NDL /NJH /NJS /NC /NS /NP >nul 2>&1
    rmdir /s /q "%TEMP%\empty_%RANDOM%" 2>nul
    rmdir /s /q "release" 2>nul
    echo    已清理release目录
) else (
    echo    release目录不存在
)

REM 3. 等待文件系统释放
echo [3/4] 等待文件系统释放...
timeout /t 2 /nobreak >nul

REM 4. 开始编译
echo [4/4] 开始编译...
echo.
call npm run electron:build

echo.
echo ========================================
echo 编译完成！
echo ========================================
echo.
pause

