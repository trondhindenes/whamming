package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// claudeSession is what Claude Code writes to ~/.claude/sessions/<pid>.json (internal format).
type claudeSession struct {
	Pid        int    `json:"pid"`
	Name       string `json:"name"`
	NameSource string `json:"nameSource"`
	SessionID  string `json:"sessionId"`
	Cwd        string `json:"cwd"`
}

func claudeDir() string {
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude")
}

func readClaudeSession(pid int) *claudeSession {
	b, err := os.ReadFile(filepath.Join(claudeDir(), "sessions", strconv.Itoa(pid)+".json"))
	if err != nil {
		return nil
	}
	var s claudeSession
	if json.Unmarshal(b, &s) != nil {
		return nil
	}
	s.Pid = pid
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
func findClaudeSession() *claudeSession {
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
