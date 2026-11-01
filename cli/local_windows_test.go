//go:build windows

package main

import (
	"net"
	"testing"

	"github.com/Microsoft/go-winio"
)

func localTestListener(t *testing.T) (net.Listener, string) {
	t.Helper()
	id, err := newRequestID()
	if err != nil {
		t.Fatal(err)
	}
	endpoint := windowsPipePrefix + "dsh-workspace-cli-test-" + id
	listener, err := winio.ListenPipe(endpoint, &winio.PipeConfig{InputBufferSize: 65536, OutputBufferSize: 65536})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	return listener, endpoint
}
