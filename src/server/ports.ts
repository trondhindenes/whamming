import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Ports handed out when an agent asks for "any free port". Above common dev defaults, below the ephemeral range. */
export const ALLOC_RANGE = { from: 20000, to: 29999 };

export interface Listener {
  port: number;
  pid: number;
  command: string;
}

function tryBind(port: number, host: string): Promise<'free' | 'in-use' | 'skip'> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve('in-use');
      else resolve('skip'); // e.g. EADDRNOTAVAIL when IPv6 is off
    });
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve('free')));
  });
}

/**
 * Whether something on this machine already holds the port. Docker Desktop publishes ports on
 * all interfaces; dev servers often bind only loopback. Check all three so neither slips through.
 */
export async function isPortFree(port: number): Promise<boolean> {
  for (const host of ['0.0.0.0', '127.0.0.1', '::']) {
    if ((await tryBind(port, host)) === 'in-use') return false;
  }
  return true;
}

function run(cmd: string, args: string[], timeout = 5000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, timeout }, (_err, stdout) => resolve(stdout ?? ''));
  });
}

const CLAUDE_SESSIONS = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'sessions');

/** Claude Code listens on a port of its own; that's agent plumbing, not something the agent started. */
export function isClaudeProcess(pid: number): boolean {
  return existsSync(join(CLAUDE_SESSIONS, `${pid}.json`));
}

/** The Claude conversation a Claude Code process is currently running, from its session file. */
export function claudeConversationOf(pid: number): string | undefined {
  try {
    return JSON.parse(readFileSync(join(CLAUDE_SESSIONS, `${pid}.json`), 'utf8')).sessionId;
  } catch {
    return undefined;
  }
}

export interface ContainerPort {
  port: number;
  container: string;
  /** docker compose project folder (com.docker.compose.project.working_dir). */
  folder?: string;
}

/** Published container ports, with the compose project folder they belong to. Empty if docker isn't available. */
export async function listContainerPorts(): Promise<ContainerPort[]> {
  const out = await run('docker', ['ps', '--format', '{{.Names}}|{{.Ports}}|{{.Label "com.docker.compose.project.working_dir"}}'], 2500);
  const result = new Map<number, ContainerPort>();
  for (const line of out.split('\n')) {
    const [container, ports, folder] = line.split('|');
    if (!container || !ports) continue;
    for (const m of ports.matchAll(/:(\d+)->/g)) {
      const port = Number(m[1]);
      if (!result.has(port)) result.set(port, { port, container, folder: folder || undefined });
    }
  }
  return [...result.values()];
}

let listenerCache: { at: number; data: Promise<Listener[]> } | null = null;

/** TCP listeners visible to this user (via lsof). Cached briefly; lsof takes ~100ms. */
export function listListeners(maxAgeMs = 3000): Promise<Listener[]> {
  if (listenerCache && Date.now() - listenerCache.at < maxAgeMs) return listenerCache.data;
  const data = run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']).then((out) => {
    const seen = new Map<string, Listener>();
    let pid = 0;
    let command = '';
    for (const line of out.split('\n')) {
      const tag = line[0];
      const val = line.slice(1);
      if (tag === 'p') pid = Number(val);
      else if (tag === 'c') command = val;
      else if (tag === 'n') {
        const port = Number(val.slice(val.lastIndexOf(':') + 1));
        if (port && pid !== process.pid) seen.set(`${port}/${pid}`, { port, pid, command });
      }
    }
    return [...seen.values()].sort((a, b) => a.port - b.port);
  });
  listenerCache = { at: Date.now(), data };
  return data;
}

export function invalidateListeners() {
  listenerCache = null;
}

/** pid → ppid for every process, to attribute listeners to the agent session that started them. */
export async function processParents(): Promise<Map<number, number>> {
  const out = await run('ps', ['-axo', 'pid=,ppid=']);
  const map = new Map<number, number>();
  for (const line of out.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid) map.set(pid, ppid);
  }
  return map;
}

/** Walk up from `pid` until we hit a process that belongs to a known session. */
export function attribute(pid: number, parents: Map<number, number>, sessionByPid: Map<number, string>): string | undefined {
  for (let p = pid, i = 0; p > 1 && i < 64; p = parents.get(p) ?? 0, i++) {
    const s = sessionByPid.get(p);
    if (s) return s;
  }
  return undefined;
}
