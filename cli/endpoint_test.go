package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func strptr(value string) *string { return &value }

func unixResolver(env map[string]string) endpointResolver {
	return endpointResolver{
		goos: "linux",
		lookupEnv: func(name string) (string, bool) {
			value, ok := env[name]
			return value, ok
		},
		userHomeDir: func() (string, error) { return "/users/Tester", nil },
		absPath: func(value string) (string, error) {
			if path.IsAbs(value) {
				return path.Clean(value), nil
			}
			return path.Join("/cwd", value), nil
		},
		joinPath: path.Join,
	}
}

func TestUnixEndpointPrecedenceAndConfigurationOnlyNormalization(t *testing.T) {
	cases := []struct {
		name string
		in   invocation
		env  map[string]string
		want string
	}{
		{"default", invocation{}, nil, "/users/Tester/.dsh/.dsh-workspace.sock"},
		{"blank env", invocation{}, map[string]string{"DSH_HOME": " \t\n", "DSH_WORKSPACE_SOCKET": "\t"}, "/users/Tester/.dsh/.dsh-workspace.sock"},
		{"home env", invocation{}, map[string]string{"DSH_HOME": "relative/../home"}, "/cwd/home/.dsh-workspace.sock"},
		{"explicit home", invocation{dshHome: strptr("./explicit/../home")}, map[string]string{"DSH_HOME": "/ignored"}, "/cwd/home/.dsh-workspace.sock"},
		{"tilde home", invocation{dshHome: strptr("~/profile/../home")}, nil, "/users/Tester/home/.dsh-workspace.sock"},
		{"bare tilde", invocation{dshHome: strptr("~")}, nil, "/users/Tester/.dsh-workspace.sock"},
		{"backslash tilde", invocation{dshHome: strptr(`~\home`)}, nil, "/users/Tester/home/.dsh-workspace.sock"},
		{"tilde env", invocation{}, map[string]string{"DSH_HOME": "~/env"}, "/users/Tester/env/.dsh-workspace.sock"},
		{"nonleading tilde literal", invocation{dshHome: strptr("~other/home")}, nil, "/cwd/~other/home/.dsh-workspace.sock"},
		{"preserve home spaces", invocation{dshHome: strptr("  home  ")}, nil, "/cwd/  home  /.dsh-workspace.sock"},
		{"socket env beats home", invocation{dshHome: strptr("/ignored")}, map[string]string{"DSH_WORKSPACE_SOCKET": "./env.sock"}, "/cwd/env.sock"},
		{"explicit endpoint beats env", invocation{endpoint: strptr("./dir/../chosen.sock")}, map[string]string{"DSH_WORKSPACE_SOCKET": "/ignored.sock", "DSH_HOME": "/ignored"}, "/cwd/chosen.sock"},
		{"tilde endpoint", invocation{endpoint: strptr("~/chosen.sock")}, nil, "/users/Tester/chosen.sock"},
		{"tilde socket env", invocation{}, map[string]string{"DSH_WORKSPACE_SOCKET": `~\chosen.sock`}, "/users/Tester/chosen.sock"},
		{"preserve socket spaces", invocation{endpoint: strptr("  socket  ")}, nil, "/cwd/  socket  "},
		{"opposite OS env ignored", invocation{}, map[string]string{"DSH_WORKSPACE_PIPE": `\\server\pipe\remote`}, "/users/Tester/.dsh/.dsh-workspace.sock"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := unixResolver(tc.env).resolve(tc.in)
			if err != nil || got != tc.want {
				t.Fatalf("got %q, %v; want %q", got, err, tc.want)
			}
		})
	}
}

