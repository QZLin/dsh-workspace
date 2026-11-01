package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"reflect"
	"strings"
	"testing"
)

func cliScript(response string) (dependencies, *scriptConn, *int) {
	client, conn, dials := scriptedClient(response)
	return dependencies{resolver: unixResolver(map[string]string{"DSH_WORKSPACE_SOCKET": "/transport.sock"}), dial: client.dial, newID: client.newID}, conn, dials
}

func TestRunCommandsJSONAndRequestMappings(t *testing.T) {
	cases := []struct {
		args   []string
		method string
		params map[string]string
		result string
	}{
		{[]string{"add", `~/missing/../raw`, "--title", "  raw title  "}, "workspace.add", map[string]string{"path": `~/missing/../raw`, "title": "  raw title  "}, `{"id":"id","path":"~/missing/../raw","title":"  raw title  "}`},
		{[]string{"add", ""}, "workspace.add", map[string]string{"path": ""}, `{"id":"id","path":"","title":""}`},
		{[]string{"list"}, "workspace.list", map[string]string{}, `[]`},
		{[]string{"get", "id"}, "workspace.get", map[string]string{"id": "id"}, `{"id":"id","path":"raw","title":"title","createdAt":"2026-01-02T03:04:05.000Z","updatedAt":"2026-01-02T03:04:05.000Z","sessionIds":[]}`},
		{[]string{"rename", "id", " \t title \n "}, "workspace.rename", map[string]string{"id": "id", "title": " \t title \n "}, `{"id":"id","path":"raw","title":" \t title \n "}`},
		{[]string{"remove", "unknown"}, "workspace.remove", map[string]string{"id": "unknown"}, `{"id":"unknown","deleted":false}`},
		{[]string{"delete", "id"}, "workspace.remove", map[string]string{"id": "id"}, `{"id":"id","deleted":true}`},
		{[]string{"rm", "id"}, "workspace.remove", map[string]string{"id": "id"}, `{"id":"id","deleted":true}`},
		{[]string{"move", "id", "--before", "before"}, "workspace.move", map[string]string{"id": "id", "beforeId": "before"}, `{"order":["id","before"]}`},
		{[]string{"move", "id"}, "workspace.move", map[string]string{"id": "id"}, `{"order":["id"]}`},
		{[]string{"resolve", `C:relative\..\raw`}, "workspace.resolve", map[string]string{"path": `C:relative\..\raw`}, `null`},
		{[]string{"status", "id"}, "workspace.status", map[string]string{"id": "id"}, `{"id":"id","status":"missing-dir"}`},
		{[]string{"ping"}, "workspace.ping", map[string]string{}, `{"service":"dsh-workspace","protocolVersion":1,"profile":null}`},
	}
	for _, tc := range cases {
		t.Run(strings.Join(tc.args, "/"), func(t *testing.T) {
			deps, conn, dials := cliScript(successResponse(tc.result) + "\n")
			var stdout, stderr bytes.Buffer
			args := append(append([]string{}, tc.args...), "--json", "--timeout", "2500")
			code := run(context.Background(), args, &stdout, &stderr, deps)
			if code != exitSuccess || stdout.String() != tc.result+"\n" || stderr.Len() != 0 || *dials != 1 {
				t.Fatalf("code=%d stdout=%q stderr=%q dials=%d", code, &stdout, &stderr, *dials)
			}
			var request rpcRequest
			if err := json.Unmarshal(conn.written, &request); err != nil {
				t.Fatal(err)
			}
			if request.Method != tc.method || !reflect.DeepEqual(request.Params, tc.params) {
				t.Fatalf("request = %#v; want %s %#v", request, tc.method, tc.params)
			}
		})
	}
}

func TestRunArgumentAndRemoteDiagnosticsOnlyStderr(t *testing.T) {
	for _, args := range [][]string{{}, {"add"}, {"list", "extra"}, {"ping", "--timeout", "0"}, {"endpoint", "--dshHome", " "}} {
		deps, _, dials := cliScript("")
		var stdout, stderr bytes.Buffer
		code := run(context.Background(), args, &stdout, &stderr, deps)
		if code != exitArgument || stdout.Len() != 0 || stderr.Len() == 0 || *dials != 0 {
			t.Fatalf("args %q: code=%d stdout=%q stderr=%q dials=%d", args, code, &stdout, &stderr, *dials)
		}
	}
	response := `{"jsonrpc":"2.0","id":"request-id","error":{"code":-32001,"message":"not registered","data":{"id":"bad"}}}` + "\n"
	for _, jsonMode := range []bool{false, true} {
		deps, _, dials := cliScript(response)
		var stdout, stderr bytes.Buffer
		args := []string{"get", "bad"}
		if jsonMode {
			args = append(args, "--json")
		}
		code := run(context.Background(), args, &stdout, &stderr, deps)
		if code != exitRemote || stdout.Len() != 0 || !strings.Contains(stderr.String(), "-32001") || !strings.Contains(stderr.String(), "not registered") || *dials != 1 {
			t.Fatalf("remote error: code=%d stdout=%q stderr=%q dials=%d", code, &stdout, &stderr, *dials)
		}
	}
}

