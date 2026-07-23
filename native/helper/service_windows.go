//go:build windows

package main

import (
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const (
	helperRegistryPath       = `SOFTWARE\FlyClash`
	helperClientSIDValueName = "HelperClientSID"
)

func isValidClientSID(value string) bool {
	parts := strings.Split(strings.TrimSpace(value), "-")
	if len(parts) < 4 || !strings.EqualFold(parts[0], "S") || parts[1] != "1" {
		return false
	}
	for _, part := range parts[2:] {
		if part == "" {
			return false
		}
		for _, r := range part {
			if r < '0' || r > '9' {
				return false
			}
		}
	}

	// Desktop users are local/domain accounts (S-1-5-21-...) or Microsoft
	// account identities (S-1-12-1-...). Do not accept well-known group SIDs
	// such as Everyone, which would make the helper pipe globally accessible.
	return (len(parts) == 8 && parts[2] == "5" && parts[3] == "21") ||
		(len(parts) == 8 && parts[2] == "12" && parts[3] == "1")
}

func resolveClientSID(requested string) (string, error) {
	if requested = strings.TrimSpace(requested); requested != "" {
		if !isValidClientSID(requested) {
			return "", fmt.Errorf("invalid client SID")
		}
		return requested, nil
	}
	current, err := user.Current()
	if err != nil {
		return "", fmt.Errorf("failed to resolve current user SID: %v", err)
	}
	if !isValidClientSID(current.Uid) {
		return "", fmt.Errorf("invalid current user SID")
	}
	return current.Uid, nil
}

func persistClientSID(sid string) error {
	key, _, err := registry.CreateKey(registry.LOCAL_MACHINE, helperRegistryPath, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("failed to open helper registry key: %v", err)
	}
	defer key.Close()
	if err := key.SetStringValue(helperClientSIDValueName, sid); err != nil {
		return fmt.Errorf("failed to persist helper client SID: %v", err)
	}
	return nil
}

func authorizedClientSID() (string, error) {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, helperRegistryPath, registry.QUERY_VALUE)
	if err != nil {
		return "", fmt.Errorf("failed to read helper client SID: %v", err)
	}
	defer key.Close()
	sid, _, err := key.GetStringValue(helperClientSIDValueName)
	if err != nil {
		return "", fmt.Errorf("failed to read helper client SID: %v", err)
	}
	if !isValidClientSID(sid) {
		return "", fmt.Errorf("stored helper client SID is invalid")
	}
	return sid, nil
}

func helperPipeSecurityDescriptor() (string, error) {
	sid, err := authorizedClientSID()
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;%s)", sid), nil
}

func isServiceAlreadyExists(err error) bool {
	if err == nil {
		return false
	}
	if err == windows.ERROR_SERVICE_EXISTS {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "already exists") ||
		strings.Contains(msg, "service already exists") ||
		strings.Contains(msg, "指定的服务已存在")
}

func isServiceMarkedForDelete(err error) bool {
	if err == nil {
		return false
	}
	if err == windows.ERROR_SERVICE_MARKED_FOR_DELETE {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "marked for deletion") ||
		strings.Contains(msg, "marked for delete") ||
		strings.Contains(msg, "标记为删除")
}

func waitForServiceState(s *mgr.Service, want svc.State, attempts int, delay time.Duration) error {
	var last error
	for i := 0; i < attempts; i++ {
		status, err := s.Query()
		if err != nil {
			last = err
		} else if status.State == want {
			return nil
		}
		time.Sleep(delay)
	}
	if last != nil {
		return last
	}
	return fmt.Errorf("service did not reach state %v", want)
}

func waitUntilServiceGone(m *mgr.Mgr, attempts int, delay time.Duration) error {
	for i := 0; i < attempts; i++ {
		s, err := m.OpenService(serviceName)
		if err != nil {
			// Open failed => service no longer registered.
			return nil
		}
		s.Close()
		time.Sleep(delay)
	}
	return fmt.Errorf("service %s is still present after uninstall", serviceName)
}

func stopAndDeleteService(s *mgr.Service) error {
	// Best-effort stop first. Delete can succeed while service is still stopping,
	// but that leaves a "marked for deletion" tombstone until process exits.
	status, err := s.Query()
	if err == nil && status.State != svc.Stopped {
		_, _ = s.Control(svc.Stop)
		_ = waitForServiceState(s, svc.Stopped, 30, 200*time.Millisecond)
	}

	if err := s.Delete(); err != nil {
		if isServiceMarkedForDelete(err) {
			return nil
		}
		return fmt.Errorf("failed to delete service: %v", err)
	}
	return nil
}

