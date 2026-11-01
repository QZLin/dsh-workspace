package main

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

const defaultTimeout = 5000 * time.Millisecond

type invocation struct {
	command  string
	args     []string
	title    *string
	beforeID *string
	dshHome  *string
	endpoint *string
	timeout  time.Duration
	json     bool
	help     bool
	version  bool
}

// parseArgs deliberately does not clean, trim, expand, stat, or otherwise
// interpret positional arguments, titles, or before IDs. The server owns all
// business validation. Options may occur anywhere, until a standalone --.
func parseArgs(args []string, goos string) (invocation, error) {
	in := invocation{timeout: defaultTimeout}
	var positional []string
	options := true
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if options && arg == "--" {
			options = false
			continue
		}
		if !options || arg == "-" || !strings.HasPrefix(arg, "-") {
			positional = append(positional, arg)
			continue
		}
		name, value, inline := strings.Cut(arg, "=")
		takeValue := func() (string, error) {
			if inline {
				return value, nil
			}
			if i+1 >= len(args) {
				return "", argumentError("%s requires a value", name)
			}
			i++
			return args[i], nil
		}
		switch name {
		case "--help", "-h", "--version", "-v", "--json":
			if inline {
				return in, argumentError("%s does not take a value", name)
			}
			switch name {
			case "--help", "-h":
				in.help = true
			case "--version", "-v":
				in.version = true
			case "--json":
				in.json = true
			}
		case "--title", "--before", "--dshHome", "--dsh-home", "--endpoint", "--pipe", "--socket", "--timeout":
			if name == "--pipe" && goos != "windows" {
				return in, argumentError("--pipe is available only on Windows; use --endpoint or --socket")
			}
			if name == "--socket" && goos == "windows" {
				return in, argumentError("--socket is unavailable on Windows; use --endpoint or --pipe")
			}
			v, err := takeValue()
			if err != nil {
				return in, err
			}
			switch name {
			case "--title":
				in.title = &v
			case "--before":
				in.beforeID = &v
			case "--dshHome", "--dsh-home":
				if strings.TrimSpace(v) == "" {
					return in, argumentError("%s must not be blank", name)
				}
				in.dshHome = &v
			case "--endpoint", "--pipe", "--socket":
				if strings.TrimSpace(v) == "" {
					return in, argumentError("%s must not be blank", name)
				}
				in.endpoint = &v
			case "--timeout":
				in.timeout, err = parseTimeout(v)
				if err != nil {
					return in, err
				}
			}
		default:
			return in, argumentError("unknown option %q (use -- before a value beginning with -)", name)
		}
	}
	if in.help || in.version {
		return in, nil
	}
	if len(positional) == 0 {
		return in, argumentError("missing command (use --help for usage)")
	}
	in.command, in.args = positional[0], positional[1:]
	if in.command == "delete" || in.command == "rm" {
		in.command = "remove"
	}
	want := 0
	switch in.command {
	case "add", "get", "remove", "move", "resolve", "status":
		want = 1
	case "rename":
		want = 2
	case "list", "ping", "endpoint":
	default:
		return in, argumentError("unknown command %q (use --help for usage)", in.command)
	}
	if len(in.args) != want {
		return in, argumentError("%s expects %d positional argument(s), got %d", in.command, want, len(in.args))
	}
	if in.title != nil && in.command != "add" {
		return in, argumentError("--title is valid only with add")
	}
	if in.beforeID != nil && in.command != "move" {
		return in, argumentError("--before is valid only with move")
	}
	return in, nil
}

func parseTimeout(value string) (time.Duration, error) {
	// Milliseconds are parsed here, not by a shell or time.ParseDuration. Reject
	// signs, suffixes, whitespace, zero, and durations that overflow int64.
	if value == "" {
		return 0, argumentError("--timeout requires a positive integer in milliseconds")
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return 0, argumentError("--timeout requires a positive integer in milliseconds")
		}
	}
	ms, err := strconv.ParseInt(value, 10, 64)
	if err != nil || ms <= 0 || ms > int64((1<<63-1)/time.Millisecond) {
		return 0, argumentError("--timeout must be positive milliseconds within the supported duration range")
	}
	return time.Duration(ms) * time.Millisecond, nil
}

func (in invocation) request() (string, map[string]string) {
	params := make(map[string]string)
	switch in.command {
	case "add", "resolve":
		params["path"] = in.args[0]
		if in.title != nil {
			params["title"] = *in.title
		}
	case "get", "remove", "status":
		params["id"] = in.args[0]
	case "rename":
		params["id"], params["title"] = in.args[0], in.args[1]
	case "move":
		params["id"] = in.args[0]
		if in.beforeID != nil {
			params["beforeId"] = *in.beforeID
		}
	}
	return fmt.Sprintf("workspace.%s", in.command), params
}
