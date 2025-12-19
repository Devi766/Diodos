// FlyClash Helper Service
// 轻量级 Windows 服务，用于以管理员权限启动 mihomo 内核（TUN 模式需要）
// 使用 Named Pipe 进行 IPC 通信，支持 HMAC-SHA256 签名验证

package main

import (
	"bufio"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows/svc"
)

const (
	serviceName       = "FlyClashHelperService"
	serviceDisplay    = "FlyClash Helper Service"
	serviceDesc       = "FlyClash Helper Service for TUN mode"
	pipeName          = `\\.\pipe\flyclash-helper-service`
	messageExpirySecs = 30
	secretSeed        = "flyclash-helper-service-secret-key-v1"
)

var (
	coreProcess    *exec.Cmd
	coreMutex      sync.Mutex
	coreRunning    bool
	corePID        int
	secretKey      []byte
	serverListener net.Listener
	serverMutex    sync.Mutex
)

// IpcCommand 命令类型
type IpcCommand string

const (
	CmdGetStatus  IpcCommand = "get_status"
	CmdGetVersion IpcCommand = "get_version"
	CmdStartCore  IpcCommand = "start_core"
	CmdStopCore   IpcCommand = "stop_core"
)

// IpcRequest 请求结构
type IpcRequest struct {
	ID        string          `json:"id"`
	Timestamp int64           `json:"timestamp"`
	Command   IpcCommand      `json:"command"`
	Payload   json.RawMessage `json:"payload,omitempty"`
	Signature string          `json:"signature"`
}

// IpcResponse 响应结构
type IpcResponse struct {
	ID        string      `json:"id"`
	Success   bool        `json:"success"`
	Data      interface{} `json:"data,omitempty"`
	Error     string      `json:"error,omitempty"`
	Signature string      `json:"signature"`
}

// StartCorePayload 启动内核的参数
type StartCorePayload struct {
	BinPath    string `json:"bin_path"`
	ConfigDir  string `json:"config_dir"`
	ConfigFile string `json:"config_file"`
	LogFile    string `json:"log_file,omitempty"`
	ExtCtlPipe string `json:"ext_ctl_pipe,omitempty"`
}

// StatusData 状态数据
type StatusData struct {
	Running bool `json:"running"`
	PID     int  `json:"pid"`
}

// VersionData 版本数据
type VersionData struct {
	Service string `json:"service"`
	Version string `json:"version"`
}

func init() {
	// 派生密钥
	h := sha256.New()
	h.Write([]byte(secretSeed))
	secretKey = h.Sum(nil)
}

func main() {
	install := flag.Bool("install", false, "Install service")
	uninstall := flag.Bool("uninstall", false, "Uninstall service")
	run := flag.Bool("run", false, "Run directly (debug mode)")
	flag.Parse()

	if *install {
		if err := installService(); err != nil {
			log.Fatalf("Failed to install service: %v", err)
		}
		fmt.Println("Service installed successfully")
		return
	}

	if *uninstall {
		if err := uninstallService(); err != nil {
			log.Fatalf("Failed to uninstall service: %v", err)
		}
		fmt.Println("Service uninstalled successfully")
		return
	}

	if *run {
		runServer()
		return
	}

	isService, err := svc.IsWindowsService()
	if err != nil {
		log.Fatalf("Failed to check service status: %v", err)
	}

	if isService {
		if err := svc.Run(serviceName, &helperService{}); err != nil {
			log.Fatalf("Service run failed: %v", err)
		}
	} else {
		fmt.Println("FlyClash Helper Service")
		fmt.Println("Usage:")
		fmt.Println("  -install    Install service")
		fmt.Println("  -uninstall  Uninstall service")
		fmt.Println("  -run        Run directly (debug mode)")
	}
}

type helperService struct{}

func (s *helperService) Execute(args []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	const cmdsAccepted = svc.AcceptStop | svc.AcceptShutdown

	changes <- svc.Status{State: svc.StartPending}

	go runServer()

	changes <- svc.Status{State: svc.Running, Accepts: cmdsAccepted}

	for {
		select {
		case c := <-r:
			switch c.Cmd {
			case svc.Interrogate:
				changes <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				changes <- svc.Status{State: svc.StopPending}
				stopCore()
				stopServer()
				return false, 0
			}
		}
	}
}

