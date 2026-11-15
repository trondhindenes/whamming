import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { DeadlockError, HOOK_AGENTS, PortConflict, Store, ValidationError, type SessionPatch } from './store';
import { attribute, invalidateListeners, isClaudeProcess, isPortFree, listContainerPorts, listListeners, processParents } from './ports';
import type { PortListener, PortsSnapshot } from '../shared/types';
import { DATA_DIR } from './paths';
import { VERSION } from './status';
import { CLI_LINK, cliStatus, hooksPreview, hooksStatus, installCli, installHooks, installPiExtension, piStatus, uninstallHooks, uninstallPiExtension } from './setup';

export const DEFAULT_PORT = Number(process.env.WHAMMING_PORT) || 4477;
export const HOST = '127.0.0.1';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
};

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(json + '\n');
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'body must be valid JSON');
  }
}

function pickPatch(body: any): SessionPatch {
  const p: SessionPatch = {};
  if (body.conversationId === undefined && body.claudeSessionId !== undefined) body.conversationId = body.claudeSessionId; // older CLIs
  for (const k of ['name', 'folder', 'branch', 'agent', 'status', 'title', 'detail', 'note', 'conversationId', 'nameSource'] as const) {
    if (body[k] !== undefined) {
      if (body[k] !== null && typeof body[k] !== 'string') throw new ValidationError(`${k} must be a string`);
      (p as any)[k] = body[k] ?? '';
    }
  }
  if (body.pid !== undefined && body.pid !== null) {
    const pid = Number(body.pid);
    if (!Number.isInteger(pid) || pid <= 0) throw new ValidationError('pid must be a positive integer');
    p.pid = pid;
  }
  if (body.links !== undefined) {
    if (!Array.isArray(body.links)) throw new ValidationError('links must be an array');
    p.links = body.links;
  }
  if (body.link !== undefined) p.links = [...(p.links ?? []), body.link];
  if (body.replaceLinks) p.replaceLinks = true;
  return p;
}

