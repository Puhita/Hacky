// Gives each screen the two things it expects from VS Code: acquireVsCodeApi().postMessage(...)
// to send, and window "message" events to receive, plus getState/setState for what a screen
// remembers (kept per screen in the page's own storage). Nothing else from Electron or Node is exposed.
import { contextBridge, ipcRenderer } from "electron";

const stateKey = `hacky-state:${location.pathname}`;

contextBridge.exposeInMainWorld("acquireVsCodeApi", () => ({
  host: "desktop",
  postMessage: (message: unknown) => ipcRenderer.send("hacky:message", message),
  getState: (): unknown => {
    try {
      const saved = localStorage.getItem(stateKey);
      return saved === null ? undefined : JSON.parse(saved);
    } catch {
      return undefined;
    }
  },
  setState: (state: unknown) => {
    try {
      localStorage.setItem(stateKey, JSON.stringify(state));
    } catch {
      // Remembering the view is a convenience; the screen works without it.
    }
    return state;
  },
}));

ipcRenderer.on("hacky:state", (_event, data: unknown) => window.postMessage(data, "*"));