func installService(requestedClientSID string) error {
	clientSID, err := resolveClientSID(requestedClientSID)
	if err != nil {
		return err
	}
	if err := persistClientSID(clientSID); err != nil {
		return err
	}
	if err := ensureServiceCoreDirectory(); err != nil {
		return err
	}

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

	// If the service already exists, prefer update/start over uninstall+recreate.
	// Windows service deletion is asynchronous; recreate often races with
	// "The specified service already exists."
	if existing, err := m.OpenService(serviceName); err == nil {
		defer existing.Close()

		cfg, cfgErr := existing.Config()
		if cfgErr != nil {
			return fmt.Errorf("failed to read existing service config: %v", cfgErr)
		}
		cfg.BinaryPathName = exePath
		cfg.DisplayName = serviceDisplay
		cfg.Description = serviceDesc
		cfg.StartType = mgr.StartAutomatic
		if err := existing.UpdateConfig(cfg); err != nil {
			return fmt.Errorf("failed to update existing service: %v", err)
		}

		status, queryErr := existing.Query()
		if queryErr == nil && status.State == svc.Running {
			// Restart so the new binary/path takes effect.
			_, _ = existing.Control(svc.Stop)
			_ = waitForServiceState(existing, svc.Stopped, 30, 200*time.Millisecond)
		}
		if err := existing.Start(); err != nil {
			// Start can return "already running" depending on race; treat as success
			// if the service ends up RUNNING.
			if status, qerr := existing.Query(); qerr == nil && status.State == svc.Running {
				return nil
			}
			return fmt.Errorf("failed to start existing service: %v", err)
		}
		return nil
	}

	// Create service when it does not exist.
	config := mgr.Config{
		DisplayName: serviceDisplay,
		Description: serviceDesc,
		StartType:   mgr.StartAutomatic,
	}

	var s *mgr.Service
	var createErr error
	for attempt := 0; attempt < 8; attempt++ {
		s, createErr = m.CreateService(serviceName, exePath, config)
		if createErr == nil {
			break
		}

		if isServiceAlreadyExists(createErr) || isServiceMarkedForDelete(createErr) {
			// Existing/tombstoned service: wait and prefer update path.
			time.Sleep(400 * time.Millisecond)
			if existing, openErr := m.OpenService(serviceName); openErr == nil {
				cfg, cfgErr := existing.Config()
				if cfgErr != nil {
					existing.Close()
					return fmt.Errorf("failed to read existing service config: %v", cfgErr)
				}
				cfg.BinaryPathName = exePath
				cfg.DisplayName = serviceDisplay
				cfg.Description = serviceDesc
				cfg.StartType = mgr.StartAutomatic
				if err := existing.UpdateConfig(cfg); err != nil {
					existing.Close()
					return fmt.Errorf("failed to update existing service: %v", err)
				}
				status, queryErr := existing.Query()
				if queryErr == nil && status.State != svc.Running {
					if err := existing.Start(); err != nil {
						existing.Close()
						return fmt.Errorf("failed to start existing service: %v", err)
					}
				} else if queryErr == nil && status.State == svc.Running {
					// Restart to pick up binary path changes.
					_, _ = existing.Control(svc.Stop)
					_ = waitForServiceState(existing, svc.Stopped, 30, 200*time.Millisecond)
					if err := existing.Start(); err != nil {
						if status, qerr := existing.Query(); qerr == nil && status.State == svc.Running {
							existing.Close()
							return nil
						}
						existing.Close()
						return fmt.Errorf("failed to restart existing service: %v", err)
					}
				}
				existing.Close()
				return nil
			}
			continue
		}
		return fmt.Errorf("failed to create service: %v", createErr)
	}
	if createErr != nil {
		return fmt.Errorf("failed to create service: %v", createErr)
	}
	defer s.Close()

	if err := s.Start(); err != nil {
		if status, qerr := s.Query(); qerr == nil && status.State == svc.Running {
			return nil
		}
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
		// Service does not exist.
		return nil
	}

	deleteErr := stopAndDeleteService(s)
	s.Close()
	if deleteErr != nil {
		return deleteErr
	}

	// SCM delete is asynchronous. Wait until OpenService fails so subsequent
	// installs don't race with "already exists".
	if err := waitUntilServiceGone(m, 40, 150*time.Millisecond); err != nil {
		// Not fatal if already marked for deletion; report for visibility.
		return err
	}
	return nil
}
