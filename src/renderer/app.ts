import {
  type Link,
  type Message,
  type Peer,
  type PortLeaseView,
  type PortListener,
  type PortsSnapshot,
  type SessionStatus,
  type SessionView,
  type SubTask,
} from '../shared/types';
import { ago, chip, esc, exitedSvg, fullTime, copyText, installTooltips, isExited, safeUrl, statusIcon, toast } from './ui';

type View = 'all' | SessionStatus | 'ports';
type GroupBy = 'status' | 'folder';

const STATUS_LABEL: Record<SessionStatus, string> = {
  waiting: 'Waiting for you',
  working: 'Working',
  idle: 'Idle',
  done: 'Done',
  error: 'Error',
  blocked: 'Blocked',
};
const NAV: Array<{ view: 'all' | SessionStatus; label: string; tip: string }> = [
  { view: 'all', label: 'All sessions', tip: 'Every running session' },
  { view: 'waiting', label: 'Waiting for you', tip: 'Sessions with a question or an approval for you' },
  { view: 'working', label: 'Working', tip: 'Sessions busy with a task' },
  { view: 'idle', label: 'Idle', tip: 'Sessions that finished their turn and wait for a new prompt' },
  { view: 'blocked', label: 'Blocked', tip: "Sessions waiting on something that isn't you: a port, CI, another agent" },
  { view: 'error', label: 'Error', tip: 'Sessions that hit a problem they could not resolve' },
  { view: 'done', label: 'Done', tip: 'Sessions whose task is finished' },
];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const GROUP_ORDER: SessionStatus[] = ['waiting', 'error', 'working', 'blocked', 'idle', 'done'];

const state = {
  sessions: [] as SessionView[],
  view: 'all' as View,
  folder: null as string | null,
  query: '',
  groupBy: (localStorage.getItem('groupBy') as GroupBy) || 'status',
  selectedId: null as string | null,
  detail: null as (SessionView & { peers: Peer[]; messages: Message[] }) | null,
  connected: false,
  ports: { leases: [], unclaimed: [], queues: [] } as PortsSnapshot,
  showAllListeners: false,
  /** Sessions whose subagent rows are folded away. */
  collapsed: new Set<string>(JSON.parse(localStorage.getItem('collapsed') ?? '[]') as string[]),
  /** Sessions where finished subagents are shown too. */
  showDone: new Set<string>(),
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- helpers ----------

const folderSvg = `<svg class="folder-icon" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4.5c0-.8.7-1.5 1.5-1.5h3l1.5 1.5h4.5c.8 0 1.5.7 1.5 1.5v5.5c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5z" stroke="currentColor" stroke-width="1.3"/></svg>`;
const portSvg = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2.5" y="4" width="11" height="8" rx="2" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 8h.01M8 8h.01M10.5 8h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const allSvg = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M5 6h6M5 8.5h6M5 11h3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;


async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body as T;
}

// ---------- data ----------

async function refresh() {
  try {
    const [{ sessions }, ports] = await Promise.all([api<{ sessions: SessionView[] }>('/api/sessions'), api<PortsSnapshot>('/api/ports')]);
    state.sessions = sessions;
    state.ports = ports;
    setConnected(true);
  } catch {
    setConnected(false);
  }
  render();
  if (state.selectedId) await loadDetail(state.selectedId);
}

async function loadDetail(id: string) {
  try {
    const [{ session }, { peers }, { messages }] = await Promise.all([
      api<{ session: SessionView }>(`/api/sessions/${encodeURIComponent(id)}`),
      api<{ peers: Peer[] }>(`/api/sessions/${encodeURIComponent(id)}/peers`),
      // The human viewing an inbox shouldn't mark it read on the agent's behalf.
      api<{ messages: Message[] }>(`/api/sessions/${encodeURIComponent(id)}/messages?markRead=0`),
    ]);
    if (state.selectedId !== id) return;
    state.detail = { ...session, peers, messages };
  } catch {
    state.detail = null;
    state.selectedId = null;
  }
  renderDetail();
}

let refreshTimer: number | undefined;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(refresh, 60);
}

function connectStream() {
  const es = new EventSource('/api/stream');
  es.addEventListener('hello', () => {
    setConnected(true);
    refresh();
  });
  es.addEventListener('change', scheduleRefresh);
  es.onerror = () => setConnected(false);
}

function setConnected(ok: boolean) {
  state.connected = ok;
  const el = $('conn');
  el.className = `conn ${ok ? 'ok' : 'down'}`;
  $('conn-label').textContent = ok ? location.host : 'Disconnected';
  $('conn').dataset.tip = ok ? `Live connection to the Whamming server at ${location.host}` : 'Lost the connection to the Whamming server; retrying';
}

// ---------- filtering ----------

