package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// hookInput is the JSON Claude Code passes to hooks on stdin (only the fields we use).
type hookInput struct {
	SessionID        string `json:"session_id"`
	Cwd              string `json:"cwd"`
	Event            string `json:"hook_event_name"`
	Prompt           string `json:"prompt"`
	Message          string `json:"message"`
	NotificationType string `json:"notification_type"`
	Source           string `json:"source"`
	ToolName         string `json:"tool_name"`
}

// runHook reports a Claude Code hook event. It must never block or disturb Claude:
// it prints nothing (hook stdout can end up in the conversation), always exits 0,
// and gives up after a short timeout if Whamming isn't running.
func runHook() {
	defer func() { _ = recover() }()
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 1<<20))
	if err != nil {
		return
	}
	var in hookInput
	if json.Unmarshal(raw, &in) != nil || in.Event == "" {
		return
	}
	s := findClaudeSession()
	if s == nil {
		return
	}
	cwd := in.Cwd
	if cwd == "" {
		cwd = s.Cwd
	}
	name := s.Name
	if name == "" {
		id := in.SessionID
		if len(id) > 4 {
			id = id[:4]
		}
		name = filepath.Base(cwd) + "-" + id
	}
	conv := in.SessionID
	if conv == "" {
		conv = s.SessionID
	}
	body := map[string]any{
		"event":            in.Event,
		"name":             name,
		"nameSource":       s.NameSource,
		"pid":              s.Pid,
		"conversationId":   conv,
		"cwd":              cwd,
		"message":          in.Message,
		"notificationType": in.NotificationType,
		"source":           in.Source,
	}
	if in.Prompt != "" {
		p := in.Prompt
		if len(p) > 400 {
			p = p[:400]
		}
		body["prompt"] = p
	}
	// Branch lookups cost a few ms; only do them when a turn starts or a session starts.
	if in.Event == "UserPromptSubmit" || in.Event == "SessionStart" {
		if b := gitBranch(cwd); b != "" && !strings.Contains(b, "fatal") {
			body["branch"] = b
		}
	}
	_ = call("POST", "/api/hooks/claude", body, 800*time.Millisecond, nil)
}
