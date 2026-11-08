/**
 * UI wiring only: startup update check -> onboarding or main view, then
 * URL -> fetchFormats -> resolution dropdown -> startDownload, with the live
 * progress events driving the progress bar.
 */
const updateOverlay = document.getElementById('update-overlay');
const updateText = document.getElementById('update-text');
const updateSpinner = updateOverlay.querySelector('.spinner');
const onboardingView = document.getElementById('onboarding-view');
const onboardingStatus = document.getElementById('onboarding-status');
const openExtensionButton = document.getElementById('open-extension-button');
const importCookiesButton = document.getElementById('import-cookies-button');
const changeCookiesButton = document.getElementById('change-cookies-button');
const mainView = document.getElementById('main-view');
const urlInput = document.getElementById('url-input');
const fetchButton = document.getElementById('fetch-button');
const formatSelect = document.getElementById('format-select');
const downloadButton = document.getElementById('download-button');
const videoTitle = document.getElementById('video-title');
const progressBox = document.getElementById('progress');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const statusText = document.getElementById('status');

let isFetching = false;
let isDownloading = false;
/** Guards against a second file dialog while one is already open. */
let isImportingCookies = false;

/** How long the finished update message stays on screen before the app appears. */
const UPDATE_MESSAGE_HOLD_MS = 1500;

const UPDATE_MESSAGES = {
  updated: 'อัปเดตแล้ว',
  'up-to-date': 'เป็นเวอร์ชันล่าสุดอยู่แล้ว',
  skipped: 'ข้ามการตรวจสอบ (ไม่มีอินเทอร์เน็ต?)',
  error: 'ตรวจสอบอัปเดตไม่ได้ ข้ามไปก่อน'
};

function setStatus(message, kind) {
  statusText.textContent = message;
  statusText.className = kind ? `status ${kind}` : 'status';
}