function filtered(): SessionView[] {
  const q = state.query.trim().toLowerCase();
  return state.sessions.filter((s) => {
    if (state.view !== 'all' && s.status !== state.view) return false;
    if (state.view === 'all' && s.status === 'done' && !q) return false; // "All" = active; Done has its own view
    if (state.folder && s.folder !== state.folder) return false;
    if (!q) return true;
    const hay = [s.name, s.id, s.folderName, s.folder, s.title, s.detail, s.branch, ...s.links.map((l) => `${l.label} ${l.url}`), ...(s.tasks ?? []).map((t) => `${t.key} ${t.title ?? ''}`)].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

function grouped(list: SessionView[]): Array<{ key: string; label: string; icon: string; items: SessionView[] }> {
  if (state.groupBy === 'folder') {
    const m = new Map<string, SessionView[]>();
    for (const s of list) m.set(s.folder, [...(m.get(s.folder) ?? []), s]);
    return [...m.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([folder, items]) => ({
        key: folder,
        label: items[0].folderName,
        icon: folderSvg,
        items: items.sort((a, b) => GROUP_ORDER.indexOf(a.status) - GROUP_ORDER.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt)),
      }));
  }
  // An exited process can't be waiting or working, whatever it last reported.
  const live = list.filter((s) => !isExited(s));
  const exited = list.filter(isExited).sort((a, b) => (b.endedAt ?? b.updatedAt).localeCompare(a.endedAt ?? a.updatedAt));
  return [
    ...GROUP_ORDER.map((st) => ({ key: st, label: STATUS_LABEL[st], icon: statusIcon(st), items: live.filter((s) => s.status === st) })),
    { key: 'exited', label: 'Exited', icon: exitedSvg, items: exited },
  ].filter((g) => g.items.length);
}

/** Flat order of visible rows, for keyboard navigation. */
let visibleOrder: string[] = [];

// ---------- render ----------

function render() {
  renderSidebar();
  renderList();
}

function renderSidebar() {
  const count = (v: View) => state.sessions.filter((s) => !isExited(s) && (v === 'all' ? s.status !== 'done' : s.status === v)).length;
  $('nav').innerHTML = NAV.filter((n) => n.view === 'all' || n.view === 'waiting' || n.view === 'working' || count(n.view) > 0 || n.view === 'idle')
    .map((n) => {
      const c = count(n.view);
      const active = state.view === n.view && !state.folder;
      const hot = n.view === 'waiting' && c > 0;
      return `<button class="nav-item ${active ? 'active' : ''}" data-view="${n.view}" data-tip="${esc(`${n.tip} (${c})`)}">
        ${n.view === 'all' ? allSvg : statusIcon(n.view)}
        <span class="label">${esc(n.label)}</span><span class="n ${hot ? 'hot' : ''}">${c || ''}</span></button>`;
    })
    .join('') +
    `<button class="nav-item ${state.view === 'ports' && !state.folder ? 'active' : ''}" data-view="ports" data-tip="${esc(`Ports claimed by agents, who is waiting for one, and what listens without a claim (${plural(state.ports.leases.length, 'claimed port')})`)}">
      ${portSvg}<span class="label">Ports</span><span class="n">${state.ports.leases.length || ''}</span></button>`;

  const folders = new Map<string, { name: string; n: number; waiting: number }>();
  for (const s of state.sessions) {
    if (s.status === 'done') continue;
    const f = folders.get(s.folder) ?? { name: s.folderName, n: 0, waiting: 0 };
    if (!isExited(s)) f.n++;
    if (s.status === 'waiting' && !isExited(s)) f.waiting++;
    folders.set(s.folder, f);
  }
  $('folders').innerHTML =
    [...folders.entries()]
      .sort((a, b) => a[1].name.localeCompare(b[1].name))
      .map(
        ([path, f]) => `<button class="nav-item ${state.folder === path ? 'active' : ''}" data-folder="${esc(path)}" data-tip="${esc(`${path}\n${plural(f.n, 'running session')}${f.waiting ? `, ${f.waiting} waiting for you` : ''}`)}">
        ${folderSvg}<span class="label">${esc(f.name)}</span><span class="n ${f.waiting ? 'hot' : ''}">${f.n}</span></button>`,
      )
      .join('') || `<div class="nav-item muted" style="cursor:default">No active folders</div>`;
}

function renderList() {
  $('group-by').hidden = state.view === 'ports';
  if (state.view === 'ports' && !state.folder) return renderPorts();
  const list = filtered();
  const title = state.folder
    ? (state.sessions.find((s) => s.folder === state.folder)?.folderName ?? state.folder)
    : (NAV.find((n) => n.view === state.view)?.label ?? 'Ports');
  $('view-title').textContent = title;
  $('view-count').textContent = list.length ? String(list.length) : '';
  $('view-count').dataset.tip = plural(list.length, 'session') + ' in this view';
  document.querySelectorAll<HTMLButtonElement>('#group-by button').forEach((b) => b.classList.toggle('active', b.dataset.group === state.groupBy));

  if (!list.length) {
    visibleOrder = [];
    $('list').innerHTML = emptyState();
    return;
  }

  const groups = grouped(list);
  visibleOrder = groups.flatMap((g) => g.items.map((s) => s.id));
  $('list').innerHTML = groups
    .map(
      (g) => `<div class="group">
      <div class="group-head">${g.icon}<span>${esc(g.label)}</span><span class="n" data-tip="${esc(plural(g.items.length, 'session'))}">${g.items.length}</span></div>
      ${g.items.map((s) => row(s) + subRows(s)).join('')}
    </div>`,
    )
    .join('');
}

const subtaskSvg = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M4 2.5v6.5a2 2 0 0 0 2 2h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="m10 8.5 2.5 2.5L10 13.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function taskCounts(s: SessionView) {
  const tasks = s.tasks ?? [];
  const active = tasks.filter((t) => t.status !== 'done');
  return { tasks, active, done: tasks.length - active.length };
}

/** Child rows for a session's subagents: active ones, then finished ones folded into one line. */
function subRows(s: SessionView): string {
  const { tasks, active } = taskCounts(s);
  if (!tasks.length || state.collapsed.has(s.id)) return '';
  const order: SessionStatus[] = ['waiting', 'error', 'working', 'idle', 'done'];
  const byRecent = (a: SubTask, b: SubTask) => order.indexOf(a.status) - order.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt);
  const done = tasks.filter((t) => t.status === 'done').sort(byRecent);
  const showDone = state.showDone.has(s.id);
  const shown = [...active.sort(byRecent), ...(showDone ? done : [])];
  const subRow = (t: SubTask) => `<div class="row subrow ${t.status}" data-id="${esc(s.id)}">
      <span class="tree"></span>
      <div class="sub-key">${statusIcon(t.status)}<span title="Subagent task key">${esc(t.key)}</span></div>
      <div class="row-main">
        <span class="row-title ${t.title ? '' : 'empty'}" data-tip="${esc(t.title || "This subagent hasn't reported a title yet")}">${esc(t.title || 'No task reported')}</span>
        <span class="row-detail">${esc(t.detail ?? '')}</span>
      </div>
      <div class="row-chips">${t.links.slice(-2).map(chip).join('')}</div>
      <div class="row-meta"></div>
      <div class="row-time" data-tip="Last update ${esc(fullTime(t.updatedAt))}">${ago(t.updatedAt)}</div>
    </div>`;
  return (
    shown.map(subRow).join('') +
    (done.length
      ? `<div class="row subrow more-done" data-toggle-done="${esc(s.id)}" data-tip="${showDone ? 'Hide' : 'Show'} subagents that have finished"><span class="tree"></span>
          <div class="sub-key muted">${showDone ? 'Hide' : `${done.length}`} finished</div><div></div><div></div><div></div><div></div></div>`
      : '')
  );
}

