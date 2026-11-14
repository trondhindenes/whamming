import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  STATUSES,
  type ActivityEvent,
  type Link,
  type LinkKind,
  type Message,
  type Peer,
  type PortLease,
  type PortQueue,
  type Session,
  type SessionStatus,
  type SubTask,
  type SessionView,
} from '../shared/types';

import { ALLOC_RANGE as ALLOC, claudeConversationOf } from './ports';

const MAX_ACTIVITY = 200;
/** Ended sessions are kept this long so a later `claude -r` can still merge into them. */
export const ENDED_RETENTION_MS = 3 * 24 * 3600 * 1000;
const MAX_INBOX = 200;
/** A "working" session that hasn't reported in this long is flagged stale. */
export const STALE_AFTER_MS = 15 * 60 * 1000;

export interface TaskPatch {
  title?: string;
  status?: SessionStatus;
  detail?: string;
  links?: Array<Link | string>;
  note?: string;
}

const MAX_TASKS = 30;

export interface SessionPatch {
  name?: string;
  folder?: string;
  branch?: string;
  agent?: string;
  pid?: number;
  claudeSessionId?: string;
  nameSource?: string;
  status?: SessionStatus;
  title?: string;
  detail?: string;
  /** Links are merged by URL unless replaceLinks is true. */
  links?: Array<Link | string>;
  replaceLinks?: boolean;
  /** Free-form line appended to the activity log. */
  note?: string;
  /** Defaults to "agent". */
  statusSource?: 'agent' | 'hook';
  /** Don't log working/idle transitions in the activity feed (hooks flip these every turn). */
  quiet?: boolean;
}

/** A Claude Code hook event, as forwarded by `whamming hook`. */
export interface HookEvent {
  event: string;
  name: string;
  nameSource?: string;
  pid: number;
  claudeSessionId: string;
  cwd: string;
  branch?: string;
  prompt?: string;
  message?: string;
  notificationType?: string;
  source?: string;
}

interface PersistedState {
  sessions: Session[];
  inbox: Record<string, Message[]>;
  leases?: PortLease[];
}

export class ValidationError extends Error {}

export interface ClaimRequest {
  /** Demand exactly this port. */
  port?: number;
  /** Try this port first, fall back to any free one. */
  prefer?: number;
  purpose?: string;
  /** Register a port that's already in use (skip the OS check, still respect other claims). */
  adopt?: boolean;
  /** Subagent task key: the claim belongs to that subagent, not the whole session. */
  task?: string;
}

export interface PortConflictInfo {
  port: number;
  reason: 'claimed' | 'in-use' | 'queued';
  /** Session holding the claim, when reason is "claimed". */
  heldBy?: { session: string; purpose?: string; folder?: string };
}

export class PortConflict extends Error {
  constructor(public info: PortConflictInfo) {
    super(
      info.reason === 'claimed'
        ? `port ${info.port} is claimed by session "${info.heldBy?.session}"${info.heldBy?.purpose ? ` (${info.heldBy.purpose})` : ''}`
        : info.reason === 'queued'
          ? `port ${info.port} has other agents waiting for it; join the queue with --wait`
          : `port ${info.port} is already in use on this machine`,
    );
  }
}

export class DeadlockError extends Error {}

/** An agent waiting for a busy port. Lives only in memory; waits end if Whamming restarts. */
interface Waiter {
  session: string;
  /** Subagent task key, when a subagent waits (subagents share their parent's session). */
  task?: string;
  port: number;
  purpose?: string;
  since: string;
  /** Last time the waiting client was seen (a long-poll arriving or ending). Expired after WAITER_TTL_MS. */
  lastSeen: number;
  /** Set while a long-poll is attached: called with the lease when the port is granted. */
  notify?: (lease: PortLease) => void;
}
const WAITER_TTL_MS = 10_000;

/** Who holds or wants a port: a session, or one subagent task inside it. */
export interface Owner {
  session: string;
  task?: string;
}
const ownerKey = (o: Owner) => (o.task ? `${o.session} › ${o.task}` : o.session);
const ownerLabel = ownerKey;
const sameOwner = (a: Owner, b: Owner) => a.session === b.session && (a.task || undefined) === (b.task || undefined);

function validPort(n: unknown, field: string): number {
  const p = Number(n);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new ValidationError(`${field} must be a port number (1-65535)`);
  return p;
}

export function normalizeFolder(folder: string): string {
  const r = resolve(folder);
  return r.length > 1 && r.endsWith(sep) ? r.slice(0, -1) : r;
}

