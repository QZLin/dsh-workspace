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
	"regexp"
	"strings"
	"testing"
	"time"
)

const testRequestID = "request-id"

func successResponse(result string) string {
	return `{"jsonrpc":"2.0","id":"` + testRequestID + `","result":` + result + `}`
}

type testAddr string

func (a testAddr) Network() string { return "test" }
func (a testAddr) String() string  { return string(a) }

type scriptConn struct {
	reader        io.Reader
	writeFn       func([]byte) (int, error)
	deadlineErr   error
	written       []byte
	writes        int
	reads         int
	closed        bool
	deadline      time.Time
	deadlineCalls int
}

func (c *scriptConn) Read(p []byte) (int, error) { c.reads++; return c.reader.Read(p) }
func (c *scriptConn) Write(p []byte) (int, error) {
	c.writes++
	c.written = append(c.written, p...)
	if c.writeFn != nil {
		return c.writeFn(p)
	}
	return len(p), nil
}
func (c *scriptConn) Close() error                     { c.closed = true; return nil }
func (c *scriptConn) LocalAddr() net.Addr              { return testAddr("client") }
func (c *scriptConn) RemoteAddr() net.Addr             { return testAddr("server") }
func (c *scriptConn) SetReadDeadline(time.Time) error  { return nil }
func (c *scriptConn) SetWriteDeadline(time.Time) error { return nil }
func (c *scriptConn) SetDeadline(t time.Time) error {
	c.deadline = t
	c.deadlineCalls++
	return c.deadlineErr
}

func scriptedClient(response string) (rpcClient, *scriptConn, *int) {
	conn := &scriptConn{reader: strings.NewReader(response)}
	calls := new(int)
	client := rpcClient{
		timeout: 5 * time.Second,
		newID:   func() (string, error) { return testRequestID, nil },
		dial: func(context.Context, string) (net.Conn, error) {
			*calls++
			return conn, nil
		},
	}
	return client, conn, calls
}

func TestRPCRequestRawStringsAndSingleWrite(t *testing.T) {
	client, conn, dials := scriptedClient(successResponse(`{"id":"id","path":"raw","title":"title"}`) + "\r\n")
	params := map[string]string{"path": `C:relative\..\~/missing`, "title": "  title \t\n世界  "}
	result, err := client.call(context.Background(), "endpoint", "workspace.add", params)
	if err != nil {
		t.Fatal(err)
	}
	var request rpcRequest
	if err := json.Unmarshal(bytes.TrimSuffix(conn.written, []byte("\n")), &request); err != nil {
		t.Fatal(err)
	}
	if request.JSONRPC != "2.0" || request.ID != testRequestID || request.Method != "workspace.add" || request.Params["path"] != params["path"] || request.Params["title"] != params["title"] {
		t.Fatalf("request lost raw values: %#v", request)
	}
	if *dials != 1 || conn.writes != 1 || !conn.closed || conn.deadlineCalls != 1 || conn.deadline.IsZero() || len(result) == 0 {
		t.Fatalf("unexpected transport state: dials=%d conn=%#v", *dials, conn)
	}
}

func TestRPCEmptyParamsAreObject(t *testing.T) {
	client, conn, _ := scriptedClient(successResponse(`[]`) + "\n")
	if _, err := client.call(context.Background(), "endpoint", "workspace.list", nil); err != nil {
		t.Fatal(err)
	}
	var request map[string]json.RawMessage
	if err := json.Unmarshal(conn.written, &request); err != nil {
		t.Fatal(err)
	}
	if string(request["params"]) != "{}" {
		t.Fatalf("params is not an empty object: %s", request["params"])
	}
}

func TestRPCRequestLimitIncludesEncodingBytesNotTerminator(t *testing.T) {
	params := map[string]string{"path": ""}
	base, err := json.Marshal(rpcRequest{JSONRPC: "2.0", ID: testRequestID, Method: "workspace.add", Params: params})
	if err != nil {
		t.Fatal(err)
	}
	params["path"] = strings.Repeat("a", maxRequestLine-len(base))
	client, conn, dials := scriptedClient(successResponse(`null`) + "\n")
	if _, err := client.call(context.Background(), "endpoint", "workspace.add", params); err != nil {
		t.Fatalf("exact request limit: %v", err)
	}
	if len(conn.written) != maxRequestLine+1 || conn.written[len(conn.written)-1] != '\n' {
		t.Fatalf("request frame has %d bytes", len(conn.written))
	}
	params["path"] += "a"
	client, _, dials = scriptedClient("")
	_, err = client.call(context.Background(), "endpoint", "workspace.add", params)
	if err == nil || failureCode(t, err) != exitArgument || *dials != 0 {
		t.Fatalf("oversized request should fail before connecting: %v, dials=%d", err, *dials)
	}
	params["path"] = strings.Repeat("界", maxRequestLine/3)
	client, _, dials = scriptedClient("")
	_, err = client.call(context.Background(), "endpoint", "workspace.add", params)
	if err == nil || failureCode(t, err) != exitArgument || *dials != 0 {
		t.Fatalf("UTF-8 byte request limit: %v", err)
	}
}

