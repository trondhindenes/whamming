package main

import (
	"encoding/json"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// agentSession is the agent session this command runs under. For Claude Code it's read from
// ~/.claude/sessions/<pid>.json (internal format); for pi it comes from Whamming, which the extension told.
type agentSession struct {
	Pid        int    `json:"pid"`
	Name       string `json:"name"`
	NameSource string `json:"nameSource"`
	SessionID  string `json:"sessionId"`
	Cwd        string `json:"cwd"`
	Agent      string `json:"-"`
}

var slugRe = regexp.MustCompile(`[^A-Za-z0-9_.:-]+`)

// slug turns a display name into a session id, exactly like the server's sessionSlug().
func slug(name string) string {
	s := strings.Trim(slugRe.ReplaceAllString(strings.TrimSpace(name), "-"), "-")
	if len(s) > 128 {
		s = s[:128]
	}
	if s == "" {
		s = "session"
	}
	return s
}

// findSession: pi when its shell says so (PI_SESSION_ID) and Whamming knows that session, else Claude Code.
func findSession() *agentSession {
	if s := findPiSession(); s != nil {
		return s
	}
	if s := findClaudeSession(); s != nil {
		s.Agent = "claude-code"
		return s
	}
	return nil
}

// findPiSession asks Whamming which entry pi's extension registered for this pi session.
// pi's bash tool sets PI_SESSION_ID for every command it runs.
func findPiSession() *agentSession {
	id := os.Getenv("PI_SESSION_ID")
	if id == "" {
		return nil
	}
	var r struct {
		Sessions []struct {
			ID             string `json:"id"`
			Pid            int    `json:"pid"`
			NameSource     string `json:"nameSource"`
			ConversationID string `json:"conversationId"`
			Folder         string `json:"folder"`
			Alive          *bool  `json:"alive"`
		} `json:"sessions"`
	}
	if call("GET", "/api/sessions?conversation="+url.QueryEscape(id), nil, 2*time.Second, &r) != nil {
		return nil
	}
	for _, s := range r.Sessions {
		if s.Alive != nil && !*s.Alive {
			continue
		}
		return &agentSession{Pid: s.Pid, Name: s.ID, NameSource: s.NameSource, SessionID: id, Cwd: s.Folder, Agent: "pi"}
	}
	return nil
}

func claudeDir() string {
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude")
}

func readClaudeSession(pid int) *agentSession {
	b, err := os.ReadFile(filepath.Join(claudeDir(), "sessions", strconv.Itoa(pid)+".json"))
	if err != nil {
		return nil
	}
	var s agentSession
	if json.Unmarshal(b, &s) != nil {
		return nil
	}
	s.Pid = pid
	if s.Name != "" {
		s.Name = slug(s.Name)
	}
	return &s
}

func parentPid(pid int) int {
	out, err := exec.Command("ps", "-o", "ppid=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	return n
}

// findClaudeSession finds the Claude Code process this command runs under.
// Fast path: Claude sets CLAUDE_PID in agent shells. Otherwise walk up the process tree.
func findClaudeSession() *agentSession {
	if p, err := strconv.Atoi(os.Getenv("CLAUDE_PID")); err == nil && p > 1 {
		if s := readClaudeSession(p); s != nil {
			return s
		}
	}
	pid := os.Getppid()
	for i := 0; i < 15 && pid > 1; i++ {
		if s := readClaudeSession(pid); s != nil {
			return s
		}
		pid = parentPid(pid)
	}
	return nil
}

func gitBranch(dir string) string {
	cmd := exec.Command("git", "rev-parse", "--abbrev-ref", "HEAD")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
