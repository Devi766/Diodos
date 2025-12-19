@echo off
setlocal

cd /d "%~dp0"

echo Building FlyClash Helper Service...

:: 说明：
:: 旧版本会根据 mihomo.exe 的 SHA256 动态注入 TOKEN，
:: 导致每次更换内核或重新打包 helper 的二进制指纹都会变化。
:: 新的 Go helper 已不再使用 TOKEN 机制，这里去掉与 mihomo 绑定，
:: 只根据自身代码变化生成稳定的二进制。

set GOOS=windows
set CGO_ENABLED=0

:: 构建 64 位版本
echo Building amd64...
set GOARCH=amd64
go build -ldflags="-s -w" -o flyclash-helper-x64.exe .

:: 构建 32 位版本
echo Building 386...
set GOARCH=386
go build -ldflags="-s -w" -o flyclash-helper-x86.exe .

:: 构建 ARM64 版本
echo Building arm64...
set GOARCH=arm64
go build -ldflags="-s -w" -o flyclash-helper-arm64.exe .

echo Done!
echo.
echo Output files:
dir /b flyclash-helper-*.exe

endlocal