function setOnboardingStatus(message, kind) {
  onboardingStatus.textContent = message;
  onboardingStatus.className = kind ? `status ${kind}` : 'status';
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function setProgress(percent, detail) {
  progressBox.classList.remove('hidden');
  const clamped = Math.max(0, Math.min(100, percent));
  progressBar.style.width = `${clamped}%`;
  progressText.textContent = detail ? `${clamped.toFixed(1)}% — ${detail}` : `${clamped.toFixed(1)}%`;
}

function resetFormats(placeholder) {
  formatSelect.innerHTML = '';
  const option = document.createElement('option');
  option.value = '';
  option.textContent = placeholder;
  formatSelect.appendChild(option);
  formatSelect.disabled = true;
}

/** Buttons must reflect both jobs at once: fetching during a download is still allowed to be blocked. */
function refreshButtons() {
  fetchButton.disabled = isFetching || isDownloading;
  fetchButton.textContent = isFetching ? 'กำลังดึงข้อมูล...' : 'ดึงข้อมูล';
  downloadButton.disabled = isDownloading || isFetching || formatSelect.value === '';
  downloadButton.textContent = isDownloading ? 'กำลังดาวน์โหลด...' : 'ดาวน์โหลด';
  changeCookiesButton.disabled = isImportingCookies;
}

/** Exactly one of the two views is visible at any time. */
function showView(name) {
  const wantsOnboarding = name === 'onboarding';
  onboardingView.classList.toggle('hidden', !wantsOnboarding);
  mainView.classList.toggle('hidden', wantsOnboarding);
}

/**
 * Picks the view from whether cookies.txt exists. If the check itself fails the
 * main view is shown: the download handlers still refuse politely without
 * cookies, so a failed check must not lock the user out.
 */
async function showViewForCookieStatus() {
  let result;
  try {
    result = await window.ytBridge.checkCookiesStatus();
  } catch (error) {
    console.error('could not check the cookies file:', error);
    showView('main');
    return;
  }

  showView(result && result.ok && result.hasCookies === false ? 'onboarding' : 'main');
}

/**
 * Runs the startup update check behind the blocking overlay. The main process
 * always answers with a status, and any surprise here is treated as "skipped":
 * the app must become usable either way.
 */
async function runStartupUpdateCheck() {
  let status = 'skipped';
  try {
    const result = await window.ytBridge.checkYtDlpUpdate();
    if (result && result.ok && UPDATE_MESSAGES[result.status]) {
      status = result.status;
    }
  } catch (error) {
    console.error('update check failed:', error);
  }

  updateSpinner.classList.add('done');
  updateText.textContent = UPDATE_MESSAGES[status];
  await delay(UPDATE_MESSAGE_HOLD_MS);
  updateOverlay.classList.add('hidden');
}

/**
 * Shared by the onboarding step 4 button and the "เปลี่ยนไฟล์คุกกี้" link.
 * A dismissed dialog leaves everything untouched.
 */
async function importCookies(button, reportStatus) {
  if (isImportingCookies) {
    return;
  }
  isImportingCookies = true;
  button.disabled = true;
  refreshButtons();

  let result;
  try {
    result = await window.ytBridge.importCookiesFile();
  } catch (error) {
    result = {
      ok: false,
      error: `เลือกไฟล์ไม่สำเร็จ: ${error && error.message ? error.message : String(error)}`
    };
  }

  isImportingCookies = false;
  button.disabled = false;
  refreshButtons();

  if (!result || !result.ok) {
    reportStatus((result && result.error) || 'เลือกไฟล์คุกกี้ไม่สำเร็จ', 'error');
    return;
  }
  if (!result.imported) {
    return;
  }

  showView('main');
  setStatus('บันทึกไฟล์คุกกี้แล้ว พร้อมใช้งาน', 'success');
}

async function openExtensionPage() {
  openExtensionButton.disabled = true;
  let result;
  try {
    result = await window.ytBridge.openCookieExtensionPage();
  } catch (error) {
    result = {
      ok: false,
      error: `เปิดหน้าเว็บไม่สำเร็จ: ${error && error.message ? error.message : String(error)}`
    };
  }
  openExtensionButton.disabled = false;

  if (!result || !result.ok) {
    setOnboardingStatus((result && result.error) || 'เปิดหน้าเว็บไม่สำเร็จ', 'error');
    return;
  }
  setOnboardingStatus('เปิดหน้าติดตั้งในเบราว์เซอร์แล้ว', 'busy');
}

async function fetchFormats() {
  if (isFetching || isDownloading) {
    return;
  }

  const url = urlInput.value.trim();
  if (url === '') {
    setStatus('กรุณาใส่ลิงก์วิดีโอก่อน', 'error');
    return;
  }

  isFetching = true;
  refreshButtons();
  videoTitle.textContent = '';
  resetFormats('กำลังดึงข้อมูล...');
  progressBox.classList.add('hidden');
  setStatus('กำลังดึงข้อมูลวิดีโอ...', 'busy');

  let result;
  try {
    result = await window.ytBridge.fetchFormats(url);
  } catch (error) {
    result = { ok: false, error: `ดึงข้อมูลไม่สำเร็จ: ${error && error.message ? error.message : String(error)}` };
  }

  isFetching = false;

  if (!result || !result.ok) {
    resetFormats('— ไม่มีข้อมูล —');
    setStatus((result && result.error) || 'ดึงข้อมูลไม่สำเร็จ', 'error');
    refreshButtons();
    return;
  }

  formatSelect.innerHTML = '';
  for (const format of result.formats) {
    const option = document.createElement('option');
    option.value = format.formatId;
    option.textContent = format.label;
    formatSelect.appendChild(option);
  }
  formatSelect.disabled = false;

  videoTitle.textContent = result.title ? `วิดีโอ: ${result.title}` : '';
  setStatus(`พบ ${result.formats.length} ตัวเลือก (วิดีโอ หรือ MP3 / WAV) เลือกแล้วกดดาวน์โหลดได้เลย`, 'success');
  refreshButtons();
}

async function startDownload() {
  if (isDownloading || isFetching) {
    return;
  }

  const url = urlInput.value.trim();
  const formatId = formatSelect.value;
  if (url === '' || formatId === '') {
    setStatus('กรุณาดึงข้อมูลและเลือกความละเอียดก่อน', 'error');
    return;
  }

  isDownloading = true;
  refreshButtons();
  setProgress(0, '');
  setStatus('กำลังเริ่มดาวน์โหลด...', 'busy');

  let result;
  try {
    result = await window.ytBridge.startDownload({ url, formatId });
  } catch (error) {
    result = {
      ok: false,
      error: `เริ่มดาวน์โหลดไม่สำเร็จ: ${error && error.message ? error.message : String(error)}`
    };
  }

  // Only the handshake is awaited here; the rest arrives as events.
  if (!result || !result.ok) {
    isDownloading = false;
    progressBox.classList.add('hidden');
    setStatus((result && result.error) || 'เริ่มดาวน์โหลดไม่สำเร็จ', 'error');
    refreshButtons();
    return;
  }

  setStatus(`กำลังดาวน์โหลดไปที่: ${result.outputDir}`, 'busy');
}

window.ytBridge.subscribeDownload({
  onProgress: (payload) => {
    if (!payload || typeof payload.percent !== 'number') {
      return;
    }
    setProgress(payload.percent, payload.detail || '');
  },
  onComplete: (payload) => {
    isDownloading = false;
    setProgress(100, '');
    const filePath = payload && payload.filePath ? payload.filePath : '';
    // `note` is only present when the file went through the compatibility pass.
    const note = payload && payload.note ? ` (${payload.note})` : '';
    setStatus(
      filePath ? `ดาวน์โหลดเสร็จแล้ว: ${filePath}${note}` : `ดาวน์โหลดเสร็จแล้ว${note}`,
      'success'
    );
    refreshButtons();
  },
  onError: (payload) => {
    isDownloading = false;
    setStatus((payload && payload.message) || 'ดาวน์โหลดไม่สำเร็จ', 'error');
    refreshButtons();
  }
});

fetchButton.addEventListener('click', () => {
  fetchFormats();
});

urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    fetchFormats();
  }
});

formatSelect.addEventListener('change', () => {
  refreshButtons();
});

downloadButton.addEventListener('click', () => {
  startDownload();
});

openExtensionButton.addEventListener('click', () => {
  openExtensionPage();
});

importCookiesButton.addEventListener('click', () => {
  importCookies(importCookiesButton, setOnboardingStatus);
});

changeCookiesButton.addEventListener('click', () => {
  importCookies(changeCookiesButton, setStatus);
});

refreshButtons();

// The overlay is already visible in the markup, so the app is never interactive
// before this finishes.
// Not awaited: a slow GitHub answer must never hold up the app.
window.ytBridge
  .checkAppUpdate()
  .then((result) => {
    if (result && result.newer) {
      document.getElementById('app-update-version').textContent = result.newer;
      document.getElementById('app-update').classList.remove('hidden');
    }
  })
  .catch((error) => console.error('app update check failed:', error));
document.getElementById('app-update-button').addEventListener('click', () => window.ytBridge.openReleasePage());

runStartupUpdateCheck()
  .then(() => showViewForCookieStatus())
  .catch((error) => {
    console.error('startup sequence failed:', error);
    // Last resort: never leave the user staring at the overlay.
    updateOverlay.classList.add('hidden');
    showView('main');
  });
