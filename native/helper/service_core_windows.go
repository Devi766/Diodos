//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/windows/registry"
)

const serviceCoreRegistryPath = `SOFTWARE\FlyClash\ServiceCores`

func decodeServiceCorePath(encoded string) (string, error) {
	if strings.TrimSpace(encoded) == "" {
		return "", fmt.Errorf("missing service core path")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(decoded) == 0 {
		return "", fmt.Errorf("invalid service core path")
	}
	return string(decoded), nil
}

func serviceCoreDirectory() string {
	programData := os.Getenv("ProgramData")
	if strings.TrimSpace(programData) == "" {
		programData = `C:\ProgramData`
	}
	return filepath.Join(programData, "FlyClash", "service-cores")
}

func runIcacls(path string, args ...string) error {
	commandArgs := append([]string{path}, args...)
	cmd := exec.Command("icacls", commandArgs...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("icacls failed: %v: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func ensureServiceCoreDirectory() error {
	dir := serviceCoreDirectory()
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create service core directory: %v", err)
	}
	if err := runIcacls(dir, "/setowner", "*S-1-5-32-544"); err != nil {
		return err
	}
	return runIcacls(
		dir,
		"/inheritance:r",
		"/grant:r",
		"*S-1-5-18:(OI)(CI)F",
		"*S-1-5-32-544:(OI)(CI)F",
	)
}

func hardenServiceCoreFile(path string) error {
	if err := runIcacls(path, "/setowner", "*S-1-5-32-544"); err != nil {
		return err
	}
	return runIcacls(
		path,
		"/inheritance:r",
		"/grant:r",
		"*S-1-5-18:F",
		"*S-1-5-32-544:F",
	)
}

func serviceCoreValueName(path string) string {
	clean, err := filepath.Abs(path)
	if err != nil {
		clean = filepath.Clean(path)
	}
	digest := sha256.Sum256([]byte(strings.ToLower(clean)))
	return "core-" + hex.EncodeToString(digest[:])
}

func serviceCoreDigest(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func isServiceCorePath(path string) bool {
	serviceDir, err := filepath.EvalSymlinks(serviceCoreDirectory())
	if err != nil {
		return false
	}
	realPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		return false
	}
	return pathIsSameOrChild(realPath, serviceDir)
}

func isTrustedServiceCore(path string) bool {
	if !isServiceCorePath(path) {
		return false
	}
	realPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		return false
	}
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, serviceCoreRegistryPath, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer key.Close()
	expected, _, err := key.GetStringValue(serviceCoreValueName(realPath))
	if err != nil || expected == "" {
		return false
	}
	actual, err := serviceCoreDigest(realPath)
	return err == nil && strings.EqualFold(expected, actual)
}

func installTrustedServiceCore(source, target string) error {
	if err := ensureServiceCoreDirectory(); err != nil {
		return err
	}

	sourcePath, err := filepath.EvalSymlinks(source)
	if err != nil {
		return fmt.Errorf("failed to resolve source core: %v", err)
	}
	sourceInfo, err := os.Stat(sourcePath)
	if err != nil || sourceInfo.IsDir() {
		return fmt.Errorf("source core is not a file")
	}
	if !strings.EqualFold(filepath.Ext(sourcePath), ".exe") {
		return fmt.Errorf("source core must use the .exe extension")
	}

	serviceDir, err := filepath.EvalSymlinks(serviceCoreDirectory())
	if err != nil {
		return fmt.Errorf("failed to resolve service core directory: %v", err)
	}
	targetPath, err := filepath.Abs(target)
	if err != nil {
		return fmt.Errorf("failed to resolve target core: %v", err)
	}
	targetPath = filepath.Clean(targetPath)
	if !strings.EqualFold(filepath.Dir(targetPath), serviceDir) || !strings.EqualFold(filepath.Ext(targetPath), ".exe") {
		return fmt.Errorf("target core must be a direct child of the service core directory")
	}

	sourceFile, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer sourceFile.Close()
	tempFile, err := os.CreateTemp(serviceDir, ".install-*.tmp")
	if err != nil {
		return err
	}
	tempPath := tempFile.Name()
	defer os.Remove(tempPath)
	if _, err := io.Copy(tempFile, sourceFile); err != nil {
		tempFile.Close()
		return err
	}
	if err := tempFile.Sync(); err != nil {
		tempFile.Close()
		return err
	}
	if err := tempFile.Close(); err != nil {
		return err
	}
	if err := os.Remove(targetPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to replace existing service core: %v", err)
	}
	if err := os.Rename(tempPath, targetPath); err != nil {
		return err
	}
	if err := hardenServiceCoreFile(targetPath); err != nil {
		return err
	}

	digest, err := serviceCoreDigest(targetPath)
	if err != nil {
		return err
	}
	key, _, err := registry.CreateKey(registry.LOCAL_MACHINE, serviceCoreRegistryPath, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("failed to open service core registry key: %v", err)
	}
	defer key.Close()
	if err := key.SetStringValue(serviceCoreValueName(targetPath), digest); err != nil {
		return fmt.Errorf("failed to record service core digest: %v", err)
	}
	return nil
}