function row(s: SessionView): string {
  const maxChips = 2;
  const chips = s.links.slice(-maxChips).map(chip).join('') + (s.links.length > maxChips ? `<span class="chip more" data-tip="${esc(plural(s.links.length - maxChips, 'more link'))}; open the session to see all">+${s.links.length - maxChips}</span>` : '');
  const sub = s.status === 'waiting' && s.detail ? s.detail : s.name !== s.title ? s.name : '';
  return `<div class="row ${isExited(s) ? 'exited' : s.status} ${s.stale || s.alive === false ? 'stale' : ''} ${s.id === state.selectedId ? 'selected' : ''}" data-id="${esc(s.id)}">
    ${isExited(s) ? exitedSvg : statusIcon(s.status)}
    <div class="row-folder" title="Folder: ${esc(s.folder)}">${esc(s.folderName)}</div>
    <div class="row-main">
      <span class="row-title ${s.title ? '' : 'empty'}" data-tip="${esc(s.title || "The agent hasn't reported what it's working on yet")}">${esc(s.title || 'No task reported')}</span>
      <span class="row-detail">${esc(sub)}</span>
    </div>
    <div class="row-chips">${chips}</div>
    <div class="row-meta">
      ${
        s.tasks?.length
          ? `<button class="sub-toggle ${state.collapsed.has(s.id) ? 'collapsed' : ''}" data-toggle-tasks="${esc(s.id)}" data-tip="${esc(`Subagents: ${taskCounts(s).active.length} of ${s.tasks.length} still running. Click to ${state.collapsed.has(s.id) ? 'show' : 'hide'} them`)}">${subtaskSvg}${taskCounts(s).active.length}/${s.tasks.length}</button>`
          : ''
      }
      ${s.conflicts.length ? `<span class="tag danger" title="Another running session has the same name: ${esc(s.conflicts.join(', '))}. Give one of them a new name with /rename">name clash</span>` : ''}
      ${s.alive === false && s.status !== 'done' ? '<span class="tag" title="The agent process is no longer running">exited</span>' : ''}
      ${s.stale ? '<span class="stale-tag" title="No update in 15+ minutes; the agent may be stuck or forgot to report">stale</span>' : ''}
      ${s.unread ? `<span class="badge" data-tip="${esc(`${plural(s.unread, 'unread message')} from other agents. Open the session to read ${s.unread === 1 ? 'it' : 'them'}`)}">${s.unread}</span>` : ''}
      ${s.ports.map((p) => `<span class="port-tag" title="Port ${p} is claimed by this session">:${p}</span>`).join('')}
      ${s.branch ? `<span class="branch" title="Git branch: ${esc(s.branch)}">${esc(s.branch)}</span>` : ''}
    </div>
    <div class="row-time" data-tip="Last update ${esc(fullTime(s.updatedAt))}">${ago(s.updatedAt)}</div>
  </div>`;
}

// ---------- ports ----------

function portMatches(...fields: Array<string | number | undefined>): boolean {
  const q = state.query.trim().toLowerCase();
  return !q || fields.join(' ').toLowerCase().includes(q);
}

function sessionRef(id?: string, task?: string): string {
  if (!id) return '<span class="muted">—</span>';
  const s = state.sessions.find((x) => x.id === id);
  const t = task ? s?.tasks?.find((x) => x.key === task) : undefined;
  const icon = t ? statusIcon(t.status) : s ? statusIcon(s.status) : '';
  return `<button class="session-ref" data-select="${esc(id)}" data-tip="Open this session">${icon}<span>${esc(id)}${task ? ` <span class="muted">› ${esc(task)}</span>` : ''}</span></button>`;
}

function leaseState(l: PortLeaseView): string {
  if (!l.ownerAlive) return '<span class="pstate gone" title="The session holding this claim has ended; the port can be claimed again">owner gone</span>';
  if (l.listener) {
    const what = l.listener.container ? `container ${l.listener.container}` : `${l.listener.command} · pid ${l.listener.pid}`;
    return `<span class="pstate live" title="${esc(what)}">listening</span>`;
  }
  return '<span class="pstate reserved" title="Claimed, nothing listening yet">reserved</span>';
}

function listenerWhat(l: PortListener): string {
  return l.container
    ? `<span title="${esc(l.containerFolder ?? '')}">container <b>${esc(l.container)}</b></span>`
    : `${esc(l.command)} <span class="muted">· pid ${l.pid}</span>`;
}

