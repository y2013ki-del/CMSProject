var TARGET_URL = 'http://12.23.67.245:8080/client?launcher=custom-app';
var LOAD_TIMEOUT_MS = 8000;
var RETRY_INTERVAL_MS = 15000;

var loadTimer = null;
var retryTimer = null;

function byId(id) {
  return document.getElementById(id);
}

function setStatus(message) {
  var el = byId('statusText');
  if (el) {
    el.textContent = message;
  }
}

function addClass(el, className) {
  if (!el) {
    return;
  }
  if (el.classList) {
    el.classList.add(className);
    return;
  }
  if ((' ' + el.className + ' ').indexOf(' ' + className + ' ') === -1) {
    el.className = (el.className ? el.className + ' ' : '') + className;
  }
}

function removeClass(el, className) {
  var re;
  if (!el) {
    return;
  }
  if (el.classList) {
    el.classList.remove(className);
    return;
  }
  re = new RegExp('(^|\\\\s)' + className + '(?=\\\\s|$)', 'g');
  el.className = el.className.replace(re, ' ').replace(/\\s+/g, ' ').replace(/^\\s|\\s$/g, '');
}

function showOverlay() {
  removeClass(byId('overlay'), 'is-hidden');
}

function hideOverlay() {
  addClass(byId('overlay'), 'is-hidden');
}

function clearTimers() {
  if (loadTimer) {
    window.clearTimeout(loadTimer);
  }
  if (retryTimer) {
    window.clearTimeout(retryTimer);
  }
  loadTimer = null;
  retryTimer = null;
}

function buildTargetUrl(forceReload) {
  if (forceReload) {
    return TARGET_URL + '&t=' + new Date().getTime();
  }
  return TARGET_URL;
}

function loadPlayer(forceReload) {
  var frame;
  clearTimers();
  showOverlay();
  setStatus('CMS 서버에 연결을 시도하고 있습니다.');

  frame = byId('playerFrame');
  if (!frame) {
    return;
  }
  frame.src = buildTargetUrl(!!forceReload);

  loadTimer = window.setTimeout(function () {
    showOverlay();
    setStatus('연결이 지연되고 있습니다. 네트워크와 CMS 서버 상태를 확인하세요.');
    retryTimer = window.setTimeout(function () {
      loadPlayer(true);
    }, RETRY_INTERVAL_MS);
  }, LOAD_TIMEOUT_MS);
}

function onFrameLoaded() {
  clearTimers();
  hideOverlay();
}

function onRetryClick() {
  loadPlayer(true);
}

function onVisibilityChange() {
  if (!document.hidden) {
    loadPlayer(true);
  }
}

function onTizenHwKey(event) {
  if (event && event.keyName === 'back') {
    event.preventDefault();
    loadPlayer(true);
  }
}

function init() {
  var targetEl = byId('targetUrl');
  var retryButton = byId('retryButton');
  var playerFrame = byId('playerFrame');

  if (targetEl) {
    targetEl.textContent = TARGET_URL;
  }
  if (retryButton) {
    retryButton.addEventListener('click', onRetryClick);
  }
  if (playerFrame) {
    playerFrame.addEventListener('load', onFrameLoaded);
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('tizenhwkey', onTizenHwKey);

  loadPlayer(false);
}

document.addEventListener('DOMContentLoaded', init);
