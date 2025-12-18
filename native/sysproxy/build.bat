@echo off
REM FlyClash SysProxy Build Script
REM 编译 Windows 系统代理工具

cd /d "%~dp0"

echo Building sysproxy.exe for Windows...

REM 编译 amd64 版本
set GOOS=windows
set GOARCH=amd64
set CGO_ENABLED=0
go build -ldflags="-s -w" -o ..\..\tools\sysproxy.exe .

if %ERRORLEVEL% neq 0 (
    echo Build failed!
    exit /b 1
)

echo Build completed: tools\sysproxy.exe
echo.

REM 可选：编译其他架构
REM echo Building for x86...
REM set GOARCH=386
REM go build -ldflags="-s -w" -o ..\..\tools\sysproxy-x86.exe .

REM echo Building for arm64...
REM set GOARCH=arm64
REM go build -ldflags="-s -w" -o ..\..\tools\sysproxy-arm64.exe .

echo Done!
