// whamming: command line client for the Whamming dashboard. Bundled inside Whamming.app.
package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

var version = "dev"

const usage = `whamming <command> [options]

Identity: the session name and pid come from the Claude Code or pi session this runs under
(Claude: the name set with /rename, or Claude's generated name; pi: the name set with /name, or
folder-id). --id or WHAMMING_SESSION overrides the name.
Subagents: pass --task KEY on update/done to report a child row under the parent session.

Commands:
  whoami                      show the resolved session name and pid
  update   [--status S] [--title T] [--detail D] [--link URL[|label]]... [--note N]
           [--name N] [--branch B] [--folder PATH] [--agent A] [--task KEY]
  peers                       sessions working in the same folder
  send     SESSION MESSAGE    leave a message for another session
  inbox    [--all]            unread messages (marks them read)
  done     [--task KEY]       mark the session (or a subagent task) done
  remove                      remove this session
  list                        all sessions
  port claim [PORT] [--prefer N] [--purpose P] [--adopt] [--wait DURATION]
           prints the claimed port, e.g. PG_PORT=$(whamming port claim --prefer 5432 --purpose postgres)
           --wait 10m: if PORT is busy, queue for it (status "blocked") until it's free or time runs out
  port release PORT... | --all
  port check PORT             free | claimed | in-use (exit 1 unless free)
  ports [--all]               who holds what
  ping                        is Whamming running? where, which version (exit 1 if not)
  hook                        (for Claude Code hooks) read a hook event on stdin and report it
  version

Statuses: working | waiting (needs the human) | blocked (waiting on something else) | idle | done | error
Server: found via WHAMMING_URL / WHAMMING_PORT, else ~/.whamming/status.json (WHAMMING_HOME), else port 4477.
Env: WHAMMING_SESSION, WHAMMING_TASK, WHAMMING_URL, WHAMMING_PORT, WHAMMING_HOME`

func fail(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "whamming: "+format+"\n", a...)
	os.Exit(1)
}

type ctx struct {
	a    *args
	id   string
	self *agentSession
	json bool
	task string // subagent task key (--task / WHAMMING_TASK)
}

func (c *ctx) needID() string {
	if c.id == "" {
		fail("could not determine a session name: not running under Claude Code or pi (with the Whamming extension)? Pass --id or set WHAMMING_SESSION")
	}
	return url.PathEscape(c.id)
}

func (c *ctx) pidQS(prefix string) string {
	if c.self == nil {
		return ""
	}
	return prefix + "pid=" + strconv.Itoa(c.self.Pid)
}

// identity adds the agent session's pid / conversation fields to a request body.
func (c *ctx) identity(body map[string]any) {
	if c.self != nil {
		body["pid"] = c.self.Pid
		body["conversationId"] = c.self.SessionID
		body["nameSource"] = c.self.NameSource
	}
}

func (c *ctx) folder() string {
	if f := c.a.str("folder"); f != "" {
		return f
	}
	wd, _ := os.Getwd()
	return wd
}

func links(raw []string) []map[string]string {
	out := []map[string]string{}
	for _, l := range raw {
		u, label, _ := strings.Cut(l, "|")
		m := map[string]string{"url": u}
		if label != "" {
			m["label"] = label
		}
		out = append(out, m)
	}
	return out
}

func (c *ctx) do(method, path string, body any, out any) {
	if err := call(method, path, body, 5*time.Second, out); err != nil {
		fail("%s", err)
	}
}

