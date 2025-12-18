// FlyClash SysProxy - Windows System Proxy Manager
// 用于设置 Windows 系统代理的命令行工具
//
// 用法:
//   sysproxy global <host:port> [bypass]  - 设置全局代理
//   sysproxy pac <url>                    - 设置 PAC 自动代理
//   sysproxy off                          - 关闭代理
//   sysproxy query                        - 查询当前代理状态

package main

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

var (
	wininet              = syscall.NewLazyDLL("wininet.dll")
	advapi32             = syscall.NewLazyDLL("advapi32.dll")
	internetSetOptionW   = wininet.NewProc("InternetSetOptionW")
	regOpenKeyExW        = advapi32.NewProc("RegOpenKeyExW")
	regSetValueExW       = advapi32.NewProc("RegSetValueExW")
	regDeleteValueW      = advapi32.NewProc("RegDeleteValueW")
	regQueryValueExW     = advapi32.NewProc("RegQueryValueExW")
	regCloseKey          = advapi32.NewProc("RegCloseKey")
)

const (
	HKEY_CURRENT_USER                = 0x80000001
	KEY_ALL_ACCESS                   = 0xF003F
	KEY_READ                         = 0x20019
	REG_SZ                           = 1
	REG_DWORD                        = 4
	INTERNET_OPTION_SETTINGS_CHANGED = 39
	INTERNET_OPTION_REFRESH          = 37
	ERROR_SUCCESS                    = 0
	ERROR_FILE_NOT_FOUND             = 2
)

var internetSettingsPath = syscall.StringToUTF16Ptr(`Software\Microsoft\Windows\CurrentVersion\Internet Settings`)

// 默认绕过列表
const defaultBypass = "localhost;127.*;192.168.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;<local>"

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	cmd := os.Args[1]

	var err error
	switch cmd {
	case "global":
		if len(os.Args) < 3 {
			fmt.Println("错误: 缺少代理地址")
			printUsage()
			os.Exit(1)
		}
		server := os.Args[2]
		bypass := defaultBypass
		if len(os.Args) >= 4 {
			bypass = os.Args[3]
		}
		err = setGlobalProxy(server, bypass)
	case "pac":
		if len(os.Args) < 3 {
			fmt.Println("错误: 缺少 PAC URL")
			printUsage()
			os.Exit(1)
		}
		pacURL := os.Args[2]
		err = setPacProxy(pacURL)
	case "off", "disable":
		err = disableProxy()
	case "set":
		// 兼容 "set 1" 命令（关闭代理）
		if len(os.Args) >= 3 && os.Args[2] == "1" {
			err = disableProxy()
		} else {
			fmt.Println("错误: 未知的 set 参数")
			os.Exit(1)
		}
	case "query", "status":
		err = queryProxy()
	case "help", "-h", "--help":
		printUsage()
	default:
		fmt.Printf("错误: 未知命令 '%s'\n", cmd)
		printUsage()
		os.Exit(1)
	}

	if err != nil {
		fmt.Printf("错误: %v\n", err)
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println(`FlyClash SysProxy - Windows 系统代理管理工具

用法:
  sysproxy global <host:port> [bypass]  设置全局代理
  sysproxy pac <url>                    设置 PAC 自动代理
  sysproxy off                          关闭代理
  sysproxy query                        查询当前代理状态

示例:
  sysproxy global 127.0.0.1:7890
  sysproxy global 127.0.0.1:7890 "localhost;127.*;<local>"
  sysproxy pac http://127.0.0.1:7890/pac
  sysproxy off
  sysproxy query`)
}

// openInternetSettingsKey 打开注册表键
func openInternetSettingsKey(access uint32) (syscall.Handle, error) {
	var hKey syscall.Handle
	ret, _, _ := regOpenKeyExW.Call(
		HKEY_CURRENT_USER,
		uintptr(unsafe.Pointer(internetSettingsPath)),
		0,
		uintptr(access),
		uintptr(unsafe.Pointer(&hKey)),
	)
	if ret != ERROR_SUCCESS {
		return 0, fmt.Errorf("无法打开注册表键: 错误码 %d", ret)
	}
	return hKey, nil
}

