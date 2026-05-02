const TARGET_URL = 'http://12.23.67.245:8080/client?launcher=custom-app';
const LOAD_TIMEOUT_MS = 8000;
const RETRY_INTERVAL_MS = 15000;

let loadTimer = null;
let retryTimer = null;

function byId(id) {
  return document.getElementById(id);
}

function setStatus(message) {
  byId('statusText').textContent = message;
}

function showOverlay() {
  byId('overlay').classList.remove('is-hidden');
}

function hideOverlay() {
  byId('overlay').classList.add('is-hidden');
}

function clearTimers() {
  if (loadTimer) clearTimeout(loadTimer);
  if (retryTimer) clearTimeout(retryTimer);
  loadTimer = null;
  retryTimer = null;
}

function loadPlayer(forceReload = false) {
  clearTimers();
  showOverlay();
  setStatus('CMS 서버에 연결을 시도하고 있습니다.');

  const frame = byId('playerFrame');
  const target = forceReload ? `${TARGET_URL}&t=${Date.now()}` : TARGET_URL;
  frame.src = target;

  loadTimer = setTimeout(() => {
    showOverlay();
    setStatus('연결이 지연되고 있습니다. 네트워크와 CMS 서버 상태를 확인하세요.');
    retryTimer = setTimeout(() => loadPlayer(true), RETRY_INTERVAL_MS);
  }, LOAD_TIMEOUT_MS);
}

function init() {
  byId('targetUrl').textContent = TARGET_URL;
  byId('retryButton').addEventListener('click', () => loadPlayer(true));

  byId('playerFrame').addEventListener('load', () => {
    clearTimers();
    hideOverlay();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadPlayer(true);
  });

  window.addEventListener('tizenhwkey', event => {
    if (event.keyName === 'back') {
      event.preventDefault();
      loadPlayer(true);
    }
  });

  loadPlayer();
}

document.addEventListener('DOMContentLoaded', init);
