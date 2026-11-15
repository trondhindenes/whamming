// Whamming extension for the pi coding agent: reports each pi session's lifecycle to the local Whamming
// dashboard, the way the Claude Code hooks do. Shipped inside Whamming.app and linked into
// ~/.pi/agent/extensions/ from Agent setup.
//
// It must never disturb pi: every request is fire-and-forget with a short timeout, errors are swallowed,
// and nothing is printed. No imports from pi itself, so it works with whatever pi version loads it.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

type Ctx = any;
type Pi = any;

const TIMEOUT_MS = 800;
const HEARTBEAT_MS = 20_000;

let cached: { url: string; at: number } | null = null;

/** Same lookup as the CLI: WHAMMING_URL / WHAMMING_PORT, then ~/.whamming/status.json, then port 4477. */
function serverUrl(): string {
  if (process.env.WHAMMING_URL) return process.env.WHAMMING_URL.replace(/\/$/, '');
  if (process.env.WHAMMING_PORT) return `http://127.0.0.1:${process.env.WHAMMING_PORT}`;
  if (cached && Date.now() - cached.at < 5000) return cached.url;
  let url = 'http://127.0.0.1:4477';
  try {
    const home = process.env.WHAMMING_HOME || join(homedir(), '.whamming');
    const st = JSON.parse(readFileSync(join(home, 'status.json'), 'utf8'));
    if (typeof st.url === 'string') url = st.url;
  } catch {
    /* not running, or an older Whamming: fall back to the default port */
  }
  cached = { url, at: Date.now() };
  return url;
}

function gitBranch(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 1000 }, (err, out) => resolve(err ? undefined : out.trim() || undefined));
  });
}

export default function whamming(pi: Pi) {
  // Send events in order (a prompt that opens and closes quickly must not arrive reversed).
  let queue: Promise<unknown> = Promise.resolve();
  let lastBeat = 0;

  function identity(ctx: Ctx) {
    const sm = ctx?.sessionManager;
    const conversationId: string | undefined = sm?.getSessionId?.();
    const cwd: string = ctx?.cwd ?? sm?.getCwd?.() ?? process.cwd();
    const named: string | undefined = sm?.getSessionName?.() ?? pi.getSessionName?.();
    // pi's session ids are time-ordered (UUIDv7), so take the random tail, not the shared prefix.
    const name = named?.trim() || `${basename(cwd)}-${(conversationId ?? String(process.pid)).replace(/-/g, '').slice(-4)}`;
    return { conversationId, cwd, name, nameSource: named?.trim() ? 'user' : 'generated' };
  }

  function send(event: string, ctx: Ctx, extra: Record<string, unknown> = {}, withBranch = false): Promise<unknown> {
    let id: ReturnType<typeof identity>;
    try {
      id = identity(ctx);
    } catch {
      return queue;
    }
    if (!id.conversationId) return queue; // ephemeral sessions have no id to track
    queue = queue
      .then(async () => {
        const branch = withBranch ? await gitBranch(id.cwd) : undefined;
        await fetch(`${serverUrl()}/api/hooks/pi`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event, pid: process.pid, ...id, ...(branch && { branch }), ...extra }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      })
      .catch(() => {
        /* Whamming isn't running: nothing to do */
      });
    return queue;
  }

  pi.on('session_start', (_e: any, ctx: Ctx) => send('SessionStart', ctx, {}, true));
  pi.on('session_info_changed', (_e: any, ctx: Ctx) => send('SessionStart', ctx)); // /name: re-register under the new name

  pi.on('before_agent_start', (e: any, ctx: Ctx) => {
    lastBeat = Date.now();
    const prompt = e?.messageType === 'user' && typeof e.prompt === 'string' ? e.prompt.slice(0, 400) : undefined;
    send('UserPromptSubmit', ctx, prompt ? { prompt } : {}, true);
  });

  // An extension dialog (confirm, select, input…) is waiting for the human.
  pi.on('ui_prompt_start', (e: any, ctx: Ctx) => {
    const title = typeof e?.title === 'string' && e.title.trim() ? e.title.trim() : '';
    send('Notification', ctx, { notificationType: 'permission_prompt', message: title ? `pi is asking: ${title}` : 'pi is waiting for your input' });
  });
  pi.on('ui_prompt_end', (_e: any, ctx: Ctx) => send(ctx?.isIdle?.() ? 'Stop' : 'PostToolUse', ctx));

  // Heartbeat during long runs, at most every 20 s.
  pi.on('tool_execution_end', (_e: any, ctx: Ctx) => {
    if (Date.now() - lastBeat < HEARTBEAT_MS) return;
    lastBeat = Date.now();
    send('PostToolUse', ctx);
  });

  // agent_end can still be followed by retries or queued messages; agent_settled is final.
  pi.on('agent_settled', (_e: any, ctx: Ctx) => send('Stop', ctx));

  pi.on('session_shutdown', (e: any, ctx: Ctx) => {
    const why: Record<string, string> = {
      quit: 'pi exited',
      new: 'Started a new session (/new)',
      resume: 'Switched to another session (/resume)',
      fork: 'Forked into a new session',
    };
    // Returned so pi waits (at most the 0.8 s timeout) before tearing the session down.
    if (e?.reason && why[e.reason]) return send('SessionEnd', ctx, { message: why[e.reason] });
  });
}