func runServer() {
	// 创建 Named Pipe
	// 必须显式设置安全描述符，允许所有用户（包括普通用户）连接
	// SDDL: D:(A;;GA;;;WD) 表示允许 Everyone (WD) 完全访问 (GA)
	pipeConfig := &winio.PipeConfig{
		SecurityDescriptor: "D:(A;;GA;;;WD)",
	}
	listener, err := winio.ListenPipe(pipeName, pipeConfig)
	if err != nil {
		log.Fatalf("Failed to create named pipe: %v", err)
	}

	// 保存 listener 引用，以便停止时关闭
	serverMutex.Lock()
	serverListener = listener
	serverMutex.Unlock()

	defer func() {
		serverMutex.Lock()
		serverListener = nil
		serverMutex.Unlock()
		listener.Close()
	}()

	log.Printf("Helper service listening on %s", pipeName)

	for {
		conn, err := listener.Accept()
		if err != nil {
			// 检查是否是因为 listener 被关闭
			serverMutex.Lock()
			stopped := serverListener == nil
			serverMutex.Unlock()
			if stopped {
				log.Printf("Server stopped")
				return
			}
			log.Printf("Accept error: %v", err)
			continue
		}
		go handleConnection(conn)
	}
}

func stopServer() {
	serverMutex.Lock()
	defer serverMutex.Unlock()
	if serverListener != nil {
		log.Printf("Stopping server...")
		serverListener.Close()
		serverListener = nil
	}
}

func handleConnection(conn net.Conn) {
	defer conn.Close()

	reader := bufio.NewReader(conn)
	line, err := reader.ReadString('\n')
	if err != nil {
		log.Printf("Read error: %v", err)
		return
	}

	var req IpcRequest
	if err := json.Unmarshal([]byte(line), &req); err != nil {
		sendResponse(conn, "", false, nil, "Invalid request format")
		return
	}

	// 验证时间戳
	if !verifyTimestamp(req.Timestamp) {
		sendResponse(conn, req.ID, false, nil, "Request expired")
		return
	}

	// 验证签名
	if !verifySignature(&req) {
		sendResponse(conn, req.ID, false, nil, "Invalid signature")
		return
	}

	// 处理命令
	handleCommand(conn, &req)
}

func handleCommand(conn net.Conn, req *IpcRequest) {
	switch req.Command {
	case CmdGetStatus:
		coreMutex.Lock()
		data := StatusData{Running: coreRunning, PID: corePID}
		coreMutex.Unlock()
		sendResponse(conn, req.ID, true, data, "")

	case CmdGetVersion:
		data := VersionData{Service: "FlyClash Helper Service", Version: "1.0.0"}
		sendResponse(conn, req.ID, true, data, "")

	case CmdStartCore:
		var payload StartCorePayload
		if err := json.Unmarshal(req.Payload, &payload); err != nil {
			sendResponse(conn, req.ID, false, nil, "Invalid payload")
			return
		}
		if err := startCore(&payload); err != nil {
			sendResponse(conn, req.ID, false, nil, err.Error())
			return
		}
		sendResponse(conn, req.ID, true, nil, "")

	case CmdStopCore:
		if err := stopCore(); err != nil {
			sendResponse(conn, req.ID, false, nil, err.Error())
			return
		}
		sendResponse(conn, req.ID, true, nil, "")

	default:
		sendResponse(conn, req.ID, false, nil, "Unknown command")
	}
}

