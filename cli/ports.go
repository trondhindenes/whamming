package main

import (
	"fmt"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// parseWait accepts Go durations ("10m", "90s") or a plain number of seconds.
func parseWait(v string) (time.Duration, error) {
	if n, err := strconv.Atoi(v); err == nil {
		return time.Duration(n) * time.Second, nil
	}
	return time.ParseDuration(v)
}

type claimResponse struct {
	Lease *struct {
		Port int `json:"port"`
	} `json:"lease"`
	Waiting       bool   `json:"waiting"`
	Position      int    `json:"position"`
	HeldBy        string `json:"heldBy"`
	OutsideAgents bool   `json:"outsideAgents"`
}

// waitForPort keeps asking for an exact port until it's ours or the deadline passes.
// The server holds each request up to ~25s; progress goes to stderr, the port to stdout.
func waitForPort(c *ctx, body map[string]any, port int, wait time.Duration) {
	body["wait"] = true
	deadline := time.Now().Add(wait)
	cancel := func() {
		_ = call("DELETE", fmt.Sprintf("/api/ports/%d/wait?%s", port, c.meQuery()), nil, 3*time.Second, nil)
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sig
		cancel()
		fmt.Fprintf(os.Stderr, "whamming: stopped waiting for :%d\n", port)
		os.Exit(130)
	}()
	last := ""
	for {
		// Ask the server to hold this request no longer than the time we have left.
		left := time.Until(deadline)
		if left < 0 {
			left = 0
		}
		body["waitMs"] = left.Milliseconds()
		var r claimResponse
		if err := call("POST", "/api/ports/claim", body, 35*time.Second, &r); err != nil {
			fail("%s", err)
		}
		if r.Lease != nil {
			if last != "" {
				fmt.Fprintf(os.Stderr, "whamming: got :%d\n", r.Lease.Port)
			}
			fmt.Println(r.Lease.Port)
			return
		}
		msg := fmt.Sprintf("waiting for :%d (%s), position %d", port, r.HeldBy, r.Position)
		if r.OutsideAgents {
			msg += ". It's held by a process outside Whamming, so no agent will release it; consider asking the user"
		}
		if msg != last {
			fmt.Fprintln(os.Stderr, "whamming: "+msg)
			last = msg
		}
		if !time.Now().Before(deadline) {
			cancel()
			fail("gave up waiting for :%d after %s (%s)", port, wait, r.HeldBy)
		}
	}
}

func (c *ctx) meQuery() string {
	q := url.Values{"session": {c.id}}
	if c.claude != nil {
		q.Set("pid", strconv.Itoa(c.claude.Pid))
	}
	if c.task != "" {
		q.Set("task", c.task) // a subagent's claims are its own, not the whole session's
	}
	return q.Encode()
}

func runPort(c *ctx, rest []string) {
	if len(rest) == 0 {
		fail("usage: whamming port claim|release|check ...")
	}
	sub, args := rest[0], rest[1:]
	switch sub {
	case "claim":
		c.needID()
		folder := c.folder()
		body := map[string]any{"session": c.id, "folder": folder, "branch": gitBranch(folder)}
		if c.task != "" {
			body["task"] = c.task
		}
		c.identity(body)
		if c.claude != nil {
			body["agent"] = "claude-code"
		}
		if p := c.a.str("purpose"); p != "" {
			body["purpose"] = p
		}
		var prefer int
		if len(args) > 0 {
			n, err := strconv.Atoi(args[0])
			if err != nil {
				fail("PORT must be a number")
			}
			body["port"] = n
		}
		if v := c.a.str("prefer"); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil {
				fail("--prefer must be a number")
			}
			prefer = n
			body["prefer"] = n
		}
		if c.a.bools["adopt"] {
			body["adopt"] = true
		}
		if v := c.a.str("wait"); v != "" {
			wait, err := parseWait(v)
			if err != nil || wait <= 0 {
				fail("--wait takes a duration like 10m or 90s")
			}
			n, ok := body["port"].(int)
			if !ok {
				fail("--wait needs an exact port: whamming port claim PORT --wait 10m")
			}
			waitForPort(c, body, n, wait)
			return
		}
		var r struct {
			Lease struct {
				Port int `json:"port"`
			} `json:"lease"`
		}
		c.do("POST", "/api/ports/claim", body, &r)
		if c.json {
			c.print(r.Lease, "")
			return
		}
		if prefer != 0 && r.Lease.Port != prefer {
			fmt.Fprintf(os.Stderr, "whamming: %d is taken; claimed %d instead\n", prefer, r.Lease.Port)
		}
		fmt.Println(r.Lease.Port)

	case "release":
		c.needID()
		if c.a.bools["all"] {
			var r struct {
				Released []int `json:"released"`
			}
			c.do("DELETE", "/api/ports?"+c.meQuery(), nil, &r)
			if len(r.Released) == 0 {
				fmt.Println("nothing to release")
				return
			}
			fmt.Println("released " + joinInts(r.Released))
			return
		}
		if len(args) == 0 {
			fail("usage: whamming port release PORT... | --all")
		}
		for _, p := range args {
			if _, err := strconv.Atoi(p); err != nil {
				fail("not a port: %s", p)
			}
			c.do("DELETE", "/api/ports/"+p+"?"+c.meQuery(), nil, nil)
		}
		fmt.Println("released " + strings.Join(args, " "))

	case "check":
		if len(args) == 0 {
			fail("usage: whamming port check PORT")
		}
		if _, err := strconv.Atoi(args[0]); err != nil {
			fail("not a port: %s", args[0])
		}
		var r struct {
			Port  int    `json:"port"`
			State string `json:"state"`
			Lease *struct {
				Session, Purpose string
			} `json:"lease"`
			Listener *struct {
				Pid                         int
				Command, Session, Container string
			} `json:"listener"`
		}
		c.do("GET", "/api/ports/"+args[0], nil, &r)
		human := fmt.Sprintf("%d: %s", r.Port, r.State)
		switch {
		case r.State == "claimed" && r.Lease != nil:
			human = fmt.Sprintf("%d: claimed by %s", r.Port, r.Lease.Session)
			if r.Lease.Purpose != "" {
				human += " (" + r.Lease.Purpose + ")"
			}
		case r.State == "in-use" && r.Listener != nil:
			who := fmt.Sprintf("%s (pid %d", r.Listener.Command, r.Listener.Pid)
			if r.Listener.Container != "" {
				who = "container " + r.Listener.Container + " ("
			}
			if r.Listener.Session != "" {
				who += ", session " + r.Listener.Session
			}
			human = fmt.Sprintf("%d: in use by %s)", r.Port, strings.Replace(who, "(, ", "(", 1))
		}
		c.print(r, human)
		if r.State != "free" {
			os.Exit(1)
		}

	default:
		fail("usage: whamming port claim|release|check ...")
	}
}

