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

// Only the Terminal screen gets to ask for terminals. The app checks again where the request comes from.
if (location.pathname === "/terminal.html") {
  contextBridge.exposeInMainWorld("hackyTerminal", {
    open: (kind: string, folder: string): Promise<number | { error: string }> => ipcRenderer.invoke("hacky:term:open", { kind, folder }),
    input: (id: number, data: string) => ipcRenderer.send("hacky:term:input", { id, data }),
    resize: (id: number, cols: number, rows: number) => ipcRenderer.send("hacky:term:resize", { id, cols, rows }),
    close: (id: number) => ipcRenderer.send("hacky:term:close", { id }),
    onData: (callback: (event: { id: number; data: string }) => void) => ipcRenderer.on("hacky:term:data", (_event, payload) => callback(payload)),
    onExit: (callback: (event: { id: number; code: number }) => void) => ipcRenderer.on("hacky:term:exit", (_event, payload) => callback(payload)),
  });
}

ipcRenderer.on("hacky:state", (_event, data: unknown) => window.postMessage(data, "*"));