func TestDecodeResponseValidation(t *testing.T) {
	valid := []string{
		successResponse(`null`), successResponse(`[]`), successResponse(`{"id":"business-id"}`),
		` {"jsonrpc":"2.0","id":"request-id","result":false} `,
	}
	for _, raw := range valid {
		if _, err := decodeResponse([]byte(raw), testRequestID); err != nil {
			t.Fatalf("valid response %s: %v", raw, err)
		}
	}
	invalid := []string{
		``, `not-json`, `{`, `null`, `[]`, `[ {"jsonrpc":"2.0","id":"request-id","result":null} ]`,
		`{"id":"request-id","result":null}`, `{"jsonrpc":2,"id":"request-id","result":null}`, `{"jsonrpc":"1.0","id":"request-id","result":null}`,
		`{"jsonrpc":"2.0","result":null}`, `{"jsonrpc":"2.0","id":null,"result":null}`, `{"jsonrpc":"2.0","id":1,"result":null}`,
		`{"jsonrpc":"2.0","id":"other","result":null}`, `{"jsonrpc":"2.0","id":"request-id"}`,
		`{"jsonrpc":"2.0","id":"request-id","result":null,"error":null}`,
		`{"jsonrpc":"2.0","id":"request-id","error":null}`, `{"jsonrpc":"2.0","id":"request-id","error":[]}`,
		`{"jsonrpc":"2.0","id":"request-id","error":{"message":"missing code"}}`,
		`{"jsonrpc":"2.0","id":"request-id","error":{"code":"1","message":"text"}}`,
		`{"jsonrpc":"2.0","id":"request-id","error":{"code":1.5,"message":"text"}}`,
		`{"jsonrpc":"2.0","id":"request-id","error":{"code":1,"message":null}}`,
		`{"jsonrpc":"2.0","id":"request-id","error":{"code":1}}`,
		`{"jsonrpc":"2.0","id":"request-id","error":{"code":1,"message":4}}`,
		`{"jsonrpc":"2.0","id":"request-id","error":{"code":9223372036854775808,"message":"text"}}`,
		`{"jsonrpc":"2.0","id":"request-id","id":"request-id","result":null}`,
		`{"jsonrpc":"2.0","id":"request-id","result":null,"result":null}`,
		`{"jsonrpc":"2.0","id":"request-id","error":{"code":1,"code":2,"message":"text"}}`,
		`{"jsonrpc":"2.0","id":"request-id","result":null} {}`, `{"jsonrpc":"2.0","id":"request-id","result":null} garbage`,
		`{"jsonrpc":"2.0","id":"request-id","result":null,}`,
	}
	for i, raw := range invalid {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			_, err := decodeResponse([]byte(raw), testRequestID)
			if err == nil || failureCode(t, err) != exitProtocol {
				t.Fatalf("accepted invalid response %s: %v", raw, err)
			}
		})
	}
	badUTF8 := []byte(successResponse(`"bad`))
	badUTF8 = append(badUTF8, 0xff)
	badUTF8 = append(badUTF8, '"', '}')
	if _, err := decodeResponse(badUTF8, testRequestID); err == nil || failureCode(t, err) != exitProtocol {
		t.Fatalf("invalid UTF-8: %v", err)
	}
}

func TestRemoteErrorAndStrictID(t *testing.T) {
	raw := `{"jsonrpc":"2.0","id":"request-id","error":{"code":-32001,"message":"missing workspace","data":{"id":"bad"}}}`
	_, err := decodeResponse([]byte(raw), testRequestID)
	if err == nil || failureCode(t, err) != exitRemote || !strings.Contains(err.Error(), "-32001") || !strings.Contains(err.Error(), `data: {"id":"bad"}`) {
		t.Fatalf("remote error was not preserved: %v", err)
	}
	_, err = decodeResponse([]byte(raw), "other")
	if err == nil || failureCode(t, err) != exitProtocol {
		t.Fatalf("remote error with mismatched ID must be protocol error: %v", err)
	}
	raw = `{"jsonrpc":"2.0","id":"request-id","error":{"code":-32603,"message":"","data":null}}`
	_, err = decodeResponse([]byte(raw), testRequestID)
	if err == nil || failureCode(t, err) != exitRemote {
		t.Fatalf("empty remote message is valid: %v", err)
	}
}

