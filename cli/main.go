package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
)

var version = "0.1.0"

const (
	exitSuccess  = 0
	exitRemote   = 1
	exitArgument = 2
	exitIO       = 3
	exitTimeout  = 4
	exitProtocol = 5
)

type failure struct {
	code    int
	message string
}

func (f *failure) Error() string { return f.message }

func argumentError(format string, args ...any) error {
	return &failure{code: exitArgument, message: fmt.Sprintf(format, args...)}
}

func protocolError(format string, args ...any) error {
	return &failure{code: exitProtocol, message: fmt.Sprintf(format, args...)}
}

type dependencies struct {
	resolver endpointResolver
	dial     dialFunc
	newID    func() (string, error)
}

func nativeDependencies() dependencies {
	return dependencies{resolver: nativeEndpointResolver(), dial: dialLocal, newID: newRequestID}
}

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	var signalExit atomic.Int32
	go func() {
		select {
		case sig := <-signals:
			code := int32(130)
			if sig == syscall.SIGTERM {
				code = 143
			}
			signalExit.Store(code)
			cancel()
		case <-ctx.Done():
		}
	}()
	code := run(ctx, os.Args[1:], os.Stdout, os.Stderr, nativeDependencies())
	signal.Stop(signals)
	cancel()
	if interrupted := signalExit.Load(); interrupted != 0 {
		code = int(interrupted)
	}
	os.Exit(code)
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer, deps dependencies) int {
	in, err := parseArgs(args, deps.resolver.goos)
	if err != nil {
		return reportFailure(stderr, err)
	}
	if in.help {
		return writeOutput(stdout, stderr, []byte(helpText(deps.resolver.goos)))
	}
	if in.version {
		return writeOutput(stdout, stderr, []byte("dsh-workspace "+version+"\n"))
	}
	endpoint, err := deps.resolver.resolve(in)
	if err != nil {
		return reportFailure(stderr, err)
	}
	if in.command == "endpoint" {
		output, err := formatEndpoint(endpoint, in.json)
		if err != nil {
			return reportFailure(stderr, err)
		}
		return writeOutput(stdout, stderr, output)
	}
	method, params := in.request()
	client := rpcClient{dial: deps.dial, newID: deps.newID, timeout: in.timeout}
	result, err := client.call(ctx, endpoint, method, params)
	if err != nil {
		return reportFailure(stderr, err)
	}
	output, err := formatResult(in.command, result, in.json)
	if err != nil {
		return reportFailure(stderr, err)
	}
	return writeOutput(stdout, stderr, output)
}

func reportFailure(stderr io.Writer, err error) int {
	code := exitIO
	var f *failure
	if errors.As(err, &f) {
		code = f.code
	}
	_, _ = fmt.Fprintf(stderr, "dsh-workspace: %s\n", err)
	return code
}

func writeOutput(stdout, stderr io.Writer, output []byte) int {
	n, err := stdout.Write(output)
	if err == nil && n != len(output) {
		err = io.ErrShortWrite
	}
	if err != nil {
		return reportFailure(stderr, &failure{code: exitIO, message: "cannot write stdout: " + err.Error()})
	}
	return exitSuccess
}

func helpText(goos string) string {
	alias := "  --socket <path>       Unix alias for --endpoint\n"
	if goos == "windows" {
		alias = "  --pipe <full-pipe>    Windows alias for --endpoint (full local pipe required)\n"
	}
	return `dsh-workspace - native local IPC client

Usage:
  dsh-workspace [options] add <path> [--title <title>]
  dsh-workspace [options] list
  dsh-workspace [options] get <id>
  dsh-workspace [options] rename <id> <title>
  dsh-workspace [options] remove <id>            (aliases: delete, rm)
  dsh-workspace [options] move <id> [--before <id>]
  dsh-workspace [options] resolve <path>
  dsh-workspace [options] status <id>
  dsh-workspace [options] ping
  dsh-workspace [options] endpoint               (offline; never connects)

Options (anywhere before a standalone --):
  --json                Print successful results as JSON
  --timeout <ms>        Positive integer milliseconds; default 5000
  --dshHome <home>      DSH home (alias: --dsh-home)
  --endpoint <endpoint> Override the local socket/full local Windows pipe
` + alias + `  --help, -h            Show help
  --version, -v         Show version

Business paths and titles are sent unchanged. Use -- for values beginning
with -. The client never launches DSH, searches profiles, or retries a request.
Only endpoint/home configuration is normalized. Whitespace-only environment
values are ignored. Unix endpoint env: DSH_WORKSPACE_SOCKET; Windows:
DSH_WORKSPACE_PIPE. Otherwise use explicit home, DSH_HOME, or ~/.dsh.
Windows endpoint overrides must use \\.\pipe\NAME; remote pipes are rejected.

Exit codes: 0 success, 1 remote error, 2 arguments/configuration, 3 connection/I/O,
4 timeout, 5 invalid protocol; supported interrupt/termination signals: 130/143.
`
}
