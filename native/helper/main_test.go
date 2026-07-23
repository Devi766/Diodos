package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestAllowedCoreDirsExcludeUserWritableAppData(t *testing.T) {
	dirs := getAllowedCoreDirs()
	needle := strings.ToLower(filepath.Join("com.flyclash.desktop", "cores"))

	for _, dir := range dirs {
		if strings.Contains(strings.ToLower(dir), needle) {
			t.Fatalf("allowed core dirs must not include user-writable app data: %s", dir)
		}
	}
}

func TestHelperVersionBumpedForRuntimeCompatibility(t *testing.T) {
	if helperVersion != "1.0.4" {
		t.Fatalf("unexpected helper version: %s", helperVersion)
	}
}

func TestClientSIDValidation(t *testing.T) {
	if !isValidClientSID("S-1-5-21-1000-2000-3000-1001") {
		t.Fatal("valid Windows SID was rejected")
	}
	if !isValidClientSID("S-1-12-1-1000-2000-3000-1001") {
		t.Fatal("valid Microsoft account SID was rejected")
	}
	for _, value := range []string{"", "S-2-5-21", "S-1-a-21", "S-1-5-", "S-1-1-0", "S-1-5-11"} {
		if isValidClientSID(value) {
			t.Fatalf("invalid Windows SID was accepted: %q", value)
		}
	}
}

func TestDecodeServiceCorePath(t *testing.T) {
	encoded := "QzpcUHJvZ3JhbURhdGFcRmx5Q2xhc2hcc2VydmljZS1jb3Jlc1xtaWhvbW8uZXhl"
	decoded, err := decodeServiceCorePath(encoded)
	if err != nil {
		t.Fatalf("decode path: %v", err)
	}
	if decoded != `C:\ProgramData\FlyClash\service-cores\mihomo.exe` {
		t.Fatalf("unexpected path: %q", decoded)
	}
	if _, err := decodeServiceCorePath("%%%invalid%%%"); err == nil {
		t.Fatal("invalid path encoding was accepted")
	}
}

func TestUsersRootFromProfileAcceptsNormalWindowsUsersProfile(t *testing.T) {
	root := usersRootFromProfile(`C:\Users\GtxFury`)
	if !strings.EqualFold(root, `C:\Users`) {
		t.Fatalf("unexpected users root: %s", root)
	}
}

func TestUsersRootFromProfileRejectsSystemProfileConfigDir(t *testing.T) {
	root := usersRootFromProfile(`C:\WINDOWS\system32\config\systemprofile`)
	if root != "" {
		t.Fatalf("system profile should not produce a users root, got: %s", root)
	}
}