func runPorts(c *ctx) {
	type listener struct {
		Port                                         int
		Pid                                          int
		Command, Session, Container, ContainerFolder string
	}
	var r struct {
		Leases []struct {
			Port             int
			Session, Purpose string
			OwnerAlive       bool `json:"ownerAlive"`
			Listener         *listener
		} `json:"leases"`
		Unclaimed []listener `json:"unclaimed"`
	}
	c.do("GET", "/api/ports", nil, &r)
	if c.json {
		c.print(r, "")
		return
	}
	var b strings.Builder
	if len(r.Leases) == 0 {
		b.WriteString("No claimed ports.\n")
	} else {
		b.WriteString("Claimed:\n")
		for _, l := range r.Leases {
			state := "reserved"
			if !l.OwnerAlive {
				state = "owner exited"
			} else if l.Listener != nil {
				state = "listening (" + l.Listener.Command + ")"
			}
			fmt.Fprintf(&b, "%d\t%s\t%s\t%s\n", l.Port, l.Session, orDash(l.Purpose), state)
		}
	}
	shown, hidden := []listener{}, 0
	for _, l := range r.Unclaimed {
		if c.a.bools["all"] || l.Session != "" || l.Container != "" {
			shown = append(shown, l)
		} else {
			hidden++
		}
	}
	if len(shown) > 0 {
		b.WriteString("\nListening but not claimed:\n")
		for _, l := range shown {
			what := fmt.Sprintf("%s (pid %d)", l.Command, l.Pid)
			if l.Container != "" {
				what = "container " + l.Container
				if l.ContainerFolder != "" {
					what += " (" + l.ContainerFolder + ")"
				}
			}
			fmt.Fprintf(&b, "%d\t%s\t%s\n", l.Port, orDash(l.Session), what)
		}
	}
	if hidden > 0 {
		fmt.Fprintf(&b, "\n(%d other listeners hidden; --all to show)\n", hidden)
	}
	fmt.Print(b.String())
}

func joinInts(ns []int) string {
	s := make([]string, len(ns))
	for i, n := range ns {
		s[i] = strconv.Itoa(n)
	}
	return strings.Join(s, " ")
}