function renderPorts() {
  visibleOrder = [];
  const leases = state.ports.leases.filter((l) => portMatches(l.port, l.purpose, l.session, l.folderName, l.listener?.command, l.listener?.container));
  const agentOwned = state.ports.unclaimed.filter((l) => l.session || l.container);
  const others = state.ports.unclaimed.filter((l) => !l.session && !l.container);
  const unclaimed = (state.showAllListeners ? [...agentOwned, ...others] : agentOwned).filter((l) =>
    portMatches(l.port, l.session, l.command, l.container, l.containerFolder),
  );
  $('view-title').textContent = 'Ports';
  $('view-count').textContent = leases.length ? String(leases.length) : '';
  $('view-count').dataset.tip = plural(leases.length, 'claimed port');

  const leaseRows = leases
    .map(
      (l) => `<div class="prow ${l.ownerAlive ? '' : 'stale'}">
      <span class="pnum" title="Port">:${l.port}</span>
      <span class="ppurpose" title="What it is for, as the agent said">${esc(l.purpose ?? '')}${l.adopted ? ' <span class="tag" title="Registered after it was already running">adopted</span>' : ''}</span>
      ${sessionRef(l.session, l.task)}
      <span class="pfolder" title="Folder: ${esc(l.folder ?? '')}">${esc(l.folderName ?? '')}</span>
      ${leaseState(l)}
      <span class="row-time" title="Claimed ${esc(fullTime(l.claimedAt))}">${ago(l.claimedAt)}</span>
      <button class="icon-btn release" data-release="${l.port}" title="Release this claim (click twice)">
        <svg width="12" height="12" viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </button>
    </div>`,
    )
    .join('');

  const otherRows = unclaimed
    .map(
      (l) => `<div class="prow unclaimed">
      <span class="pnum">:${l.port}</span>
      <span class="ppurpose">${listenerWhat(l)}</span>
      ${sessionRef(l.session)}
      <span class="pfolder" title="${esc(l.containerFolder ?? '')}">${esc(l.containerFolder?.split('/').pop() ?? '')}</span>
      <span class="pstate ${l.session ? 'warn' : 'reserved'}" title="${l.session ? 'Started by an agent without claiming it first' : 'Not claimed in Whamming'}">${l.session ? 'not claimed' : 'unclaimed'}</span>
      <span></span><span></span>
    </div>`,
    )
    .join('');

  const holderOf = (port: number) => {
    const l = state.ports.leases.find((x) => x.port === port && x.ownerAlive);
    if (l) return `held by ${esc(l.session)}${l.task ? ` › ${esc(l.task)}` : ''}`;
    const u = state.ports.unclaimed.find((x) => x.port === port);
    return u ? `held by ${u.container ? `container ${esc(u.container)}` : esc(u.command)}${u.session ? '' : ', not by an agent'}` : 'about to be granted';
  };
  const queueRows = (state.ports.queues ?? [])
    .filter((q) => portMatches(q.port, ...q.waiters.map((w) => `${w.session} ${w.purpose ?? ''}`)))
    .map(
      (q) => `<div class="prow queued">
      <span class="pnum">:${q.port}</span>
      <span class="ppurpose">${q.waiters.map((w, i) => `${i + 1}. ${esc(w.session)}${w.task ? ` › ${esc(w.task)}` : ''}${w.purpose ? ` <span class="muted">(${esc(w.purpose)})</span>` : ''}`).join(' &nbsp;')}</span>
      ${sessionRef(q.waiters[0]?.session, q.waiters[0]?.task)}
      <span class="pfolder" title="Holds the port now">${holderOf(q.port)}</span>
      <span class="pstate blocked" title="${esc(`${plural(q.waiters.length, 'agent')} in line for this port, in the order shown`)}">${q.waiters.length} waiting</span>
      <span class="row-time" title="First in line since ${esc(fullTime(q.waiters[0].since))}">${ago(q.waiters[0].since)}</span><span></span>
    </div>`,
    )
    .join('');

  const hidden = state.showAllListeners ? 0 : others.length;
  $('list').innerHTML = `${
    queueRows
      ? `<div class="group"><div class="group-head">${statusIcon('blocked')}<span>Waiting for a port</span><span class="n" title="Ports that agents are queueing for">${state.ports.queues.length}</span></div>${queueRows}</div>`
      : ''
  }
    <div class="group">
      <div class="group-head">${portSvg}<span>Claimed</span><span class="n" title="Ports claimed through Whamming">${leases.length}</span></div>
      ${leaseRows || `<div class="pempty">No claimed ports. Agents claim with <code>whamming port claim --prefer 5432 --purpose postgres</code>.</div>`}
    </div>
    <div class="group">
      <div class="group-head">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2.4 2"/></svg>
        <span>Listening, not claimed</span><span class="n" title="Ports in use that no agent claimed">${unclaimed.length}</span>
        <span style="flex:1"></span>
        ${
          others.length
            ? `<button class="link-btn" data-action="toggle-listeners" title="Other processes on this machine listening on a port (not started by agents or containers)">${state.showAllListeners ? 'Hide' : `Show ${hidden}`} other listener${others.length === 1 ? '' : 's'}</button>`
            : ''
        }
      </div>
      ${otherRows || '<div class="pempty">Nothing started by agents or containers is listening without a claim.</div>'}
    </div>`;
}

