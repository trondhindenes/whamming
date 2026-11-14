import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DATA_DIR, STATUS_FILE } from './paths';
import { isAlive } from './store';
import type { ApiServer } from './api';

export interface RunStatus {
  pid: number;
  port: number;
  url: string;
  version: string;
  /** The data folder this server serves (WHAMMING_HOME). */
  home: string;
  startedAt: string;
}

declare const __WHAMMING_VERSION__: string;
export const VERSION = typeof __WHAMMING_VERSION__ === 'string' ? __WHAMMING_VERSION__ : 'dev';

/** The status file, if it describes a server that is still running. A hint only: callers confirm via /api/health. */
export function readLiveStatus(): RunStatus | null {
  try {
    const s = JSON.parse(readFileSync(STATUS_FILE, 'utf8')) as RunStatus;
    return s && Number.isInteger(s.pid) && s.pid !== process.pid && isAlive(s.pid) && typeof s.url === 'string' ? s : null;
  } catch {
    return null;
  }
}

/** Confirm that `url` really is a Whamming serving this data folder. */
export async function isOurWhamming(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    const j = (await r.json()) as { app?: string; home?: string };
    if (j.app !== 'whamming') return false;
    // Older builds don't report `home`; they can only be assumed to serve the default data folder.
    return j.home === undefined ? DATA_DIR === join(homedir(), '.whamming') : j.home === DATA_DIR;
  } catch {
    return false;
  }
}

/** Write status.json atomically for the server that just started. */
export function writeStatus(api: ApiServer) {
  const s: RunStatus = { pid: process.pid, port: api.port, url: api.url, version: VERSION, home: DATA_DIR, startedAt: new Date().toISOString() };
  mkdirSync(dirname(STATUS_FILE), { recursive: true });
  const tmp = `${STATUS_FILE}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  renameSync(tmp, STATUS_FILE);
}

/** Remove status.json on shutdown, but only if it is still ours (another instance may have taken over). */
export function removeStatus() {
  try {
    if (!existsSync(STATUS_FILE)) return;
    const s = JSON.parse(readFileSync(STATUS_FILE, 'utf8')) as RunStatus;
    if (s.pid === process.pid) unlinkSync(STATUS_FILE);
  } catch {
    /* best effort */
  }
}

/** Ports to try: an explicit WHAMMING_PORT is strict; otherwise 4477, a few neighbours, then any free port. */
export function candidatePorts(): number[] {
  const explicit = Number(process.env.WHAMMING_PORT);
  if (explicit) return [explicit];
  return [4477, 4478, 4479, 4480, 4481, 4482, 4483, 4484, 4485, 4486, 0];
}

/**
 * Start the API on the first free candidate port. If a live Whamming already serves this data folder
 * (per status.json, or an older build on the default port), return its URL instead so we never run
 * two servers on the same state.
 */
export async function startOrReuse(listen: (port: number) => Promise<ApiServer>): Promise<{ api: ApiServer } | { reuse: string }> {
  const live = readLiveStatus();
  if (live && (await isOurWhamming(live.url))) return { reuse: live.url };

  let lastErr: unknown;
  for (const port of candidatePorts()) {
    let api: ApiServer;
    try {
      api = await listen(port);
    } catch (err: any) {
      lastErr = err;
      if (err?.code !== 'EADDRINUSE') throw err;
      // Whoever holds this port might be a Whamming for this same data folder that started a moment
      // before us (and hasn't written status.json yet), or an older build without status.json.
      // Check every busy port, not just the default, so two instances never share one state.json.
      const url = `http://127.0.0.1:${port}`;
      if (await isOurWhamming(url)) return { reuse: url };
      continue;
    }
    try {
      writeStatus(api);
    } catch (err) {
      await api.close(); // don't leave a half-started server behind
      throw err;
    }
    return { api };
  }
  throw lastErr;
}
