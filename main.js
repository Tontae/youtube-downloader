const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Two windows racing `yt-dlp -U` on startup could both try to overwrite the
// same bin/yt-dlp.exe at once, and the one-download-at-a-time guard is
// per-process, so a second window could also start a conflicting download.
// A non-technical user double-clicking the exe twice is an easy way to trigger
// this, so the second instance just quits instead of opening another window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  // CommonJS wraps this file in a function, so `return` here really does skip
  // registering any window/IPC handlers in the second instance before it exits.
  return;
}

/**
 * Two different roots, because packaged builds split them:
 * - appDir is the folder the user unzipped, where the .exe sits. Files the user
 *   is meant to see and replace (cookies.txt) belong here.
 * - resourcesDir is where the packaging config copies bin/, i.e. the `resources`
 *   subfolder of that same folder.
 * In dev both are __dirname, so `npm start` behaves exactly as before.
 */
const appDir = app.isPackaged ? path.dirname(process.execPath) : __dirname;
const resourcesDir = app.isPackaged ? process.resourcesPath : __dirname;

const IS_WINDOWS = process.platform === 'win32';
const EXE_SUFFIX = IS_WINDOWS ? '.exe' : '';

const BUNDLED_YT_DLP_PATH = path.join(resourcesDir, 'bin', `yt-dlp${EXE_SUFFIX}`);
const FFMPEG_PATH = path.join(resourcesDir, 'bin', `ffmpeg${EXE_SUFFIX}`);

/**
 * `yt-dlp -U` overwrites its own binary. On Windows the unzipped app folder is
 * writable, so the bundled copy is updated in place as before. On macOS the
 * bundled copy sits inside the signed .app, which must not be modified (and may
 * not be writable), so it is copied once into userData and that copy is the one
 * that runs and self-updates. If the copy cannot be made, the bundled binary is
 * still usable — it just will not be able to update itself.
 * `app.getPath('userData')` is valid before 'ready', so this can run at load.
 */
function resolveYtDlpPath() {
  if (IS_WINDOWS) {
    return BUNDLED_YT_DLP_PATH;
  }
  const writablePath = path.join(app.getPath('userData'), 'bin', 'yt-dlp');
  try {
    if (!fs.existsSync(writablePath)) {
      fs.mkdirSync(path.dirname(writablePath), { recursive: true });
      // Copied under a temp name and renamed, so a copy cut short (disk full,
      // app killed) never leaves a truncated binary that existsSync would then
      // treat as good on every later launch.
      const tempPath = `${writablePath}.tmp`;
      // Contents only: copyFileSync would carry the zip's com.apple.quarantine
      // xattr over, and Gatekeeper may then refuse to run the copy.
      fs.writeFileSync(tempPath, fs.readFileSync(BUNDLED_YT_DLP_PATH), { mode: 0o755 });
      fs.renameSync(tempPath, writablePath);
    }
    fs.chmodSync(writablePath, 0o755);
    return writablePath;
  } catch (error) {
    console.error('[main] could not copy yt-dlp to userData, using the bundled copy:', describeError(error));
    return BUNDLED_YT_DLP_PATH;
  }
}

const YT_DLP_PATH = resolveYtDlpPath();

/** Makes the yt-dlp child (and the JS runtime it launches, which inherits this
 *  env) run process.execPath as plain Node instead of opening another Electron app. */
const YT_DLP_ENV = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
/** On macOS/Linux, `detached` makes each child the leader of its own process
 *  group, so killProcessTree can signal the whole group (yt-dlp plus the ffmpeg
 *  and JS runtime it spawns). Not used on Windows: there it would give the child
 *  its own console window, and taskkill /T already handles the tree. */
const PROCESS_GROUP_OPTIONS = IS_WINDOWS ? {} : { detached: true };

const OUTPUT_TEMPLATE = '%(title)s [%(id)s].%(ext)s';
/** YouTube now 403s anonymous requests for most formats. Reading the cookie DB
 *  straight from Chrome/Edge fails on this machine (App-Bound Encryption breaks
 *  yt-dlp's DPAPI decrypt, see yt-dlp#10927), so instead we read a Netscape-format
 *  cookies.txt the user exports manually via a browser extension. On Windows it
 *  is kept next to the app (not in AppData) so the user can see and swap the
 *  file themselves. On macOS "next to the app" is inside the .app bundle, which
 *  is not a place to write, so it goes in userData; the in-app import button is
 *  how the user replaces it there. */
const COOKIES_FILE_PATH = IS_WINDOWS
  ? path.join(appDir, 'cookies.txt')
  : path.join(app.getPath('userData'), 'cookies.txt');
/** Searched rather than linked to a specific extension id: store ids change and
 *  a wrong one would send the user to a dead page. */
const COOKIE_EXTENSION_SEARCH_URL = 'https://chromewebstore.google.com/search/Get%20cookies.txt%20LOCALLY';
/** YouTube's "n" signature challenge needs a JS engine to solve, and users'
 *  machines cannot be assumed to have Node.js or Deno installed. Electron is
 *  itself a Node runtime when started with ELECTRON_RUN_AS_NODE=1 (see
 *  YT_DLP_ENV), so yt-dlp is pointed at our own executable — electron.exe in dev,
 *  the app binary when packaged. The solver script itself is fetched from the
 *  yt-dlp-ejs GitHub release on first use. */
