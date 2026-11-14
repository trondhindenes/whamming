package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// server is where (we think) Whamming is, and how we found out.
type server struct {
	url    string
	source string // "env", "status", "default"
	pid    int
}

func whammingHome() string {
	if d := os.Getenv("WHAMMING_HOME"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".whamming")
}

func pidAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

type runStatus struct {
	Pid     int    `json:"pid"`
	URL     string `json:"url"`
	Version string `json:"version"`
}

// resolveServer finds the running Whamming: env override, then ~/.whamming/status.json, then the
// default port (older app builds don't write status.json). A stale status file means "not running"
// and is reported without touching the network.
func resolveServer() (server, error) {
	if u := os.Getenv("WHAMMING_URL"); u != "" {
		return server{url: u, source: "env"}, nil
	}
	if p := os.Getenv("WHAMMING_PORT"); p != "" {
		return server{url: "http://127.0.0.1:" + p, source: "env"}, nil
	}
	file := filepath.Join(whammingHome(), "status.json")
	b, err := os.ReadFile(file)
	if err != nil {
		return server{url: "http://127.0.0.1:4477", source: "default"}, nil
	}
	var s runStatus
	if json.Unmarshal(b, &s) != nil || s.URL == "" || s.Pid <= 0 {
		return server{url: "http://127.0.0.1:4477", source: "default"}, nil
	}
	if !pidAlive(s.Pid) {
		return server{}, &apiError{fmt.Sprintf("Whamming isn't running (%s is stale: pid %d is gone)", tildePath(file), s.Pid)}
	}
	return server{url: s.URL, source: "status", pid: s.Pid}, nil
}

func tildePath(p string) string {
	if home, err := os.UserHomeDir(); err == nil && len(p) > len(home) && p[:len(home)] == home {
		return "~" + p[len(home):]
	}
	return p
}

type apiError struct{ msg string }

func (e *apiError) Error() string { return e.msg }

func unreachable(s server) error {
	switch s.source {
	case "status":
		return &apiError{fmt.Sprintf("Whamming (pid %d) isn't responding at %s", s.pid, s.url)}
	case "env":
		return &apiError{fmt.Sprintf("cannot reach Whamming at %s (set by WHAMMING_URL/WHAMMING_PORT)", s.url)}
	default:
		return &apiError{fmt.Sprintf("Whamming isn't running (no %s, and nothing at %s)", tildePath(filepath.Join(whammingHome(), "status.json")), s.url)}
	}
}

// call does one JSON request against the running Whamming. Never panics.
func call(method, path string, body any, timeout time.Duration, out any) error {
	s, err := resolveServer()
	if err != nil {
		return err
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, s.url+path, rd)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	res, err := (&http.Client{Timeout: timeout}).Do(req)
	if err != nil {
		return unreachable(s)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	var e struct {
		Error *string `json:"error"`
	}
	if json.Unmarshal(raw, &e) != nil {
		return &apiError{fmt.Sprintf("something answered at %s, but it doesn't look like Whamming", s.url)}
	}
	if res.StatusCode >= 300 {
		if e.Error != nil && *e.Error != "" {
			return &apiError{*e.Error}
		}
		return &apiError{res.Status}
	}
	if out != nil {
		return json.Unmarshal(raw, out)
	}
	return nil
}
