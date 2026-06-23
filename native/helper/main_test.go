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
	if helperVersion != "1.0.1" {
		t.Fatalf("unexpected helper version: %s", helperVersion)
	}
}
