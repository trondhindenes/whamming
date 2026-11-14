import { app, BrowserWindow, clipboard, ipcMain, Menu, Notification, shell } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createApi, DEFAULT_PORT, findBundledCli, HOST } from '../server/api';
import { removeStatus, startOrReuse } from '../server/status';
import { refreshCliLink } from '../server/setup';
import { STATE_FILE } from '../server/paths';
import { Store } from '../server/store';
import type { SessionStatus, SessionView } from '../shared/types';
import { createMenuBar } from './tray';

const ASSETS = join(__dirname, '../../assets');

let win: BrowserWindow | null = null;
let dashboardUrl = `http://${HOST}:${DEFAULT_PORT}`;
let store: Store | null = null;

// Separate profile for a second (dev) instance; otherwise the single-instance lock hands off to the running app.
if (process.env.WHAMMING_USER_DATA) app.setPath('userData', process.env.WHAMMING_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();

// Copy requests from our own pages (dashboard + popover). Only short plain text.
ipcMain.on('clipboard:write', (_e, text: unknown) => {
  if (typeof text === 'string' && text.length <= 4096) clipboard.writeText(text);
});
app.on('second-instance', () => showWindow());

/** Show the dashboard, optionally at a route like "#/s/<id>" or "#/v/ports". */
function showWindow(hash?: string) {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (hash) win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {});
    return;
  }
  win = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: 'Whamming',
    backgroundColor: '#0e0f11',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: { preload: join(__dirname, 'window-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(dashboardUrl)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });
  win.on('closed', () => (win = null));
  win.loadURL(`${dashboardUrl}/${hash ?? ''}`);
}

function focusSession(id: string) {
  showWindow('#/s/' + encodeURIComponent(id));
}

const STATUS_GLYPH: Record<SessionStatus, string> = { waiting: '◉', error: '⊗', working: '◐', blocked: '⏸', idle: '◌', done: '✓' };

/** Right-click on the Dock icon: jump straight to a session. */
function updateDockMenu(sessions: SessionView[]) {
  if (process.platform !== 'darwin' || !app.dock) return;
  const order: SessionStatus[] = ['waiting', 'error', 'working', 'blocked', 'idle'];
  const live = sessions
    .filter((s) => s.alive !== false && s.status !== 'done')
    .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))
    .slice(0, 12);
  app.dock.setMenu(
    Menu.buildFromTemplate([
      ...live.map((s) => ({
        label: `${STATUS_GLYPH[s.status]}  ${s.folderName} — ${(s.title || s.name).slice(0, 60)}`,
        click: () => focusSession(s.id),
      })),
      ...(live.length ? [{ type: 'separator' as const }] : []),
      { label: 'Ports', click: () => showWindow('#/v/ports') },
    ]),
  );
}

/** Dock badge + native notification when an agent starts waiting on you. */
function watchForAttention(s: Store) {
  const last = new Map<string, SessionStatus>();
  for (const v of s.list()) last.set(v.id, v.status);

  const refreshBadge = () => {
    const waiting = s.list({ status: 'waiting' }).filter((v) => v.alive !== false).length;
    if (process.platform === 'darwin') app.dock?.setBadge(waiting ? String(waiting) : '');
    else app.setBadgeCount(waiting);
  };

  s.on('change', ({ id }: { id?: string }) => {
    refreshBadge();
    if (!id) return;
    const sess = s.get(id);
    if (!sess) {
      last.delete(id);
      return;
    }
    const prev = last.get(id);
    last.set(id, sess.status);
    if (prev === sess.status) return;
    if ((sess.status === 'waiting' || sess.status === 'error') && Notification.isSupported()) {
      const n = new Notification({
        title: `${sess.name} · ${sess.status === 'waiting' ? 'needs you' : 'hit an error'}`,
        subtitle: sess.folderName,
        body: sess.detail || sess.title || sess.folder,
        silent: false,
      });
      n.on('click', () => focusSession(sess.id));
      n.show();
    }
  });
  refreshBadge();

  // Blocked is "waiting on something that isn't you", so it doesn't notify, unless it lasts long
  // enough that something is probably stuck. Once per blocked episode.
  const BLOCKED_ALERT_MS = 10 * 60 * 1000;
  const alerted = new Map<string, string>(); // session id -> statusSince we alerted for
  setInterval(() => {
    for (const v of s.list({ status: 'blocked' })) {
      if (v.alive === false || !v.statusSince || alerted.get(v.id) === v.statusSince) continue;
      if (Date.now() - Date.parse(v.statusSince) < BLOCKED_ALERT_MS || !Notification.isSupported()) continue;
      alerted.set(v.id, v.statusSince);
      const n = new Notification({ title: `${v.name} · blocked for 10 minutes`, subtitle: v.folderName, body: v.detail || v.title || '' });
      n.on('click', () => focusSession(v.id));
      n.show();
    }
  }, 30_000).unref();
}

app.whenReady().then(async () => {
  store = new Store(STATE_FILE);
  // Packaged: the CLI sits in Contents/Resources (outside app.asar, so it can be executed). Dev: dist/cli.
  const packagedCli = join(process.resourcesPath, 'whamming');
  const bundledCli = app.isPackaged ? (existsSync(packagedCli) ? packagedCli : null) : findBundledCli(join(__dirname, '..'));
  try {
    refreshCliLink(bundledCli); // the app moved or updated: keep ~/.local/bin/whamming pointing at it
  } catch (err) {
    console.error('[whamming] could not refresh CLI link:', err);
  }
  const listen = createApi(store, { staticDir: join(__dirname, '../renderer'), bundledCli });
  try {
    const r = await startOrReuse(listen);
    if ('api' in r) {
      dashboardUrl = r.api.url;
      store.startReaper(); // only the instance that owns the server touches state.json
      watchForAttention(store);
      console.log(`[whamming] API on ${r.api.url}`);
    } else {
      // Another Whamming already serves this data folder; show it rather than run a second server on the same state.
      dashboardUrl = r.reuse;
      store = null;
      console.log(`[whamming] reusing the Whamming already running on ${r.reuse}`);
    }
  } catch (err) {
    console.error('[whamming] failed to start the API:', err);
    app.quit();
    return;
  }

  if (process.platform === 'darwin') app.dock?.setIcon(join(ASSETS, 'icon.png'));

  const menuBar = createMenuBar({
    dashboardUrl,
    assetsDir: ASSETS,
    preload: join(__dirname, 'popover-preload.js'),
    showDashboard: showWindow,
  });

  // Tray title + Dock menu read through the HTTP API, so they also work when reusing another server.
  let pending: NodeJS.Timeout | undefined;
  const refreshShell = async () => {
    try {
      const { sessions } = (await (await fetch(`${dashboardUrl}/api/sessions`)).json()) as { sessions: SessionView[] };
      menuBar.update(sessions);
      updateDockMenu(sessions);
    } catch {
      /* server briefly unavailable */
    }
  };
  store?.on('change', () => {
    clearTimeout(pending);
    pending = setTimeout(refreshShell, 150);
  });
  setInterval(refreshShell, 15_000); // also notices agent processes exiting
  refreshShell();

  showWindow();
  app.on('activate', () => showWindow());
});

// Keep the API alive when the window is closed on macOS; agents keep reporting.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  store?.flush();
  if (store) removeStatus();
});
// Belt and braces: also on a plain process exit (e.g. SIGTERM from a terminal).
process.on('exit', () => {
  if (store) removeStatus();
});