export interface ApiServer {
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

export interface ApiOptions {
  /** Directory the dashboard is served from. */
  staticDir?: string;
  /** The Go CLI binary shipped with this build (inside the .app, or dist/cli in dev). */
  bundledCli?: string | null;
}

/** Locate the Go CLI built next to the bundle (dist/cli/whamming), if any. */
export function findBundledCli(distDir: string): string | null {
  const p = resolve(distDir, 'cli', 'whamming');
  return existsSync(p) && !p.includes('.asar') ? p : null;
}

/** How long one long-poll for a busy port is held before the CLI asks again. */
const WAIT_POLL_MS = 25_000;

export function createApi(store: Store, { staticDir, bundledCli = null }: ApiOptions = {}) {
  store.setPortProbe(isPortFree);
  /** Path agents should call: the stable symlink once installed, else the bundled binary. */
  const cliPath = () => (cliStatus(bundledCli).installed ? CLI_LINK : bundledCli);
  type OsState = [Awaited<ReturnType<typeof listListeners>>, Map<number, number>, Awaited<ReturnType<typeof listContainerPorts>>];
  let osCache: { at: number; data: Promise<OsState> } | null = null;
  const osState = (fresh = false) => {
    if (fresh) invalidateListeners();
    if (fresh || !osCache || Date.now() - osCache.at > 3000) {
      osCache = { at: Date.now(), data: Promise.all([listListeners(), processParents(), listContainerPorts()]) };
    }
    return osCache.data;
  };

  /**
   * Listening ports, attributed to a session either by process ancestry (a dev server the agent
   * started) or by folder (a docker compose project in the session's folder).
   */
  async function listeners(fresh = false): Promise<Map<number, PortListener>> {
    const [ls, parents, containers] = await osState(fresh);
    const live = store.list().filter((v) => v.alive !== false && v.status !== 'done');
    const sessionByPid = new Map<number, string>();
    for (const v of live) if (v.pid) sessionByPid.set(v.pid, v.id);
    const byPort = new Map<number, PortListener>();
    for (const l of ls) {
      if (byPort.has(l.port) || isClaudeProcess(l.pid) || sessionByPid.has(l.pid)) continue; // the agent's own plumbing
      byPort.set(l.port, { ...l, session: attribute(l.pid, parents, sessionByPid) });
    }
    for (const c of containers) {
      // Only attribute when exactly one live session works in that folder; otherwise it's a guess.
      const inFolder = c.folder ? live.filter((v) => v.folder === c.folder) : [];
      const l = byPort.get(c.port) ?? { port: c.port, pid: 0, command: 'docker' };
      byPort.set(c.port, { ...l, container: c.container, containerFolder: c.folder, session: l.session ?? (inFolder.length === 1 ? inFolder[0].id : undefined) });
    }
    return byPort;
  }

  async function portsSnapshot(): Promise<PortsSnapshot> {
    const byPort = await listeners();
    const leases = store.allLeases().map((l) => {
      const s = store.get(l.session);
      return {
        ...l,
        sessionName: s?.name,
        folder: s?.folder,
        folderName: s?.folderName,
        sessionStatus: s?.status,
        ownerAlive: store.leaseOwnerAlive(l),
        listener: byPort.get(l.port),
      };
    });
    const leased = new Set(leases.map((l) => l.port));
    const unclaimed = [...byPort.values()]
      .filter((l) => !leased.has(l.port))
      .sort((a, b) => Number(!a.session) - Number(!b.session) || Number(!a.container) - Number(!b.container) || a.port - b.port);
    return { leases, unclaimed, queues: store.queuesSnapshot() };
  }

  /** The session a port request acts for: by pid first, else by name (created if missing). */
  function sessionFor(body: any): string {
    const pid = body.pid ? Number(body.pid) : undefined;
    if (pid) {
      const mine = store.findByPid(pid, body.conversationId);
      if (mine) return mine.id;
    }
    if (typeof body.session !== 'string' || !body.session) throw new ValidationError('session is required');
    if (!pid && store.get(body.session)) return body.session;
    const { folder, branch, agent, conversationId, nameSource } = body;
    return store.upsert(body.session, pickPatch({ folder, branch, agent, conversationId, nameSource, pid })).session.id;
  }

  async function conflictBody(err: PortConflict) {
    const listener = err.info.reason === 'in-use' ? (await listeners(true)).get(err.info.port) : undefined;
    const who = listener?.container ? `container ${listener.container}` : listener ? `${listener.command} (pid ${listener.pid})` : '';
    const by = listener ? ` by ${who}${listener.session ? `, session "${listener.session}"` : ''}` : '';
    return { error: err.message + by, conflict: err.info, ...(listener && { listener }) };
  }

  const streams = new Set<ServerResponse>();
  store.on('change', (evt) => {
    const data = `event: change\ndata: ${JSON.stringify(evt)}\n\n`;
    for (const s of streams) s.write(data);
  });
  setInterval(() => {
    for (const s of streams) s.write(': ping\n\n');
  }, 25_000).unref();

  async function handle(req: IncomingMessage, res: ServerResponse, port: number) {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const method = req.method ?? 'GET';
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    // Agents call us with curl (no Origin). Browsers send Origin: refuse any page that isn't ours.
    const origin = req.headers.origin;
    if (origin && origin !== `http://${HOST}:${port}` && origin !== `http://localhost:${port}`) {
      throw new HttpError(403, 'cross-origin requests are not allowed');
    }

    if (parts[0] !== 'api') return serveStatic(url.pathname, res);

    const [, resource, rawId, sub] = parts;
    // ?pid= lets an agent address "its own" session even if it was parked under name@pid.
    const qpid = Number(url.searchParams.get('pid'));
    const id = rawId && resource === 'sessions' && Number.isInteger(qpid) && qpid > 0 ? store.resolveId(rawId, qpid) : rawId;

    if (resource === 'health' && method === 'GET') return send(res, 200, { ok: true, app: 'whamming', version: VERSION, pid: process.pid, home: DATA_DIR });
    if (resource === 'info' && method === 'GET') return send(res, 200, { cliPath: cliPath() });

    if (resource === 'setup') {
      // Changing ~/.claude/settings.json, ~/.pi/agent/extensions or ~/.local/bin is only for the dashboard UI, not for agents with curl.
      if (method !== 'GET' && origin !== `http://${HOST}:${port}` && origin !== `http://localhost:${port}`) {
        throw new HttpError(403, 'setup changes can only be made from the Whamming dashboard');
      }
      if (!rawId && method === 'GET') {
        let hooks: unknown;
        try {
          hooks = hooksStatus();
        } catch (err: any) {
          hooks = { error: err.message };
        }
        return send(res, 200, { cli: cliStatus(bundledCli), hooks, pi: piStatus(bundledCli), cliPath: cliPath() });
      }
      if (rawId === 'pi' && method === 'POST') return send(res, 200, { pi: installPiExtension(bundledCli) });
      if (rawId === 'pi' && method === 'DELETE') return send(res, 200, { pi: uninstallPiExtension(bundledCli) });
      if (rawId === 'cli' && method === 'POST') return send(res, 200, { cli: installCli(bundledCli, { force: !!(await readJson(req)).force }) });
      if (rawId === 'hooks' && sub === 'preview' && method === 'GET') return send(res, 200, { add: hooksPreview(), status: hooksStatus() });
      if (rawId === 'hooks' && method === 'POST') {
        if (!cliStatus(bundledCli).installed) throw new ValidationError('install the command line tool first; the hooks call it');
        return send(res, 200, installHooks());
      }
      if (rawId === 'hooks' && method === 'DELETE') return send(res, 200, uninstallHooks());
    }

    if (resource === 'stream' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('event: hello\ndata: {}\n\n');
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }

    if (resource === 'ports') {
      if (!rawId && method === 'GET') return send(res, 200, await portsSnapshot());
      if (!rawId && method === 'DELETE') {
        const sid = sessionFor({ session: url.searchParams.get('session'), pid: url.searchParams.get('pid') });
        return send(res, 200, { released: store.releaseAll(sid, url.searchParams.get('task') || undefined) });
      }
      if (rawId === 'claim' && method === 'POST') {
        const body = await readJson(req);
        const sid = sessionFor(body);
        const task = typeof body.task === 'string' && body.task ? body.task : undefined;
        const owner = { session: sid, task };
        const wait = body.wait === true;
        if (wait && body.port === undefined) throw new ValidationError('wait needs an exact port (whamming port claim PORT --wait)');
        try {
          const r = await store.claimPort(sid, { port: body.port, prefer: body.prefer, purpose: body.purpose, adopt: !!body.adopt, task }, isPortFree);
          return send(res, r.created ? 201 : 200, { lease: r.lease, session: sid });
        } catch (err) {
          if (!(err instanceof PortConflict)) throw err;
          if (!wait) return send(res, 409, await conflictBody(err));
          // Join the queue and hold this request until the port is ours or the poll window ends.
          const port = err.info.port;
          const held = store.getLease(port);
          const listener = (await listeners(true)).get(port);
          const holderSession = held && store.leaseOwnerAlive(held) ? (held.task ? `${held.session} › ${held.task}` : held.session) : undefined;
          const outsideAgents = !holderSession && !!listener && !listener.session;
          const heldBy = holderSession
            ? `held by ${holderSession}${held!.purpose ? ` for ${held!.purpose}` : ''}`
            : listener
              ? `held by ${listener.container ? `container ${listener.container}` : `${listener.command} (pid ${listener.pid})`}${listener.session ? `, started by ${listener.session}` : ', not by an agent'}`
              : 'queued behind other agents';
          let joined;
          try {
            joined = store.enqueue(owner, port, body.purpose, heldBy);
          } catch (e) {
            if (e instanceof DeadlockError) return send(res, 409, { error: e.message, deadlock: true });
            throw e;
          }
          const waiting = () => send(res, 202, { waiting: true, port, position: store.positionOf(owner, port), heldBy, outsideAgents, session: sid });
          // First request: answer right away so the agent learns its position and who holds the port.
          if (joined.created) return waiting();
          // Later requests: hold until granted, but never longer than the client has left (waitMs).
          const asked = Number(body.waitMs);
          const hold = Math.max(0, Math.min(WAIT_POLL_MS, Number.isFinite(asked) && body.waitMs !== undefined ? asked : WAIT_POLL_MS));
          const lease = await store.waitForGrant(joined.waiter, hold);
          if (lease) return send(res, 201, { lease, session: sid, waited: true });
          return waiting();
        }
      }
      const port = Number(rawId);
      if (sub === 'wait' && method === 'DELETE' && Number.isInteger(port)) {
        const sid = sessionFor({ session: url.searchParams.get('session'), pid: url.searchParams.get('pid') });
        return send(res, 200, { cancelled: store.cancelWait({ session: sid, task: url.searchParams.get('task') || undefined }, port) });
      }
      if (Number.isInteger(port) && port > 0 && port < 65536) {
        if (method === 'GET') {
          const lease = store.getLease(port);
          const claimed = lease && store.leaseOwnerAlive(lease);
          const listener = (await listeners(true)).get(port);
          const state = claimed ? 'claimed' : listener || !(await isPortFree(port)) ? 'in-use' : 'free';
          return send(res, 200, { port, state, ...(claimed && { lease }), ...(listener && { listener }) });
        }
        if (method === 'DELETE') {
          const force = url.searchParams.get('force') === '1';
          const sid = force ? undefined : sessionFor({ session: url.searchParams.get('session'), pid: url.searchParams.get('pid') });
          try {
            return send(res, 200, { released: store.releasePort(port, sid ? { session: sid, task: url.searchParams.get('task') || undefined } : undefined) });
          } catch (err) {
            if (err instanceof PortConflict) return send(res, 409, { error: err.message, conflict: err.info });
            throw err;
          }
        }
      }
    }

    if (resource === 'hooks' && rawId && Object.hasOwn(HOOK_AGENTS, rawId) && method === 'POST') {
      const b = await readJson(req);
      const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
      const s = store.applyHook({
        agent: HOOK_AGENTS[rawId as keyof typeof HOOK_AGENTS],
        event: String(b.event ?? ''),
        name: String(b.name ?? ''),
        nameSource: str(b.nameSource),
        pid: Number(b.pid),
        conversationId: String(b.conversationId ?? b.claudeSessionId ?? ''),
        cwd: String(b.cwd ?? ''),
        branch: str(b.branch),
        prompt: str(b.prompt),
        message: str(b.message),
        notificationType: str(b.notificationType),
        source: str(b.source),
      });
      return send(res, 200, { ok: true, session: s?.id ?? null });
    }

    if (resource === 'peers' && method === 'GET') {
      const folder = url.searchParams.get('folder');
      if (!folder) throw new ValidationError('folder query parameter is required');
      return send(res, 200, { peers: store.peers(folder, url.searchParams.get('exclude') ?? undefined, Number(url.searchParams.get('excludePid')) || undefined) });
    }

    if (resource === 'sessions') {
      if (!id) {
        if (method === 'GET') {
          const conversation = url.searchParams.get('conversation');
          let sessions = store.list({ folder: url.searchParams.get('folder') ?? undefined, status: url.searchParams.get('status') ?? undefined });
          if (conversation) sessions = sessions.filter((s) => s.conversationId === conversation);
          return send(res, 200, { sessions });
        }
        if (method === 'POST') {
          const body = await readJson(req);
          if (typeof body.id !== 'string') throw new ValidationError('id is required');
          const r = store.upsert(body.id, pickPatch(body));
          return send(res, r.created ? 201 : 200, { session: store.view(r.session, true), ...(r.warning && { warning: r.warning }) });
        }
        if (method === 'DELETE') {
          const which = url.searchParams.get('which');
          if (which !== null) {
            if (which !== 'exited' && which !== 'all') throw new ValidationError('which must be "exited" or "all"');
            const ids = store.clear(which);
            return send(res, 200, { removed: ids.length, ids });
          }
          const n = store.prune(url.searchParams.has('olderThanHours') ? Number(url.searchParams.get('olderThanHours')) * 3600_000 : undefined);
          return send(res, 200, { removed: n });
        }
      } else if (!sub) {
        if (method === 'GET') {
          const s = store.get(id);
          if (!s) throw new HttpError(404, `no such session: ${id}`);
          return send(res, 200, { session: store.view(s, true) });
        }
        if (method === 'PUT' || method === 'PATCH') {
          // Upsert keys on the requested name; the store does its own pid-based resolution.
          const r = store.upsert(rawId, pickPatch(await readJson(req)));
          return send(res, r.created ? 201 : 200, { session: store.view(r.session, true), ...(r.warning && { warning: r.warning }) });
        }
        if (method === 'DELETE') {
          if (!store.remove(id)) throw new HttpError(404, `no such session: ${id}`);
          return send(res, 200, { removed: id });
        }
      } else if (sub === 'tasks' && parts[4]) {
        const key = parts[4];
        if (method === 'PUT' || method === 'PATCH') {
          const body = await readJson(req);
          // Create the parent session on the fly if the subagent is the first to report.
          const sid = store.get(id) ? id : sessionFor({ ...body, session: rawId, pid: body.pid ?? (qpid || undefined) });
          const links = body.links ?? (body.link !== undefined ? [body.link] : undefined);
          const { title, status, detail, note } = pickPatch({ title: body.title, status: body.status, detail: body.detail, note: body.note });
          const task = store.upsertTask(sid, key, { title, status, detail, note, links });
          return send(res, 200, { task, session: sid });
        }
        if (method === 'DELETE') {
          if (!store.removeTask(id, key)) throw new HttpError(404, `no task ${key} on ${id}`);
          return send(res, 200, { removed: key });
        }
      } else if (sub === 'heartbeat' && method === 'POST') {
        const s = store.touch(id);
        if (!s) throw new HttpError(404, `no such session: ${id}`);
        return send(res, 200, { ok: true });
      } else if (sub === 'peers' && method === 'GET') {
        const s = store.get(id);
        if (!s) throw new HttpError(404, `no such session: ${id}`);
        return send(res, 200, { peers: store.peers(s.folder, id, s.pid) });
      } else if (sub === 'messages') {
        if (method === 'GET') {
          // A session that hasn't reported yet simply has no mail.
          return send(res, 200, {
            messages: store.messages(id, {
              unreadOnly: url.searchParams.get('unread') === '1' || url.searchParams.get('unread') === 'true',
              markRead: url.searchParams.get('markRead') !== '0' && url.searchParams.get('markRead') !== 'false',
            }),
          });
        }
        if (method === 'POST') {
          const body = await readJson(req);
          return send(res, 201, { message: store.send(id, String(body.from ?? 'human'), String(body.body ?? '')) });
        }
      }
    }

    throw new HttpError(404, `no route for ${method} ${url.pathname}`);
  }

  async function serveStatic(pathname: string, res: ServerResponse) {
    if (!staticDir) throw new HttpError(404, 'not found');
    const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^([/\\])+/, '');
    const file = join(staticDir, rel);
    if (!file.startsWith(staticDir + sep)) throw new HttpError(403, 'forbidden');
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    } catch {
      throw new HttpError(404, 'not found');
    }
  }

  return function listen(port = DEFAULT_PORT): Promise<ApiServer> {
    let actualPort = port; // listen(0) picks a free port; the origin check needs the real one
    const server = createServer((req, res) => {
      handle(req, res, actualPort).catch((err) => {
        const status = err instanceof HttpError ? err.status : err instanceof ValidationError ? 400 : 500;
        if (status === 500) console.error('[whamming]', err);
        if (!res.headersSent) send(res, status, { error: err.message ?? String(err) });
        else res.end();
      });
    });
    return new Promise((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(port, HOST, () => {
        server.off('error', reject);
        actualPort = (server.address() as AddressInfo).port;
        resolvePromise({
          server,
          port: actualPort,
          url: `http://${HOST}:${actualPort}`,
          close: () =>
            new Promise<void>((r) => {
              for (const s of streams) s.end();
              server.close(() => r());
            }),
        });
      });
    });
  };
}
