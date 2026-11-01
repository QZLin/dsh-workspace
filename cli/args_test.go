package main

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

func failureCode(t *testing.T, err error) int {
	t.Helper()
	var f *failure
	if !errors.As(err, &f) {
		t.Fatalf("expected CLI failure, got %v", err)
	}
	return f.code
}

func TestCommandsAndRawBusinessArguments(t *testing.T) {
	cases := []struct {
		name   string
		args   []string
		method string
		params map[string]string
	}{
		{"add relative", []string{"add", "./does-not-exist/../raw"}, "workspace.add", map[string]string{"path": "./does-not-exist/../raw"}},
		{"add tilde", []string{"add", "~/raw", "--title", "  padded title \t\n"}, "workspace.add", map[string]string{"path": "~/raw", "title": "  padded title \t\n"}},
		{"add drive relative", []string{"--title=  世界  ", "add", `C:relative\..\missing`}, "workspace.add", map[string]string{"path": `C:relative\..\missing`, "title": "  世界  "}},
		{"add blank business strings", []string{"add", "", "--title="}, "workspace.add", map[string]string{"path": "", "title": ""}},
		{"add whitespace", []string{"add", " \t\n "}, "workspace.add", map[string]string{"path": " \t\n "}},
		{"add dash path", []string{"add", "--", "--json"}, "workspace.add", map[string]string{"path": "--json"}},
		{"add single dash", []string{"add", "-"}, "workspace.add", map[string]string{"path": "-"}},
		{"list", []string{"list"}, "workspace.list", map[string]string{}},
		{"get", []string{"get", "  id  "}, "workspace.get", map[string]string{"id": "  id  "}},
		{"rename whitespace", []string{"rename", "id", "  title  "}, "workspace.rename", map[string]string{"id": "id", "title": "  title  "}},
		{"rename terminator", []string{"rename", "id", "--", "--timeout"}, "workspace.rename", map[string]string{"id": "id", "title": "--timeout"}},
		{"remove", []string{"remove", "id"}, "workspace.remove", map[string]string{"id": "id"}},
		{"delete alias", []string{"delete", "id"}, "workspace.remove", map[string]string{"id": "id"}},
		{"rm alias", []string{"rm", "id"}, "workspace.remove", map[string]string{"id": "id"}},
		{"move end", []string{"move", "id"}, "workspace.move", map[string]string{"id": "id"}},
		{"move before", []string{"--before", " next ", "move", "id"}, "workspace.move", map[string]string{"id": "id", "beforeId": " next "}},
		{"move empty before", []string{"move", "id", "--before="}, "workspace.move", map[string]string{"id": "id", "beforeId": ""}},
		{"resolve raw", []string{"resolve", `~\nonexistent\..\raw`}, "workspace.resolve", map[string]string{"path": `~\nonexistent\..\raw`}},
		{"status", []string{"status", "id"}, "workspace.status", map[string]string{"id": "id"}},
		{"ping", []string{"ping"}, "workspace.ping", map[string]string{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in, err := parseArgs(tc.args, "windows")
			if err != nil {
				t.Fatal(err)
			}
			method, params := in.request()
			if method != tc.method || !reflect.DeepEqual(params, tc.params) {
				t.Fatalf("got %s %#v, want %s %#v", method, params, tc.method, tc.params)
			}
		})
	}
}

func TestGlobalOptionsAnywhereAndAliases(t *testing.T) {
	args := []string{"--timeout", "0123", "--json", "--dsh-home", "  ./home  ", "add", "--endpoint=\\\\.\\pipe\\custom", "raw", "--title", "  title  "}
	in, err := parseArgs(args, "windows")
	if err != nil {
		t.Fatal(err)
	}
	if !in.json || in.timeout != 123*time.Millisecond || *in.dshHome != "  ./home  " || *in.endpoint != `\\.\pipe\custom` || *in.title != "  title  " {
		t.Fatalf("unexpected options: %#v", in)
	}
	for _, tc := range []struct{ goos, flag string }{{"windows", "--pipe"}, {"linux", "--socket"}, {"darwin", "--socket"}} {
		in, err := parseArgs([]string{"endpoint", tc.flag, "value", "--dshHome=home"}, tc.goos)
		if err != nil || in.endpoint == nil || *in.endpoint != "value" || *in.dshHome != "home" {
			t.Fatalf("%s %s: %#v, %v", tc.goos, tc.flag, in, err)
		}
	}
}

func TestArgumentErrors(t *testing.T) {
	cases := [][]string{
		{}, {"unknown"}, {"add"}, {"add", "a", "b"}, {"list", "extra"}, {"rename", "id"}, {"rename", "id", "title", "extra"},
		{"get"}, {"remove"}, {"move"}, {"resolve"}, {"status"}, {"ping", "extra"}, {"endpoint", "extra"},
		{"list", "--title", "title"}, {"add", "path", "--before", "id"}, {"move", "id", "--title", "title"},
		{"add", "--unknown"}, {"add", "path", "--title"}, {"ping", "--timeout"}, {"endpoint", "--endpoint"},
		{"endpoint", "--endpoint="}, {"endpoint", "--endpoint", " \t"}, {"endpoint", "--dshHome="}, {"endpoint", "--dsh-home", "\n"},
		{"list", "--json=true"}, {"-h=1"}, {"--version=false"}, {"add", "path", "--", "--json"},
		{"ping", "--timeout", "0"}, {"ping", "--timeout", "-1"}, {"ping", "--timeout", "1ms"}, {"ping", "--timeout", "1.5"},
		{"ping", "--timeout", " 1"}, {"ping", "--timeout", "+1"}, {"ping", "--timeout", "9223372036855"},
	}
	for _, args := range cases {
		t.Run(reflect.ValueOf(args).String()+joinTestArgs(args), func(t *testing.T) {
			_, err := parseArgs(args, "windows")
			if err == nil || failureCode(t, err) != exitArgument {
				t.Fatalf("%q: expected argument failure, got %v", args, err)
			}
		})
	}
	for _, tc := range []struct{ goos, alias string }{{"windows", "--socket"}, {"linux", "--pipe"}} {
		_, err := parseArgs([]string{"endpoint", tc.alias, "value"}, tc.goos)
		if err == nil || failureCode(t, err) != exitArgument {
			t.Fatalf("%s %s: %v", tc.goos, tc.alias, err)
		}
	}
}

func joinTestArgs(args []string) string {
	name := ""
	for _, arg := range args {
		name += "/" + arg
	}
	return name
}

func TestTimeoutAndMetadataOptions(t *testing.T) {
	in, err := parseArgs([]string{"ping"}, "linux")
	if err != nil || in.timeout != 5*time.Second {
		t.Fatalf("default timeout: %v, %v", in.timeout, err)
	}
	for _, arg := range []string{"1", "0005", "5000", "9223372036854"} {
		if _, err := parseTimeout(arg); err != nil {
			t.Fatalf("valid timeout %s: %v", arg, err)
		}
	}
	for _, arg := range []string{"", "0", "-1", "+1", "1ms", "1.0", "1e3", " 5 ", "99999999999999999999999"} {
		if _, err := parseTimeout(arg); err == nil {
			t.Fatalf("accepted invalid timeout %q", arg)
		}
	}
	for _, args := range [][]string{{"--help"}, {"-h"}, {"add", "--help"}, {"--version"}, {"-v"}, {"get", "--version"}} {
		in, err := parseArgs(args, "linux")
		if err != nil || (!in.help && !in.version) {
			t.Fatalf("%v: %#v, %v", args, in, err)
		}
	}
}
