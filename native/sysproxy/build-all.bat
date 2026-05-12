@echo off
REM FlyClash SysProxy Build Script - All Architectures
REM 编译所有架构的 Windows 系统代理工具
REM
REM 用法:
REM   build-all.bat          - 编译所有架构
REM   build-all.bat x64      - 仅编译 x64 并复制为通用版本
REM   build-all.bat x86      - 仅编译 x86 并复制为通用版本
REM   build-all.bat arm64    - 仅编译 arm64 并复制为通用版本

cd /d "%~dp0"

set CGO_ENABLED=0
set GOOS=windows

echo ====================================
echo FlyClash SysProxy Multi-Arch Builder
echo ====================================
echo.

REM 创建输出目录
if not exist "..\..\tools" mkdir "..\..\tools"

REM 检查是否指定了特定架构
if "%1"=="x64" goto build_x64_only
if "%1"=="x86" goto build_x86_only
if "%1"=="ia32" goto build_x86_only
if "%1"=="arm64" goto build_arm64_only

REM 编译所有架构
echo Building all architectures...
echo.

REM 编译 amd64 版本 (x64)，并作为通用版本输出
echo [1/3] Building for Windows x64 (amd64)...
set GOARCH=amd64
go build -ldflags="-s -w" -o ..\..\native\sysproxy\dist\sysproxy-x64.exe .
if %ERRORLEVEL% neq 0 (
    echo x64 build failed!
    exit /b 1
)
echo       Done: native\sysproxy\dist\sysproxy-x64.exe

REM 额外编译 x86 版本（仅保留在 dist 目录，避免被打包为工具）
echo [2/3] Building for Windows x86 (386)...
set GOARCH=386
go build -ldflags="-s -w" -o ..\..\native\sysproxy\dist\sysproxy-x86.exe .
if %ERRORLEVEL% neq 0 (
    echo x86 build failed!
    exit /b 1
)
echo       Done: native\sysproxy\dist\sysproxy-x86.exe

REM 额外编译 arm64 版本（仅保留在 dist 目录，避免被打包为工具）
echo [3/3] Building for Windows ARM64...
set GOARCH=arm64
go build -ldflags="-s -w" -o ..\..\native\sysproxy\dist\sysproxy-arm64.exe .
if %ERRORLEVEL% neq 0 (
    echo arm64 build failed!
    exit /b 1
)
echo       Done: native\sysproxy\dist\sysproxy-arm64.exe

REM 复制 x64 版本为通用版本（最终打包只用 tools\sysproxy.exe）
copy /Y "..\..\native\sysproxy\dist\sysproxy-x64.exe" "..\..\tools\sysproxy.exe" >nul

goto done

:build_x64_only
echo Building for Windows x64 (amd64) only...
set GOARCH=amd64
go build -ldflags="-s -w" -o ..\..\native\sysproxy\dist\sysproxy-x64.exe .
if %ERRORLEVEL% neq 0 (
    echo x64 build failed!
    exit /b 1
)
copy /Y "..\..\native\sysproxy\dist\sysproxy-x64.exe" "..\..\tools\sysproxy.exe" >nul
echo Done: native\sysproxy\dist\sysproxy-x64.exe, tools\sysproxy.exe
goto done

:build_x86_only
echo Building for Windows x86 (386) only...
set GOARCH=386
go build -ldflags="-s -w" -o ..\..\native\sysproxy\dist\sysproxy-x86.exe .
if %ERRORLEVEL% neq 0 (
    echo x86 build failed!
    exit /b 1
)
copy /Y "..\..\native\sysproxy\dist\sysproxy-x86.exe" "..\..\tools\sysproxy.exe" >nul
echo Done: native\sysproxy\dist\sysproxy-x86.exe, tools\sysproxy.exe
goto done

:build_arm64_only
echo Building for Windows ARM64 only...
set GOARCH=arm64
go build -ldflags="-s -w" -o ..\..\native\sysproxy\dist\sysproxy-arm64.exe .
if %ERRORLEVEL% neq 0 (
    echo arm64 build failed!
    exit /b 1
)
copy /Y "..\..\native\sysproxy\dist\sysproxy-arm64.exe" "..\..\tools\sysproxy.exe" >nul
echo Done: native\sysproxy\dist\sysproxy-arm64.exe, tools\sysproxy.exe
goto done

:done
echo.
echo ====================================
echo Build completed successfully!
echo ====================================
echo.
echo Output files:
echo   - tools\sysproxy.exe      ^(Generic, for current build arch^)