func (c *ctx) print(v any, human string) {
	if c.json {
		b, _ := json.MarshalIndent(v, "", "  ")
		fmt.Println(string(b))
		return
	}
	if human != "" {
		fmt.Println(human)
	}
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "hook" {
		runHook() // never fails, never prints
		return
	}
	a, err := parseArgs(os.Args[1:])
	if err != nil {
		fail("%s", err)
	}
	if len(a.pos) == 0 || a.bools["help"] {
		fmt.Println(usage)
		if len(a.pos) == 0 {
			os.Exit(1)
		}
		return
	}
	c := &ctx{a: a, json: a.bools["json"], self: findSession()}
	c.id = os.Getenv("WHAMMING_SESSION")
	if v, ok := a.get("id"); ok {
		c.id = v
	}
	if c.id == "" && c.self != nil {
		c.id = c.self.Name
	}
	task := os.Getenv("WHAMMING_TASK")
	if v, ok := a.get("task"); ok {
		task = v
	}
	c.task = task
	cmd, rest := a.pos[0], a.pos[1:]

	switch cmd {
	case "version":
		fmt.Println(version)

	case "ping":
		var h struct {
			Version any    `json:"version"`
			Pid     int    `json:"pid"`
			Home    string `json:"home"`
		}
		s, _ := resolveServer()
		if err := call("GET", "/api/health", nil, 2*time.Second, &h); err != nil {
			fail("%s", err)
		}
		c.print(map[string]any{"url": s.url, "pid": h.Pid, "version": h.Version, "home": h.Home},
			fmt.Sprintf("Whamming %v is running at %s (pid %d, found via %s)", h.Version, s.url, h.Pid, s.source))

	case "whoami":
		w := map[string]any{"id": c.id, "pid": nil, "nameSource": nil, "conversationId": nil}
		human := "unknown: pass --id or set WHAMMING_SESSION"
		if c.self != nil {
			w["pid"], w["nameSource"], w["conversationId"] = c.self.Pid, c.self.NameSource, c.self.SessionID
		}
		if c.id != "" {
			human = c.id
			if c.self != nil {
				human += fmt.Sprintf("  (%s, pid %d, name %s)", c.self.Agent, c.self.Pid, c.self.NameSource)
			}
		}
		c.print(w, human)

	case "update":
		id := c.needID()
		folder := c.folder()
		body := map[string]any{"folder": folder}
		for _, k := range []string{"status", "title", "detail", "note"} {
			if v, ok := a.get(k); ok {
				body[k] = v
			}
		}
		if br, ok := a.get("branch"); ok {
			body["branch"] = br
		} else {
			body["branch"] = gitBranch(folder)
		}
		c.identity(body)
		if l := a.vals["link"]; len(l) > 0 {
			body["links"] = links(l)
		}
		if task != "" {
			var r struct {
				Task    map[string]any `json:"task"`
				Session string         `json:"session"`
			}
			c.do("PUT", "/api/sessions/"+id+"/tasks/"+url.PathEscape(task)+c.pidQS("?"), body, &r)
			c.print(r.Task, fmt.Sprintf("%s › %s: %v%s", r.Session, task, r.Task["status"], titleSuffix(r.Task["title"])))
			return
		}
		for _, k := range []string{"name", "agent"} {
			if v, ok := a.get(k); ok {
				body[k] = v
			}
		}
		if _, ok := body["agent"]; !ok && c.self != nil {
			body["agent"] = c.self.Agent
		}
		var r struct {
			Session map[string]any `json:"session"`
			Warning string         `json:"warning"`
		}
		c.do("PUT", "/api/sessions/"+id, body, &r)
		if r.Warning != "" {
			fmt.Fprintln(os.Stderr, "whamming: warning: "+r.Warning)
		}
		c.print(r.Session, fmt.Sprintf("%v: %v%s", r.Session["id"], r.Session["status"], titleSuffix(r.Session["title"])))

	case "peers":
		q := url.Values{"folder": {c.folder()}}
		if c.id != "" {
			q.Set("exclude", c.id)
		}
		if c.self != nil {
			q.Set("excludePid", strconv.Itoa(c.self.Pid))
		}
		var r struct {
			Peers []struct {
				ID, Status, Branch, Title, Relation, Folder string
			} `json:"peers"`
		}
		c.do("GET", "/api/peers?"+q.Encode(), nil, &r)
		lines := []string{}
		for _, p := range r.Peers {
			line := fmt.Sprintf("%s\t%s\t%s\t%s", p.ID, p.Status, orDash(p.Branch), p.Title)
			if p.Relation == "child" {
				line += "  (in subfolder " + p.Folder + ")"
			} else if p.Relation == "parent" {
				line += "  (in parent folder " + p.Folder + ")"
			}
			lines = append(lines, line)
		}
		if len(lines) == 0 {
			lines = append(lines, "No other sessions in this folder.")
		}
		c.print(r.Peers, strings.Join(lines, "\n"))

	case "send":
		if len(rest) < 2 {
			fail("usage: whamming send SESSION MESSAGE")
		}
		from := c.id
		if from == "" {
			from = "unknown"
		}
		var r map[string]any
		c.do("POST", "/api/sessions/"+url.PathEscape(rest[0])+"/messages", map[string]any{"from": from, "body": strings.Join(rest[1:], " ")}, &r)
		c.print(r, "sent to "+rest[0])

	case "inbox":
		id := c.needID()
		if task != "" {
			fail("subagents don't read the session inbox (that would mark the parent's messages as read); the parent session does")
		}
		q := "?unread=1"
		if a.bools["all"] {
			q = "?markRead=0"
		}
		var r struct {
			Messages []struct{ At, From, Body string } `json:"messages"`
		}
		c.do("GET", "/api/sessions/"+id+"/messages"+q+c.pidQS("&"), nil, &r)
		lines := []string{}
		for _, m := range r.Messages {
			lines = append(lines, fmt.Sprintf("[%s] %s: %s", m.At, m.From, m.Body))
		}
		if len(lines) == 0 {
			lines = append(lines, "No new messages.")
		}
		c.print(r.Messages, strings.Join(lines, "\n"))

	case "done":
		id := c.needID()
		if task != "" {
			c.do("PUT", "/api/sessions/"+id+"/tasks/"+url.PathEscape(task)+c.pidQS("?"), map[string]any{"status": "done", "folder": c.folder()}, nil)
			fmt.Printf("%s › %s: done\n", c.id, task)
			return
		}
		body := map[string]any{"status": "done"}
		if c.self != nil {
			body["pid"] = c.self.Pid
		}
		c.do("PATCH", "/api/sessions/"+id, body, nil)
		fmt.Println(c.id + ": done")

	case "remove":
		id := c.needID()
		c.do("DELETE", "/api/sessions/"+id+c.pidQS("?"), nil, nil)
		fmt.Println("removed " + c.id)

	case "list":
		var r struct {
			Sessions []struct {
				ID, Status, FolderName, Title string
				Stale                         bool
			} `json:"sessions"`
		}
		c.do("GET", "/api/sessions", nil, &r)
		lines := []string{}
		for _, s := range r.Sessions {
			st := s.Status
			if s.Stale {
				st += "(stale)"
			}
			lines = append(lines, fmt.Sprintf("%s\t%s\t%s\t%s", s.ID, st, s.FolderName, s.Title))
		}
		if len(lines) == 0 {
			lines = append(lines, "No sessions.")
		}
		c.print(r.Sessions, strings.Join(lines, "\n"))

	case "port":
		runPort(c, rest)

	case "ports":
		runPorts(c)

	default:
		fail("unknown command %q\n\n%s", cmd, usage)
	}
}

func titleSuffix(t any) string {
	if s, ok := t.(string); ok && s != "" {
		return " — " + s
	}
	return ""
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}