function detailTasks(d: SessionView): string {
  const tasks = [...(d.tasks ?? [])].sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || b.updatedAt.localeCompare(a.updatedAt));
  if (!tasks.length) return '';
  const active = tasks.filter((t) => t.status !== 'done').length;
  return `<div class="section-title">Subagents <span class="n">${active ? `${active} active · ` : ''}${tasks.length}</span></div>
    <div class="dtasks">${tasks
      .map(
        (t) => `<div class="dtask ${t.status}">
          <div class="dtask-top">${statusIcon(t.status)}<span class="dtask-title">${esc(t.title || t.key)}</span><span class="tl-time" title="Last update ${esc(fullTime(t.updatedAt))}">${ago(t.updatedAt)}</span></div>
          <div class="dtask-key" title="Subagent task key">${esc(t.key)}</div>
          ${t.detail ? `<div class="dtask-detail ${t.status === 'error' || t.status === 'waiting' ? 'warn' : ''}">${esc(t.detail)}</div>` : ''}
          ${t.links.length ? `<div class="dtask-links">${t.links.map(chip).join('')}</div>` : ''}
        </div>`,
      )
      .join('')}</div>`;
}

function detailPorts(d: SessionView): string {
  const leases = state.ports.leases.filter((l) => l.session === d.id);
  const rogue = state.ports.unclaimed.filter((l) => l.session === d.id);
  if (!leases.length && !rogue.length) return '';
  return `<div class="section-title">Ports <span class="n">${leases.length || ''}</span></div>
    <div class="dports">
      ${leases
        .map(
          (l) => `<div class="dport"><span class="pnum">:${l.port}</span><span class="ppurpose">${esc(l.purpose ?? '')}</span>${leaseState(l)}
          <button class="icon-btn release" data-release="${l.port}" title="Release this claim (click twice)"><svg width="12" height="12" viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>`,
        )
        .join('')}
      ${rogue
        .map(
          (l) => `<div class="dport"><span class="pnum">:${l.port}</span><span class="ppurpose">${listenerWhat(l)}</span>
          <span class="pstate warn" title="Listening without a claim">not claimed</span><span></span></div>`,
        )
        .join('')}
    </div>`;
}

function emptyState(): string {
  const filtering = state.query || state.folder || state.view !== 'all';
  if (filtering && state.sessions.length) {
    return `<div class="empty-state"><div><h3>Nothing here</h3><p>No sessions match this view.</p></div></div>`;
  }
  return `<div class="empty-state"><div>
    <svg width="40" height="40" viewBox="0 0 14 14" style="opacity:.5">${statusIcon('idle').replace(/<\/?svg[^>]*>/g, '')}</svg>
    <h3>No agents have reported in yet</h3>
    <p>Add the Whamming instructions to your global agent context and sessions will show up here as they start working.</p>
    <button class="btn primary" data-action="setup">Show agent setup</button>
  </div></div>`;
}