type byteReader struct{ io.Reader }

func (r byteReader) Read(p []byte) (int, error) {
	if len(p) > 1 {
		p = p[:1]
	}
	return r.Reader.Read(p)
}

func TestBoundedFramingFragmentationAndCRLF(t *testing.T) {
	for _, ending := range []string{"\n", "\r\n"} {
		line, err := readResponseLine(byteReader{strings.NewReader("12345678" + ending)}, 8)
		if err != nil || string(line) != "12345678" {
			t.Fatalf("exact line with %q: %q, %v", ending, line, err)
		}
	}
	for _, framed := range []string{"123456789\n", "123456789\r\n", "123456789", strings.Repeat("a", 16384)} {
		_, err := readResponseLine(strings.NewReader(framed), 8)
		if err == nil || failureCode(t, err) != exitProtocol {
			t.Fatalf("accepted oversized line %q: %v", framed[:min(len(framed), 20)], err)
		}
	}
	for _, incomplete := range []string{"", "1234", "12345678", "12345678\r"} {
		_, err := readResponseLine(strings.NewReader(incomplete), 8)
		if !errors.Is(err, io.ErrUnexpectedEOF) {
			t.Fatalf("incomplete line %q: %v", incomplete, err)
		}
	}
	line, err := readResponseLine(strings.NewReader("\n"), 8)
	if err != nil || len(line) != 0 {
		t.Fatalf("empty framed line: %q, %v", line, err)
	}
}

func TestActualEightMiBResponseBoundary(t *testing.T) {
	base := successResponse(`null`)
	client, _, _ := scriptedClient(base + strings.Repeat(" ", maxResponseLine-len(base)) + "\r\n")
	if result, err := client.call(context.Background(), "endpoint", "workspace.resolve", map[string]string{"path": "raw"}); err != nil || string(result) != "null" {
		t.Fatalf("exact 8 MiB response with CRLF: %s, %v", result, err)
	}
	client, _, dials := scriptedClient(base + strings.Repeat(" ", maxResponseLine-len(base)+1) + "\n")
	_, err := client.call(context.Background(), "endpoint", "workspace.resolve", map[string]string{"path": "raw"})
	if err == nil || failureCode(t, err) != exitProtocol || *dials != 1 {
		t.Fatalf("oversized response: %v, dials=%d", err, *dials)
	}
}

func TestTransportFailuresNeverRetry(t *testing.T) {
	for _, tc := range []struct {
		name     string
		response string
		write    func([]byte) (int, error)
		code     int
	}{
		{"disconnect", "", nil, exitIO},
		{"disconnect partial", `{"jsonrpc":"2.0"`, nil, exitIO},
		{"invalid response", "garbage\n", nil, exitProtocol},
		{"short write", "", func(p []byte) (int, error) { return len(p) / 2, nil }, exitIO},
		{"failed partial write", "", func(p []byte) (int, error) { return len(p) / 2, errors.New("connection lost") }, exitIO},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client, conn, dials := scriptedClient(tc.response)
			conn.writeFn = tc.write
			_, err := client.call(context.Background(), "endpoint", "workspace.remove", map[string]string{"id": "id"})
			if err == nil || failureCode(t, err) != tc.code || *dials != 1 || conn.writes != 1 {
				t.Fatalf("%v; dials=%d writes=%d", err, *dials, conn.writes)
			}
		})
	}
	client, conn, dials := scriptedClient("")
	conn.deadlineErr = errors.New("deadline unsupported")
	_, err := client.call(context.Background(), "endpoint", "workspace.move", map[string]string{"id": "id"})
	if err == nil || failureCode(t, err) != exitIO || *dials != 1 || conn.writes != 0 {
		t.Fatalf("deadline setup failure: %v", err)
	}
}