// closeKey 关闭注册表键
func closeKey(hKey syscall.Handle) {
	regCloseKey.Call(uintptr(hKey))
}

// setRegDword 设置 DWORD 值
func setRegDword(hKey syscall.Handle, name string, value uint32) error {
	namePtr := syscall.StringToUTF16Ptr(name)
	ret, _, _ := regSetValueExW.Call(
		uintptr(hKey),
		uintptr(unsafe.Pointer(namePtr)),
		0,
		REG_DWORD,
		uintptr(unsafe.Pointer(&value)),
		4,
	)
	if ret != ERROR_SUCCESS {
		return fmt.Errorf("设置 %s 失败: 错误码 %d", name, ret)
	}
	return nil
}

// setRegString 设置字符串值
func setRegString(hKey syscall.Handle, name string, value string) error {
	namePtr := syscall.StringToUTF16Ptr(name)
	valuePtr := syscall.StringToUTF16(value)
	ret, _, _ := regSetValueExW.Call(
		uintptr(hKey),
		uintptr(unsafe.Pointer(namePtr)),
		0,
		REG_SZ,
		uintptr(unsafe.Pointer(&valuePtr[0])),
		uintptr(len(valuePtr)*2),
	)
	if ret != ERROR_SUCCESS {
		return fmt.Errorf("设置 %s 失败: 错误码 %d", name, ret)
	}
	return nil
}

// deleteRegValue 删除注册表值
func deleteRegValue(hKey syscall.Handle, name string) error {
	namePtr := syscall.StringToUTF16Ptr(name)
	ret, _, _ := regDeleteValueW.Call(
		uintptr(hKey),
		uintptr(unsafe.Pointer(namePtr)),
	)
	// 忽略值不存在的错误
	if ret != ERROR_SUCCESS && ret != ERROR_FILE_NOT_FOUND {
		return fmt.Errorf("删除 %s 失败: 错误码 %d", name, ret)
	}
	return nil
}

// getRegDword 获取 DWORD 值
func getRegDword(hKey syscall.Handle, name string) (uint32, error) {
	namePtr := syscall.StringToUTF16Ptr(name)
	var value uint32
	var size uint32 = 4
	var regType uint32
	ret, _, _ := regQueryValueExW.Call(
		uintptr(hKey),
		uintptr(unsafe.Pointer(namePtr)),
		0,
		uintptr(unsafe.Pointer(&regType)),
		uintptr(unsafe.Pointer(&value)),
		uintptr(unsafe.Pointer(&size)),
	)
	if ret != ERROR_SUCCESS {
		return 0, fmt.Errorf("获取 %s 失败: 错误码 %d", name, ret)
	}
	return value, nil
}

// getRegString 获取字符串值
func getRegString(hKey syscall.Handle, name string) (string, error) {
	namePtr := syscall.StringToUTF16Ptr(name)
	var size uint32 = 0
	var regType uint32

	// 先获取大小
	ret, _, _ := regQueryValueExW.Call(
		uintptr(hKey),
		uintptr(unsafe.Pointer(namePtr)),
		0,
		uintptr(unsafe.Pointer(&regType)),
		0,
		uintptr(unsafe.Pointer(&size)),
	)
	if ret != ERROR_SUCCESS && ret != 234 { // 234 = ERROR_MORE_DATA
		return "", fmt.Errorf("获取 %s 大小失败: 错误码 %d", name, ret)
	}

	if size == 0 {
		return "", nil
	}

	// 分配缓冲区并读取值
	buf := make([]uint16, size/2+1)
	ret, _, _ = regQueryValueExW.Call(
		uintptr(hKey),
		uintptr(unsafe.Pointer(namePtr)),
		0,
		uintptr(unsafe.Pointer(&regType)),
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(unsafe.Pointer(&size)),
	)
	if ret != ERROR_SUCCESS {
		return "", fmt.Errorf("获取 %s 失败: 错误码 %d", name, ret)
	}

	return syscall.UTF16ToString(buf), nil
}

