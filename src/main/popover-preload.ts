import { contextBridge, ipcRenderer } from 'electron';

// The popover's only window into the main process. Kept deliberately small.
contextBridge.exposeInMainWorld('whamming', {
  openSession: (id: string) => ipcRenderer.send('popover:open-session', String(id)),
  openDashboard: (view?: string) => ipcRenderer.send('popover:open-dashboard', view ? String(view) : undefined),
  resize: (height: number) => ipcRenderer.send('popover:resize', Number(height)),
  hide: () => ipcRenderer.send('popover:hide'),
  quit: () => ipcRenderer.send('popover:quit'),
  copy: (text: string) => ipcRenderer.send('clipboard:write', String(text)),
});