func TestTotalDeadlineIsSharedWithDialAndConnection(t *testing.T) {
	client, conn, _ := scriptedClient(successResponse(`null`) + "\n")
	var dialDeadline time.Time
	client.timeout = time.Second
	client.dial = func(ctx context.Context, endpoint string) (net.Conn, error) {
		dialDeadline, _ = ctx.Deadline()
		return conn, nil
	}
	if _, err := client.call(context.Background(), "endpoint", "workspace.resolve", nil); err != nil {
		t.Fatal(err)
	}
	if !conn.deadline.Equal(dialDeadline) {
		t.Fatalf("deadline reset after dial: dial=%s I/O=%s", dialDeadline, conn.deadline)
	}
}

func TestTimeoutsInDialWriteAndRead(t *testing.T) {
	t.Run("dial", func(t *testing.T) {
		calls := 0
		client := rpcClient{timeout: 25 * time.Millisecond, newID: func() (string, error) { return testRequestID, nil }, dial: func(ctx context.Context, endpoint string) (net.Conn, error) {
			calls++
			<-ctx.Done()
			return nil, ctx.Err()
		}}
		_, err := client.call(context.Background(), "endpoint", "workspace.remove", nil)
		if err == nil || failureCode(t, err) != exitTimeout || calls != 1 {
			t.Fatalf("dial timeout: %v, calls=%d", err, calls)
		}
	})
	for _, phase := range []string{"write", "read"} {
		t.Run(phase, func(t *testing.T) {
			local, peer := net.Pipe()
			defer peer.Close()
			done := make(chan struct{})
			if phase == "read" {
				go func() {
					_, _ = bufio.NewReader(peer).ReadBytes('\n')
					_, _ = io.Copy(io.Discard, peer)
					close(done)
				}()
			}
			calls := 0
			client := rpcClient{timeout: 30 * time.Millisecond, newID: func() (string, error) { return testRequestID, nil }, dial: func(context.Context, string) (net.Conn, error) { calls++; return local, nil }}
			_, err := client.call(context.Background(), "endpoint", "workspace.add", map[string]string{"path": "raw"})
			if err == nil || failureCode(t, err) != exitTimeout || calls != 1 {
				t.Fatalf("%s timeout: %v, calls=%d", phase, err, calls)
			}
			if phase == "read" {
				<-done
			}
		})
	}
}

func TestCancellationInterruptsConnectionWithoutRetry(t *testing.T) {
	local, peer := net.Pipe()
	defer peer.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		_, _ = bufio.NewReader(peer).ReadBytes('\n')
		cancel()
		_, _ = io.Copy(io.Discard, peer)
		close(done)
	}()
	calls := 0
	client := rpcClient{timeout: time.Second, newID: func() (string, error) { return testRequestID, nil }, dial: func(context.Context, string) (net.Conn, error) { calls++; return local, nil }}
	_, err := client.call(ctx, "endpoint", "workspace.add", map[string]string{"path": "raw"})
	if err == nil || failureCode(t, err) != exitIO || calls != 1 {
		t.Fatalf("cancelled call: %v, calls=%d", err, calls)
	}
	<-done
}

func TestUnrepresentableRequestValuesFailBeforeDial(t *testing.T) {
	invalid := string([]byte{'r', 'a', 'w', 0xff})
	for _, key := range []string{"path", "title", "id", "beforeId"} {
		client, conn, dials := scriptedClient("")
		_, err := client.call(context.Background(), "endpoint", "workspace.add", map[string]string{key: invalid})
		if err == nil || failureCode(t, err) != exitArgument || *dials != 0 || conn.writes != 0 {
			t.Fatalf("unencodable %s: %v, dials=%d writes=%d", key, err, *dials, conn.writes)
		}
	}
	client, conn, dials := scriptedClient(successResponse(`null`) + "\n")
	raw := "~/unchanged/../raw\x00path"
	if _, err := client.call(context.Background(), "endpoint", "workspace.resolve", map[string]string{"path": raw}); err != nil {
		t.Fatalf("NUL is representable JSON and belongs to server business validation: %v", err)
	}
	var request rpcRequest
	if err := json.Unmarshal(conn.written, &request); err != nil || request.Params["path"] != raw || *dials != 1 {
		t.Fatalf("representable path was changed: %#v, %v", request, err)
	}
}

func TestUUIDRequestIDs(t *testing.T) {
	pattern := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	seen := make(map[string]bool)
	for i := 0; i < 100; i++ {
		id, err := newRequestID()
		if err != nil || !pattern.MatchString(id) || seen[id] {
			t.Fatalf("UUID %q: %v", id, err)
		}
		seen[id] = true
	}
}
