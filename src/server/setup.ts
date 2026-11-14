import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ValidationError } from './store';

/** Stable place for the CLI: a symlink into the app bundle, re-pointed if the app moves. */
export const CLI_LINK = join(homedir(), '.local', 'bin', 'whamming');

/** The Claude Code events Whamming listens to. */
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'PostToolUse', 'Stop'] as const;

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
export const SETTINGS_FILE = join(CLAUDE_DIR, 'settings.json');

interface HookCommand {
  type: string;
  command?: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookCommand[];
}
type Settings = Record<string, any> & { hooks?: Record<string, HookGroup[]> };

const isOurs = (h: HookCommand) => typeof h.command === 'string' && /whamming(\.mjs)?["']?\s+hook\b/.test(h.command);

function linkTarget(): string | null {
  try {
    return lstatSync(CLI_LINK).isSymbolicLink() ? resolve(dirname(CLI_LINK), readlinkSync(CLI_LINK)) : null;
  } catch {
    return null;
  }
}

// ---------- CLI ----------

export interface CliStatus {
  /** The binary shipped with this build of the app (null if it wasn't built). */
  bundled: string | null;
  link: string;
  /** ~/.local/bin/whamming exists and points at this app's binary. */
  installed: boolean;
  /** Something else lives at the link path (a regular file, or a link elsewhere). */
  conflict: string | null;
}

export function cliStatus(bundled: string | null): CliStatus {
  const target = linkTarget();
  const exists = existsSync(CLI_LINK) || target !== null;
  let conflict: string | null = null;
  if (exists && target === null) conflict = `${CLI_LINK} exists and is not a symlink`;
  else if (target && bundled && target !== bundled && existsSync(target)) conflict = `${CLI_LINK} points to ${target}`;
  return { bundled, link: CLI_LINK, installed: !!bundled && target === bundled, conflict };
}

/** Create (or re-point) ~/.local/bin/whamming → the bundled binary. Never replaces a regular file. */
export function installCli(bundled: string | null, { force = false } = {}): CliStatus {
  if (!bundled || !existsSync(bundled)) throw new ValidationError('this build of Whamming has no bundled CLI');
  mkdirSync(dirname(CLI_LINK), { recursive: true });
  const target = linkTarget();
  if (target === null && existsSync(CLI_LINK)) throw new ValidationError(`${CLI_LINK} already exists and is not a symlink; not touching it`);
  if (target !== null && target !== bundled && existsSync(target) && !force) {
    throw new ValidationError(`${CLI_LINK} already points to ${target}`);
  }
  if (target !== null) unlinkSync(CLI_LINK);
  symlinkSync(bundled, CLI_LINK);
  return cliStatus(bundled);
}

/** On launch: if the user installed the CLI before and the app has moved (or been updated), follow it. */
export function refreshCliLink(bundled: string | null) {
  const target = linkTarget();
  if (!bundled || target === null || target === bundled) return;
  // Only re-point links that are ours: they point at some Whamming binary that no longer exists.
  if (/whamming$/.test(target) && !existsSync(target)) {
    unlinkSync(CLI_LINK);
    symlinkSync(bundled, CLI_LINK);
  }
}

// ---------- hooks ----------

export interface HooksStatus {
  settingsFile: string;
  command: string;
  installed: string[];
  missing: string[];
  /** Hook groups that are not ours, per event (left untouched). */
  others: Record<string, number>;
}

export function hookCommand(): string {
  const exe = /\s/.test(CLI_LINK) ? JSON.stringify(CLI_LINK) : CLI_LINK;
  return `${exe} hook`;
}

function readSettings(): Settings {
  if (!existsSync(SETTINGS_FILE)) return {};
  const raw = readFileSync(SETTINGS_FILE, 'utf8');
  let j: any;
  try {
    j = JSON.parse(raw);
  } catch (err: any) {
    throw new ValidationError(`${SETTINGS_FILE} is not plain JSON (${err.message}); not touching it`);
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new ValidationError(`${SETTINGS_FILE} is not a JSON object; not touching it`);
  // Refuse to edit a hooks section we don't understand rather than guess and damage it.
  if (j.hooks !== undefined) {
    if (!j.hooks || typeof j.hooks !== 'object' || Array.isArray(j.hooks)) {
      throw new ValidationError(`"hooks" in ${SETTINGS_FILE} is not an object; not touching it`);
    }
    for (const [ev, groups] of Object.entries(j.hooks)) {
      if (!Array.isArray(groups)) throw new ValidationError(`"hooks.${ev}" in ${SETTINGS_FILE} is not a list; not touching it`);
    }
  }
  return j;
}

/**
 * Remove only Whamming's own hook commands. Other groups are kept exactly as they are (even odd ones,
 * like a group with no hooks); a group is dropped only if it became empty because we removed ours.
 */
function withoutOurs(groups: HookGroup[] = []): HookGroup[] {
  const out: HookGroup[] = [];
  for (const g of groups) {
    const hooks = Array.isArray(g?.hooks) ? g.hooks : null;
    if (!hooks || !hooks.some(isOurs)) {
      out.push(g);
      continue;
    }
    const left = hooks.filter((h) => !isOurs(h));
    if (left.length) out.push({ ...g, hooks: left });
  }
  return out;
}

export function hooksStatus(): HooksStatus {
  const settings = readSettings();
  const installed: string[] = [];
  const others: Record<string, number> = {};
  for (const ev of HOOK_EVENTS) {
    const groups = settings.hooks?.[ev] ?? [];
    if (groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some(isOurs))) installed.push(ev);
    const theirs = withoutOurs(groups).length;
    if (theirs) others[ev] = theirs;
  }
  return { settingsFile: SETTINGS_FILE, command: hookCommand(), installed, missing: HOOK_EVENTS.filter((e) => !installed.includes(e)), others };
}

/** Exactly what will be added, for the confirmation dialog. */
export function hooksPreview(): Record<string, HookGroup[]> {
  const command = hookCommand();
  const out: Record<string, HookGroup[]> = {};
  for (const ev of HOOK_EVENTS) {
    out[ev] = [{ ...(ev === 'PostToolUse' && { matcher: '*' }), hooks: [{ type: 'command', command, timeout: 2 }] }];
  }
  return out;
}

function writeSettings(next: Settings): string {
  mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
  // If settings.json is a symlink (dotfile managers), write to the file it points at and keep the link.
  const target = existsSync(SETTINGS_FILE) ? realpathSync(SETTINGS_FILE) : SETTINGS_FILE;
  let backup = '';
  if (existsSync(target)) {
    backup = `${SETTINGS_FILE}.${new Date().toISOString().replace(/[:.]/g, '-')}.whamming-backup`;
    copyFileSync(target, backup);
  }
  // Unique temp name next to the real file, so concurrent writes can't collide and the rename stays atomic.
  const tmp = `${target}.${process.pid}-${randomBytes(4).toString('hex')}.whamming-tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, target);
  return backup;
}

/** Add Whamming's hooks next to whatever is there (replacing only our own previous entries). */
export function installHooks(): { status: HooksStatus; backup: string } {
  const settings = readSettings();
  const hooks: Record<string, HookGroup[]> = { ...(settings.hooks ?? {}) };
  const ours = hooksPreview();
  for (const ev of HOOK_EVENTS) hooks[ev] = [...withoutOurs(hooks[ev]), ...ours[ev]];
  const backup = writeSettings({ ...settings, hooks });
  return { status: hooksStatus(), backup };
}

export function uninstallHooks(): { status: HooksStatus; backup: string } {
  const settings = readSettings();
  const hooks: Record<string, HookGroup[]> = { ...(settings.hooks ?? {}) };
  for (const ev of Object.keys(hooks)) {
    const left = withoutOurs(hooks[ev]);
    if (left.length || !hooks[ev].length) hooks[ev] = left; // keep lists that were already empty
    else delete hooks[ev]; // it only held our entries
  }
  const next: Settings = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  const backup = writeSettings(next);
  return { status: hooksStatus(), backup };
}