const JS_CHALLENGE_ARGS = ['--js-runtimes', `node:${process.execPath}`, '--remote-components', 'ejs:github'];
/** Metadata lookup is a network call; without a cap a stalled DNS/TLS hang would freeze the UI forever. */
const METADATA_TIMEOUT_MS = 60_000;
/** The self-update check runs before the user can do anything, so it gets a
 *  short leash: with no internet it must give up quickly, not hold the app shut. */
const UPDATE_CHECK_TIMEOUT_MS = 15_000;
/** `ffmpeg -i` with no output file only prints stream info and exits; if it has
 *  not done that in this long, something is wrong and the probe is abandoned. */
const PROBE_TIMEOUT_MS = 15_000;
/** Idle timeout for the re-encode pass: ffmpeg logs progress roughly once a
 *  second, so this only fires if it has genuinely stalled, regardless of how
 *  long the whole re-encode legitimately takes on a long video. */
const TRANSCODE_IDLE_TIMEOUT_MS = 60_000;

let mainWindow = null;
/** Only one download at a time: the UI has a single progress bar, and two concurrent muxes fight over the same output name. */
let activeDownload = null;

function createMainWindow() {
  const window = new BrowserWindow({
    width: 480,
    height: 640,
    minWidth: 420,
    minHeight: 520,
    title: 'YouTube Downloader',
    backgroundColor: '#1e1f24',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  window.setMenuBarVisibility(false);

  // The page only ever shows local content. Anything trying to navigate away
  // or open a popup is a bug or an attack, so refuse both.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  window.loadFile(path.join(__dirname, 'renderer', 'index.html')).catch((error) => {
    console.error('[main] failed to load renderer:', error);
  });

  window.on('closed', () => {
    mainWindow = null;
  });

  return window;
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `child.kill()` on Windows only signals the one PID; a yt-dlp process spawns
 * ffmpeg (and, with --js-runtimes node, a node subprocess) as children of that
 * PID, so killing just the parent leaves them running and still writing the
 * output file after the app has quit. taskkill /T walks the whole tree.
 * Elsewhere the child was spawned as a process-group leader (see
 * PROCESS_GROUP_OPTIONS), so a negative pid signals the whole group.
 */
function killProcessTree(child) {
  if (!child || child.pid == null) {
    return;
  }
  if (IS_WINDOWS) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    // ESRCH just means the group already exited; anything else, at least stop the parent.
    console.error('[main] could not kill the process group, killing the child only:', describeError(error));
    child.kill('SIGKILL');
  }
}

/**
 * Returns the `--cookies <file>` args if cookies.txt was exported next to the
 * app, otherwise an error pointing at the in-app import flow. YouTube rejects
 * most download requests without a logged-in session's cookies. The renderer
 * checks for the file up front too (see 'check-cookies-status'); this stays as
 * the fallback for the file disappearing mid-session.
 */
function cookieArgsOrError() {
  if (!fs.existsSync(COOKIES_FILE_PATH)) {
    return {
      ok: false,
      error: 'ไม่พบไฟล์คุกกี้ กรุณากดปุ่ม "เปลี่ยนไฟล์คุกกี้" ด้านล่าง แล้วเลือกไฟล์ cookies.txt'
    };
  }
  return { ok: true, args: ['--cookies', COOKIES_FILE_PATH] };
}

/**
 * A URL that starts with http:// or https:// can never be mistaken for a
 * command line option by yt-dlp, which is the whole point of checking the
 * scheme rather than trusting the renderer.
 */
function validateUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return { ok: false, error: 'กรุณาใส่ลิงก์วิดีโอ' };
  }
  const url = rawUrl.trim();
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    return { ok: false, error: 'ลิงก์ไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'รองรับเฉพาะลิงก์ http:// หรือ https:// เท่านั้น' };
  }
  return { ok: true, url };
}

/** Pulls the first "ERROR: ..." line out of yt-dlp's stderr; falls back to the last non-empty line. */
function extractYtDlpError(stderr) {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const errorLine = lines.find((line) => line.startsWith('ERROR:'));
  return errorLine || lines[lines.length - 1] || '';
}

/**
 * Runs yt-dlp to completion and buffers its output. Only used for the metadata call, which is small.
 *
 * `timeoutMs` is an IDLE timeout, reset on every byte of output, not a flat cap
 * on total runtime — a slow-but-progressing metadata fetch should not be killed.
 * Firing the timeout resolves the promise directly instead of only killing the
 * process and hoping 'close' follows: on Windows, `yt-dlp -U` replaces its own
 * exe via a helper process, and `taskkill` can fail to reach every descendant,
 * so 'close' is not guaranteed to ever fire. Without resolving here, callers
 * (the startup update check, in particular) would hang forever.
 */
