// Sandboxed preloads can't load ES modules or local files, so this stays a single CommonJS file.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS is required here
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// The object's presence is how the page knows it runs in the desktop app.
contextBridge.exposeInMainWorld('pgmacDesktop', {
  // Finder drops copy from where the files are instead of uploading them. Only this one
  // webUtils function is passed through; it returns "" for items with no file on disk.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  // A native drag of Mac files out of the window. Fire-and-forget on purpose: main must start
  // the drag while the page's dragstart handler is still running, so there is nothing to await.
  startDrag: (paths) => {
    ipcRenderer.send('drag-out', paths);
  },
  // A native picker for one file; resolves to its path, or null when cancelled. Nothing from
  // the page is passed along.
  chooseFile: () => ipcRenderer.invoke('choose-file'),
});
