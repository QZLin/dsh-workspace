//go:build !windows

package main

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

func TestNativeSignalsReturnConventionalCodes(t *testing.T) {
	for _, tc := range []struct {
		name   string
		signal syscall.Signal
		code   int
	}{{"SIGINT", syscall.SIGINT, 130}, {"SIGTERM", syscall.SIGTERM, 143}} {
		t.Run(tc.name, func(t *testing.T) {
			listener, endpoint := localTestListener(t)
			received, done := serveOne(listener, func(rpcRequest) []byte { return nil })
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			cmd := helperCommand(t, ctx, "ping", "--endpoint", endpoint, "--timeout", "4000")
			var stdout, stderr bytes.Buffer
			cmd.Stdout, cmd.Stderr = &stdout, &stderr
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			select {
			case <-received:
			case <-ctx.Done():
				t.Fatal("subprocess never sent its request")
			}
			if err := cmd.Process.Signal(tc.signal); err != nil {
				t.Fatal(err)
			}
			err := cmd.Wait()
			var exited *exec.ExitError
			if !errors.As(err, &exited) || exited.ExitCode() != tc.code || stdout.Len() != 0 {
				t.Fatalf("signal exit=%v stdout=%q stderr=%q", err, &stdout, &stderr)
			}
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		})
	}
}
