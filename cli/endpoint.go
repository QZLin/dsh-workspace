package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const windowsPipePrefix = `\\.\pipe\`

type endpointResolver struct {
	goos        string
	lookupEnv   func(string) (string, bool)
	userHomeDir func() (string, error)
	absPath     func(string) (string, error)
	joinPath    func(...string) string
}

func nativeEndpointResolver() endpointResolver {
	return endpointResolver{
		goos: runtime.GOOS, lookupEnv: os.LookupEnv, userHomeDir: os.UserHomeDir,
		absPath: filepath.Abs, joinPath: filepath.Join,
	}
}

// resolve examines exactly one endpoint and one home configuration hierarchy.
// It never searches profiles, starts DSH, or observes any business path.
func (r endpointResolver) resolve(in invocation) (string, error) {
	if in.endpoint != nil {
		return r.explicitEndpoint(*in.endpoint)
	}
	envName := "DSH_WORKSPACE_SOCKET"
	if r.goos == "windows" {
		envName = "DSH_WORKSPACE_PIPE"
	}
	if endpoint, ok := r.lookupEnv(envName); ok && strings.TrimSpace(endpoint) != "" {
		return r.explicitEndpoint(endpoint)
	}
	home := ""
	if in.dshHome != nil {
		home = *in.dshHome
	} else if value, ok := r.lookupEnv("DSH_HOME"); ok && strings.TrimSpace(value) != "" {
		home = value
	} else {
		userHome, err := r.userHomeDir()
		if err != nil || strings.TrimSpace(userHome) == "" {
			return "", argumentError("cannot discover the user home directory: %v", err)
		}
		home = r.joinPath(userHome, ".dsh")
	}
	if strings.TrimSpace(home) == "" {
		return "", argumentError("DSH home must not be blank")
	}
	var err error
	home, err = r.expandHome(home)
	if err != nil {
		return "", err
	}
	if strings.ContainsRune(home, '\x00') {
		return "", argumentError("DSH home must not contain NUL bytes")
	}
	home, err = r.absPath(home)
	if err != nil {
		return "", argumentError("cannot resolve DSH home: %v", err)
	}
	if r.goos != "windows" {
		return r.validateEndpoint(r.joinPath(home, ".dsh-workspace.sock"))
	}
	identity := windowsHomeIdentity(home)
	digest := sha256.Sum256([]byte(identity))
	return windowsPipePrefix + "dsh-workspace-" + hex.EncodeToString(digest[:])[:24], nil
}

func (r endpointResolver) expandHome(home string) (string, error) {
	if home != "~" && !strings.HasPrefix(home, "~/") && !strings.HasPrefix(home, `~\`) {
		return home, nil
	}
	userHome, err := r.userHomeDir()
	if err != nil || strings.TrimSpace(userHome) == "" {
		return "", argumentError("cannot expand DSH home: %v", err)
	}
	if home == "~" {
		return userHome, nil
	}
	// Only the leading tilde separator is special. filepath.Abs/Join handle
	// endpoint/home paths using the current OS's ordinary path semantics.
	return r.joinPath(userHome, home[2:]), nil
}

func (r endpointResolver) explicitEndpoint(endpoint string) (string, error) {
	if r.goos != "windows" {
		var err error
		endpoint, err = r.expandHome(endpoint)
		if err != nil {
			return "", err
		}
		endpoint, err = r.absPath(endpoint)
		if err != nil {
			return "", argumentError("cannot resolve socket endpoint: %v", err)
		}
	}
	return r.validateEndpoint(endpoint)
}

func (r endpointResolver) validateEndpoint(endpoint string) (string, error) {
	if strings.TrimSpace(endpoint) == "" || strings.ContainsRune(endpoint, '\x00') {
		return "", argumentError("endpoint must not be blank or contain NUL bytes")
	}
	if r.goos != "windows" {
		limit := 103
		if r.goos == "linux" {
			limit = 107
		}
		if len(endpoint) > limit {
			return "", argumentError("Unix socket endpoint exceeds %d UTF-8 bytes; choose a shorter DSH home or endpoint", limit)
		}
		return endpoint, nil
	}
	// Full local named-pipe paths are required. In particular, never connect
	// to a remote UNC pipe or silently prefix a bare name.
	if len(endpoint) <= len(windowsPipePrefix) || asciiLower(endpoint[:len(windowsPipePrefix)]) != windowsPipePrefix {
		return "", argumentError("Windows endpoint must be a full local pipe path such as %sNAME; remote UNC pipes are not allowed", windowsPipePrefix)
	}
	name := endpoint[len(windowsPipePrefix):]
	if strings.ContainsAny(name, `\/`) {
		return "", argumentError("Windows endpoint must name one local pipe without path separators")
	}
	return endpoint, nil
}

func windowsHomeIdentity(absoluteHome string) string {
	return asciiLower(strings.TrimRight(strings.ReplaceAll(absoluteHome, "/", `\`), `\`))
}

// Unicode case folding would disagree with the endpoint protocol. Only ASCII
// A-Z is folded; every other UTF-8 byte is retained exactly.
func asciiLower(value string) string {
	b := []byte(value)
	for i := range b {
		if b[i] >= 'A' && b[i] <= 'Z' {
			b[i] += 'a' - 'A'
		}
	}
	return string(b)
}
