## Whamming — report what you're working on

A local dashboard (Whamming, http://127.0.0.1:4477) shows the human what every agent session is doing.
Keep your entry current with the `whamming` CLI. If it fails or isn't installed, carry on silently —
never block work on it.

**Identity is automatic.** The CLI uses your Claude Code session name (set by the user with `/rename`,
otherwise Claude's generated name) plus your process id. Don't pass `--id`. Run `whamming whoami` to
see it. If `update` warns about a name clash, tell the user that another running session has the same name.

**Report** — send only what changed; folder and git branch are filled in automatically:

    whamming update --title "Fix login redirect loop" --link https://linear.app/acme/issue/ENG-42

Working/idle and permission prompts are tracked automatically by Whamming's Claude Code hooks. You report:
- a one-line `--title` when you start a task, and again when the task changes.
- `--status waiting --detail "<the question>"` right BEFORE ending a turn where you need the human
  (question, approval, review). The hooks never override this.
- `--status error --detail "..."` when blocked by a failure you can't resolve.
- `whamming done` when the task is finished (PR merged, ticket closed).
(If the hooks aren't installed, also send `--status working` when you start and `--status idle` when you end a turn.)

Also report:
- Tickets, PRs and docs as soon as you have them: `--link URL` (repeatable; `URL|label` to set a label).
- Milestones: `--note "Tests green, opening PR"`.

**Subagents.** Subagents share their parent's session, so they report as child rows with `--task <key>`:
- When you spawn a subagent, give it a short kebab-case key in its prompt, e.g.
  "Report progress with `whamming update --task review-auth --title "..."` and finish with `whamming done --task review-auth`."
- If you ARE a subagent, always pass `--task <key>` (use the key you were given, or pick one and reuse it).
  Never run `update`/`done` without `--task` (that would overwrite the parent's entry), and don't read the inbox.

**Coordinate with other sessions.**
- Before editing files, see who else is in this folder (also parent/sub folders): `whamming peers`.
  Each line is: session name, status, branch, title. If work overlaps, coordinate before editing.
- Message another session by its name: `whamming send <name> "message"`.
- Check your inbox at the start of each turn: `whamming inbox`.

**Ports — claim before you bind.** Never pick a port yourself for anything you start (dev servers,
docker compose databases, test runners). Ask Whamming and use the port it returns:

    PG_PORT=$(whamming port claim --prefer 5432 --purpose "postgres (e2e)")

then wire it in, e.g. `ports: ["${PG_PORT}:5432"]` in docker compose (change only the host side).
- `--prefer N` gets N if it's free, otherwise another free port: always use the printed port.
  `whamming port claim N` insists on exactly N and fails if it's taken.
- The claim is checked against other agents' claims and against what's actually listening on the machine.
- Already started something on a fixed port? Register it: `whamming port claim N --adopt --purpose "..."`.
- Release when you tear down: `whamming port release N` (or `--all`). Claims also end with your session.
- `whamming ports` shows who holds what, and what's listening without a claim.