func startCore(payload *StartCorePayload) error {
	coreMutex.Lock()

	// 如果已经在运行，先停止
	if coreProcess != nil && coreRunning {
		coreProcess.Process.Kill()
		coreProcess.Wait()
		coreProcess = nil
		coreRunning = false
		corePID = 0
	}

	// 构建参数
	args := []string{"-d", payload.ConfigDir, "-f", payload.ConfigFile}
	if payload.ExtCtlPipe != "" {
		args = append(args, "-ext-ctl-pipe", payload.ExtCtlPipe)
	}

	// 创建进程
	cmd := exec.Command(payload.BinPath, args...)
	cmd.Dir = filepath.Dir(payload.BinPath)

	// 如果指定了日志文件，重定向输出
	if payload.LogFile != "" {
		logFile, err := os.OpenFile(payload.LogFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
		if err == nil {
			cmd.Stdout = logFile
			cmd.Stderr = logFile
		}
	}

	if err := cmd.Start(); err != nil {
		coreMutex.Unlock()
		return fmt.Errorf("failed to start core: %v", err)
	}

	coreProcess = cmd
	coreRunning = true
	corePID = cmd.Process.Pid
	coreMutex.Unlock()

	// 监控进程退出
	go func() {
		cmd.Wait()
		coreMutex.Lock()
		if coreProcess == cmd {
			coreRunning = false
			coreProcess = nil
			corePID = 0
		}
		coreMutex.Unlock()
	}()

	// 等待确认启动成功
	time.Sleep(200 * time.Millisecond)

	coreMutex.Lock()
	running := coreRunning
	pid := corePID
	coreMutex.Unlock()

	if !running {
		return fmt.Errorf("core process exited immediately")
	}

	log.Printf("Core started with PID: %d", pid)
	return nil
}

func stopCore() error {
	coreMutex.Lock()
	defer coreMutex.Unlock()

	if coreProcess == nil || !coreRunning {
		return nil
	}

	pid := corePID
	if err := coreProcess.Process.Kill(); err != nil {
		return fmt.Errorf("failed to kill core: %v", err)
	}

	coreProcess.Wait()
	coreProcess = nil
	coreRunning = false
	corePID = 0

	log.Printf("Core stopped (PID: %d)", pid)
	return nil
}

func verifyTimestamp(timestamp int64) bool {
	now := time.Now().Unix()
	diff := now - timestamp
	if diff < 0 {
		diff = -diff
	}
	return diff <= messageExpirySecs
}

func verifySignature(req *IpcRequest) bool {
	// 构建签名数据
	data := fmt.Sprintf("%s:%d:%s", req.ID, req.Timestamp, req.Command)
	if len(req.Payload) > 0 {
		data += ":" + string(req.Payload)
	}

	expected := signMessage(data)
	return hmac.Equal([]byte(expected), []byte(req.Signature))
}

func signMessage(data string) string {
	h := hmac.New(sha256.New, secretKey)
	h.Write([]byte(data))
	return hex.EncodeToString(h.Sum(nil))
}

func sendResponse(conn net.Conn, id string, success bool, data interface{}, errMsg string) {
	resp := IpcResponse{
		ID:      id,
		Success: success,
		Data:    data,
		Error:   errMsg,
	}

	// 签名响应
	signData := fmt.Sprintf("%s:%v", id, success)
	if data != nil {
		jsonData, _ := json.Marshal(data)
		signData += ":" + string(jsonData)
	}
	if errMsg != "" {
		signData += ":" + errMsg
	}
	resp.Signature = signMessage(signData)

	jsonResp, _ := json.Marshal(resp)
	conn.Write(append(jsonResp, '\n'))
}

// 查找并终止其他 mihomo 进程
func killOtherMihomoProcesses() {
	// 使用 taskkill 终止所有 mihomo 进程（除了我们管理的）
	coreMutex.Lock()
	ourPID := corePID
	coreMutex.Unlock()

	cmd := exec.Command("tasklist", "/FI", "IMAGENAME eq mihomo.exe", "/FO", "CSV", "/NH")
	output, err := cmd.Output()
	if err != nil {
		return
	}

	lines := strings.Split(string(output), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.Split(line, ",")
		if len(parts) >= 2 {
			pidStr := strings.Trim(parts[1], "\"")
			var pid int
			fmt.Sscanf(pidStr, "%d", &pid)
			if pid > 0 && pid != ourPID {
				exec.Command("taskkill", "/F", "/PID", fmt.Sprintf("%d", pid)).Run()
			}
		}
	}
}
