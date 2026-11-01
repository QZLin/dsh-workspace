package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestResultFormatsAndJSONPayloads(t *testing.T) {
	cases := []struct{ command, raw, human string }{
		{"add", `{"id":"id","path":"~/raw","title":"  title  "}`, "ID: id\nTitle:   title  \nPath: ~/raw\n"},
		{"rename", `{"id":"id","path":"relative","title":"new"}`, "ID: id\nTitle: new\nPath: relative\n"},
		{"resolve", "null", "No workspace owns this path.\n"},
		{"resolve", `{"id":"id","path":"raw","title":"title"}`, "ID: id\nTitle: title\nPath: raw\n"},
		{"list", `[]`, "No workspaces.\n"},
		{"list", `[{"id":"id","path":"path","title":"title"}]`, "ID\tTITLE\tPATH\nid\ttitle\tpath\n"},
		{"get", `{"id":"id","path":"path","title":"title","createdAt":"2026-01-02T03:04:05.000Z","updatedAt":"2026-01-02T03:04:05.000Z","sessionIds":["s1","s2"]}`, "ID: id\nTitle: title\nPath: path\nCreated: 2026-01-02T03:04:05.000Z\nUpdated: 2026-01-02T03:04:05.000Z\nSessions: s1, s2\n"},
		{"remove", `{"id":"id","deleted":true}`, "Removed workspace id.\n"},
		{"remove", `{"id":"unknown","deleted":false}`, "Workspace unknown was not registered.\n"},
		{"move", `{"order":["b","a"]}`, "Order: b, a\n"},
		{"move", `{"order":[]}`, "Order: \n"},
		{"status", `{"id":"id","status":"ok"}`, "id: ok\n"},
		{"status", `{"id":"id","status":"missing-dir"}`, "id: missing-dir\n"},
		{"ping", `{"service":"dsh-workspace","protocolVersion":1,"profile":null}`, "dsh-workspace (protocol 1, profile (none))\n"},
		{"ping", `{"service":"dsh-workspace","protocolVersion":1,"profile":"desktop"}`, "dsh-workspace (protocol 1, profile desktop)\n"},
	}
	for i, tc := range cases {
		t.Run(fmt.Sprintf("%s/%d", tc.command, i), func(t *testing.T) {
			output, err := formatResult(tc.command, json.RawMessage(tc.raw), false)
			if err != nil || string(output) != tc.human {
				t.Fatalf("human got %q, %v; want %q", output, err, tc.human)
			}
			output, err = formatResult(tc.command, json.RawMessage(tc.raw), true)
			if err != nil || string(output) != tc.raw+"\n" {
				t.Fatalf("JSON got %q, %v; want %q", output, err, tc.raw+"\n")
			}
		})
	}
}

func TestMalformedResultShapesAreProtocolErrors(t *testing.T) {
	cases := []struct{ command, raw string }{
		{"add", `null`}, {"add", `{}`}, {"add", `{"id":"id","path":"raw","title":null}`}, {"add", `{"id":1,"path":"raw","title":"title"}`},
		{"rename", `[]`}, {"resolve", `false`}, {"list", `null`}, {"list", `{}`}, {"list", `[null]`}, {"list", `[{"id":"id"}]`},
		{"get", `{"id":"id","path":"raw","title":"title"}`},
		{"get", `{"id":"id","path":"raw","title":"title","createdAt":1,"updatedAt":"date","sessionIds":[]}`},
		{"get", `{"id":"id","path":"raw","title":"title","createdAt":"date","updatedAt":"date","sessionIds":[null]}`},
		{"remove", `{"id":"id"}`}, {"remove", `{"id":"id","deleted":null}`}, {"remove", `{"id":"id","deleted":"false"}`},
		{"move", `{}`}, {"move", `{"order":null}`}, {"move", `{"order":[1]}`}, {"move", `{"order":[null]}`},
		{"status", `{"id":"id","status":"unknown"}`}, {"status", `{"id":"id","status":null}`},
		{"ping", `{"service":"wrong","protocolVersion":1,"profile":null}`},
		{"ping", `{"service":"dsh-workspace","protocolVersion":2,"profile":null}`},
		{"ping", `{"service":"dsh-workspace","protocolVersion":1}`},
		{"ping", `{"service":"dsh-workspace","protocolVersion":1,"profile":{}}`},
	}
	for i, tc := range cases {
		for _, jsonMode := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/%d/json=%t", tc.command, i, jsonMode), func(t *testing.T) {
				output, err := formatResult(tc.command, json.RawMessage(tc.raw), jsonMode)
				if err == nil || failureCode(t, err) != exitProtocol || len(output) != 0 {
					t.Fatalf("malformed result %s: %q, %v", tc.raw, output, err)
				}
			})
		}
	}
}

func TestEndpointJSONAndCompactionPreserveStrings(t *testing.T) {
	endpoint := `\\.\pipe\name with spaces`
	output, err := formatEndpoint(endpoint, false)
	if err != nil || string(output) != endpoint+"\n" {
		t.Fatalf("human endpoint: %q, %v", output, err)
	}
	output, err = formatEndpoint(endpoint, true)
	var parsed string
	if err != nil || json.Unmarshal(output, &parsed) != nil || parsed != endpoint {
		t.Fatalf("JSON endpoint: %q, %v", output, err)
	}
	raw := ` { "id":"id", "path":"~/a/../b", "title":"  padded  " } `
	output, err = formatResult("add", json.RawMessage(raw), true)
	if err != nil || string(output) != `{"id":"id","path":"~/a/../b","title":"  padded  "}`+"\n" || strings.Contains(string(output), "jsonrpc") {
		t.Fatalf("JSON payload: %q, %v", output, err)
	}
}
