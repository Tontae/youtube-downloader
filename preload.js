const { contextBridge, ipcRenderer } = require('electron');

/**
 * The page gets these functions and nothing else: no ipcRenderer, no require, no
 * path. Event payloads are forwarded without the IpcRendererEvent object, which
 * would otherwise hand the page a way back into the main process. None of these
 * take a file path or URL to open from the page: the main process decides both,
 * so the page cannot point them anywhere of its own choosing.
 */
const bridge = {
  fetchFormats: (url) => ipcRenderer.invoke('fetch-formats', url),

  startDownload: (options) => ipcRenderer.invoke('start-download', options),

  /** True/false answer used on load to pick the onboarding screen or the normal UI. */
  checkCookiesStatus: () => ipcRenderer.invoke('check-cookies-status'),

  /** Opens the native file picker and copies the chosen cookies.txt into place. */
  importCookiesFile: () => ipcRenderer.invoke('import-cookies-file'),

  openCookieExtensionPage: () => ipcRenderer.invoke('open-cookie-extension-page'),

  /** Runs yt-dlp's self-update once at startup. Always resolves with a status. */
  checkYtDlpUpdate: () => ipcRenderer.invoke('check-yt-dlp-update'),

  /** Resolves with { newer: 'x.y.z' } when GitHub has a newer release, else newer: null. */
  checkAppUpdate: () => ipcRenderer.invoke('check-app-update'),

  openReleasePage: () => ipcRenderer.invoke('open-release-page'),

  /** Subscribes to the download lifecycle. Returns a function that unsubscribes again. */
  subscribeDownload: ({ onProgress, onComplete, onError }) => {
    const progressListener = (_event, payload) => {
      if (typeof onProgress === 'function') {
        onProgress(payload);
      }
    };
    const completeListener = (_event, payload) => {
      if (typeof onComplete === 'function') {
        onComplete(payload);
      }
    };
    const errorListener = (_event, payload) => {
      if (typeof onError === 'function') {
        onError(payload);
      }
    };

    ipcRenderer.on('download-progress', progressListener);
    ipcRenderer.on('download-complete', completeListener);
    ipcRenderer.on('download-error', errorListener);

    return () => {
      ipcRenderer.removeListener('download-progress', progressListener);
      ipcRenderer.removeListener('download-complete', completeListener);
      ipcRenderer.removeListener('download-error', errorListener);
    };
  }
};

contextBridge.exposeInMainWorld('ytBridge', bridge);