function runYtDlp(args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(YT_DLP_PATH, args, { windowsHide: true, ...PROCESS_GROUP_OPTIONS, env: YT_DLP_ENV });
    } catch (error) {
      resolve({ ok: false, error: `เรียก yt-dlp ไม่สำเร็จ: ${describeError(error)}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    let timer = null;
    const resetIdleTimer = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        killProcessTree(child);
        // `timedOut` lets callers that can live without the result (the update
        // check) tell "no network" apart from "yt-dlp is broken".
        resolve({ ok: false, timedOut: true, error: 'ดึงข้อมูลนานเกินไป (หมดเวลา) กรุณาลองใหม่' });
      }, timeoutMs);
    };
    resetIdleTimer();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      resetIdleTimer();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      resetIdleTimer();
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `เรียก yt-dlp ไม่สำเร็จ: ${describeError(error)}` });
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ok: true, code, stdout, stderr });
    });
  });
}

/** A whole re-encode logs a progress line per second; only the tail is ever
 *  needed (for the error message), so the buffer is capped. */
const FFMPEG_STDERR_LIMIT = 8_000;

/**
 * Runs ffmpeg to completion and buffers stderr, which is where ffmpeg puts
 * everything including stream info.
 *
 * `timeoutMs` is an IDLE timeout (reset on every chunk of stderr), not a flat
 * cap on total runtime — a long re-encode logs roughly once a second, so this
 * only fires if ffmpeg has genuinely stopped producing output, not just because
 * the file is long. `timeoutMs` of 0 disables it entirely.
 *
 * As with runYtDlp, the timeout resolves the promise directly rather than only
 * killing the process and waiting for 'close' — taskkill is not guaranteed to
 * make 'close' fire, and a promise that never settles here means activeDownload
 * never gets cleared, permanently blocking every future download.
 *
 * `opts.onStderrChunk`, if given, is called with each raw chunk as it arrives —
 * used to report real re-encode progress instead of a frozen-looking bar.
 *
 * ffmpeg only ever runs as part of a download here, so the child takes over the
 * activeDownload slot: that keeps the one-job-at-a-time guard true while it runs
 * and lets the before-quit handler kill it.
 */
function runFfmpeg(args, timeoutMs, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(FFMPEG_PATH, args, { windowsHide: true, ...PROCESS_GROUP_OPTIONS });
    } catch (error) {
      resolve({ ok: false, error: `เรียก ffmpeg ไม่สำเร็จ: ${describeError(error)}` });
      return;
    }
    activeDownload = child;

    let stderr = '';
    let settled = false;
    let timer = null;

    const release = () => {
      if (timer) {
        clearTimeout(timer);
      }
      if (activeDownload === child) {
        activeDownload = null;
      }
    };

    const resetIdleTimer = () => {
      if (timeoutMs <= 0) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        killProcessTree(child);
        release();
        resolve({ ok: false, timedOut: true, error: 'ffmpeg ใช้เวลานานเกินไป (หมดเวลา)' });
      }, timeoutMs);
    };
    resetIdleTimer();

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > FFMPEG_STDERR_LIMIT) {
        stderr = stderr.slice(-FFMPEG_STDERR_LIMIT);
      }
      resetIdleTimer();
      if (opts.onStderrChunk) {
        opts.onStderrChunk(chunk);
      }
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      release();
      resolve({ ok: false, error: `เรียก ffmpeg ไม่สำเร็จ: ${describeError(error)}` });
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      release();
      resolve({ ok: true, code, stderr });
    });
  });
}

/**
 * Pulls the first video and audio codec out of `ffmpeg -i` output. The bundled
 * build ships ffmpeg only (no ffprobe), so parsing these lines is the only way
 * to learn what was actually downloaded:
 *   Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, ...
 *   Stream #0:1[0x2](und): Audio: opus, 48000 Hz, stereo, fltp
 * An empty string means that stream kind was not found.
 */
function parseStreamCodecs(ffmpegStderr) {
  const codecs = { video: '', audio: '' };
  for (const line of ffmpegStderr.split(/\r?\n/)) {
    const match = /^\s*Stream #\d+:\d+.*?:\s*(Video|Audio):\s*([A-Za-z0-9_.-]+)/.exec(line);
    if (!match) {
      continue;
    }
    const kind = match[1] === 'Video' ? 'video' : 'audio';
    if (codecs[kind] === '') {
      codecs[kind] = match[2].toLowerCase();
    }
  }
  return codecs;
}

/** Parses a `HH:MM:SS(.ms)` timestamp into seconds; returns null if not found. */
function parseTimestampSeconds(text, label) {
  const match = new RegExp(`${label}\\s*(\\d+):(\\d+):(\\d+(?:\\.\\d+)?)`).exec(text);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** Pulls the most useful-looking line out of ffmpeg's stderr for a log message. */
function extractFfmpegError(stderr) {
  const lines = (stderr || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines[lines.length - 1] || '';
}

/**
 * Keeps one entry per resolution. Where several formats share a height, the one
 * with the higher bitrate wins, and mp4 breaks ties because it muxes into the
 * requested mp4 container without a re-encode.
 */
function pickDistinctResolutions(formats) {
  const bestByHeight = new Map();

  for (const format of formats) {
    if (!format || typeof format !== 'object') {
      continue;
    }
    // vcodec 'none' means audio-only; images/storyboards have no real height.
    if (!format.vcodec || format.vcodec === 'none') {
      continue;
    }
    const height = Number(format.height);
    if (!Number.isFinite(height) || height <= 0) {
      continue;
    }
    if (typeof format.format_id !== 'string' || format.format_id === '') {
      continue;
    }

    const current = bestByHeight.get(height);
    if (!current || isBetterFormat(format, current)) {
      bestByHeight.set(height, format);
    }
  }

  return [...bestByHeight.values()]
    .sort((a, b) => Number(b.height) - Number(a.height))
    .map((format) => {
      const ext = typeof format.ext === 'string' && format.ext !== '' ? format.ext : 'mp4';
      return {
        formatId: format.format_id,
        height: Number(format.height),
        ext,
        label: `${Number(format.height)}p (${ext})`
      };
    });
}

function isBetterFormat(candidate, current) {
  // h264 needs no compatibility re-encode afterwards, which is by far the
  // slowest step of a download, so it wins over a higher-bitrate VP9/AV1.
  const candidateIsH264 = isH264(candidate);
  const currentIsH264 = isH264(current);
  if (candidateIsH264 !== currentIsH264) {
    return candidateIsH264;
  }
  const candidateIsMp4 = candidate.ext === 'mp4';
  const currentIsMp4 = current.ext === 'mp4';
  if (candidateIsMp4 !== currentIsMp4) {
    return candidateIsMp4;
  }
  return (Number(candidate.tbr) || 0) > (Number(current.tbr) || 0);
}

function isH264(format) {
  return typeof format.vcodec === 'string' && format.vcodec.startsWith('avc1');
}

/** The renderer asks on load, and decides between the onboarding screen and the
 *  normal UI from the answer. */
ipcMain.handle('check-cookies-status', () => {
  return { ok: true, hasCookies: fs.existsSync(COOKIES_FILE_PATH) };
});

ipcMain.handle('open-cookie-extension-page', async () => {
  try {
    await shell.openExternal(COOKIE_EXTENSION_SEARCH_URL);
  } catch (error) {
    console.error('[main] could not open the extension page:', describeError(error));
    return { ok: false, error: `เปิดหน้าเว็บไม่สำเร็จ: ${describeError(error)}` };
  }
  return { ok: true };
});

/**
 * Copies a cookies.txt the user picked into place. Also used later on, from the
 * normal UI, because YouTube cookies expire every few weeks and the user must be
 * able to swap the file without touching the folder by hand.
 * `imported: false` means the dialog was dismissed, which is not an error.
 */
ipcMain.handle('import-cookies-file', async () => {
  const options = {
    title: 'เลือกไฟล์ cookies.txt',
    properties: ['openFile'],
    filters: [{ name: 'ไฟล์คุกกี้', extensions: ['txt'] }]
  };

  let result;
  try {
    result =
      mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
  } catch (error) {
    console.error('[main] file dialog failed:', describeError(error));
    return { ok: false, error: `เปิดหน้าต่างเลือกไฟล์ไม่สำเร็จ: ${describeError(error)}` };
  }

  if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
    return { ok: true, imported: false };
  }

  const source = result.filePaths[0];
  try {
    // Picking the file that is already in place is a no-op: copying a file onto
    // itself fails on Windows instead of doing nothing.
    if (path.resolve(source) !== path.resolve(COOKIES_FILE_PATH)) {
      // A no-op on Windows (appDir always exists); on macOS userData may not
      // have been created yet on a first run.
      fs.mkdirSync(path.dirname(COOKIES_FILE_PATH), { recursive: true });
      fs.copyFileSync(source, COOKIES_FILE_PATH);
    }
  } catch (error) {
    console.error('[main] could not save the cookies file:', describeError(error));
    return { ok: false, error: `บันทึกไฟล์คุกกี้ไม่สำเร็จ: ${describeError(error)}` };
  }

  return { ok: true, imported: true };
});

/**
 * yt-dlp breaks whenever YouTube changes something, so it self-updates on every
 * launch. Always resolves with a status and never rejects: a failed or timed-out
 * update check must not stop the app from being usable.
 */
ipcMain.handle('check-yt-dlp-update', async () => {
  const result = await runYtDlp(['-U'], UPDATE_CHECK_TIMEOUT_MS);

  if (!result.ok) {
    if (result.timedOut) {
      console.error('[main] yt-dlp -U timed out; continuing without updating');
      return { ok: true, status: 'skipped' };
    }
    console.error('[main] yt-dlp -U could not run:', result.error);
    return { ok: true, status: 'error' };
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0) {
    console.error(`[main] yt-dlp -U exited with code ${result.code}: ${extractYtDlpError(result.stderr)}`);
    return { ok: true, status: 'error' };
  }
  if (/Updated yt-dlp/i.test(output)) {
    return { ok: true, status: 'updated' };
  }
  if (/up to date/i.test(output)) {
    return { ok: true, status: 'up-to-date' };
  }
  // Exit code 0 with unfamiliar wording still means yt-dlp is fine, so it is
  // reported the same as "nothing to do" rather than alarming the user.
  return { ok: true, status: 'up-to-date' };
});

/**
 * The app is ad-hoc signed, which rules out real auto-update on macOS, so this
 * only tells the user a newer release exists and opens its page. Any failure
 * (offline, rate limit) just means no notice.
 */
const RELEASES_API_URL = 'https://api.github.com/repos/Tontae/youtube-downloader/releases/latest';
const RELEASES_PAGE_URL = 'https://github.com/Tontae/youtube-downloader/releases/latest';

ipcMain.handle('check-app-update', async () => {
  try {
    const response = await fetch(RELEASES_API_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'yt-downloader' },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      return { ok: true, newer: null };
    }
    const release = await response.json();
    const latest = String(release.tag_name || '').replace(/^v/, '');
    return { ok: true, newer: isNewerVersion(latest, app.getVersion()) ? latest : null };
  } catch (error) {
    console.error('[main] app update check failed:', describeError(error));
    return { ok: true, newer: null };
  }
});

ipcMain.handle('open-release-page', () => shell.openExternal(RELEASES_PAGE_URL));

/** Compares plain x.y.z versions; anything unparsable is never "newer". */
function isNewerVersion(candidate, current) {
  const parse = (v) => (/^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : null);
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) {
    return false;
  }
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) {
      return diff > 0;
    }
  }
  return false;
}

ipcMain.handle('fetch-formats', async (_event, rawUrl) => {
  const validated = validateUrl(rawUrl);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }

  const cookies = cookieArgsOrError();
  if (!cookies.ok) {
    return cookies;
  }

  const result = await runYtDlp(
    ['-J', '--no-playlist', ...JS_CHALLENGE_ARGS, ...cookies.args, validated.url],
    METADATA_TIMEOUT_MS
  );
  if (!result.ok) {
    return result;
  }

  if (result.code !== 0) {
    const detail = extractYtDlpError(result.stderr);
    return {
      ok: false,
      error: detail ? `ดึงข้อมูลไม่สำเร็จ: ${detail}` : 'ดึงข้อมูลไม่สำเร็จ ลิงก์อาจไม่ใช่วิดีโอหรือเชื่อมต่อไม่ได้'
    };
  }

  let info;
  try {
    info = JSON.parse(result.stdout);
  } catch (error) {
    console.error('[main] could not parse yt-dlp metadata:', describeError(error));
    return { ok: false, error: 'อ่านข้อมูลวิดีโอไม่ได้ (รูปแบบข้อมูลไม่ถูกต้อง)' };
  }

  if (!info || !Array.isArray(info.formats)) {
    return { ok: false, error: 'ไม่พบรายการคุณภาพวิดีโอในลิงก์นี้' };
  }

  const formats = pickDistinctResolutions(info.formats);
  if (formats.length === 0) {
    return { ok: false, error: 'ไม่พบความละเอียดที่ดาวน์โหลดได้สำหรับลิงก์นี้' };
  }

  return { ok: true, title: typeof info.title === 'string' ? info.title : '', formats: [...formats, ...AUDIO_CHOICES] };
});

/** Audio-only choices appended after the resolutions. The ids contain ':' so
 *  they can never collide with a real yt-dlp format id. */
const AUDIO_CHOICES = [
  { formatId: 'audio:mp3', label: 'เสียงอย่างเดียว — MP3' },
  { formatId: 'audio:wav', label: 'เสียงอย่างเดียว — WAV' }
];
const AUDIO_FORMATS = { 'audio:mp3': 'mp3', 'audio:wav': 'wav' };

ipcMain.handle('start-download', async (_event, options) => {
  if (activeDownload) {
    return { ok: false, error: 'มีการดาวน์โหลดที่กำลังทำงานอยู่ กรุณารอให้เสร็จก่อน' };
  }

  const request = options && typeof options === 'object' ? options : {};
  const validated = validateUrl(request.url);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }

  // The id comes from our own list, but the renderer is still untrusted input
  // and this string is interpolated into the -f expression.
  const formatId = typeof request.formatId === 'string' ? request.formatId.trim() : '';
  const audioFormat = Object.hasOwn(AUDIO_FORMATS, formatId) ? AUDIO_FORMATS[formatId] : null;
  if (!audioFormat && !/^[\w.+-]+$/.test(formatId)) {
    return { ok: false, error: 'กรุณาเลือกความละเอียดก่อนดาวน์โหลด' };
  }

  const cookies = cookieArgsOrError();
  if (!cookies.ok) {
    return cookies;
  }

  // Always the user's Downloads folder — the renderer has no folder picker, so
  // accepting a caller-supplied path here would just be unused attack surface.
  const outputDir = app.getPath('downloads');

  // -x converts the best audio stream with ffmpeg; --audio-quality 0 is the
  // best VBR setting for mp3 and is ignored by lossless wav.
  const formatArgs = audioFormat
    ? ['-f', 'bestaudio/best', '-x', '--audio-format', audioFormat, '--audio-quality', '0']
    : // m4a is AAC, so preferring it skips the audio half of the compatibility pass.
      ['-f', `${formatId}+bestaudio[ext=m4a]/${formatId}+bestaudio/best`, '--merge-output-format', 'mp4'];

  const args = [
    ...formatArgs,
    '--ffmpeg-location',
    FFMPEG_PATH,
    '--no-playlist',
    ...JS_CHALLENGE_ARGS,
    ...cookies.args,
    // --newline puts every progress update on its own line instead of rewriting
    // one line with \r, and --no-color keeps escape codes out of the parsed text.
    // Note: --print would have given the final path directly, but it implies
    // --quiet and silences the progress lines, so the path is read from the
    // normal output below instead.
    '--newline',
    '--no-color',
    '-o',
    OUTPUT_TEMPLATE,
    '-P',
    outputDir,
    validated.url
  ];

  try {
    startDownloadProcess(args, outputDir, Boolean(audioFormat));
  } catch (error) {
    return { ok: false, error: `เริ่มดาวน์โหลดไม่สำเร็จ: ${describeError(error)}` };
  }

  return { ok: true, outputDir };
});

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function startDownloadProcess(args, outputDir, audioOnly) {
  const child = spawn(YT_DLP_PATH, args, { windowsHide: true, ...PROCESS_GROUP_OPTIONS, env: YT_DLP_ENV });
  activeDownload = child;

  let finalPath = '';
  let stderr = '';
  let stdoutTail = '';
  // On Windows, a spawn failure (e.g. missing exe) fires BOTH 'error' and
  // 'close' — without this flag the generic "close code -4058" message from
  // 'close' overwrites the specific ENOENT message 'error' already sent.
  let spawnFailed = false;
  const progressState = { streamsSeen: 0, lastPercent: 0, expectedStreams: audioOnly ? 1 : 2 };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  child.stdout.on('data', (chunk) => {
    // --newline already splits progress onto its own lines, but yt-dlp still
    // uses \r in some phases, so treat both as line breaks.
    stdoutTail += chunk;
    const lines = stdoutTail.split(/\r\n|\r|\n/);
    stdoutTail = lines.pop() || '';
    for (const line of lines) {
      const captured = handleDownloadLine(line, progressState);
      if (captured) {
        finalPath = captured;
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  child.on('error', (error) => {
    spawnFailed = true;
    activeDownload = null;
    console.error('[main] yt-dlp failed to start:', describeError(error));
    sendToRenderer('download-error', { message: `เรียก yt-dlp ไม่สำเร็จ: ${describeError(error)}` });
  });

  child.on('close', (code) => {
    if (spawnFailed) {
      activeDownload = null;
      return;
    }
    if (stdoutTail !== '') {
      const captured = handleDownloadLine(stdoutTail, progressState);
      if (captured) {
        finalPath = captured;
      }
      stdoutTail = '';
    }

    if (code === 0) {
      // Guarantees the bar visually completes even if the phase-weighted
      // estimate above never quite reached 100 (e.g. a single-stream fallback).
      sendToRenderer('download-progress', { percent: 100, detail: 'ดาวน์โหลดเสร็จสมบูรณ์' });
      // The editor-compatibility pass is for video; it would re-encode an
      // mp3/wav into an AAC .mp4 under the audio file's name.
      if (audioOnly) {
        activeDownload = null;
        sendToRenderer('download-complete', { filePath: finalPath || outputDir });
        return;
      }
      // activeDownload deliberately stays set: finalizeDownload may still run
      // ffmpeg, and it clears the slot itself when it is done.
      finalizeDownload(finalPath, outputDir).catch((error) => {
        activeDownload = null;
        console.error('[main] finalize step crashed:', describeError(error));
        sendToRenderer('download-complete', { filePath: finalPath || outputDir });
      });
      return;
    }

    activeDownload = null;
    const detail = extractYtDlpError(stderr);
    sendToRenderer('download-error', {
      message: detail ? `ดาวน์โหลดไม่สำเร็จ: ${detail}` : `ดาวน์โหลดไม่สำเร็จ (yt-dlp จบด้วยรหัส ${code})`
    });
  });
}

/**
 * Premiere Pro and After Effects do not reliably open VP9 video or Opus audio,
 * which is what YouTube serves for a lot of formats, so a finished download is
 * inspected and re-encoded to h264/AAC when needed before it is reported as
 * complete. Anything that goes wrong here still reports success with the
 * original file: a playable-but-awkward file beats losing the download.
 */
async function finalizeDownload(finalPath, outputDir) {
  try {
    if (!finalPath || !fs.existsSync(finalPath)) {
      // The output path could not be read out of yt-dlp's output; nothing to probe.
      sendToRenderer('download-complete', { filePath: finalPath || outputDir });
      return;
    }

    // No output file, so ffmpeg prints the stream list and exits non-zero. That
    // exit code is expected and ignored; only the text matters.
    const probe = await runFfmpeg(['-i', finalPath], PROBE_TIMEOUT_MS);
    const codecs = probe.ok ? parseStreamCodecs(probe.stderr) : { video: '', audio: '' };

    if (codecs.video === '' && codecs.audio === '') {
      console.error('[main] could not read codecs from ffmpeg output; skipping the compatibility pass');
      sendToRenderer('download-complete', { filePath: finalPath });
      return;
    }

    const needsVideo = codecs.video !== '' && codecs.video !== 'h264';
    const needsAudio = codecs.audio !== '' && codecs.audio !== 'aac';
    if (!needsVideo && !needsAudio) {
      sendToRenderer('download-complete', { filePath: finalPath });
      return;
    }

    const totalSeconds = probe.ok ? parseTimestampSeconds(probe.stderr, 'Duration:') : null;
    sendToRenderer('download-progress', { percent: 100, detail: 'กำลังแปลงไฟล์ให้เข้ากับโปรแกรมตัดต่อ...' });

    // Written next to the original and renamed over it at the end, so the name
    // the user was told about never changes.
    const tempPath = `${finalPath}.tmp.mp4`;
    // Many YouTube VP9 sources are 10-bit; without forcing 8-bit yuv420p the
    // encoder would produce High10 output that Premiere/AE often refuse to open.
    const libx264 = ['-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p'];
    const videoChoices = !needsVideo
      ? [['-c:v', 'copy']]
      : process.platform === 'darwin'
        ? // The Mac's hardware encoder is several times faster than libx264. It has
          // no CRF mode, so a bitrate is picked from the height; libx264 is the
          // fallback for Macs (or VMs) where VideoToolbox will not start.
          [['-c:v', 'h264_videotoolbox', '-b:v', videoToolboxBitrate(probe.stderr), '-pix_fmt', 'yuv420p'], libx264]
        : [libx264];
    const audioArgs = needsAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-c:a', 'copy'];

    let pass;
    for (const videoArgs of videoChoices) {
      pass = await transcodePass([...['-y', '-i', finalPath], ...videoArgs, ...audioArgs, tempPath], totalSeconds);
      if (pass.ok && pass.code === 0) {
        break;
      }
      console.error(`[main] ${videoArgs[1]} pass failed:`, pass.ok ? extractFfmpegError(pass.stderr) : pass.error);
      removeIfPresent(tempPath);
    }
    if (!pass.ok || pass.code !== 0) {
      sendToRenderer('download-complete', {
        filePath: finalPath,
        note: 'แปลงไฟล์ให้เข้ากับโปรแกรมตัดต่อไม่สำเร็จ ไฟล์ที่ได้เป็นไฟล์ต้นฉบับ'
      });
      return;
    }

    try {
      // A plain rename (no unlink first) is atomic on Windows — it replaces the
      // destination in one step, so a crash mid-way can never leave neither file.
      fs.renameSync(tempPath, finalPath);
    } catch (error) {
      console.error('[main] could not replace the original with the converted file:', describeError(error));
      sendToRenderer('download-complete', {
        filePath: finalPath,
        note: 'แปลงไฟล์เสร็จแล้วแต่เปลี่ยนชื่อไฟล์ไม่สำเร็จ ไฟล์ต้นฉบับยังอยู่'
      });
      return;
    }

    sendToRenderer('download-progress', { percent: 100, detail: 'แปลงไฟล์เสร็จสมบูรณ์' });
    sendToRenderer('download-complete', {
      filePath: finalPath,
      note: 'แปลงไฟล์ให้เข้ากับโปรแกรมตัดต่อแล้ว (h264/AAC)'
    });
  } finally {
    activeDownload = null;
  }
}

/** Generous enough that the hardware encode does not visibly lose detail. */
function videoToolboxBitrate(probeText) {
  const match = /Video:.*?\b(\d{3,5})x(\d{3,5})\b/.exec(probeText || '');
  const height = match ? Number(match[2]) : 1080;
  if (height >= 2000) return '45M';
  if (height >= 1400) return '24M';
  return '12M';
}

function transcodePass(args, totalSeconds) {
  return runFfmpeg(args, TRANSCODE_IDLE_TIMEOUT_MS, {
    onStderrChunk: (chunk) => {
      if (!totalSeconds) {
        return;
      }
      const elapsed = parseTimestampSeconds(chunk, 'time=');
      if (elapsed == null) {
        return;
      }
      // Capped below 100 so the final "complete" message is what the user
      // sees reach 100, not this in-progress estimate.
      const percent = Math.min(99, Math.round((elapsed / totalSeconds) * 100));
      sendToRenderer('download-progress', {
        percent,
        detail: `กำลังแปลงไฟล์ให้เข้ากับโปรแกรมตัดต่อ... ${percent}%`
      });
    }
  });
}

/** Deletes a leftover temp file; a failure here is logged, never thrown. */
function removeIfPresent(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error('[main] could not delete the temporary file:', describeError(error));
  }
}

/**
 * `-f <id>+bestaudio/best` almost always downloads two streams back-to-back
 * (video, then audio) before muxing — each reports its OWN 0-100%, so the raw
 * number resets partway through. This assumes that common 2-stream case and
 * maps stream 1 to the 0-50 range and stream 2 to 50-100, so the bar climbs
 * instead of resetting. The rare single-stream fallback just caps at 50% until
 * the close handler forces a final 100% (see startDownloadProcess).
 * Audio-only downloads fetch a single stream, so `state.expectedStreams` is 1 there.
 */
function computeOverallPercent(state, rawPercent) {
  const phase = Math.max(state.streamsSeen - 1, 0);
  const overall = (phase * 100 + rawPercent) / state.expectedStreams;
  // Never let the displayed percent move backwards.
  state.lastPercent = Math.max(state.lastPercent, Math.min(100, overall));
  return state.lastPercent;
}

/**
 * Reads one stdout line. Returns the final output path when the line reveals
 * it, otherwise an empty string. Progress is pushed to the renderer as a side
 * effect because it has to be reported as it arrives. `state` tracks which
 * stream (video/audio) is currently downloading, across calls for one download.
 */
function handleDownloadLine(rawLine, state) {
  const line = rawLine.trim();
  if (line === '') {
    return '';
  }

  const progress = /^\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line);
  if (progress) {
    const percent = computeOverallPercent(state, Number(progress[1]));
    sendToRenderer('download-progress', { percent, detail: line });
    return '';
  }

  // The caller keeps the last path seen. Order matters and yt-dlp cooperates:
  // the per-stream "Destination:" lines come first, and the "Merger"/
  // "VideoRemuxer" line with the real final file comes last, so it wins.
  const merged = /^\[Merger\] Merging formats into "(.+)"$/.exec(line);
  if (merged) {
    state.lastPercent = 100;
    sendToRenderer('download-progress', { percent: 100, detail: 'กำลังรวมไฟล์ภาพและเสียง...' });
    return merged[1];
  }
  // A single-format fallback (no separate audio to merge) still gets remuxed
  // into mp4 by --merge-output-format; its own line carries the real path too,
  // e.g. "[VideoRemuxer] Remuxing video from webm to mp4; Destination: <path>".
  // Without capturing it here, finalPath would keep pointing at the pre-remux
  // file that yt-dlp deletes after remuxing, silently skipping the h264 check.
  const remuxed = /^\[VideoRemuxer\].*Destination:\s*(.+)$/.exec(line);
  if (remuxed) {
    state.lastPercent = 100;
    sendToRenderer('download-progress', { percent: 100, detail: 'กำลังแปลงไฟล์คอนเทนเนอร์...' });
    return remuxed[1];
  }
  // Audio-only: the converted .mp3/.wav replaces the downloaded stream.
  const extracted = /^\[ExtractAudio\] Destination:\s*(.+)$/.exec(line);
  if (extracted) {
    state.lastPercent = 100;
    sendToRenderer('download-progress', { percent: 100, detail: 'กำลังแปลงเป็นไฟล์เสียง...' });
    return extracted[1];
  }
  const destination = /^\[download\] Destination:\s*(.+)$/.exec(line);
  if (destination) {
    state.streamsSeen += 1;
    return destination[1];
  }
  const alreadyDone = /^\[download\]\s+(.+?) has already been downloaded$/.exec(line);
  if (alreadyDone) {
    state.lastPercent = 100;
    sendToRenderer('download-progress', { percent: 100, detail: line });
    return alreadyDone[1];
  }

  return '';
}

/**
 * If the app was closed (or killed) mid-transcode, a `<name>.mp4.tmp.mp4` from
 * finalizeDownload is left behind — always incomplete, never resumable, and
 * with no other code path that ever cleans it up. Since every download always
 * lands in the Downloads folder (see start-download), that's the only place
 * that needs sweeping.
 */
function cleanupStaleTranscodeTempFiles() {
  const downloadsDir = app.getPath('downloads');
  let entries;
  try {
    entries = fs.readdirSync(downloadsDir);
  } catch (error) {
    console.error('[main] could not list the downloads folder for cleanup:', describeError(error));
    return;
  }
  for (const name of entries) {
    if (name.endsWith('.tmp.mp4')) {
      removeIfPresent(path.join(downloadsDir, name));
    }
  }
}

app.whenReady().then(() => {
  cleanupStaleTranscodeTempFiles();
  mainWindow = createMainWindow();
  console.log('[main] window ready');
}).catch((error) => {
  console.error('[main] startup failed:', describeError(error));
  app.quit();
});

app.on('window-all-closed', () => {
  app.quit();
});

// The second instance quits itself (see requestSingleInstanceLock above), but
// without this the user's second double-click just silently does nothing —
// bringing the existing window forward makes it look like their click worked.
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  }
});

// A yt-dlp child outliving the window would keep writing a file nobody is
// watching, so it is killed together with the app.
app.on('before-quit', () => {
  if (activeDownload) {
    killProcessTree(activeDownload);
    activeDownload = null;
  }
});
