// Keeps the installed app up to date from the project's GitHub releases. A new version downloads
// in the background and installs when the app quits, or straight away if the person asks.
import { autoUpdater } from "electron-updater";

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export function startUpdates(onReady: (version: string) => void): void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", (info) => onReady(info.version));
  // Being offline or having no release yet is normal, so a failed check is only logged.
  autoUpdater.on("error", (error) => console.warn(`Update check failed: ${error.message}`));
  const check = () => void autoUpdater.checkForUpdates().catch(() => undefined);
  check();
  setInterval(check, CHECK_EVERY_MS);
}

export function installUpdateNow(): void {
  autoUpdater.quitAndInstall();
}
