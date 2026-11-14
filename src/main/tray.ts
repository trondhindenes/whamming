import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron';
import { join } from 'node:path';
import type { SessionView } from '../shared/types';

const WIDTH = 380;
const MIN_HEIGHT = 140;
const MAX_HEIGHT = 620;

export interface TrayOptions {
  dashboardUrl: string;
  assetsDir: string;
  preload: string;
  showDashboard: (hash?: string) => void;
}

/**
 * Menu bar presence: a template icon with the number of agents waiting on you, and a popover
 * with the at-a-glance overview. Data comes from the HTTP API so it works even when another
 * Whamming process owns the store.
 */
export function createMenuBar(opts: TrayOptions) {
  const icon = nativeImage.createFromPath(join(opts.assetsDir, 'trayTemplate.png'));
  icon.setTemplateImage(true);
  const tray = new Tray(icon);
  tray.setToolTip('Whamming');
  // Don't let the system highlight-on-click fight with our popover toggle.
  tray.setIgnoreDoubleClickEvents(true);

  let popover: BrowserWindow | null = null;
  let hiddenAt = 0;

  function createPopover() {
    const w = new BrowserWindow({
      width: WIDTH,
      height: 360,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      transparent: true,
      vibrancy: 'popover',
      visualEffectState: 'active',
      backgroundColor: '#00000000',
      roundedCorners: true,
      webPreferences: { preload: opts.preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    w.on('blur', () => {
      if (!w.webContents.isDevToolsOpened()) hide();
    });
    w.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
      hide();
      return { action: 'deny' };
    });
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.loadURL(`${opts.dashboardUrl}/popover.html`);
    return w;
  }

  function position(w: BrowserWindow) {
    const t = tray.getBounds();
    const { workArea } = screen.getDisplayNearestPoint({ x: t.x, y: t.y });
    const [, h] = w.getSize();
    const x = Math.round(Math.min(Math.max(t.x + t.width / 2 - WIDTH / 2, workArea.x + 8), workArea.x + workArea.width - WIDTH - 8));
    const y = Math.round(t.y + t.height + 4);
    w.setBounds({ x, y, width: WIDTH, height: h });
  }

  function show() {
    popover ??= createPopover();
    position(popover);
    popover.show();
    popover.focus();
    popover.webContents.send('popover:shown');
  }

  function hide() {
    if (popover?.isVisible()) {
      popover.hide();
      hiddenAt = Date.now();
    }
  }

  function toggle() {
    // Clicking the icon while the popover is open blurs it first; don't immediately re-open.
    if (popover?.isVisible()) return hide();
    if (Date.now() - hiddenAt < 250) return;
    show();
  }

  tray.on('click', toggle);
  tray.on('right-click', () =>
    tray.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Dashboard', click: () => opts.showDashboard() },
        { label: 'Ports', click: () => opts.showDashboard('#/v/ports') },
        { type: 'separator' },
        { label: 'Quit Whamming', role: 'quit' },
      ]),
    ),
  );

  ipcMain.on('popover:open-session', (_e, id: string) => {
    hide();
    opts.showDashboard('#/s/' + encodeURIComponent(id));
  });
  ipcMain.on('popover:open-dashboard', (_e, view?: string) => {
    hide();
    opts.showDashboard(view ? `#/v/${encodeURIComponent(view)}` : undefined);
  });
  ipcMain.on('popover:resize', (_e, height: number) => {
    if (!popover || !Number.isFinite(height)) return;
    // The page measures CSS pixels; zoom (shared per host with the dashboard, so Cmd+/- there
    // applies here too) scales them. Also never grow past the screen.
    const zoom = popover.webContents.getZoomFactor() || 1;
    const { workArea } = screen.getDisplayMatching(popover.getBounds());
    const max = Math.min(MAX_HEIGHT * Math.max(1, zoom), workArea.height - 40);
    const h = Math.round(Math.min(max, Math.max(MIN_HEIGHT, height * zoom)));
    const b = popover.getBounds();
    if (b.height !== h) popover.setBounds({ ...b, height: h });
  });
  ipcMain.on('popover:hide', hide);
  ipcMain.on('popover:quit', () => app.quit());

  /** Title next to the icon: how many agents are waiting on you (or erroring). */
  function update(sessions: SessionView[]) {
    const live = sessions.filter((s) => s.alive !== false);
    const waiting = live.filter((s) => s.status === 'waiting').length;
    const errors = live.filter((s) => s.status === 'error').length;
    tray.setTitle(waiting + errors ? ` ${waiting + errors}` : '', { fontType: 'monospacedDigit' });
    const working = live.filter((s) => s.status === 'working').length;
    tray.setToolTip(`Whamming — ${waiting} waiting, ${working} working${errors ? `, ${errors} error` : ''}`);
  }

  return { update, show, hide };
}
