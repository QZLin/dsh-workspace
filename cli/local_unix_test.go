//go:build !windows

package main

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

func localTestListener(t *testing.T) (net.Listener, string) {
	t.Helper()
	dir, err := os.MkdirTemp("", "dsh-cli-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	endpoint := filepath.Join(dir, "s")
	listener, err := net.Listen("unix", endpoint)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	return listener, endpoint
}
