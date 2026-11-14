import { contextBridge, ipcRenderer } from 'electron';

// Dashboard window bridge: just clipboard writes (the web clipboard API refuses unfocused windows).
contextBridge.exposeInMainWorld('whamming', {
  copy: (text: string) => ipcRenderer.send('clipboard:write', String(text)),
});