func TestRunConnectionTimeoutAndProtocolExitCodes(t *testing.T) {
	for _, tc := range []struct {
		name, response string
		code           int
	}{
		{"disconnect", "", exitIO},
		{"partial disconnect", `{"jsonrpc":"2.0"`, exitIO},
		{"malformed JSON", "invalid\n", exitProtocol},
		{"wrong ID", `{"jsonrpc":"2.0","id":"wrong","result":[]}` + "\n", exitProtocol},
		{"bad result", successResponse(`null`) + "\n", exitProtocol},
	} {
		t.Run(tc.name, func(t *testing.T) {
			deps, _, dials := cliScript(tc.response)
			var stdout, stderr bytes.Buffer
			code := run(context.Background(), []string{"list", "--json"}, &stdout, &stderr, deps)
			if code != tc.code || stdout.Len() != 0 || stderr.Len() == 0 || *dials != 1 {
				t.Fatalf("code=%d stdout=%q stderr=%q dials=%d", code, &stdout, &stderr, *dials)
			}
		})
	}
	for _, timeout := range []bool{false, true} {
		deps, _, _ := cliScript("")
		calls := 0
		deps.dial = func(ctx context.Context, endpoint string) (net.Conn, error) {
			calls++
			if timeout {
				<-ctx.Done()
				return nil, ctx.Err()
			}
			return nil, errors.New("endpoint missing")
		}
		var stdout, stderr bytes.Buffer
		code := run(context.Background(), []string{"remove", "id", "--timeout=10", "--json"}, &stdout, &stderr, deps)
		want := exitIO
		if timeout {
			want = exitTimeout
		}
		if code != want || stdout.Len() != 0 || stderr.Len() == 0 || calls != 1 {
			t.Fatalf("dial timeout=%t: code=%d stdout=%q stderr=%q calls=%d", timeout, code, &stdout, &stderr, calls)
		}
	}
}

func TestRunUnencodableArgumentsDoNotMutateOrConnect(t *testing.T) {
	invalid := string([]byte{0xff})
	for _, args := range [][]string{{"add", invalid}, {"add", "raw", "--title", invalid}, {"rename", "id", invalid}} {
		deps, conn, dials := cliScript("")
		var stdout, stderr bytes.Buffer
		code := run(context.Background(), args, &stdout, &stderr, deps)
		if code != exitArgument || stdout.Len() != 0 || !strings.Contains(stderr.String(), "UTF-8") || *dials != 0 || conn.writes != 0 {
			t.Fatalf("unencodable args: code=%d stdout=%q stderr=%q dials=%d writes=%d", code, &stdout, &stderr, *dials, conn.writes)
		}
	}
}

func TestRunOfflineEndpointHelpAndVersion(t *testing.T) {
	deps := dependencies{resolver: unixResolver(nil)}
	deps.dial = func(context.Context, string) (net.Conn, error) { t.Fatal("offline command dialed"); return nil, nil }
	deps.newID = func() (string, error) { t.Fatal("offline command generated request ID"); return "", nil }
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"endpoint", "--endpoint", "./raw/../socket"}, "/cwd/socket\n"},
		{[]string{"--json", "endpoint", "--endpoint=~/socket"}, "\"/users/Tester/socket\"\n"},
		{[]string{"endpoint", "--dsh-home", "./not-existing/home"}, "/cwd/not-existing/home/.dsh-workspace.sock\n"},
		{[]string{"--version"}, "dsh-workspace " + version + "\n"},
		{[]string{"-v"}, "dsh-workspace " + version + "\n"},
		{[]string{"--help"}, helpText("linux")},
		{[]string{"get", "-h"}, helpText("linux")},
	} {
		var stdout, stderr bytes.Buffer
		code := run(context.Background(), tc.args, &stdout, &stderr, deps)
		if code != exitSuccess || stdout.String() != tc.want || stderr.Len() != 0 {
			t.Fatalf("%q: code=%d stdout=%q stderr=%q want=%q", tc.args, code, &stdout, &stderr, tc.want)
		}
	}
}

type brokenWriter struct{}

func (brokenWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestStdoutFailuresAreIOErrors(t *testing.T) {
	deps, _, _ := cliScript(successResponse(`[]`) + "\n")
	var stderr bytes.Buffer
	code := run(context.Background(), []string{"list"}, brokenWriter{}, &stderr, deps)
	if code != exitIO || !strings.Contains(stderr.String(), "stdout") {
		t.Fatalf("stdout error code=%d stderr=%q", code, &stderr)
	}
}
