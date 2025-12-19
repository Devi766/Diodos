//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func installService() error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("failed to get executable path: %v", err)
	}
	exePath, err = filepath.Abs(exePath)
	if err != nil {
		return fmt.Errorf("failed to get absolute path: %v", err)
	}

	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("failed to connect to service manager: %v", err)
	}
	defer m.Disconnect()

	// 检查服务是否已存在
	s, err := m.OpenService(serviceName)
	if err == nil {
		s.Close()
		// 服务已存在，先卸载
		if err := uninstallService(); err != nil {
			return fmt.Errorf("failed to uninstall existing service: %v", err)
		}
		time.Sleep(time.Second)
	}

	// 创建服务
	config := mgr.Config{
		DisplayName: serviceDisplay,
		Description: serviceDesc,
		StartType:   mgr.StartAutomatic, // 自动启动
	}

	s, err = m.CreateService(serviceName, exePath, config)
	if err != nil {
		return fmt.Errorf("failed to create service: %v", err)
	}
	defer s.Close()

	// 启动服务
	if err := s.Start(); err != nil {
		return fmt.Errorf("failed to start service: %v", err)
	}

	return nil
}

func uninstallService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("failed to connect to service manager: %v", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err != nil {
		// 服务不存在
		return nil
	}
	defer s.Close()

	// 先停止服务
	status, err := s.Query()
	if err == nil && status.State != svc.Stopped {
		s.Control(svc.Stop)
		// 等待服务停止
		for i := 0; i < 10; i++ {
			status, err = s.Query()
			if err != nil || status.State == svc.Stopped {
				break
			}
			time.Sleep(500 * time.Millisecond)
		}
	}

	// 删除服务
	if err := s.Delete(); err != nil {
		return fmt.Errorf("failed to delete service: %v", err)
	}

	return nil
}
