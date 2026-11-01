package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"time"
	"unicode/utf8"
)

const (
	maxRequestLine  = 64 * 1024
	maxResponseLine = 8 * 1024 * 1024
)

type dialFunc func(context.Context, string) (net.Conn, error)

type rpcClient struct {
	dial    dialFunc
	newID   func() (string, error)
	timeout time.Duration
}

type rpcRequest struct {
	JSONRPC string            `json:"jsonrpc"`
	ID      string            `json:"id"`
	Method  string            `json:"method"`
	Params  map[string]string `json:"params"`
}

// call makes exactly one connection and writes exactly one request. There is
// no fallback endpoint, retry, reconnect, or request replay, even on a partial
// write, timeout, or disconnect after a mutation.
func (c rpcClient) call(parent context.Context, endpoint, method string, params map[string]string) (json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(parent, c.timeout)
	defer cancel()
	id, err := c.newID()
	if err != nil {
		return nil, ioFailure(ctx, "cannot generate request ID", err)
	}
	if params == nil {
		params = make(map[string]string)
	}
	// JSON is a UTF-8 transport. encoding/json would silently replace invalid
	// bytes, which could change a raw path/title before a mutation. Reject only
	// unrepresentable wire strings; do not inspect or validate business paths.
	for key, value := range params {
		if !utf8.ValidString(key) || !utf8.ValidString(value) {
			return nil, argumentError("request parameter %q cannot be encoded losslessly as UTF-8 JSON", key)
		}
	}
	request, err := json.Marshal(rpcRequest{JSONRPC: "2.0", ID: id, Method: method, Params: params})
	if err != nil {
		return nil, argumentError("cannot encode request: %v", err)
	}
	// Limits count UTF-8 JSON bytes, excluding the LF/optional CR terminator.
	if len(request) > maxRequestLine {
		return nil, argumentError("request exceeds the %d-byte JSON line limit", maxRequestLine)
	}
	if err := ctx.Err(); err != nil {
		return nil, ioFailure(ctx, "request cancelled before connecting", err)
	}
	conn, err := c.dial(ctx, endpoint)
	if err != nil {
		return nil, ioFailure(ctx, "cannot connect to local endpoint", err)
	}
	if conn == nil {
		return nil, ioFailure(ctx, "cannot connect to local endpoint", errors.New("dial returned no connection"))
	}
	defer conn.Close()
	// The same absolute deadline covers dial, write, and read. Closing on
	// cancellation also interrupts I/O implementations that ignore deadlines.
	stopClose := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stopClose()
	deadline, _ := ctx.Deadline()
	if err := conn.SetDeadline(deadline); err != nil {
		return nil, ioFailure(ctx, "cannot set request deadline", err)
	}
	request = append(request, '\n')
	n, err := conn.Write(request)
	if err != nil {
		return nil, ioFailure(ctx, "cannot write request (not retried)", err)
	}
	if n != len(request) {
		return nil, ioFailure(ctx, "incomplete request write (not retried)", io.ErrShortWrite)
	}
	line, err := readResponseLine(conn, maxResponseLine)
	if err != nil {
		var f *failure
		if errors.As(err, &f) {
			return nil, err
		}
		return nil, ioFailure(ctx, "cannot read a complete response", err)
	}
	if err := ctx.Err(); err != nil {
		return nil, ioFailure(ctx, "request deadline or cancellation reached", err)
	}
	result, err := decodeResponse(line, id)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, ioFailure(ctx, "request deadline or cancellation reached", err)
	}
	return result, nil
}

func newRequestID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

func ioFailure(ctx context.Context, operation string, err error) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return &failure{code: exitTimeout, message: operation + ": request timed out"}
	}
	var timeout net.Error
	if errors.As(err, &timeout) && timeout.Timeout() {
		return &failure{code: exitTimeout, message: operation + ": request timed out"}
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		return &failure{code: exitIO, message: operation + ": request cancelled"}
	}
	return &failure{code: exitIO, message: fmt.Sprintf("%s: %v", operation, err)}
}

// readResponseLine allows fragmented messages and LF or CRLF, while bounding
// memory even when a peer sends an oversized line without a terminator.
func readResponseLine(reader io.Reader, limit int) ([]byte, error) {
	buffered := bufio.NewReaderSize(reader, 4096)
	var line []byte
	for {
		fragment, err := buffered.ReadSlice('\n')
		line = append(line, fragment...)
		if len(line) > limit+2 {
			return nil, protocolError("response exceeds the %d-byte JSON line limit", limit)
		}
		if len(line) > 0 && line[len(line)-1] == '\n' {
			line = line[:len(line)-1]
			if len(line) > 0 && line[len(line)-1] == '\r' {
				line = line[:len(line)-1]
			}
			if len(line) > limit {
				return nil, protocolError("response exceeds the %d-byte JSON line limit", limit)
			}
			return line, nil
		}
		if len(line) > limit+1 || (len(line) == limit+1 && line[len(line)-1] != '\r') {
			return nil, protocolError("response exceeds the %d-byte JSON line limit", limit)
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil, io.ErrUnexpectedEOF
			}
			return nil, err
		}
	}
}

func decodeResponse(line []byte, requestID string) (json.RawMessage, error) {
	if !utf8.Valid(line) {
		return nil, protocolError("response is not valid UTF-8")
	}
	fields, err := decodeObject(line)
	if err != nil {
		return nil, protocolError("invalid JSON-RPC response: %v", err)
	}
	var version string
	if raw, ok := fields["jsonrpc"]; !ok || json.Unmarshal(raw, &version) != nil || version != "2.0" {
		return nil, protocolError("response jsonrpc must be exactly the string 2.0")
	}
	var id string
	if raw, ok := fields["id"]; !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &id) != nil || id != requestID {
		return nil, protocolError("response ID does not exactly match the request string ID")
	}
	result, hasResult := fields["result"]
	rawError, hasError := fields["error"]
	if hasResult == hasError {
		return nil, protocolError("response must contain exactly one of result or error")
	}
	if hasResult {
		return result, nil
	}
	errFields, err := decodeObject(rawError)
	if err != nil {
		return nil, protocolError("response error must be an object: %v", err)
	}
	var message string
	if raw, ok := errFields["message"]; !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &message) != nil {
		return nil, protocolError("response error message must be a string")
	}
	codeRaw, ok := errFields["code"]
	if !ok {
		return nil, protocolError("response error code must be an integer")
	}
	code, err := strconv.ParseInt(string(bytes.TrimSpace(codeRaw)), 10, 64)
	if err != nil {
		return nil, protocolError("response error code must be an integer")
	}
	diagnostic := fmt.Sprintf("remote error %d: %s", code, message)
	if data, ok := errFields["data"]; ok {
		var compact bytes.Buffer
		if err := json.Compact(&compact, data); err == nil {
			diagnostic += " (data: " + compact.String() + ")"
		}
	}
	return nil, &failure{code: exitRemote, message: diagnostic}
}

// JSON permits duplicate keys syntactically, but ambiguous envelopes are not
// safe to correlate. Reject duplicate object members instead of last-key wins.
func decodeObject(raw []byte) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return nil, errors.New("expected one JSON object")
	}
	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, ok := token.(string)
		if !ok {
			return nil, errors.New("object key is not a string")
		}
		if _, exists := fields[key]; exists {
			return nil, fmt.Errorf("duplicate object member %q", key)
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		fields[key] = value
	}
	end, err := decoder.Token()
	if err != nil || end != json.Delim('}') {
		return nil, errors.New("unterminated JSON object")
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return nil, errors.New("extra or malformed data after JSON object")
	}
	return fields, nil
}
