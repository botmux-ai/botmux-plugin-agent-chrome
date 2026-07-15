import RFB from '@novnc/novnc';
import Cursor from '@botmux/novnc-cursor';
import { cursorDisplayScale, scaledCursorGeometry } from './cursor-scale.mjs';

const cursorState = new WeakMap();
const originalCursor = {
  attach: Cursor.prototype.attach,
  change: Cursor.prototype.change,
  detach: Cursor.prototype.detach,
};

function resizeCursorPixels(rgba, width, height, scaledWidth, scaledHeight) {
  if (width === scaledWidth && height === scaledHeight) return rgba;

  const source = document.createElement('canvas');
  source.width = width;
  source.height = height;
  const sourceContext = source.getContext('2d');
  sourceContext.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);

  const target = document.createElement('canvas');
  target.width = scaledWidth;
  target.height = scaledHeight;
  const targetContext = target.getContext('2d');
  targetContext.imageSmoothingEnabled = true;
  targetContext.imageSmoothingQuality = 'high';
  targetContext.drawImage(source, 0, 0, scaledWidth, scaledHeight);
  return targetContext.getImageData(0, 0, scaledWidth, scaledHeight).data;
}

function renderCursor(cursor) {
  const state = cursorState.get(cursor);
  if (!state?.image || !cursor._target) return;

  const { rgba, hotX, hotY, width, height } = state.image;
  const rect = cursor._target.getBoundingClientRect();
  const scale = cursorDisplayScale(cursor._target.width, cursor._target.height, rect.width, rect.height);
  const geometry = scaledCursorGeometry(width, height, hotX, hotY, scale);
  const pixels = resizeCursorPixels(rgba, width, height, geometry.width, geometry.height);
  originalCursor.change.call(cursor, pixels, geometry.hotX, geometry.hotY, geometry.width, geometry.height);
}

function scheduleCursorRender(cursor) {
  const state = cursorState.get(cursor);
  if (!state || state.frame) return;
  state.frame = requestAnimationFrame(() => {
    state.frame = null;
    renderCursor(cursor);
  });
}

Cursor.prototype.attach = function attachScaledCursor(target) {
  originalCursor.attach.call(this, target);
  const state = cursorState.get(this) || {};
  state.observer?.disconnect();
  state.observer = new ResizeObserver(() => scheduleCursorRender(this));
  state.observer.observe(target);
  cursorState.set(this, state);
};

Cursor.prototype.change = function changeScaledCursor(rgba, hotX, hotY, width, height) {
  const state = cursorState.get(this) || {};
  if (width === 0 || height === 0) {
    state.image = null;
    cursorState.set(this, state);
    originalCursor.change.call(this, rgba, hotX, hotY, width, height);
    return;
  }
  state.image = {
    rgba: new Uint8ClampedArray(rgba),
    hotX,
    hotY,
    width,
    height,
  };
  cursorState.set(this, state);
  renderCursor(this);
};

Cursor.prototype.detach = function detachScaledCursor() {
  const state = cursorState.get(this);
  state?.observer?.disconnect();
  if (state?.frame) cancelAnimationFrame(state.frame);
  cursorState.delete(this);
  originalCursor.detach.call(this);
};

const screen = document.querySelector('#screen');
const status = document.querySelector('#status');
const params = new URLSearchParams(window.location.search);
const reconnect = params.get('reconnect') !== 'false';
const reconnectDelay = Math.max(250, Number(params.get('reconnect_delay')) || 1000);
let client = null;
let retryTimer = null;
let stopped = false;

function socketUrl() {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const path = (params.get('path') || 'websockify').replace(/^\/+/, '');
  return `${scheme}://${window.location.host}/${path}`;
}

function showStatus(message, error = false) {
  status.textContent = message;
  status.dataset.error = error ? 'true' : 'false';
  status.hidden = false;
}

function connect() {
  clearTimeout(retryTimer);
  retryTimer = null;
  showStatus('正在连接浏览器画面...');
  try {
    client = new RFB(screen, socketUrl(), { shared: true });
    client.scaleViewport = true;
    client.resizeSession = false;
    client.background = '#11151b';
    client.addEventListener('connect', () => {
      status.hidden = true;
    });
    client.addEventListener('disconnect', event => {
      client = null;
      if (stopped || !reconnect) {
        showStatus(event.detail?.clean ? '连接已关闭' : '浏览器画面连接中断', !event.detail?.clean);
        return;
      }
      showStatus('连接中断，正在重连...');
      retryTimer = setTimeout(connect, reconnectDelay);
    });
    client.addEventListener('securityfailure', event => {
      showStatus(event.detail?.reason || 'VNC 安全协商失败', true);
    });
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
    if (reconnect && !stopped) retryTimer = setTimeout(connect, reconnectDelay);
  }
}

window.addEventListener('pagehide', () => {
  stopped = true;
  clearTimeout(retryTimer);
  client?.disconnect();
});

connect();
