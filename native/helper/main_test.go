package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestAllowedCoreDirsIncludeTauriAppDataIdentifier(t *testing.T) {
	dirs := getAllowedCoreDirs()
	needle := strings.ToLower(filepath.Join("com.flyclash.desktop", "cores"))

	for _, dir := range dirs {
		if strings.Contains(strings.ToLower(dir), needle) {
			return
		}
	}

	t.Fatalf("allowed core dirs do not include %s: %v", needle, dirs)
}

func TestHelperVersionBumpedForRuntimeCompatibility(t *testing.T) {
	if helperVersion != "1.0.2" {
		t.Fatalf("unexpected helper version: %s", helperVersion)
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
