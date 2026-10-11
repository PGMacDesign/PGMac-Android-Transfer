// Sandboxed preloads can't load ES modules or local files, so this stays a single CommonJS file.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS is required here
const { contextBridge } = require('electron');

// The object's presence is how the page knows it runs in the desktop app.
contextBridge.exposeInMainWorld('pgmacDesktop', {});
