# Whamming (What am I working on?)

**See what all your Claude Code (and pi) sessions are working on, at a glance.**

When you have several Claude Code sessions going at once, across repos and tickets, it's easy to lose track of
which one is waiting for you, what each is doing, and which PR belongs to which. Whamming is a small local
dashboard that answers that: folder, status (working, waiting for you, idle, error), the task, and links to
the tickets and PRs involved. Agents can also find each other, message each other, and claim ports so
parallel sessions don't fight over `5432`.

> **Prototype.** Whamming is an early, macOS-only prototype built around **Claude Code**, with support for
> the [pi](https://pi.dev) coding agent too. For Claude it relies on hooks and on reading Claude Code's own
> session files (`~/.claude/sessions/*.json`, an internal format that may change); for pi, on a small pi
> extension. The HTTP API is generic, so other agents can report too. Expect rough edges and breaking changes.

![Dashboard](docs/screenshots/dashboard.png)

<img src="docs/screenshots/popover.png" alt="Menu bar popover" width="380" align="right">

## What it does

- **Live overview** of every session, grouped by status or folder, Linear-style. What needs you comes first,
  with the agent's question.
- **Menu bar icon** with the number of sessions waiting for you, and a popover with the quick overview.
  Dock badge, notifications when an agent starts waiting or hits an error, and a Dock menu to jump to a session.
- **Automatic status** through Claude Code hooks: working, idle and permission prompts are tracked without the
  agent having to remember. Agents add titles, questions, and links to tickets and PRs.
- **Claude Code and pi**: a small mark next to each session shows which agent it runs in.
- **Subagents** show up as child rows under the session that spawned them.
- **Coordination**: agents can ask who else works in the same folder, and leave each other messages.
- **Port claims**: agents ask Whamming for a port before binding one, checked against other agents'
  claims and what's actually listening, including docker compose containers. If an app needs one specific
  port and it's busy, agents wait in a fair queue (shown as *blocked*), the holder is asked to release it,
  and deadlocks are detected.
- **Notices exits** within about 2 seconds (Ctrl-C, crash, closed terminal, `/clear`) without slowing Claude's
  exit, and merges a resumed session (`claude -r`) back into its old entry.

<br clear="right">

Two subagents of one session need the same hardcoded port: `e2e-chrome` holds `:3000`, `e2e-safari` waits
in line (*blocked*), and the parent got a message asking for the port back when Chrome is done.

![Subagents queueing for a port](docs/screenshots/subagents-ports.png)

## Install

Requirements: macOS, Node.js 20+, Go 1.24+ (to build the CLI), and Claude Code.

```sh
git clone https://github.com/trondhindenes/whamming.git
cd whamming
npm install
npm run install-mac -- --open        # build, install into /Applications, launch
```

`install-mac` builds `release/Whamming-darwin-<arch>/Whamming.app` and copies it to `/Applications` (or
`~/Applications` if that isn't writable). `--no-build` installs the last build as is. It refuses while
Whamming is running (quit it first), only ever replaces a bundle whose id is `app.whamming.desktop`, and if
the CLI link points at another copy of the app, it moves the link to the installed one. Re-run it to update.
The build is signed ad hoc for your own machine; it isn't notarized for distribution.

Then open **Agent setup** (bottom left in the dashboard) and follow the steps:

1. **Install the command line tool.** Links `~/.local/bin/whamming` to the CLI inside the app. The link follows
   the app if you move or update it.
2. **Install the Claude Code hooks.** Shows exactly what will be added to `~/.claude/settings.json` before
   changing anything, keeps your existing hooks, and saves a backup first. The hook prints nothing, never
   fails, and gives up after 0.8 s if Whamming isn't running. *Remove* takes them out again.
3. **Install the pi extension** (optional, if you use [pi](https://pi.dev)). Links a small extension into
   `~/.pi/agent/extensions/` that reports when a pi session starts, works, shows a dialog waiting for you,
   goes idle and ends. Like the hooks, it prints nothing and gives up after 0.8 s if Whamming isn't running.
4. **Add the agent instructions** to your global `~/.claude/CLAUDE.md` (Claude Code) or `~/.pi/agent/AGENTS.md`
   (pi), so agents report titles, questions, links, ports and subagents, and check for other sessions in the
   same folder.

New Claude Code and pi sessions show up automatically from then on.

## How it works

```
Claude Code ──hooks──▶ whamming hook ───┐
pi ──extension (in-process) ────────────┤
     │                                  ├──▶ Whamming server (127.0.0.1:4477) ──▶ dashboard, menu bar, Dock
     └─ agent runs ─▶ whamming update ──┘        state: ~/.whamming/state.json
```

- **Identity.** The CLI walks up its process tree to the Claude Code process and reads that session's file
  for its name (the one set with `/rename`, or Claude's generated name) and its process ID. Sessions are keyed
  by name; the process ID tells two sessions with the same name apart, which the dashboard flags as a
  *name clash*. A `/rename` moves the entry to the new name.
  In pi, the extension registers the session (its `/name`, or the folder name plus a short id) with pi's
  process ID, and the CLI finds it through `PI_SESSION_ID`, which pi sets for every shell command.
- **Status.** Hooks: a prompt → *working* (plus a provisional title from the prompt until the agent sets one);
  a permission prompt → *waiting*; the next tool call → *working*; the end of a turn → *idle*. Hooks never
  override a status the agent set itself (*waiting* with a question, *error*, *done*).
- **pi** maps onto the same statuses: a prompt → *working*; an extension dialog (confirm, select, input) →
  *waiting*; the run settling → *idle*; `/new`, `/resume`, `/fork` or quitting → *Exited*. pi has no
  permission prompts or subagents of its own, so those parts don't apply.
- **Exits.** Every 2 seconds the server checks each session's process and Claude's session file. Ended
  sessions move to *Exited*, release their port claims, and are kept for 3 days so a resume can merge into them.
- **Subagents** run inside their parent's process, so they can't be told apart automatically. They report
  with `--task <key>`, and the parent passes them the key when it spawns them. Port claims and queue places
  belong to the subagent (`session › task`), so two subagents of one session queue for a port like any
  two agents, and one can't release the other's port.
- **Finding the server.** While it runs, Whamming writes `~/.whamming/status.json` (`pid`, `port`, `url`,
  `version`). The CLI uses `WHAMMING_URL` / `WHAMMING_PORT`, then that file, then port 4477. A stale file
  (its process is gone) means "not running", without a network attempt. If 4477 is taken, the server uses
  the next free port. Two instances never serve the same data folder: a second one reuses the first.

## The CLI

```sh
whamming whoami                                    # resolved session name and pid
whamming update --title "Fix login redirect loop" --link https://linear.app/acme/issue/ENG-42
whamming update --status waiting --detail "Mock Stripe or keep the sandbox?"
whamming done
whamming update --task review-auth --title "Review auth middleware"   # a subagent's child row
whamming peers                                     # who else works in this folder
whamming send <session> "heads up: I'm editing src/payments"
whamming inbox
PG_PORT=$(whamming port claim --prefer 5432 --purpose postgres)      # 5432 if free, else another free port
whamming port claim 5432 --wait 10m --purpose postgres              # exactly 5432; queue for it if busy
whamming port release --all
whamming ports                                     # who holds what, and unclaimed listeners
whamming ping                                      # is Whamming running, where, which version
```

Statuses: `working`, `waiting` (needs you), `blocked` (waiting on something else: a port, CI, another agent),
`idle`, `done`, `error`. Only `waiting` and `error` notify you; `blocked` does once it has lasted 10 minutes. `--id` / `WHAMMING_SESSION` set the name for non-Claude
agents. Run `whamming --help` for everything.

## API

The server listens on `127.0.0.1` only. Requests that come from a browser page other than the dashboard
itself are rejected, and the setup endpoints (which change `~/.claude/settings.json` and `~/.local/bin`) only
accept requests from the dashboard.

| Method | Path | |
|---|---|---|
| `PUT`/`PATCH` | `/api/sessions/:id` | Create or update. `folder` (required on create), `status`, `title`, `detail`, `branch`, `name`, `agent`, `pid`, `conversationId`, `links[]`, `note`, `replaceLinks` |
| `GET` | `/api/sessions?folder=&status=&conversation=` | List (`conversation`: the agent's own session id) |
| `GET` | `/api/sessions/:id` | One session, with its activity log |
| `DELETE` | `/api/sessions/:id` | Remove |
| `DELETE` | `/api/sessions?olderThanHours=` | Prune finished (and old) sessions |
| `POST` | `/api/sessions/:id/heartbeat` | Bump `updatedAt` |
| `PUT`/`PATCH` | `/api/sessions/:id/tasks/:key` | A subagent's child row: `{title?, status?, detail?, links?, note?}` |
| `DELETE` | `/api/sessions/:id/tasks/:key` | Remove a child row |
| `GET` | `/api/peers?folder=&exclude=&excludePid=` | Sessions in the same, parent or child folder |
| `GET` | `/api/sessions/:id/peers` | Same, for a known session |
| `POST` | `/api/sessions/:id/messages` | `{from, body}`: leave a message |
| `GET` | `/api/sessions/:id/messages?unread=1&markRead=0` | Read the inbox (marks as read by default) |
| `POST` | `/api/ports/claim` | `{session, pid?, folder?, port? \| prefer?, purpose?, adopt?, wait?, waitMs?}` → `201 {lease}`, `409 {error, conflict}`, or with `wait: true` on a busy port `202 {waiting, position, heldBy}` (repeat the request to keep your place) |
| `DELETE` | `/api/ports/:port/wait?session=&pid=` | Leave the queue for a port |
| `GET` | `/api/ports` | `{leases, queues, unclaimed}` with live listener info |
| `GET` | `/api/ports/:port` | `{state: free \| claimed \| in-use}` |
| `DELETE` | `/api/ports/:port?session=&pid=` | Release a claim |
| `DELETE` | `/api/ports?session=&pid=` | Release all of a session's claims |
| `POST` | `/api/hooks/claude` | A Claude Code hook event, forwarded by `whamming hook` |
| `POST` | `/api/hooks/pi` | A pi lifecycle event, sent by the pi extension |
| `GET` | `/api/stream` | Server-sent events on every change |
| `GET` | `/api/health` | `{ok, app, version, pid, home}` |
| `GET` | `/api/info` | `{cliPath}` |
| `GET` | `/api/setup` | CLI and hooks install status |
| `POST` | `/api/setup/cli` | Install the CLI link (dashboard only) |
| `GET` | `/api/setup/hooks/preview` | The hook entries that would be added |
| `POST`/`DELETE` | `/api/setup/hooks` | Install or remove the hooks (dashboard only; backs up first) |
| `POST`/`DELETE` | `/api/setup/pi` | Link or unlink the pi extension (dashboard only) |

## Development

```sh
npm start            # build, then run the Electron app from source
npm run server       # headless server; open http://127.0.0.1:4477 in a browser
npm run demo         # fill a running instance with example sessions
npm run typecheck
npm run icons        # re-render assets/*.svg to PNG + .icns
npm run package      # build Whamming.app
```

Run a second instance next to your real one with its own data, profile and port:

```sh
WHAMMING_HOME=/tmp/wh-dev WHAMMING_USER_DATA=/tmp/wh-dev/profile WHAMMING_PORT=4499 npm start
```

| | |
|---|---|
| `src/server/` | Store (JSON persistence in `~/.whamming`), HTTP API, ports, setup, status file |
| `src/main/` | Electron shell: window, menu bar popover, Dock, notifications |
| `src/renderer/` | Dashboard and popover (TypeScript, no framework) |
| `cli/` | The `whamming` CLI (Go, no dependencies), bundled into the app |
| `src/pi/` | The pi extension, bundled into the app as `whamming-pi.js` |
| `docs/agent-instructions.md` | The snippet shown in *Agent setup* (`{{claude}}`/`{{pi}}` mark agent-specific parts) |
| `assets/` | Icons (SVG sources and rendered files) |

## License

[MIT](LICENSE)