function renderDetail() {
  const el = $('detail');
  const d = state.detail;
  if (!d) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  // Live updates re-render the panel; keep the user's draft, focus and scroll.
  const prevTa = el.querySelector('textarea');
  const draft = prevTa?.value ?? '';
  const hadFocus = !!prevTa && document.activeElement === prevTa;
  const sameSession = el.dataset.id === d.id;
  const scroll = el.querySelector('.detail-body')?.scrollTop ?? 0;
  el.dataset.id = d.id;
  const unread = d.messages.filter((m) => !m.read).length;
  const activity = [...(d.activity ?? [])].reverse().slice(0, 40);

  el.innerHTML = `
    <div class="detail-head">
      ${statusIcon(d.status)}
      <div class="crumb">${esc(d.folderName)} › <b>${esc(d.name)}</b></div>
      <button class="icon-btn" data-action="close" title="Close (Esc)">
        <svg width="14" height="14" viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="detail-body">
      ${
        d.conflicts.length
          ? `<div class="callout danger"><span class="callout-label">Name clash</span>Another running session also calls itself <b>${esc(d.name)}</b>: ${d.conflicts
              .map((c) => `<button class="link-btn" data-select="${esc(c)}">${esc(c)}</button>`)
              .join(', ')}. Rename one of them with <code>/rename</code>.</div>`
          : ''
      }
      <h1 class="detail-title">${esc(d.title || 'No task reported')}</h1>
      ${
        d.detail
          ? d.status === 'waiting' || d.status === 'error' || d.status === 'blocked'
            ? `<div class="callout ${d.status === 'blocked' ? 'blocked' : ''}"><span class="callout-label">${
                d.status === 'waiting' ? 'Needs your input' : d.status === 'blocked' ? 'Blocked' : 'Error'
              }</span>${esc(d.detail)}</div>`
            : `<p class="detail-text">${esc(d.detail)}</p>`
          : ''
      }
      <dl class="props">
        <dt>Status</dt><dd>${statusIcon(d.status)} ${esc(STATUS_LABEL[d.status])}${d.stale ? ' <span class="stale-tag" title="No update in 15+ minutes">stale</span>' : ''}</dd>
        <dt>Session</dt><dd><span class="mono copyable" data-copy="${esc(d.id)}" title="Copy session id">${esc(d.id)}</span>${
          d.nameSource === 'user' ? '<span class="muted" title="Named by you with /rename">· renamed</span>' : ''
        }</dd>
        ${
          d.pid
            ? `<dt>Process</dt><dd><span class="mono">pid ${d.pid}</span>${
              d.alive === false
                ? `<span class="tag" title="The Claude Code process has ended">exited</span>${d.endedAt ? `<span class="muted" title="Ended ${esc(fullTime(d.endedAt))}">· ${ago(d.endedAt)} ago</span>` : ''}`
                : '<span class="muted" title="The Claude Code process is running">· running</span>'
            }</dd>`
            : ''
        }
        <dt>Folder</dt><dd><span class="mono copyable" data-copy="${esc(d.folder)}" title="Copy path">${esc(d.folder)}</span></dd>
        ${d.branch ? `<dt>Branch</dt><dd><span class="mono copyable" data-copy="${esc(d.branch)}" title="Copy branch name">${esc(d.branch)}</span></dd>` : ''}
        ${d.agent ? `<dt>Agent</dt><dd>${esc(d.agent)}</dd>` : ''}
        <dt>Started</dt><dd>${esc(fullTime(d.createdAt))}</dd>
        <dt>Updated</dt><dd>${esc(fullTime(d.updatedAt))} <span class="muted">· ${ago(d.updatedAt)} ago</span></dd>
      </dl>

      ${
        d.links.length
          ? `<div class="section-title">Links <span class="n">${d.links.length}</span></div>
      <div class="links">${d.links
        .map(
          (l) => `<a class="link-row" href="${esc(safeUrl(l.url))}" target="_blank">
          <span class="kind">${esc(l.kind)}</span><span class="lbl">${esc(l.label)}</span><span class="url">${esc(l.url.replace(/^https?:\/\//, ''))}</span></a>`,
        )
        .join('')}</div>`
          : ''
      }

      <div class="section-title">Also in this folder <span class="n">${d.peers.length || ''}</span></div>
      ${
        d.peers.length
          ? d.peers
              .map(
                (p) => `<button class="peer" data-select="${esc(p.id)}" title="Open this session">${statusIcon(p.status)}<span class="pname">${esc(p.id)}</span>
                <span class="ptitle">${esc(p.title ?? '')}${p.relation !== 'same' ? ` <span class="muted">(${p.relation === 'child' ? 'subfolder' : 'parent folder'})</span>` : ''}</span></button>`,
              )
              .join('')
          : `<div class="muted">No other agents in ${esc(d.folderName)}.</div>`
      }

      ${detailTasks(d)}
      ${detailPorts(d)}

      <div class="section-title">Inbox <span class="n">${d.messages.length ? `${d.messages.length}${unread ? ` · ${unread} unread` : ''}` : ''}</span></div>
      <div class="messages">
        ${d.messages
          .slice(-10)
          .map(
            (m) => `<div class="msg ${m.read ? '' : 'unread'}"><div class="msg-head"><b>${esc(m.from)}</b><span title="${esc(fullTime(m.at))}">${ago(m.at)}${m.read ? '' : ' · unread'}</span></div>
            <div class="msg-body">${esc(m.body)}</div></div>`,
          )
          .join('')}
      </div>
      <form class="composer" data-action="send">
        <textarea name="body" placeholder="Leave a message for ${esc(d.name)}…" rows="1"></textarea>
        <button class="btn" type="submit" title="Leave a message in this session's inbox; the agent reads it at the start of its next turn">Send</button>
      </form>

      <div class="section-title">Activity</div>
      <div class="timeline">
        ${activity
          .map(
            (a) => `<div class="tl-item">${a.status ? statusIcon(a.status) : '<span class="tl-dot"></span>'}
            <span class="tl-msg">${esc(a.message)}</span><span class="tl-time" title="${esc(fullTime(a.at))}">${ago(a.at)}</span></div>`,
          )
          .join('')}
      </div>

      <div class="detail-foot"><button class="btn danger" data-action="remove" title="Remove this entry from Whamming (the agent itself keeps running). Click twice">Remove session</button></div>
    </div>`;
  if (sameSession) {
    const ta = el.querySelector('textarea')!;
    ta.value = draft;
    if (hadFocus) ta.focus();
    el.querySelector('.detail-body')!.scrollTop = scroll;
  }
}

// ---------- selection ----------

function select(id: string | null) {
  state.selectedId = id;
  if (!id) {
    state.detail = null;
    if (location.hash) history.replaceState(null, '', location.pathname);
    renderDetail();
  } else {
    if (location.hash !== `#/s/${encodeURIComponent(id)}`) history.replaceState(null, '', `#/s/${encodeURIComponent(id)}`);
    loadDetail(id);
  }
  document.querySelectorAll<HTMLElement>('.row').forEach((r) => r.classList.toggle('selected', r.dataset.id === id));
  document.querySelector(`.row[data-id="${CSS.escape(id ?? '')}"]`)?.scrollIntoView({ block: 'nearest' });
}

