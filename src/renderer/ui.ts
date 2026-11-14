import type { Link, SessionStatus, SessionView } from '../shared/types';

// Rendering helpers shared by the dashboard and the menu bar popover.

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function safeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : '#';
}

export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function fullTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const STATUS_HELP: Record<SessionStatus, string> = {
  waiting: 'Waiting for you: the agent has a question or needs approval',
  working: 'Working on its task',
  idle: 'Idle: finished its turn, ready for a new prompt',
  blocked: "Blocked: waiting on something that isn't you (a port, CI, another agent)",
  done: 'Done: the task is finished',
  error: "Error: the agent hit a problem it couldn't resolve",
};

export function statusIcon(st: SessionStatus): string {
  return statusSvg(st).replace('<svg ', `<svg data-tip="${esc(STATUS_HELP[st])}" `);
}

function statusSvg(st: SessionStatus): string {
  const c = `var(--st-${st})`;
  switch (st) {
    case 'blocked':
      return `<svg class="st" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.75" fill="none" stroke="${c}" stroke-width="1.5"/><path d="M5.6 4.9v4.2M8.4 4.9v4.2" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/></svg>`;
    case 'waiting':
      return `<svg class="st st-waiting" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.75" fill="none" stroke="${c}" stroke-width="1.5"/><circle class="pulse" cx="7" cy="7" r="2.5" fill="${c}"/></svg>`;
    case 'working':
      return `<svg class="st" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.75" fill="none" stroke="${c}" stroke-width="1.5"/><path d="M7 3.25a3.75 3.75 0 0 1 0 7.5z" fill="${c}"/></svg>`;
    case 'idle':
      return `<svg class="st" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.75" fill="none" stroke="${c}" stroke-width="1.5" stroke-dasharray="2.6 2"/></svg>`;
    case 'done':
      return `<svg class="st" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.5" fill="${c}"/><path d="m4.4 7.1 1.8 1.8 3.5-3.6" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    case 'error':
      return `<svg class="st" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.5" fill="${c}"/><path d="m5 5 4 4M9 5 5 9" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  }
}

export const exitedSvg = `<svg class="st" data-tip="Exited: the Claude Code process has ended" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.75" fill="none" stroke="var(--text-faint)" stroke-width="1.5"/><path d="M4.5 7h5" stroke="var(--text-faint)" stroke-width="1.5" stroke-linecap="round"/></svg>`;

export function isExited(s: SessionView): boolean {
  return s.alive === false && s.status !== 'done';
}

export function chip(l: Link): string {
  return `<a class="chip ${esc(l.kind)}" href="${esc(safeUrl(l.url))}" target="_blank"><span class="dot"></span>${esc(l.label)}</a>`;
}

/** Copy via the Electron bridge when present (works without focus), else the web clipboard API. */
export async function copyText(text: string): Promise<boolean> {
  const bridge = (window as any).whamming;
  if (bridge?.copy) {
    bridge.copy(text);
    return true;
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function toast(text: string) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1600);
}

/**
 * Hover help for everything. Elements carry `data-tip` (or a plain `title`, converted on hover so the slow
 * native tooltip never shows). External links get their URL plus "click to open · right-click to copy".
 * Right-clicking a link copies its URL.
 */
export function installTooltips() {
  const tip = document.createElement('div');
  tip.className = 'link-tip';
  tip.hidden = true;
  document.body.appendChild(tip);

  let current: HTMLElement | null = null;
  let timer: number | undefined;
  const linkOf = (t: EventTarget | null) => {
    const a = (t as Element | null)?.closest?.<HTMLAnchorElement>('a[target="_blank"]');
    return a && /^https?:/.test(a.href) ? a : null;
  };
  /** The innermost element with help text (a link counts too). */
  const targetOf = (t: EventTarget | null): HTMLElement | null => {
    const el = (t as Element | null)?.closest?.<HTMLElement>('[data-tip], [title]:not(title), a[target="_blank"]');
    if (!el) return null;
    if (el.hasAttribute('title') && !(el instanceof SVGTitleElement)) {
      const text = el.getAttribute('title');
      el.removeAttribute('title');
      if (text) el.dataset.tip = text;
    }
    return el.dataset.tip || linkOf(el) ? el : null;
  };

  const hide = () => {
    clearTimeout(timer);
    current = null;
    tip.hidden = true;
  };

  const show = (el: HTMLElement) => {
    const a = linkOf(el);
    const text = el.dataset.tip;
    tip.innerHTML =
      a && el === a
        ? `${text ? `<span class="t">${esc(text)}</span>` : ''}<span class="u">${esc(a.href.replace(/^https?:\/\//, ''))}</span><span class="h">Click to open · right-click to copy</span>`
        : `<span class="t">${esc(text)}</span>`;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    const below = r.bottom + 6 + h < window.innerHeight;
    tip.style.left = `${left}px`;
    tip.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - h - 6)}px`;
  };

  document.addEventListener('mouseover', (e) => {
    const el = targetOf(e.target);
    if (el === current) return;
    hide();
    if (!el) return;
    current = el;
    timer = window.setTimeout(() => current === el && el.isConnected && show(el), 400);
  });
  document.addEventListener('mouseout', (e) => {
    if (current && !current.contains(e.relatedTarget as Node | null)) hide();
  });
  document.addEventListener('scroll', hide, true);
  document.addEventListener('mousedown', hide);
  window.addEventListener('blur', hide);

  document.addEventListener('contextmenu', async (e) => {
    const a = linkOf(e.target);
    if (!a) return;
    e.preventDefault();
    hide();
    toast((await copyText(a.href)) ? 'Link copied' : 'Could not copy link');
  });
}
