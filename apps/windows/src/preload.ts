import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, DesktopEvent, DesktopRequest } from "./contracts.js";

const bridge: DesktopBridge = {
  request: <T>(request: DesktopRequest) => ipcRenderer.invoke("desktop:request", request) as Promise<T>,
  subscribe(callback) {
    const receive = (_event: Electron.IpcRendererEvent, event: DesktopEvent) => callback(event);
    ipcRenderer.on("desktop:event", receive);
    return () => ipcRenderer.removeListener("desktop:event", receive);
  },
};
contextBridge.exposeInMainWorld("desktop", bridge);