export function inferLinkKind(url: string): LinkKind {
  if (/github\.com\/[^/]+\/[^/]+\/pull\/\d+|gitlab\.[^/]+\/.+\/merge_requests\/\d+|bitbucket\.org\/.+\/pull-requests\/\d+/.test(url)) return 'pr';
  if (/linear\.app\/.+\/issue\/|atlassian\.net\/browse\/|github\.com\/[^/]+\/[^/]+\/issues\/\d+|\/browse\/[A-Z]+-\d+|shortcut\.com\/.+\/story\//.test(url)) return 'ticket';
  if (/docs\.google\.com|notion\.so|confluence|\.md($|[?#])/.test(url)) return 'doc';
  return 'other';
}

export function defaultLinkLabel(url: string, kind: LinkKind): string {
  let m: RegExpMatchArray | null;
  if ((m = url.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/))) return `${m[1]}#${m[2]}`;
  if ((m = url.match(/github\.com\/[^/]+\/([^/]+)\/issues\/(\d+)/))) return `${m[1]}#${m[2]}`;
  if ((m = url.match(/merge_requests\/(\d+)/))) return `!${m[1]}`;
  if ((m = url.match(/\b([A-Z][A-Z0-9]+-\d+)\b/))) return m[1];
  if ((m = url.match(/linear\.app\/[^/]+\/issue\/([a-z0-9]+-\d+)/i))) return m[1].toUpperCase();
  try {
    const u = new URL(url);
    return kind === 'other' ? u.hostname.replace(/^www\./, '') : u.hostname.replace(/^www\./, '') + u.pathname.slice(0, 24);
  } catch {
    return url;
  }
}

function normalizeLink(input: Link | string): Link {
  const link: Link = typeof input === 'string' ? { url: input } : { ...input };
  if (!link.url || typeof link.url !== 'string') throw new ValidationError('link.url is required');
  let parsed: URL;
  try {
    parsed = new URL(link.url);
  } catch {
    throw new ValidationError(`invalid link url: ${link.url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ValidationError(`link must be http(s): ${link.url}`);
  link.kind = link.kind ?? inferLinkKind(link.url);
  link.label = link.label?.trim() || defaultLinkLabel(link.url, link.kind);
  return link;
}

/** Same-machine liveness check. EPERM means the process exists but belongs to someone else. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

export interface UpsertResult {
  session: Session;
  created: boolean;
  previousStatus?: SessionStatus;
  /** Set when the session was stored under a different id than requested. */
  warning?: string;
}

function relation(a: string, b: string): Peer['relation'] | null {
  if (a === b) return 'same';
  if (b.startsWith(a + sep)) return 'child'; // b is inside a
  if (a.startsWith(b + sep)) return 'parent'; // b contains a
  return null;
}

export class Store extends EventEmitter {
  private sessions = new Map<string, Session>();
  private inbox = new Map<string, Message[]>();
  private leases = new Map<number, PortLease>();
  /** Claims are check-then-write across an async OS probe; run them one at a time. */
  private claimQueue: Promise<unknown> = Promise.resolve();
  /** Ports agents are waiting for, in FIFO order. */
  private queues = new Map<number, Waiter[]>();
  /** What a session was doing before it started waiting, to restore afterwards. */
  private beforeWait = new Map<string, { status: SessionStatus; detail?: string; statusSource?: Session['statusSource'] }>(); // by owner key
  /** OS check used when granting queued ports. Set by the API layer. */
  private portProbe: (port: number) => Promise<boolean> = async () => true;
  private allocCursor = 0;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {
    super();
    this.load();
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const state = JSON.parse(readFileSync(this.file, 'utf8')) as PersistedState;
      for (const s of state.sessions ?? []) this.sessions.set(s.id, s);
      for (const [id, msgs] of Object.entries(state.inbox ?? {})) this.inbox.set(id, msgs);
      for (const l of state.leases ?? []) this.leases.set(l.port, l);
    } catch (err) {
      console.error(`[whamming] could not read ${this.file}, starting empty:`, err);
    }
  }

  private changed(kind: string, id?: string) {
    this.emit('change', { kind, id });
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 250);
  }

  flush() {
    const state: PersistedState = {
      sessions: [...this.sessions.values()],
      inbox: Object.fromEntries(this.inbox),
      leases: [...this.leases.values()],
    };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.file);
  }

  view(s: Session, withActivity = false): SessionView {
    const { activity, ...rest } = s;
    const stale = s.status === 'working' && Date.now() - Date.parse(s.updatedAt) > STALE_AFTER_MS;
    const unread = (this.inbox.get(s.id) ?? []).filter((m) => !m.read).length;
    const alive = s.endedAt ? false : s.pid !== undefined ? isAlive(s.pid) : undefined;
    const conflicts =
      alive === false || s.status === 'done'
        ? []
        : [...this.sessions.values()]
            .filter((o) => o.id !== s.id && o.name === s.name && o.status !== 'done' && (o.pid === undefined || isAlive(o.pid)))
            .map((o) => o.id);
    const ports = this.leasesOf(s.id).map((l) => l.port);
    const base = { ...rest, stale: stale && alive !== false, alive, conflicts, unread, ports };
    return withActivity ? { ...base, activity } : base;
  }

  list(filter: { folder?: string; status?: string } = {}): SessionView[] {
    let all = [...this.sessions.values()];
    if (filter.folder) {
      const f = normalizeFolder(filter.folder);
      all = all.filter((s) => s.folder === f);
    }
    if (filter.status) {
      const wanted = new Set(filter.status.split(','));
      all = all.filter((s) => wanted.has(s.status));
    }
    return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((s) => this.view(s));
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** The session currently owned by this process, if any. */
  findByPid(pid: number, claudeSessionId?: string): Session | undefined {
    for (const s of this.sessions.values()) {
      if (s.pid !== pid) continue;
      // Same PID but a different Claude session: the OS reused the PID.
      if (claudeSessionId && s.claudeSessionId && s.claudeSessionId !== claudeSessionId) continue;
      return s;
    }
    return undefined;
  }

  /** An entry from the same Claude conversation whose process has exited: it was resumed (`claude -r`). */
  private findResumed(claudeSessionId?: string, exceptId?: string): Session | undefined {
    if (!claudeSessionId) return undefined;
    for (const s of this.sessions.values()) {
      if (s.id !== exceptId && s.claudeSessionId === claudeSessionId && (s.endedAt || s.pid === undefined || !isAlive(s.pid))) return s;
    }
    return undefined;
  }

  /** Fold an exited entry of the same conversation into `into`, so a resume doesn't leave a duplicate behind. */
  private mergeInto(into: Session, from: Session) {
    for (const l of from.links) if (!into.links.some((x) => x.url === l.url)) into.links.push(l);
    for (const t of from.tasks ?? []) if (!into.tasks?.some((x) => x.key === t.key)) (into.tasks ??= []).push(t);
    into.activity = [...from.activity, ...into.activity].sort((a, b) => a.at.localeCompare(b.at)).slice(-MAX_ACTIVITY);
    if (from.createdAt < into.createdAt) into.createdAt = from.createdAt;
    const box = [...(this.inbox.get(from.id) ?? []), ...(this.inbox.get(into.id) ?? [])].sort((a, b) => a.at.localeCompare(b.at));
    if (box.length) this.inbox.set(into.id, box.slice(-MAX_INBOX));
    this.remove(from.id);
  }

  /** Map a requested id (+ optional pid) to the id that session is actually stored under. */
  resolveId(id: string, pid?: number): string {
    if (pid !== undefined) {
      const mine = this.findByPid(pid);
      if (mine) return mine.id;
    }
    return id;
  }

  /** Can a process with `pid` claim the name currently held by `holder`? */
  private canClaim(holder: Session | undefined, pid: number | undefined, claudeSessionId?: string): boolean {
    if (!holder || pid === undefined) return true;
    if (holder.pid === undefined || holder.pid === pid) return true;
    if (claudeSessionId && holder.claudeSessionId === claudeSessionId) return true; // resumed in a new process
    return !isAlive(holder.pid) || holder.status === 'done';
  }

  private rekey(s: Session, newId: string) {
    const box = this.inbox.get(s.id);
    this.sessions.delete(s.id);
    this.inbox.delete(s.id);
    for (const l of this.leases.values()) if (l.session === s.id) l.session = newId;
    s.id = newId;
    this.sessions.set(newId, s);
    if (box) this.inbox.set(newId, box);
  }

  upsert(requestedId: string, patch: SessionPatch): UpsertResult {
    if (!requestedId || !/^[\w.:@-]{1,128}$/.test(requestedId)) throw new ValidationError('session id must be 1-128 chars of [A-Za-z0-9_.:@-]');
    if (patch.pid !== undefined && (!Number.isInteger(patch.pid) || patch.pid <= 0)) throw new ValidationError('pid must be a positive integer');
    if (patch.status !== undefined && !STATUSES.includes(patch.status)) {
      throw new ValidationError(`status must be one of: ${STATUSES.join(', ')}`);
    }

    const now = new Date().toISOString();
    const { pid, claudeSessionId } = patch;
    const events: ActivityEvent[] = [];
    let warning: string | undefined;

    // Identity: the name (requestedId) is the key, the pid tells processes apart.
    const holder = this.sessions.get(requestedId);
    // Same process, or the same conversation resumed in a new process (possibly under a new name).
    const mine = pid !== undefined ? (this.findByPid(pid, claudeSessionId) ?? this.findResumed(claudeSessionId)) : undefined;
    const resumedFrom = mine && pid !== undefined && mine.pid !== undefined && mine.pid !== pid ? mine.pid : undefined;
    let id = requestedId;
    let existing: Session | undefined;

    if (mine && mine.id === requestedId) {
      existing = mine;
      if (resumedFrom) events.push({ at: now, message: `Resumed in pid ${pid} (was ${resumedFrom})` });
    } else if (mine) {
      // This process already has an entry under another id: it was renamed (or was parked on name@pid).
      if (this.canClaim(holder, pid, claudeSessionId)) {
        if (holder) this.remove(holder.id);
        events.push({ at: now, message: resumedFrom ? `Resumed in pid ${pid} (was ${mine.id}, pid ${resumedFrom})` : `Renamed from ${mine.id}` });
        this.rekey(mine, requestedId);
        existing = mine;
      } else {
        existing = mine;
        id = mine.id;
      }
    } else if (this.canClaim(holder, pid, claudeSessionId)) {
      const differentSession = !!(holder && claudeSessionId && holder.claudeSessionId && holder.claudeSessionId !== claudeSessionId);
      if (holder && differentSession) {
        this.remove(holder.id); // a new session reusing a dead session's name starts fresh
      } else {
        existing = holder; // free, same process, or the same session resumed in a new process
        if (holder?.pid !== undefined && pid !== undefined && holder.pid !== pid) {
          events.push({ at: now, message: `Resumed in pid ${pid} (was ${holder.pid})` });
        }
      }
    } else {
      id = `${requestedId}@${pid}`;
      existing = this.sessions.get(id);
    }
    if (id !== requestedId) {
      const other = this.sessions.get(requestedId)!;
      warning = `name "${requestedId}" is already used by pid ${other.pid} in ${other.folder}; stored as "${id}". Rename one of the sessions to tell them apart.`;
    }
    if (!existing && !patch.folder) throw new ValidationError('folder is required when creating a session');

    const s: Session = existing ?? {
      id,
      name: requestedId,
      folder: '',
      folderName: '',
      status: 'working',
      links: [],
      createdAt: now,
      updatedAt: now,
      activity: [],
    };
    const previousStatus = existing?.status;
    if (!patch.name) s.name = requestedId;
    if (pid !== undefined) s.pid = pid;
    if (claudeSessionId) s.claudeSessionId = claudeSessionId;
    if (s.endedAt && (s.pid === undefined || isAlive(s.pid))) delete s.endedAt; // reporting again: it's back
    if (patch.nameSource) s.nameSource = patch.nameSource;

    if (patch.folder !== undefined) {
      s.folder = normalizeFolder(patch.folder);
      s.folderName = basename(s.folder) || s.folder;
    }
    if (patch.name) s.name = patch.name.trim() || requestedId;
    if (patch.branch !== undefined) s.branch = patch.branch || undefined;
    if (patch.agent !== undefined) s.agent = patch.agent || undefined;
    if (patch.detail !== undefined) s.detail = patch.detail || undefined;
    if (patch.title !== undefined && patch.title !== s.title) {
      s.title = patch.title || undefined;
      if (s.title) events.push({ at: now, message: s.title });
    }
    if (patch.status !== undefined) s.statusSource = patch.statusSource ?? 'agent';
    if (patch.status !== undefined && (patch.status !== s.status || !existing)) {
      s.status = patch.status;
      s.statusSince = now;
      if (!existing) events.unshift({ at: now, status: s.status, message: 'Session started' });
      else if (!(patch.quiet && (s.status === 'working' || s.status === 'idle'))) {
        events.push({ at: now, status: s.status, message: `Status → ${s.status}` });
      }
    } else if (!existing) {
      events.unshift({ at: now, status: s.status, message: 'Session started' });
    }
    if (patch.links) {
      const incoming = patch.links.map(normalizeLink);
      if (patch.replaceLinks) {
        s.links = incoming;
      } else {
        for (const l of incoming) {
          const i = s.links.findIndex((x) => x.url === l.url);
          if (i >= 0) s.links[i] = { ...s.links[i], ...l };
          else {
            s.links.push(l);
            events.push({ at: now, message: `Linked ${l.label}` });
          }
        }
      }
    }
    if (patch.note) events.push({ at: now, message: patch.note });
    if (patch.status === 'done' && existing) {
      const freed = this.dropLeases(existing.id);
      if (freed.length) events.push({ at: now, message: `Released ${freed.map((p) => `:${p}`).join(' ')}` });
    }

    s.updatedAt = now;
    s.activity = [...s.activity, ...events].slice(-MAX_ACTIVITY);
    this.sessions.set(id, s);
    // Clean up duplicates a resume left behind before this fix (or in a race).
    for (let dup = this.findResumed(s.claudeSessionId, s.id); dup; dup = this.findResumed(s.claudeSessionId, s.id)) {
      this.mergeInto(s, dup);
      s.activity = [...s.activity, { at: now, message: `Merged earlier entry ${dup.id} (same conversation)` }].slice(-MAX_ACTIVITY);
    }
    this.changed(existing ? 'updated' : 'created', id);
    return { session: s, created: !existing, previousStatus, warning };
  }

  touch(id: string): Session | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    s.updatedAt = new Date().toISOString();
    this.changed('heartbeat', id);
    return s;
  }

  remove(id: string): boolean {
    const had = this.sessions.delete(id);
    this.inbox.delete(id);
    this.dropLeases(id);
    if (had) this.changed('removed', id);
    return had;
  }

  /** Remove sessions marked done (or untouched for `olderThanMs`). */
  prune(olderThanMs?: number): number {
    let n = 0;
    for (const s of [...this.sessions.values()]) {
      const old = olderThanMs !== undefined && Date.now() - Date.parse(s.updatedAt) > olderThanMs;
      if (s.status === 'done' || old) {
        this.sessions.delete(s.id);
        this.inbox.delete(s.id);
        this.dropLeases(s.id);
        n++;
      }
    }
    if (n) this.changed('pruned');
    return n;
  }

  peers(folder: string, excludeId?: string, excludePid?: number): Peer[] {
    const f = normalizeFolder(folder);
    const out: Peer[] = [];
    for (const s of this.sessions.values()) {
      if (s.id === excludeId || (excludePid !== undefined && s.pid === excludePid) || s.status === 'done') continue;
      if (s.pid !== undefined && !isAlive(s.pid)) continue; // can't coordinate with an exited process
      const rel = relation(f, s.folder);
      if (!rel) continue;
      out.push({ id: s.id, name: s.name, folder: s.folder, status: s.status, title: s.title, branch: s.branch, pid: s.pid, relation: rel });
    }
    return out;
  }

  send(to: string, from: string, body: string): Message {
    if (!this.sessions.has(to)) throw new ValidationError(`no such session: ${to}`);
    if (!body?.trim()) throw new ValidationError('body is required');
    const msg: Message = { id: randomUUID(), from: from || 'human', to, body, at: new Date().toISOString(), read: false };
    const box = [...(this.inbox.get(to) ?? []), msg].slice(-MAX_INBOX);
    this.inbox.set(to, box);
    this.changed('message', to);
    return msg;
  }

  messages(id: string, opts: { unreadOnly?: boolean; markRead?: boolean } = {}): Message[] {
    const box = this.inbox.get(id) ?? [];
    const result = (opts.unreadOnly ? box.filter((m) => !m.read) : box).map((m) => ({ ...m }));
    if (opts.markRead && result.some((m) => !m.read)) {
      for (const m of box) m.read = true;
      this.changed('read', id);
    }
    return result;
  }

  // ---------- Claude Code hooks ----------

  /**
   * Turn a hook event into a status change. Hooks keep working/idle accurate without the agent
   * having to remember, but never override a status the agent set itself (waiting with a question,
   * error, done) except to clear a "waiting" that a permission prompt caused.
   */
  applyHook(h: HookEvent): Session | undefined {
    if (!h.pid || !h.claudeSessionId || !h.cwd || !h.name) throw new ValidationError('hook event needs pid, claudeSessionId, cwd and name');
    const cur = this.findByPid(h.pid, h.claudeSessionId);
    const base: SessionPatch = {
      folder: h.cwd,
      pid: h.pid,
      claudeSessionId: h.claudeSessionId,
      nameSource: h.nameSource,
      agent: 'claude-code',
      statusSource: 'hook',
      quiet: true,
      ...(h.branch && { branch: h.branch }),
    };
    const hookWaiting = cur?.status === 'waiting' && cur.statusSource === 'hook';
    let patch: SessionPatch | null = null;

    switch (h.event) {
      case 'SessionStart':
        patch = cur ? base : { ...base, status: 'idle' };
        break;
      case 'UserPromptSubmit': {
        patch = { ...base, status: 'working' };
        // Answering a question / retrying after an error: the old detail no longer applies.
        if (cur && (cur.status === 'waiting' || cur.status === 'error')) patch.detail = '';
        // Until the agent reports a proper title, show what was asked.
        const first = h.prompt?.trim().split('\n')[0]?.trim();
        if (!cur?.title && first && !first.startsWith('/')) patch.title = first.length > 80 ? first.slice(0, 79) + '…' : first;
        break;
      }
      case 'Notification': {
        const permission = h.notificationType === 'permission_prompt' || (!h.notificationType && /permission/i.test(h.message ?? ''));
        if (permission) patch = { ...base, status: 'waiting', detail: h.message || 'Needs your permission', quiet: false };
        else if (!cur) patch = { ...base, status: 'idle' }; // e.g. "waiting for your input": just make sure it's registered
        break;
      }
      case 'PostToolUse':
        if (hookWaiting) patch = { ...base, status: 'working', detail: '' }; // permission granted, carrying on
        else if (cur) {
          this.touch(cur.id); // heartbeat during long turns
          return cur;
        } else patch = { ...base, status: 'working' };
        break;
      case 'Stop':
        if (!cur) patch = { ...base, status: 'idle' };
        else if (cur.status === 'working' || hookWaiting) patch = { ...base, status: 'idle', ...(hookWaiting && { detail: '' }) };
        else patch = base; // the agent said waiting/error/done: keep it
        break;
      default:
        return cur;
    }
    if (!patch) return cur;
    return this.upsert(h.name, patch).session;
  }

  // ---------- process lifecycle ----------

  /**
   * Notice agents that went away without saying so (Ctrl-C, crash, closed terminal, /clear).
   * Cheap enough to run every couple of seconds: one kill(pid, 0) and one small file read per live session.
   */
  reap(now = Date.now()): { ended: string[]; pruned: string[] } {
    const ended: string[] = [];
    const pruned: string[] = [];
    for (const s of [...this.sessions.values()]) {
      if (s.endedAt) {
        if (now - Date.parse(s.endedAt) > ENDED_RETENTION_MS) {
          this.remove(s.id);
          pruned.push(s.id);
        }
        continue;
      }
      if (s.pid === undefined) continue;
      let why: string | undefined;
      if (!isAlive(s.pid)) why = 'Process exited';
      else if (s.claudeSessionId) {
        const current = claudeConversationOf(s.pid);
        if (current && current !== s.claudeSessionId) why = 'Conversation replaced in the same process (/clear or /resume)';
      }
      if (!why) continue;
      const at = new Date(now).toISOString();
      s.endedAt = at;
      const freed = this.leasesOf(s.id).map((l) => l.port);
      for (const p of freed) this.leases.delete(p);
      s.activity = [
        ...s.activity,
        { at, message: why },
        ...(freed.length ? [{ at, message: `Released ${freed.map((p) => `:${p}`).join(' ')}` }] : []),
      ].slice(-MAX_ACTIVITY);
      this.changed('ended', s.id);
      ended.push(s.id);
    }
    return { ended, pruned };
  }

  /** Run reap() on an interval. Returns a stop function. */
  startReaper(intervalMs = 2000): () => void {
    this.reap();
    const t = setInterval(() => {
      this.reap();
      if (this.queues.size) void this.pumpQueues();
    }, intervalMs);
    t.unref();
    return () => clearInterval(t);
  }

  // ---------- subagent tasks ----------

  /** Create or update a subagent's child row. Never touches the parent's own title/status. */
  upsertTask(sessionId: string, key: string, patch: TaskPatch): SubTask {
    const s = this.sessions.get(sessionId);
    if (!s) throw new ValidationError(`no such session: ${sessionId}`);
    if (!/^[\w.:-]{1,64}$/.test(key)) throw new ValidationError('task key must be 1-64 chars of [A-Za-z0-9_.:-]');
    if (patch.status !== undefined && !STATUSES.includes(patch.status)) throw new ValidationError(`status must be one of: ${STATUSES.join(', ')}`);

    const now = new Date().toISOString();
    const tasks = (s.tasks ??= []);
    let t = tasks.find((x) => x.key === key);
    const events: ActivityEvent[] = [];
    if (!t) {
      t = { key, status: patch.status ?? 'working', links: [], createdAt: now, updatedAt: now };
      tasks.push(t);
      events.push({ at: now, message: `Subagent ${key} started${patch.title ? `: ${patch.title}` : ''}` });
    } else if (patch.status !== undefined && patch.status !== t.status) {
      events.push({ at: now, status: patch.status, message: `Subagent ${key} → ${patch.status}` });
    }
    if (patch.status !== undefined) t.status = patch.status;
    if (patch.title !== undefined) t.title = patch.title || undefined;
    if (patch.detail !== undefined) t.detail = patch.detail || undefined;
    if (patch.links) for (const l of patch.links.map(normalizeLink)) if (!t.links.some((x) => x.url === l.url)) t.links.push(l);
    if (patch.note) events.push({ at: now, message: `[${key}] ${patch.note}` });
    t.updatedAt = now;

    // Keep the list bounded: drop the oldest finished tasks first.
    while (tasks.length > MAX_TASKS) {
      const i = tasks.findIndex((x) => x.status === 'done');
      tasks.splice(i >= 0 ? i : 0, 1);
    }
    s.updatedAt = now; // a busy subagent means the session is alive
    s.activity = [...s.activity, ...events].slice(-MAX_ACTIVITY);
    this.changed('task', s.id);
    return t;
  }

  removeTask(sessionId: string, key: string): boolean {
    const s = this.sessions.get(sessionId);
    const i = s?.tasks?.findIndex((t) => t.key === key) ?? -1;
    if (!s || i < 0) return false;
    s.tasks!.splice(i, 1);
    this.changed('task', s.id);
    return true;
  }

  // ---------- ports ----------

  leasesOf(sessionId: string): PortLease[] {
    return [...this.leases.values()].filter((l) => l.session === sessionId).sort((a, b) => a.port - b.port);
  }

  allLeases(): PortLease[] {
    return [...this.leases.values()].sort((a, b) => a.port - b.port);
  }

  getLease(port: number): PortLease | undefined {
    return this.leases.get(port);
  }

  /** A claim counts while its session exists, isn't done, and its process (if known) is running. */
  leaseOwnerAlive(l: PortLease): boolean {
    const s = this.sessions.get(l.session);
    if (!s || s.status === 'done' || s.endedAt) return false;
    return s.pid === undefined || isAlive(s.pid);
  }

  private dropLeases(sessionId: string): number[] {
    const freed: number[] = [];
    for (const l of [...this.leases.values()]) {
      if (l.session === sessionId) {
        this.leases.delete(l.port);
        freed.push(l.port);
      }
    }
    if (freed.length) {
      this.changed('ports', sessionId);
      void this.pumpQueues();
    }
    return freed;
  }

  /**
   * Claim a port for a session. `isFree` probes the OS, so a port held by something Whamming
   * doesn't know about (a Homebrew postgres, a leftover container) is never handed out.
   */
  claimPort(sessionId: string, req: ClaimRequest, isFree: (port: number) => Promise<boolean>): Promise<{ lease: PortLease; created: boolean }> {
    const run = this.claimQueue.then(() => this.doClaim(sessionId, req, isFree));
    this.claimQueue = run.catch(() => {});
    return run;
  }

  private async doClaim(sessionId: string, req: ClaimRequest, isFree: (port: number) => Promise<boolean>) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new ValidationError(`no such session: ${sessionId}`);
    const me: Owner = { session: s.id, task: req.task || undefined };
    const exact = req.port !== undefined ? validPort(req.port, 'port') : undefined;
    const prefer = req.prefer !== undefined ? validPort(req.prefer, 'prefer') : undefined;
    if (req.adopt && exact === undefined) throw new ValidationError('adopt needs an exact port');

    const candidates = function* (this: Store): Generator<number> {
      if (exact !== undefined) return yield exact;
      if (prefer !== undefined) yield prefer;
      const { from, to } = ALLOC;
      const span = to - from + 1;
      for (let i = 0; i < span; i++) yield from + ((this.allocCursor + i) % span);
    }.call(this);

    let tried = 0;
    for (const port of candidates) {
      if (++tried > 300) break;
      const held = this.leases.get(port);
      if (held && sameOwner(held, me)) {
        if (req.purpose && held.purpose !== req.purpose) {
          held.purpose = req.purpose;
          this.changed('ports', s.id);
        }
        return { lease: held, created: false };
      }
      const explicit = port === exact || port === prefer;
      // Agents queued for this port go first; nobody jumps the queue.
      const queue = this.queues.get(port);
      if (queue?.length && !sameOwner(queue[0], me)) {
        if (port === exact) throw new PortConflict({ port, reason: 'queued' });
        continue;
      }
      if (held && this.leaseOwnerAlive(held)) {
        if (port === exact) {
          const h = this.sessions.get(held.session);
          throw new PortConflict({ port, reason: 'claimed', heldBy: { session: ownerLabel(held), purpose: held.purpose, folder: h?.folder } });
        }
        continue;
      }
      if (!req.adopt && !(await isFree(port))) {
        if (port === exact) throw new PortConflict({ port, reason: 'in-use' });
        continue;
      }
      if (held) this.leases.delete(port); // stale claim from an exited session
      if (!explicit) this.allocCursor = port - ALLOC.from + 1;

      const lease: PortLease = {
        port,
        session: s.id,
        ...(me.task && { task: me.task }),
        purpose: req.purpose || undefined,
        claimedAt: new Date().toISOString(),
        ...(req.adopt && { adopted: true }),
      };
      this.leases.set(port, lease);
      this.log(s, `${me.task ? `[${me.task}] ` : ''}Claimed :${port}${lease.purpose ? ` for ${lease.purpose}` : ''}`);
      if (queue?.[0] && sameOwner(queue[0], me)) this.finishWait(queue[0], `Got :${port}`);
      this.changed('ports', s.id);
      return { lease, created: true };
    }
    throw new ValidationError('no free port found');
  }

  private log(s: Session, message: string, status?: SessionStatus) {
    s.activity = [...s.activity, { at: new Date().toISOString(), message, ...(status && { status }) }].slice(-MAX_ACTIVITY);
  }

  // ---------- waiting for busy ports ----------

  setPortProbe(fn: (port: number) => Promise<boolean>) {
    this.portProbe = fn;
  }

  queuesSnapshot(): PortQueue[] {
    return [...this.queues.entries()]
      .filter(([, q]) => q.length)
      .map(([port, q]) => ({ port, waiters: q.map((w) => ({ session: w.session, ...(w.task && { task: w.task }), purpose: w.purpose, since: w.since })) }))
      .sort((a, b) => a.port - b.port);
  }

  positionOf(owner: Owner, port: number): number {
    return (this.queues.get(port) ?? []).findIndex((w) => sameOwner(w, owner)) + 1;
  }

  /** Owners that `owner` is currently waiting on: the holders of ports it queues for, and anyone ahead of it. */
  private waitsOn(owner: string): Set<string> {
    const out = new Set<string>();
    for (const [port, q] of this.queues) {
      const i = q.findIndex((w) => ownerKey(w) === owner);
      if (i < 0) continue;
      const held = this.leases.get(port);
      if (held && this.leaseOwnerAlive(held)) out.add(ownerKey(held));
      for (const w of q.slice(0, i)) out.add(ownerKey(w));
    }
    out.delete(owner);
    return out;
  }

  /** Would `owner` waiting for `port` close a cycle (A waits for B, B waits for A)? Returns the cycle if so. */
  private findDeadlock(owner: string, port: number): string[] | null {
    const first = new Set<string>();
    const held = this.leases.get(port);
    if (held && this.leaseOwnerAlive(held)) first.add(ownerKey(held));
    for (const w of this.queues.get(port) ?? []) if (ownerKey(w) !== owner) first.add(ownerKey(w));
    const seen = new Set<string>();
    const dfs = (at: string, path: string[]): string[] | null => {
      if (at === owner) return path;
      if (seen.has(at)) return null;
      seen.add(at);
      for (const next of this.waitsOn(at)) {
        const found = dfs(next, [...path, next]);
        if (found) return found;
      }
      return null;
    };
    for (const f of first) {
      if (f === owner) continue;
      const found = dfs(f, [f]);
      if (found) return found;
    }
    return null;
  }

  /** Mark a waiting owner as blocked: a subagent's child row, or the session itself. Remembers what to restore. */
  private setBlocked(s: Session, owner: Owner, detail: string) {
    const key = ownerKey(owner);
    const now = new Date().toISOString();
    if (owner.task) {
      const t = (s.tasks ??= []).find((x) => x.key === owner.task) ?? this.upsertTask(s.id, owner.task, {});
      if (!this.beforeWait.has(key)) this.beforeWait.set(key, { status: t.status, detail: t.detail });
      t.status = 'blocked';
      t.detail = detail;
      t.updatedAt = now;
      return;
    }
    if (!this.beforeWait.has(key)) this.beforeWait.set(key, { status: s.status, detail: s.detail, statusSource: s.statusSource });
    s.status = 'blocked';
    s.statusSource = 'wait';
    s.statusSince = now;
    s.detail = detail;
  }

  private clearBlocked(s: Session, owner: Owner) {
    const key = ownerKey(owner);
    const prev = this.beforeWait.get(key);
    this.beforeWait.delete(key);
    const now = new Date().toISOString();
    if (owner.task) {
      const t = s.tasks?.find((x) => x.key === owner.task);
      if (t && t.status === 'blocked') {
        t.status = prev?.status && prev.status !== 'blocked' ? prev.status : 'working';
        t.detail = prev?.detail;
        t.updatedAt = now;
      }
      return;
    }
    if (s.status === 'blocked' && s.statusSource === 'wait') {
      s.status = prev?.status && prev.status !== 'blocked' ? prev.status : 'working';
      s.detail = prev?.detail;
      s.statusSource = prev?.statusSource ?? 'agent';
      s.statusSince = now;
    }
  }

  /**
   * Join (or rejoin) the queue for `port`. The waiter shows as "blocked" (a subagent's child row, or the
   * session) while it waits, and whoever holds the port gets an inbox message so it can release early.
   */
  enqueue(owner: Owner, port: number, purpose: string | undefined, heldByText: string): { waiter: Waiter; created: boolean } {
    const s = this.sessions.get(owner.session);
    if (!s) throw new ValidationError(`no such session: ${owner.session}`);
    const q = this.queues.get(port) ?? [];
    const existing = q.find((w) => sameOwner(w, owner));
    if (existing) {
      existing.lastSeen = Date.now();
      return { waiter: existing, created: false };
    }
    const key = ownerKey(owner);
    const cycle = this.findDeadlock(key, port);
    if (cycle) {
      throw new DeadlockError(
        `waiting for :${port} would deadlock: ${[key, ...cycle].join(' → ')} are all waiting on each other. Release a port or pick another one.`,
      );
    }
    const now = new Date().toISOString();
    const w: Waiter = { session: owner.session, ...(owner.task && { task: owner.task }), port, purpose: purpose || undefined, since: now, lastSeen: Date.now() };
    q.push(w);
    this.queues.set(port, q);

    const detail = `Waiting for :${port} (${heldByText})`;
    this.setBlocked(s, owner, detail);
    this.log(s, `${owner.task ? `[${owner.task}] ` : ''}${detail}`, owner.task ? undefined : 'blocked');

    const held = this.leases.get(port);
    if (held && !sameOwner(held, owner) && this.sessions.has(held.session) && this.leaseOwnerAlive(held)) {
      const yours = held.task ? `your subagent ${held.task} holds` : 'you hold';
      this.send(
        held.session,
        'whamming',
        `${ownerLabel(owner)} is waiting for :${port}${purpose ? ` (${purpose})` : ''}, which ${yours}${held.purpose ? ` for ${held.purpose}` : ''}. ` +
          `Release it as soon as you're done: whamming port release ${port}${held.task ? ` --task ${held.task}` : ''}`,
      );
    }
    this.changed('ports', owner.session);
    void this.pumpQueues(); // it may already be free
    return { waiter: w, created: true };
  }

  /** Hold a long-poll until the port is granted (returns the lease) or `ms` passes (returns null). */
  waitForGrant(w: Waiter, ms: number): Promise<PortLease | null> {
    const granted = this.leases.get(w.port);
    if (granted && sameOwner(granted, w)) return Promise.resolve(granted);
    w.lastSeen = Date.now();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (w.notify === done) w.notify = undefined;
        w.lastSeen = Date.now();
        resolve(null);
      }, ms);
      const done = (lease: PortLease) => {
        clearTimeout(timer);
        resolve(lease);
      };
      w.notify = done;
    });
  }

  /** The waiting client gave up (timeout, Ctrl-C). */
  cancelWait(owner: Owner, port: number): boolean {
    const w = this.queues.get(port)?.find((x) => sameOwner(x, owner));
    if (!w) return false;
    this.finishWait(w, `Gave up waiting for :${port}`);
    void this.pumpQueues();
    return true;
  }

  /** Remove a waiter and, if it has no other waits, put its status back to what it was. */
  private finishWait(w: Waiter, message: string) {
    const q = this.queues.get(w.port) ?? [];
    const i = q.indexOf(w);
    if (i >= 0) q.splice(i, 1);
    if (!q.length) this.queues.delete(w.port);
    const s = this.sessions.get(w.session);
    const stillWaiting = [...this.queues.values()].some((qq) => qq.some((x) => sameOwner(x, w)));
    if (s) {
      this.log(s, `${w.task ? `[${w.task}] ` : ''}${message}`);
      if (!stillWaiting) this.clearBlocked(s, w);
      this.changed('ports', w.session);
    } else if (!stillWaiting) this.beforeWait.delete(ownerKey(w));
  }

  /**
   * Hand freed ports to the first waiter. Runs after releases, when sessions end, and on the reaper's
   * 2-second tick (which also notices ports freed by processes outside Whamming).
   */
  pumpQueues(): Promise<void> {
    const run = this.claimQueue.then(async () => {
      const now = Date.now();
      for (const [port, q] of [...this.queues]) {
        // Drop waiters whose client went away (no long-poll attached and not seen for a while), or whose session ended.
        for (const w of [...q]) {
          const s = this.sessions.get(w.session);
          const gone = !s || !!s.endedAt || (s.pid !== undefined && !isAlive(s.pid));
          if (gone || (!w.notify && now - w.lastSeen > WAITER_TTL_MS)) this.finishWait(w, `Stopped waiting for :${port}`);
        }
        const head = this.queues.get(port)?.[0];
        if (!head) continue;
        const held = this.leases.get(port);
        if (held && !sameOwner(held, head) && this.leaseOwnerAlive(held)) continue;
        if (!(await this.portProbe(port))) continue;
        if (held) this.leases.delete(port);
        const s = this.sessions.get(head.session)!;
        const lease: PortLease = { port, session: head.session, ...(head.task && { task: head.task }), purpose: head.purpose, claimedAt: new Date().toISOString() };
        this.leases.set(port, lease);
        const waited = Math.round((Date.now() - Date.parse(head.since)) / 1000);
        this.log(s, `${head.task ? `[${head.task}] ` : ''}Claimed :${port}${head.purpose ? ` for ${head.purpose}` : ''}`);
        const notify = head.notify;
        this.finishWait(head, `Got :${port} after waiting ${waited}s`);
        notify?.(lease);
      }
    });
    this.claimQueue = run.catch(() => {});
    return run;
  }

  /** Release a claim. With `owner`, only that owner's claim is released (a subagent can't free its sibling's port). */
  releasePort(port: number, owner?: Owner): PortLease {
    const l = this.leases.get(validPort(port, 'port'));
    if (!l) throw new ValidationError(`port ${port} is not claimed`);
    if (owner && !sameOwner(l, owner) && this.leaseOwnerAlive(l)) {
      throw new PortConflict({ port, reason: 'claimed', heldBy: { session: ownerLabel(l), purpose: l.purpose } });
    }
    this.leases.delete(l.port);
    const s = this.sessions.get(l.session);
    if (s) this.log(s, `${l.task ? `[${l.task}] ` : ''}Released :${l.port}`);
    this.changed('ports', l.session);
    void this.pumpQueues();
    return l;
  }

  /** Release every claim of a session, or only those of one subagent task. */
  releaseAll(sessionId: string, task?: string): number[] {
    if (!task) return this.dropLeases(sessionId);
    const freed: number[] = [];
    for (const l of [...this.leases.values()]) {
      if (l.session === sessionId && l.task === task) {
        this.leases.delete(l.port);
        freed.push(l.port);
      }
    }
    if (freed.length) {
      this.changed('ports', sessionId);
      void this.pumpQueues();
    }
    return freed;
  }
}
