package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

type workspaceSummary struct {
	id    string
	path  string
	title string
}

func formatEndpoint(endpoint string, jsonMode bool) ([]byte, error) {
	if !jsonMode {
		return []byte(endpoint + "\n"), nil
	}
	encoded, err := json.Marshal(endpoint)
	if err != nil {
		return nil, protocolError("cannot encode endpoint: %v", err)
	}
	return append(encoded, '\n'), nil
}

// Validate the successful result in both output modes. --json writes just the
// result, never the RPC envelope, and diagnostics always go to stderr.
func formatResult(command string, raw json.RawMessage, jsonMode bool) ([]byte, error) {
	var human strings.Builder
	switch command {
	case "add", "rename", "resolve", "get":
		if command == "resolve" && isNull(raw) {
			human.WriteString("No workspace owns this path.\n")
			break
		}
		summary, fields, err := parseSummary(raw)
		if err != nil {
			return nil, resultError(command, err)
		}
		fmt.Fprintf(&human, "ID: %s\nTitle: %s\nPath: %s\n", summary.id, summary.title, summary.path)
		if command == "get" {
			created, err := requiredString(fields, "createdAt")
			if err != nil {
				return nil, resultError(command, err)
			}
			updated, err := requiredString(fields, "updatedAt")
			if err != nil {
				return nil, resultError(command, err)
			}
			sessions, err := requiredStrings(fields, "sessionIds")
			if err != nil {
				return nil, resultError(command, err)
			}
			fmt.Fprintf(&human, "Created: %s\nUpdated: %s\nSessions: %s\n", created, updated, strings.Join(sessions, ", "))
		}
	case "list":
		var entries []json.RawMessage
		if isNull(raw) || json.Unmarshal(raw, &entries) != nil {
			return nil, protocolError("invalid list result: expected an array")
		}
		if len(entries) == 0 {
			human.WriteString("No workspaces.\n")
		} else {
			human.WriteString("ID\tTITLE\tPATH\n")
			for _, entry := range entries {
				summary, _, err := parseSummary(entry)
				if err != nil {
					return nil, resultError(command, err)
				}
				fmt.Fprintf(&human, "%s\t%s\t%s\n", summary.id, summary.title, summary.path)
			}
		}
	case "remove":
		fields, err := decodeObject(raw)
		if err != nil {
			return nil, resultError(command, err)
		}
		id, err := requiredString(fields, "id")
		if err != nil {
			return nil, resultError(command, err)
		}
		deletedRaw, ok := fields["deleted"]
		var deleted bool
		if !ok || isNull(deletedRaw) || json.Unmarshal(deletedRaw, &deleted) != nil {
			return nil, protocolError("invalid remove result: deleted must be a boolean")
		}
		if deleted {
			fmt.Fprintf(&human, "Removed workspace %s.\n", id)
		} else {
			fmt.Fprintf(&human, "Workspace %s was not registered.\n", id)
		}
	case "move":
		fields, err := decodeObject(raw)
		if err != nil {
			return nil, resultError(command, err)
		}
		order, err := requiredStrings(fields, "order")
		if err != nil {
			return nil, resultError(command, err)
		}
		fmt.Fprintf(&human, "Order: %s\n", strings.Join(order, ", "))
	case "status":
		fields, err := decodeObject(raw)
		if err != nil {
			return nil, resultError(command, err)
		}
		id, err := requiredString(fields, "id")
		if err != nil {
			return nil, resultError(command, err)
		}
		status, err := requiredString(fields, "status")
		if err != nil || (status != "ok" && status != "missing-dir") {
			return nil, protocolError("invalid status result: status must be ok or missing-dir")
		}
		fmt.Fprintf(&human, "%s: %s\n", id, status)
	case "ping":
		fields, err := decodeObject(raw)
		if err != nil {
			return nil, resultError(command, err)
		}
		service, err := requiredString(fields, "service")
		if err != nil || service != "dsh-workspace" {
			return nil, protocolError("invalid ping result: service must be dsh-workspace")
		}
		protocolRaw, ok := fields["protocolVersion"]
		var protocol int
		if !ok || isNull(protocolRaw) || json.Unmarshal(protocolRaw, &protocol) != nil || protocol != 1 {
			return nil, protocolError("invalid ping result: protocolVersion must be 1")
		}
		profileRaw, ok := fields["profile"]
		if !ok {
			return nil, protocolError("invalid ping result: profile is required")
		}
		profile := "(none)"
		if !isNull(profileRaw) {
			if json.Unmarshal(profileRaw, &profile) != nil {
				return nil, protocolError("invalid ping result: profile must be a string or null")
			}
		}
		fmt.Fprintf(&human, "%s (protocol %d, profile %s)\n", service, protocol, profile)
	default:
		return nil, protocolError("cannot format unknown command result %q", command)
	}
	if !jsonMode {
		return []byte(human.String()), nil
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return nil, protocolError("cannot encode JSON result: %v", err)
	}
	return append(compact.Bytes(), '\n'), nil
}

func parseSummary(raw []byte) (workspaceSummary, map[string]json.RawMessage, error) {
	var summary workspaceSummary
	fields, err := decodeObject(raw)
	if err != nil {
		return summary, nil, err
	}
	if summary.id, err = requiredString(fields, "id"); err != nil {
		return summary, nil, err
	}
	if summary.path, err = requiredString(fields, "path"); err != nil {
		return summary, nil, err
	}
	if summary.title, err = requiredString(fields, "title"); err != nil {
		return summary, nil, err
	}
	return summary, fields, nil
}

func requiredString(fields map[string]json.RawMessage, key string) (string, error) {
	raw, ok := fields[key]
	var value string
	if !ok || isNull(raw) || json.Unmarshal(raw, &value) != nil {
		return "", fmt.Errorf("%s must be a string", key)
	}
	return value, nil
}

func requiredStrings(fields map[string]json.RawMessage, key string) ([]string, error) {
	raw, ok := fields[key]
	var values []string
	if !ok || isNull(raw) || json.Unmarshal(raw, &values) != nil {
		return nil, fmt.Errorf("%s must be an array of strings", key)
	}
	// Unmarshaling JSON null elements into string silently produces "". Check
	// each element explicitly so malformed result arrays are rejected.
	var elements []json.RawMessage
	if err := json.Unmarshal(raw, &elements); err != nil {
		return nil, fmt.Errorf("%s must be an array of strings", key)
	}
	for _, element := range elements {
		if isNull(element) {
			return nil, fmt.Errorf("%s must contain only strings", key)
		}
	}
	return values, nil
}

func isNull(raw []byte) bool { return bytes.Equal(bytes.TrimSpace(raw), []byte("null")) }

func resultError(command string, err error) error {
	return protocolError("invalid %s result: %v", command, err)
}
