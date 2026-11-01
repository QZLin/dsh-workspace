package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"
)

const helperEnv = "DSH_WORKSPACE_CLI_TEST_MAIN"

// Reuse the Go test executable to exercise the real main, signal setup, and
// process exit codes without building or installing a global executable.
func TestMain(m *testing.M) {
	if os.Getenv(helperEnv) == "1" {
		main()
		return
	}
	os.Exit(m.Run())
}

type responder func(rpcRequest) []byte

func serveOne(listener net.Listener, respond responder) (<-chan rpcRequest, <-chan error) {
	received := make(chan rpcRequest, 1)
	done := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			done <- err
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(6 * time.Second))
		line, err := bufio.NewReader(conn).ReadBytes('\n')
		if err != nil {
			done <- err
			return
		}
		var request rpcRequest
		if err := json.Unmarshal(line, &request); err != nil {
			done <- err
			return
		}
		received <- request
		response := respond(request)
		if response == nil {
			// Hold the response until the client deadline or signal closes its
			// connection. Do not block the test with sleeps or retry requests.
			_, _ = io.Copy(io.Discard, conn)
			done <- nil
			return
		}
		// Fragment every response, including across an optional CRLF ending.
		for offset := 0; offset < len(response); {
			next := min(offset+7, len(response))
			if _, err := conn.Write(response[offset:next]); err != nil {
				done <- err
				return
			}
			offset = next
		}
		done <- nil
	}()
	return received, done
}

func envelope(id string, result any) []byte {
	encoded, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	if err != nil {
		panic(err)
	}
	return encoded
}

func TestNativeTransportRawFidelityAndFragmentedCRLF(t *testing.T) {
	listener, endpoint := localTestListener(t)
	rawPath, rawTitle := `C:relative\..\~/does not exist`, "  raw \t title \n 世界  "
	received, done := serveOne(listener, func(request rpcRequest) []byte {
		return append(envelope(request.ID, map[string]string{"id": "id", "path": rawPath, "title": rawTitle}), '\r', '\n')
	})
	var stdout, stderr bytes.Buffer
	code := run(context.Background(), []string{"--json", "add", rawPath, "--endpoint", endpoint, "--title", rawTitle, "--timeout", "2000"}, &stdout, &stderr, nativeDependencies())
	if code != exitSuccess || stderr.Len() != 0 {
		t.Fatalf("native IPC: code=%d stdout=%q stderr=%q", code, &stdout, &stderr)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	request := <-received
	if request.JSONRPC != "2.0" || request.ID == "" || request.Method != "workspace.add" || !reflect.DeepEqual(request.Params, map[string]string{"path": rawPath, "title": rawTitle}) {
		t.Fatalf("native request changed arguments: %#v", request)
	}
	var result map[string]string
	if json.Unmarshal(stdout.Bytes(), &result) != nil || result["path"] != rawPath || result["title"] != rawTitle {
		t.Fatalf("native JSON output changed strings: %q", &stdout)
	}
}

func helperCommand(t *testing.T, ctx context.Context, args ...string) *exec.Cmd {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Env = append(os.Environ(), helperEnv+"=1")
	return cmd
}

func runHelper(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	cmd := helperCommand(t, ctx, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	if ctx.Err() != nil {
		t.Fatalf("CLI subprocess did not finish: %v", ctx.Err())
	}
	if err == nil {
		return 0, stdout.String(), stderr.String()
	}
	var exited *exec.ExitError
	if !errors.As(err, &exited) {
		t.Fatalf("cannot run CLI subprocess: %v", err)
	}
	return exited.ExitCode(), stdout.String(), stderr.String()
}

func TestNativeMainMetadataAndOfflineEndpoint(t *testing.T) {
	for _, tc := range []struct {
		args []string
		code int
		text string
	}{
		{[]string{"--help"}, 0, "Usage:"},
		{[]string{"-v"}, 0, "dsh-workspace " + version},
		{[]string{"add"}, 2, ""},
	} {
		code, stdout, stderr := runHelper(t, tc.args...)
		if code != tc.code {
			t.Fatalf("%q: exit=%d stdout=%q stderr=%q", tc.args, code, stdout, stderr)
		}
		if tc.code == 0 && (!strings.Contains(stdout, tc.text) || stderr != "") {
			t.Fatalf("metadata stdout=%q stderr=%q", stdout, stderr)
		}
		if tc.code != 0 && (stdout != "" || stderr == "") {
			t.Fatalf("argument diagnostics stdout=%q stderr=%q", stdout, stderr)
		}
	}
	listener, endpoint := localTestListener(t)
	_ = listener.Close()
	code, stdout, stderr := runHelper(t, "endpoint", "--endpoint", endpoint, "--json")
	var decoded string
	if code != 0 || stderr != "" || json.Unmarshal([]byte(stdout), &decoded) != nil || decoded != endpoint {
		t.Fatalf("offline endpoint exit=%d stdout=%q stderr=%q", code, stdout, stderr)
	}
	code, stdout, stderr = runHelper(t, "ping", "--endpoint", endpoint, "--timeout", "100", "--json")
	if code != exitIO || stdout != "" || stderr == "" {
		t.Fatalf("missing endpoint exit=%d stdout=%q stderr=%q", code, stdout, stderr)
	}
}

func TestNativeMainExitCodesAndNoErrorStdout(t *testing.T) {
	cases := []struct {
		name    string
		respond responder
		code    int
	}{
		{"success", func(request rpcRequest) []byte { return append(envelope(request.ID, []string{}), '\n') }, exitSuccess},
		{"remote", func(request rpcRequest) []byte {
			return []byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":%q,"error":{"code":-32001,"message":"remote failure","data":{"detail":"preserved"}}}`+"\n", request.ID))
		}, exitRemote},
		{"invalid JSON", func(rpcRequest) []byte { return []byte("not-json\n") }, exitProtocol},
		{"wrong ID", func(rpcRequest) []byte { return append(envelope("wrong-id", []string{}), '\n') }, exitProtocol},
		{"partial disconnect", func(request rpcRequest) []byte { return envelope(request.ID, []string{}) }, exitIO},
		{"timeout", func(rpcRequest) []byte { return nil }, exitTimeout},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			listener, endpoint := localTestListener(t)
			received, done := serveOne(listener, tc.respond)
			code, stdout, stderr := runHelper(t, "list", "--endpoint", endpoint, "--timeout", "500", "--json")
			if code != tc.code {
				t.Fatalf("exit=%d stdout=%q stderr=%q; want %d", code, stdout, stderr, tc.code)
			}
			if code == exitSuccess && (stdout != "[]\n" || stderr != "") {
				t.Fatalf("success stdout=%q stderr=%q", stdout, stderr)
			}
			if code != exitSuccess && (stdout != "" || stderr == "") {
				t.Fatalf("error stdout=%q stderr=%q", stdout, stderr)
			}
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			request := <-received
			if request.Method != "workspace.list" || len(request.Params) != 0 {
				t.Fatalf("unexpected request: %#v", request)
			}
		})
	}
}
