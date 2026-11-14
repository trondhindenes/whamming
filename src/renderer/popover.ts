import type { PortsSnapshot, SessionView } from '../shared/types';
import { ago, chip, esc, fullTime, installTooltips, isExited, statusIcon } from './ui';

interface Bridge {
  openSession(id: string): void;
  openDashboard(view?: string): void;
  resize(height: number): void;
  hide(): void;
  quit(): void;
}

// In Electron the preload provides this; in a plain browser fall back to navigating the dashboard.
const bridge: Bridge = (window as any).whamming ?? {
  openSession: (id) => (location.href = `/#/s/${encodeURIComponent(id)}`),
  openDashboard: (view) => (location.href = view ? `/#/v/${view}` : '/'),
  resize: () => {},
  hide: () => {},
  quit: () => {},
};

let sessions: SessionView[] = [];
let ports: PortsSnapshot = { leases: [], unclaimed: [], queues: [] };
let order: string[] = [];
let kbd = -1;

const root = document.getElementById('root')!;
const MAX_IDLE = 4;

async function load() {
  try {
    const [s, p] = await Promise.all([fetch('/api/sessions').then((r) => r.json()), fetch('/api/ports').then((r) => r.json())]);
    sessions = s.sessions;
    ports = p;
  } catch {
    /* keep last known */
  }
  render();
}

function sub(s: SessionView): string {
  const bits = [`<span title="Folder: ${esc(s.folder)}">${esc(s.folderName)}</span>`];
  if (s.name !== s.folderName) bits.push(`<span class="mono" title="Session name">${esc(s.id)}</span>`);
  const active = (s.tasks ?? []).filter((t) => t.status !== 'done').length;
  if (active) bits.push(`<span title="Subagents still running">${active} subagent${active === 1 ? '' : 's'}</span>`);
  if (s.ports.length) bits.push(`<span class="mono" title="Ports claimed by this session">${s.ports.map((p) => ':' + p).join(' ')}</span>`);
  return bits.join(' · ');
}

function item(s: SessionView, mode: 'full' | 'compact'): string {
  order.push(s.id);
  const full = mode === 'full';
  return `<div class="item ${s.status} ${full ? '' : 'compact'}" data-id="${esc(s.id)}">
    <div class="item-top">${statusIcon(s.status)}<span class="ttl">${esc(s.title || s.name)}</span><span class="time" title="Last update ${esc(fullTime(s.updatedAt))}">${ago(s.updatedAt)}</span>${s.unread ? `<span class="badge" title="${s.unread} unread message${s.unread === 1 ? '' : 's'} from other agents">${s.unread}</span>` : ''}</div>
    <div class="item-sub">${sub(s)}</div>
    ${full && s.detail ? `<div class="q"><span>${esc(s.detail)}</span></div>` : ''}
    ${full && s.links.length ? `<div class="chips">${s.links.slice(-3).map(chip).join('')}</div>` : ''}
  </div>`;
}

function section(label: string, list: SessionView[], mode: 'full' | 'compact', limit = Infinity): string {
  if (!list.length) return '';
  const shown = list.slice(0, limit);
  return `<div class="pop-sec">${esc(label)} <span class="n" title="${list.length} session${list.length === 1 ? '' : 's'}">${list.length}</span></div>
    ${shown.map((s) => item(s, mode)).join('')}
    ${list.length > shown.length ? `<div class="more" title="Open the dashboard to see all">+${list.length - shown.length} more</div>` : ''}`;
}

function render() {
  order = [];
  const live = sessions.filter((s) => !isExited(s) && s.status !== 'done');
  const by = (st: string) => live.filter((s) => s.status === st);
  const waiting = by('waiting');
  const errors = by('error');
  const blocked = by('blocked');
  const working = by('working');
  const idle = by('idle');

  const sum: string[] = [];
  if (waiting.length) sum.push(`<span class="hot">${waiting.length} need${waiting.length === 1 ? 's' : ''} you</span>`);
  if (errors.length) sum.push(`<span class="err">${errors.length} error${errors.length === 1 ? '' : 's'}</span>`);
  if (working.length) sum.push(`${working.length} working`);
  if (blocked.length) sum.push(`${blocked.length} blocked`);
  if (idle.length) sum.push(`${idle.length} idle`);

  const body = live.length
    ? section('Needs you', waiting, 'full') + section('Errors', errors, 'full') + section('Working', working, 'compact') + section('Blocked', blocked, 'full') + section('Idle', idle, 'compact', MAX_IDLE)
    : `<div class="pop-empty"><b>All quiet</b>No agents are running right now.</div>`;

  root.innerHTML = `
    <div class="pop-head">
      <img src="icon.png" alt="">
      <div class="t"><b>Whamming</b><span class="sum" title="Running sessions by status">${sum.join(' · ') || 'Nothing running'}</span></div>
    </div>
    <div class="pop-scroll">${body}</div>
    <div class="pop-foot">
      <button data-act="ports" title="Ports claimed by agents; opens the Ports view">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="2.5" y="4" width="11" height="8" rx="2" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 8h.01M8 8h.01M10.5 8h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        ${ports.leases.length} port${ports.leases.length === 1 ? '' : 's'}
      </button>
      <span class="grow"></span>
      <button data-act="dashboard" title="Open the full dashboard (Enter)">Open dashboard <kbd>↵</kbd></button>
      <button data-act="quit" title="Quit Whamming">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 2.5v5M4.6 4.6a5 5 0 1 0 6.8 0" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      </button>
    </div>`;
  highlight();
  fit();
}

/** Ask the window to match the content height (capped by the main process). */
function fit() {
  const head = root.querySelector<HTMLElement>('.pop-head')!.offsetHeight;
  const foot = root.querySelector<HTMLElement>('.pop-foot')!.offsetHeight;
  const content = root.querySelector<HTMLElement>('.pop-scroll')!.scrollHeight;
  bridge.resize(head + content + foot);
}

function highlight() {
  root.querySelectorAll('.item').forEach((el) => el.classList.toggle('kbd', (el as HTMLElement).dataset.id === order[kbd]));
  root.querySelector('.item.kbd')?.scrollIntoView({ block: 'nearest' });
}

root.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('a')) return; // link chips open in the browser (main process handles it)
  const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'ports') return bridge.openDashboard('ports');
  if (act === 'dashboard') return bridge.openDashboard();
  if (act === 'quit') return bridge.quit();
  const it = t.closest<HTMLElement>('.item');
  if (it) bridge.openSession(it.dataset.id!);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') bridge.hide();
  else if (e.key === 'ArrowDown' || e.key === 'j') {
    kbd = Math.min(order.length - 1, kbd + 1);
    highlight();
  } else if (e.key === 'ArrowUp' || e.key === 'k') {
    kbd = Math.max(0, kbd - 1);
    highlight();
  } else if (e.key === 'Enter') {
    if (order[kbd]) bridge.openSession(order[kbd]);
    else bridge.openDashboard();
  }
});

// Live updates; and refresh relative times whenever the popover is re-shown.
const es = new EventSource('/api/stream');
let t: number | undefined;
es.addEventListener('change', () => {
  clearTimeout(t);
  t = window.setTimeout(load, 80);
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    kbd = -1;
    load();
  }
});
setInterval(() => !document.hidden && render(), 30_000);
installTooltips();
load();