function selectFromHash() {
  const v = location.hash.match(/^#\/v\/(.+)$/);
  if (v) {
    const view = decodeURIComponent(v[1]) as View;
    if (view === 'ports' || NAV.some((n) => n.view === view)) {
      state.view = view;
      state.folder = null;
      render();
    }
    history.replaceState(null, '', location.pathname);
    return;
  }
  const m = location.hash.match(/^#\/s\/(.+)$/);
  if (m) select(decodeURIComponent(m[1]));
}

function move(delta: number) {
  if (!visibleOrder.length) return;
  const i = state.selectedId ? visibleOrder.indexOf(state.selectedId) : -1;
  const next = i < 0 ? (delta > 0 ? 0 : visibleOrder.length - 1) : Math.min(visibleOrder.length - 1, Math.max(0, i + delta));
  select(visibleOrder[next]);
}

// ---------- setup modal ----------

interface SetupState {
  cli: { bundled: string | null; link: string; installed: boolean; conflict: string | null };
  hooks: { settingsFile: string; command: string; installed: string[]; missing: string[]; others: Record<string, number> } | { error: string };
  cliPath: string | null;
}

/** Point every CLI invocation in the instructions at the installed/bundled binary. */
function withCli(snippet: string, cliPath: string | null): string {
  if (!cliPath) return snippet;
  const cmd = /\s/.test(cliPath) ? `'${cliPath}'` : cliPath;
  return snippet
    .replace(/\bwhamming(?= (?:whoami|update|peers|send|inbox|done|remove|list|ports?)\b)/g, cmd)
    .replace('the `whamming` CLI', `the \`whamming\` CLI (\`${cmd}\`)`);
}

const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');
const check = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" fill="#4cb782"/><path d="m5 8.2 2 2 4-4.2" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

async function openSetup() {
  $('modal').hidden = false;
  const body = $('modal-body');
  let raw = '';
  let setup: SetupState | null = null;
  let reviewing = false;
  let busy = false;

  const load = async () => {
    try {
      [raw, setup] = await Promise.all([fetch('agent-instructions.md').then((r) => r.text()), api<SetupState>('/api/setup')]);
    } catch (err: any) {
      raw ||= 'Could not load agent instructions.';
      toast(err.message ?? String(err));
    }
    raw = raw.replaceAll('http://127.0.0.1:4477', location.origin);
  };

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    if (busy) return;
    busy = true;
    try {
      await fn();
      toast(ok);
      reviewing = false;
      await load();
    } catch (err: any) {
      toast(err.message ?? String(err));
    } finally {
      busy = false;
      draw();
    }
  };

  const draw = () => {
    if (!setup) return;
    const { cli, hooks } = setup;
    const hooksOk = !('error' in hooks) && hooks.missing.length === 0;
    const snippet = withCli(raw, setup.cliPath);

    const cliStep = !cli.bundled
      ? `<p class="muted">This build has no bundled CLI (Go wasn't available when it was built).</p>`
      : cli.installed
        ? `<p class="setup-ok">${check}<span>Installed at <code>${esc(tilde(cli.link))}</code>. It follows the app if you move or update it.
             Add <code>~/.local/bin</code> to your PATH to use <code>whamming</code> yourself; agents call it by full path.</span></p>`
        : `<p>Puts <code>whamming</code> at <code>${esc(tilde(cli.link))}</code> (a link into the app), so agents and hooks have a stable path.</p>
           ${cli.conflict ? `<p class="setup-warn">${esc(tilde(cli.conflict))}.</p>` : ''}
           <button class="btn primary" data-setup="cli">Install command line tool</button>`;

    let hooksStep: string;
    if ('error' in hooks) hooksStep = `<p class="setup-warn">${esc(hooks.error)}</p>`;
    else if (reviewing) {
      const others = Object.entries(hooks.others);
      hooksStep = `<p>These entries will be added to <code>${esc(tilde(hooks.settingsFile))}</code>:</p>
        <ul class="setup-list">${['SessionStart', 'UserPromptSubmit', 'Notification', 'PostToolUse', 'Stop']
          .map((e) => `<li><b>${e}</b> → <code>${esc(tilde(hooks.command))}</code></li>`)
          .join('')}</ul>
        <p class="muted">${others.length ? `Your existing hooks stay as they are (${others.map(([e, n]) => `${e}: ${n}`).join(', ')}). ` : ''}A backup of settings.json is saved next to it first.
        The hook prints nothing, never fails, and gives up after 0.8 s if Whamming isn't running.</p>
        <div class="setup-actions"><button class="btn primary" data-setup="hooks-install">Install hooks</button><button class="btn" data-setup="hooks-cancel">Cancel</button></div>`;
    } else if (hooksOk)
      hooksStep = `<p class="setup-ok">${check}<span>Installed. Working, idle and permission prompts are tracked automatically.</span></p>
        <div class="setup-actions"><button class="btn" data-setup="hooks-remove">Remove hooks</button></div>`;
    else
      hooksStep = `<p>Lets Claude Code tell Whamming when a turn starts and ends and when it's asking for permission,
          so status stays right even if an agent forgets its instructions.${hooks.installed.length ? ` (Partly installed: ${hooks.installed.join(', ')}.)` : ''}</p>
        <button class="btn ${cli.installed ? 'primary' : ''}" data-setup="hooks-review" ${cli.installed ? '' : 'disabled title="Install the command line tool first"'}>Review &amp; install…</button>`;

    body.innerHTML = `
      <ol class="setup-steps">
        <li class="${cli.installed ? 'done' : ''}"><h3>Command line tool</h3>${cliStep}</li>
        <li class="${hooksOk ? 'done' : ''}"><h3>Claude Code hooks</h3>${hooksStep}</li>
        <li><h3>Agent instructions</h3>
          <p>Paste into your global agent context (e.g. <code>~/.claude/CLAUDE.md</code>) so agents report titles, questions, links and ports, and coordinate with each other.</p>
          <div class="code-wrap"><pre>${esc(snippet)}</pre><button class="btn" data-copy-snippet>Copy</button></div>
        </li>
      </ol>
      <p class="muted">API: <code>${esc(location.origin)}/api</code></p>`;

    body.querySelector('[data-copy-snippet]')!.addEventListener('click', () => {
      void copyText(snippet);
      toast('Copied agent instructions');
    });
    body.querySelectorAll<HTMLButtonElement>('[data-setup]').forEach((b) =>
      b.addEventListener('click', () => {
        const what = b.dataset.setup;
        if (what === 'cli') return act(() => api('/api/setup/cli', { method: 'POST', body: '{}' }), 'Command line tool installed');
        if (what === 'hooks-review') return ((reviewing = true), draw());
        if (what === 'hooks-cancel') return ((reviewing = false), draw());
        if (what === 'hooks-install') return act(() => api('/api/setup/hooks', { method: 'POST', body: '{}' }), 'Hooks installed: takes effect in new Claude sessions');
        if (what === 'hooks-remove') return act(() => api('/api/setup/hooks', { method: 'DELETE' }), 'Hooks removed');
      }),
    );
  };

  await load();
  draw();
}

function closeSetup() {
  $('modal').hidden = true;
}

// ---------- events ----------

document.addEventListener('click', async (e) => {
  const t = e.target as HTMLElement;

  const nav = t.closest<HTMLElement>('[data-view]');
  if (nav) {
    state.view = nav.dataset.view as View;
    state.folder = null;
    return render();
  }
  const folder = t.closest<HTMLElement>('[data-folder]');
  if (folder) {
    state.folder = state.folder === folder.dataset.folder ? null : folder.dataset.folder!;
    state.view = 'all';
    return render();
  }
  const group = t.closest<HTMLElement>('[data-group]');
  if (group) {
    state.groupBy = group.dataset.group as GroupBy;
    localStorage.setItem('groupBy', state.groupBy);
    return renderList();
  }
  if (t.closest('a[target="_blank"]')) return; // links open externally; don't also select the row
  const copy = t.closest<HTMLElement>('[data-copy]');
  if (copy) {
    void copyText(copy.dataset.copy!);
    return toast('Copied');
  }
  const peer = t.closest<HTMLElement>('[data-select]');
  if (peer) return select(peer.dataset.select!);
  const tog = t.closest<HTMLElement>('[data-toggle-tasks]');
  if (tog) {
    const id = tog.dataset.toggleTasks!;
    state.collapsed.has(id) ? state.collapsed.delete(id) : state.collapsed.add(id);
    try {
      localStorage.setItem('collapsed', JSON.stringify([...state.collapsed]));
    } catch {
      /* per-viewer convenience only */
    }
    return renderList();
  }
  const more = t.closest<HTMLElement>('[data-toggle-done]');
  if (more) {
    const id = more.dataset.toggleDone!;
    state.showDone.has(id) ? state.showDone.delete(id) : state.showDone.add(id);
    return renderList();
  }
  const r = t.closest<HTMLElement>('.row');
  if (r) return select(r.dataset.id === state.selectedId ? null : r.dataset.id!);

  const rel = t.closest<HTMLButtonElement>('[data-release]');
  if (rel) {
    if (!rel.classList.contains('armed')) {
      rel.classList.add('armed');
      rel.dataset.tip = 'Click again to release';
      setTimeout(() => rel.classList.remove('armed'), 3000);
      return;
    }
    await api(`/api/ports/${rel.dataset.release}?force=1`, { method: 'DELETE' }).catch((err) => toast(err.message));
    return;
  }

  const action = t.closest<HTMLElement>('[data-action]')?.dataset.action;
  if (action === 'toggle-listeners') {
    state.showAllListeners = !state.showAllListeners;
    return renderList();
  }
  if (action === 'close') return select(null);
  if (action === 'setup') return openSetup();
  if (action === 'remove') {
    const btn = t.closest<HTMLButtonElement>('button')!;
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = 'Click again to remove';
      setTimeout(() => {
        btn.classList.remove('armed');
        btn.textContent = 'Remove session';
      }, 3000);
      return;
    }
    const id = state.selectedId!;
    select(null);
    await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch((err) => toast(err.message));
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target as HTMLFormElement;
  if (form.dataset.action !== 'send' || !state.selectedId) return;
  e.preventDefault();
  const ta = form.querySelector('textarea')!;
  const body = ta.value.trim();
  if (!body) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(state.selectedId)}/messages`, { method: 'POST', body: JSON.stringify({ from: 'human', body }) });
    ta.value = '';
    toast('Message queued — the agent sees it on its next inbox check');
  } catch (err: any) {
    toast(err.message);
  }
});

document.addEventListener('keydown', (e) => {
  const inField = (e.target as HTMLElement).closest('input, textarea');
  if (e.key === 'Escape') {
    if (!$('modal').hidden) return closeSetup();
    if (inField) return (e.target as HTMLElement).blur();
    return select(null);
  }
  if (inField) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (e.target as HTMLElement).tagName === 'TEXTAREA') {
      (e.target as HTMLElement).closest('form')?.requestSubmit();
    }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') {
    e.preventDefault();
    $<HTMLInputElement>('search').focus();
  } else if (e.key === 'j' || e.key === 'ArrowDown') {
    e.preventDefault();
    move(1);
  } else if (e.key === 'k' || e.key === 'ArrowUp') {
    e.preventDefault();
    move(-1);
  } else if (e.key === 'p') {
    state.view = 'ports';
    state.folder = null;
    render();
  } else if (/^[1-6]$/.test(e.key)) {
    state.view = NAV[Number(e.key) - 1].view;
    state.folder = null;
    render();
  }
});

$<HTMLInputElement>('search').addEventListener('input', (e) => {
  state.query = (e.target as HTMLInputElement).value;
  renderList();
});
$('setup-btn').addEventListener('click', openSetup);
$('modal-close').addEventListener('click', closeSetup);
$('modal').addEventListener('click', (e) => {
  if (e.target === $('modal')) closeSetup();
});
window.addEventListener('hashchange', selectFromHash);

// Keep relative times fresh.
setInterval(() => {
  renderList();
}, 30_000);

// Listeners come and go without store events; poll while the ports view is open.
setInterval(async () => {
  if (state.view !== 'ports' || document.hidden) return;
  try {
    state.ports = await api<PortsSnapshot>('/api/ports');
    renderList();
  } catch {
    /* connection state is handled by refresh() */
  }
}, 5000);

// Boot
installTooltips();
connectStream();
refresh().then(selectFromHash);