// refreshProxySettings 刷新代理设置
func refreshProxySettings() error {
	ret, _, _ := internetSetOptionW.Call(0, INTERNET_OPTION_SETTINGS_CHANGED, 0, 0)
	if ret == 0 {
		return fmt.Errorf("INTERNET_OPTION_SETTINGS_CHANGED 失败")
	}

	ret, _, _ = internetSetOptionW.Call(0, INTERNET_OPTION_REFRESH, 0, 0)
	if ret == 0 {
		return fmt.Errorf("INTERNET_OPTION_REFRESH 失败")
	}

	return nil
}

// setGlobalProxy 设置全局代理
func setGlobalProxy(server string, bypass string) error {
	hKey, err := openInternetSettingsKey(KEY_ALL_ACCESS)
	if err != nil {
		return err
	}
	defer closeKey(hKey)

	// 启用代理
	if err := setRegDword(hKey, "ProxyEnable", 1); err != nil {
		return err
	}

	// 设置代理服务器
	if err := setRegString(hKey, "ProxyServer", server); err != nil {
		return err
	}

	// 设置绕过列表
	if err := setRegString(hKey, "ProxyOverride", bypass); err != nil {
		return err
	}

	// 删除 PAC URL
	deleteRegValue(hKey, "AutoConfigURL")

	// 刷新设置
	if err := refreshProxySettings(); err != nil {
		return err
	}

	fmt.Printf("已启用全局代理: %s\n", server)
	return nil
}

// setPacProxy 设置 PAC 代理
func setPacProxy(pacURL string) error {
	hKey, err := openInternetSettingsKey(KEY_ALL_ACCESS)
	if err != nil {
		return err
	}
	defer closeKey(hKey)

	// 禁用手动代理
	if err := setRegDword(hKey, "ProxyEnable", 0); err != nil {
		return err
	}

	// 设置 PAC URL
	if err := setRegString(hKey, "AutoConfigURL", pacURL); err != nil {
		return err
	}

	// 刷新设置
	if err := refreshProxySettings(); err != nil {
		return err
	}

	fmt.Printf("已启用 PAC 代理: %s\n", pacURL)
	return nil
}

// disableProxy 禁用代理
func disableProxy() error {
	hKey, err := openInternetSettingsKey(KEY_ALL_ACCESS)
	if err != nil {
		return err
	}
	defer closeKey(hKey)

	// 禁用代理
	if err := setRegDword(hKey, "ProxyEnable", 0); err != nil {
		return err
	}

	// 删除 PAC URL
	deleteRegValue(hKey, "AutoConfigURL")

	// 刷新设置
	if err := refreshProxySettings(); err != nil {
		return err
	}

	fmt.Println("已关闭系统代理")
	return nil
}

// queryProxy 查询当前代理状态
func queryProxy() error {
	hKey, err := openInternetSettingsKey(KEY_READ)
	if err != nil {
		return err
	}
	defer closeKey(hKey)

	enabled, _ := getRegDword(hKey, "ProxyEnable")
	server, _ := getRegString(hKey, "ProxyServer")
	bypass, _ := getRegString(hKey, "ProxyOverride")
	pacURL, _ := getRegString(hKey, "AutoConfigURL")

	fmt.Println("=== 系统代理状态 ===")
	if enabled == 1 {
		fmt.Println("代理状态: 已启用")
		fmt.Printf("代理服务器: %s\n", server)
		fmt.Printf("绕过列表: %s\n", bypass)
	} else if pacURL != "" {
		fmt.Println("代理状态: PAC 模式")
		fmt.Printf("PAC URL: %s\n", pacURL)
	} else {
		fmt.Println("代理状态: 已关闭")
	}

	return nil
}