func TestWindowsHomeIdentityAndEndpointHash(t *testing.T) {
	cases := []struct{ home, identity string }{
		{`C:\Users\Alice\.DSH\\\`, `c:\users\alice\.dsh`},
		{`C:/Users/Alice/.DSH///`, `c:\users\alice\.dsh`},
		{`C:\`, "c:"},
		{`\\Server\SHARE\\\`, `\\server\share`},
		{`C:\ÄΣİK\HOME\\`, `c:\ÄΣİk\home`},
	}
	for _, tc := range cases {
		if got := windowsHomeIdentity(tc.home); got != tc.identity {
			t.Fatalf("identity(%q) = %q, want %q", tc.home, got, tc.identity)
		}
		r := unixResolver(nil)
		r.goos = "windows"
		r.absPath = func(value string) (string, error) { return value, nil }
		got, err := r.resolve(invocation{dshHome: strptr(tc.home)})
		digest := sha256.Sum256([]byte(tc.identity))
		want := windowsPipePrefix + "dsh-workspace-" + hex.EncodeToString(digest[:])[:24]
		if err != nil || got != want {
			t.Fatalf("hash(%q) = %q, %v; want %q", tc.home, got, err, want)
		}
	}
}

func TestWindowsPipeOverridesAreLocalFullNames(t *testing.T) {
	r := unixResolver(map[string]string{"DSH_WORKSPACE_PIPE": `\\.\pipe\from-env`, "DSH_WORKSPACE_SOCKET": "/ignored"})
	r.goos = "windows"
	if got, err := r.resolve(invocation{dshHome: strptr("ignored")}); err != nil || got != `\\.\pipe\from-env` {
		t.Fatalf("env override: %q, %v", got, err)
	}
	for _, endpoint := range []string{`\\.\pipe\local`, `\\.\PIPE\MiXeD`, `\\.\pipe\  spaces  `, `\\.\pipe\ `} {
		got, err := r.resolve(invocation{endpoint: strptr(endpoint)})
		if err != nil || got != endpoint {
			t.Fatalf("valid pipe %q: %q, %v", endpoint, got, err)
		}
	}
	for _, endpoint := range []string{"", " ", "bare-name", `\\server\pipe\remote`, `\\localhost\pipe\remote`, `\\?\pipe\name`, `//./pipe/name`, `\\.\pipe\`, `\\.\pipe\nested\name`, `\\.\pipe\slash/name`, "\\\\.\\pipe\\nul\x00"} {
		_, err := r.resolve(invocation{endpoint: strptr(endpoint)})
		if err == nil || failureCode(t, err) != exitArgument {
			t.Fatalf("accepted invalid pipe %q: %v", endpoint, err)
		}
	}
}

func TestEndpointErrorsDoNotFallbackOrDiscoverHomes(t *testing.T) {
	r := unixResolver(map[string]string{"DSH_WORKSPACE_SOCKET": "/env.sock"})
	r.userHomeDir = func() (string, error) { t.Fatal("unexpected home lookup"); return "", nil }
	if got, err := r.resolve(invocation{endpoint: strptr("/explicit.sock")}); err != nil || got != "/explicit.sock" {
		t.Fatalf("explicit override: %q, %v", got, err)
	}
	if got, err := r.resolve(invocation{}); err != nil || got != "/env.sock" {
		t.Fatalf("env override: %q, %v", got, err)
	}
	r = unixResolver(nil)
	r.absPath = func(string) (string, error) { return "", errors.New("cannot determine working directory") }
	_, err := r.resolve(invocation{dshHome: strptr("relative")})
	if err == nil || failureCode(t, err) != exitArgument {
		t.Fatalf("abs error: %v", err)
	}
	r = unixResolver(nil)
	r.userHomeDir = func() (string, error) { return "", errors.New("home unavailable") }
	_, err = r.resolve(invocation{})
	if err == nil || failureCode(t, err) != exitArgument {
		t.Fatalf("missing default home: %v", err)
	}
	_, err = r.resolve(invocation{dshHome: strptr("~/required")})
	if err == nil || failureCode(t, err) != exitArgument {
		t.Fatalf("failed tilde expansion: %v", err)
	}
}

func TestUnixSocketByteLimitsAndNUL(t *testing.T) {
	for _, goos := range []string{"linux", "darwin", "freebsd", "openbsd", "netbsd", "solaris"} {
		r := unixResolver(nil)
		r.goos = goos
		limit := 103
		if goos == "linux" {
			limit = 107
		}
		endpoint := "/" + strings.Repeat("a", limit-1)
		if got, err := r.resolve(invocation{endpoint: strptr(endpoint)}); err != nil || got != endpoint {
			t.Fatalf("exact socket limit: %q, %v", got, err)
		}
		for _, endpoint := range []string{endpoint + "a", "/" + strings.Repeat("界", 36), "/socket\x00bad"} {
			_, err := r.resolve(invocation{endpoint: strptr(endpoint)})
			if err == nil || failureCode(t, err) != exitArgument {
				t.Fatalf("accepted invalid %s socket %q: %v", goos, endpoint, err)
			}
		}
	}
}

func TestChosenHomeNULRejectedBeforeResolution(t *testing.T) {
	for _, goos := range []string{"windows", "linux", "darwin", "freebsd"} {
		for _, source := range []string{"explicit", "env", "expanded", "default"} {
			t.Run(goos+"/"+source, func(t *testing.T) {
				r := unixResolver(nil)
				r.goos = goos
				r.absPath = func(string) (string, error) { t.Fatal("NUL home reached absolute path resolution"); return "", nil }
				var in invocation
				switch source {
				case "explicit":
					in.dshHome = strptr("chosen\x00home")
				case "env":
					r.lookupEnv = func(name string) (string, bool) { return "chosen\x00home", name == "DSH_HOME" }
				case "expanded":
					in.dshHome = strptr("~")
					r.userHomeDir = func() (string, error) { return "/user\x00home", nil }
				case "default":
					r.userHomeDir = func() (string, error) { return "/user\x00home", nil }
				}
				_, err := r.resolve(in)
				if err == nil || failureCode(t, err) != exitArgument {
					t.Fatalf("NUL home: %v", err)
				}
			})
		}
	}
}

func TestNativeHomeCleaningMatchesPlatform(t *testing.T) {
	r := nativeEndpointResolver()
	r.lookupEnv = func(string) (string, bool) { return "", false }
	home := filepath.Join(t.TempDir(), "nonexistent", "..", "home")
	absolute, err := filepath.Abs(home)
	if err != nil {
		t.Fatal(err)
	}
	got, err := r.resolve(invocation{dshHome: strptr(home)})
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(absolute, ".dsh-workspace.sock")
	if runtime.GOOS == "windows" {
		digest := sha256.Sum256([]byte(windowsHomeIdentity(absolute)))
		want = windowsPipePrefix + "dsh-workspace-" + hex.EncodeToString(digest[:])[:24]
	}
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}
