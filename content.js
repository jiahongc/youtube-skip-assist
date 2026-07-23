// YouTube Auto Skip — content script (ISOLATED world).
// Receives skip notifications from injected.js (MAIN world), shows toast,
// and forwards toggle settings from extension storage to injected.js.

const DEFAULT_SETTINGS = {
  skipJumpAhead: true,
  skipAdChapter: true,
};
const DEBUG_PREFIX = '[AutoSkip]';
// Match injected.js: never skip in the opening seconds of playback.
const SKIP_GRACE_MS = 5000;

function debugLog(...args) {
  console.debug(DEBUG_PREFIX, ...args);
}

let settings = { ...DEFAULT_SETTINGS };
let musicVideoBlocked = false;
let skipInProgress = false;
let skipInProgressTimer = null;
let doneZones = []; // [{from, to}] — time ranges (seconds) already skipped
let doneZonesVideoId = getCurrentVideoId();

function getCurrentVideoId() {
  try {
    return new URLSearchParams(window.location.search).get('v') || null;
  } catch (_) {
    return null;
  }
}

function syncDoneZonesToCurrentVideo() {
  const videoId = getCurrentVideoId();
  if (videoId === doneZonesVideoId) return;
  doneZonesVideoId = videoId;
  doneZones = [];
}

function rememberDoneZone(from, to) {
  syncDoneZonesToCurrentVideo();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return;
  const alreadyRemembered = doneZones.some(
    zone => Math.abs(zone.from - from) < 0.5 && Math.abs(zone.to - to) < 0.5
  );
  if (!alreadyRemembered) doneZones.push({ from, to });
}

function postSegmentControl(type, fromSec, toSec) {
  if (!Number.isFinite(fromSec) || !Number.isFinite(toSec)) return;
  rememberDoneZone(fromSec, toSec);
  window.postMessage({
    source: 'autoskip-control',
    type,
    fromSec,
    toSec,
  }, '*');
}

const SKIP_SELECTORS = [
  '.ytp-jump-ahead-button',
  '.ytp-ad-skip-button',
  '.ytp-skip-ad-button',
  'button.ytp-ad-skip-button-modern',
  'button[class*="ytp-skip"]',
];
const SKIP_LABEL_PATTERN = /\b(jump ahead|skip (ad|ads|sponsor|promotion))\b/i;

function hasSkipLikeClass(el) {
  const cls = (el.className || '').toString();
  return /ytp-(?:jump-ahead|ad-skip|skip-ad|skip)/i.test(cls) && !/skip-intro/i.test(cls);
}

function getControlText(el) {
  return [
    el.innerText || '',
    el.textContent || '',
    el.getAttribute('aria-label') || '',
    el.getAttribute('title') || '',
    el.getAttribute('data-title-no-tooltip') || '',
  ].join(' ').replace(/\s+/g, ' ').trim();
}

function hasSkipLikeLabel(el) {
  const text = getControlText(el);
  return SKIP_LABEL_PATTERN.test(text);
}

function hasLayout(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isLikelyMusicVideoByDom() {
  const genre = document.querySelector('meta[itemprop="genre"]')?.getAttribute('content') || '';
  return /\bmusic\b/i.test(genre);
}

function postSettingsToPage() {
  window.postMessage({
    source: 'autoskip-config',
    type: 'settings',
    settings,
  }, '*');
}

async function loadSettings() {
  try {
    const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    settings = {
      skipJumpAhead: stored.skipJumpAhead !== false,
      skipAdChapter: stored.skipAdChapter !== false,
    };
  } catch (_) {
    settings = { ...DEFAULT_SETTINGS };
  }
  postSettingsToPage();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  let changed = false;

  if (changes.skipJumpAhead) {
    settings.skipJumpAhead = changes.skipJumpAhead.newValue !== false;
    changed = true;
  }
  if (changes.skipAdChapter) {
    settings.skipAdChapter = changes.skipAdChapter.newValue !== false;
    changed = true;
  }

  if (changed) postSettingsToPage();
});

// ── Toast ─────────────────────────────────────────────────────────────────────

function showToast(arg) {
  const player = document.querySelector('#movie_player');
  if (!player) return;

  // Back-compat: allow showToast('message') and showToast({ message, fromSec, toSec })
  const opts = typeof arg === 'string' ? { message: arg } : (arg || {});
  const { message = '', fromSec, toSec, kind = 'skip', durationMs = 5000 } = opts;
  const canUndo = Number.isFinite(fromSec);

  let t = document.getElementById('autoskip-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'autoskip-toast';
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    Object.assign(t.style, {
      position: 'absolute', bottom: '64px', left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(0,0,0,0.78)', color: '#fff',
      padding: '7px 8px 7px 16px', borderRadius: '20px',
      fontSize: '16px', fontFamily: 'Roboto, sans-serif',
      fontWeight: '500', letterSpacing: '0.01em',
      zIndex: '9999', pointerEvents: 'none',
      opacity: '0', transition: 'opacity 0.15s ease', whiteSpace: 'nowrap',
      display: 'flex', alignItems: 'center', gap: '10px',
    });

    const textEl = document.createElement('span');
    textEl.id = 'autoskip-toast-text';
    t.appendChild(textEl);

    const undoBtn = document.createElement('button');
    undoBtn.id = 'autoskip-toast-undo';
    undoBtn.type = 'button';
    undoBtn.textContent = '↶ Undo';
    Object.assign(undoBtn.style, {
      background: 'rgba(255,255,255,0.14)', color: '#fff',
      border: '0', borderRadius: '14px',
      padding: '3px 10px', marginLeft: '2px',
      font: 'inherit', fontWeight: '600', fontSize: '13px',
      cursor: 'pointer', pointerEvents: 'auto',
      transition: 'background 0.15s ease',
    });
    undoBtn.addEventListener('mouseenter', () => {
      undoBtn.style.background = 'rgba(255,255,255,0.26)';
    });
    undoBtn.addEventListener('mouseleave', () => {
      undoBtn.style.background = 'rgba(255,255,255,0.14)';
    });
    undoBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const target = Number(undoBtn.dataset.fromSec);
      const prevTo = Number(undoBtn.dataset.toSec);
      if (!Number.isFinite(target) || !Number.isFinite(prevTo)) return;
      postSegmentControl('undo-segment', target, prevTo);
      t.style.opacity = '0';
      clearTimeout(t._t);
    });
    t.appendChild(undoBtn);

    player.appendChild(t);
  }

  t.dataset.kind = kind;

  // SECURITY: use textContent, never innerHTML — message contains untrusted chapter titles
  const textEl = t.querySelector('#autoskip-toast-text');
  if (textEl) textEl.textContent = `⏭  ${message}`;

  const undoBtn = t.querySelector('#autoskip-toast-undo');
  if (undoBtn) {
    undoBtn.style.display = canUndo ? '' : 'none';
    undoBtn.dataset.fromSec = canUndo ? String(fromSec) : '';
    undoBtn.dataset.toSec = Number.isFinite(toSec) ? String(toSec) : '';
  }

  t.style.opacity = '1';
  clearTimeout(t._t);
  t._t = setTimeout(() => (t.style.opacity = '0'), durationMs);
}

function hideToast(kind) {
  const toast = document.getElementById('autoskip-toast');
  if (!toast || (kind && toast.dataset.kind !== kind)) return;
  toast.style.opacity = '0';
  clearTimeout(toast._t);
}

function formatClock(totalSeconds) {
  const sec = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatSkipDuration(totalSeconds) {
  const sec = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || !parts.length) parts.push(`${seconds}s`);
  return parts.join(' ');
}

function formatToastMessage(label, seconds, fromSec, toSec) {
  const parts = [];
  if (label) parts.push(label);
  if (Number.isFinite(fromSec) && Number.isFinite(toSec)) {
    parts.push(`${formatClock(fromSec)} → ${formatClock(toSec)}`);
  } else if (Number.isFinite(toSec)) {
    parts.push(`to ${formatClock(toSec)}`);
  }
  if (Number.isFinite(seconds) && seconds > 0) {
    parts.push(`+${formatSkipDuration(seconds)}`);
  }
  return parts.join(' · ') || label || 'Skipped ahead';
}

function normalizeSkipLabel(rawLabel, fallback = 'YouTube Jump Ahead') {
  const label = (rawLabel || '').replace(/\s+/g, ' ').trim();
  if (!label) return fallback;
  if (/jump ahead/i.test(label)) return 'YouTube Jump Ahead';
  if (/skip\s+ad/i.test(label)) return 'Skipped YouTube ad';
  return label.replace(/^skip\b/i, 'Skipped');
}

function parseJumpAheadSeconds(text) {
  if (!text) return null;
  let totalSeconds = 0;
  const lower = text.toLowerCase();
  const matches = lower.matchAll(/(\d+)\s*(hours?|hrs?|hr|minutes?|mins?|min|seconds?|secs?|sec)\b/g);
  for (const match of matches) {
    const value = parseInt(match[1], 10);
    if (!Number.isFinite(value)) continue;
    const unit = match[2];
    if (unit.startsWith('hour') || unit.startsWith('hr')) {
      totalSeconds += value * 3600;
    } else if (unit.startsWith('min')) {
      totalSeconds += value * 60;
    } else {
      totalSeconds += value;
    }
  }
  return totalSeconds > 0 ? totalSeconds : null;
}

function directJumpAhead(video, btn) {
  if (!video || !btn) return false;
  const text = getControlText(btn);
  if (!/jump ahead/i.test(text)) return false;

  const deltaSeconds = parseJumpAheadSeconds(text);
  if (!Number.isFinite(deltaSeconds) || deltaSeconds < 2) return false;

  const nextTime = Math.min(
    Number.isFinite(video.duration) ? video.duration : video.currentTime + deltaSeconds,
    video.currentTime + deltaSeconds
  );
  if (!Number.isFinite(nextTime) || nextTime <= video.currentTime + 1) return false;

  video.currentTime = nextTime;
  return true;
}

function isFullscreenPlayer(player) {
  const fullscreenEl = document.fullscreenElement;
  if (!fullscreenEl || !player) return false;
  return fullscreenEl === player || fullscreenEl.contains(player) || player.contains(fullscreenEl);
}

// ── Listen for skip notifications from injected.js ───────────────────────

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  if (e.origin !== window.location.origin) return;
  if (e.data?.source !== 'autoskip') return;

  if (e.data.type === 'skip-in-progress') {
    hideToast('skip-notice');
    skipInProgress = true;
    clearTimeout(skipInProgressTimer);
    skipInProgressTimer = setTimeout(() => { skipInProgress = false; }, 2000);
    debugLog('content skip-in-progress', e.data);
    return;
  }

  if (e.data.type === 'skip-notice') {
    showToast({
      message: 'Jump Ahead detected, skipping soon.',
      kind: 'skip-notice',
      durationMs: 6000,
    });
    return;
  }

  if (e.data.type === 'skip-notice-hide') {
    hideToast('skip-notice');
    return;
  }

  if (e.data.type === 'skipped') {
    const { seconds: sec, label, fromSec, toSec } = e.data;
    rememberDoneZone(fromSec, toSec);
    debugLog('content skipped', e.data);
    showToast({
      message: formatToastMessage(label, sec, fromSec, toSec),
      fromSec,
      toSec,
    });
    return;
  }

  if (e.data.type === 'segment-undone') {
    hideToast();
    return;
  }

  if (e.data.type === 'music-video-state') {
    musicVideoBlocked = Boolean(e.data.isMusicVideo);
  }
});

// ── MutationObserver fallback — click skip/jump button ───────────────────

let lastClick = 0;

function isInDoneZone() {
  syncDoneZonesToCurrentVideo();
  const video = document.querySelector('video');
  if (!video) return false;
  const t = video.currentTime;
  return doneZones.some(z => t >= z.from && t < z.to);
}

function findSkipButton() {
  // Path 1: known selectors (no layout check needed)
  for (const sel of SKIP_SELECTORS) {
    const btn = document.querySelector(sel);
    if (btn) return btn;
  }

  // Path 2: scan all buttons in player — match even without layout since
  // YouTube hides the overlay (0x0) when controls are not shown.
  const player = document.querySelector('#movie_player, .html5-video-player');
  if (!player) return null;
  for (const el of player.querySelectorAll('button, [role="button"]')) {
    if (hasSkipLikeClass(el) || hasSkipLikeLabel(el)) return el;
  }
  return null;
}

// Report button sightings to injected.js. A sighting means YouTube has
// segment data client-side right now — injected.js uses it to reprocess
// its data sources when nothing is armed, covering the case where a DOM
// click would silently no-op against a hidden overlay.
let lastSightingKey = null;

function reportButtonEvent(btn, kind) {
  if (!btn) {
    lastSightingKey = null;
    return;
  }
  const label = getControlText(btn).slice(0, 80);
  const visible = hasLayout(btn);
  if (kind === 'sighting') {
    const key = `${label}|${visible}`;
    if (key === lastSightingKey) return;
    lastSightingKey = key;
  }
  window.postMessage({
    source: 'autoskip-dom',
    type: 'jump-button-event',
    kind,
    label,
    visible,
  }, '*');
}

function scanForSkipButton() {
  const btn = findSkipButton();
  reportButtonEvent(btn, 'sighting');
  if (btn) tryClick(btn);
}

function tryClick(btn) {
  if (!settings.skipJumpAhead) return;
  if (skipInProgress) return;
  if (musicVideoBlocked || isLikelyMusicVideoByDom()) return;
  if (Date.now() - lastClick < 800) return;
  if (isInDoneZone()) return;

  const graceVideo = document.querySelector('video');
  if (graceVideo && graceVideo.currentTime * 1000 < SKIP_GRACE_MS) return;

  clickBtn(btn);
}

function clickBtn(btn) {
  const video = document.querySelector('video');
  const player = btn.closest('#movie_player, .html5-video-player') || document.querySelector('#movie_player, .html5-video-player');
  const before = video ? video.currentTime : null;
  const label = normalizeSkipLabel(getControlText(btn));
  const jumpedDirectly = directJumpAhead(video, btn);
  debugLog('content clickBtn', {
    label,
    jumpedDirectly,
    fullscreen: isFullscreenPlayer(player),
    visible: hasLayout(btn),
  });

  // In fullscreen, never click a hidden DOM button. If YouTube already made
  // the control visible on its own, clicking it is acceptable.
  if (!jumpedDirectly) {
    if (isFullscreenPlayer(player) && !hasLayout(btn)) return;
    btn.click();
  }
  lastClick = Date.now();
  setTimeout(() => {
    // Verify the click (or directJumpAhead seek) actually advanced
    // playback. YouTube's overlay buttons silently no-op when controls
    // are autohidden, which would otherwise produce a misleading toast
    // even though nothing happened — and masks the fact that the
    // data-driven path in injected.js should handle it without a mouse
    // move on the next heartbeat tick.
    if (!video || before === null) {
      showToast(label);
      return;
    }
    const after = video.currentTime;
    const sec = Math.round(after - before);
    if (sec > 2) {
      rememberDoneZone(before, after);
      window.postMessage({
        source: 'autoskip-dom',
        type: 'segment-skipped',
        fromSec: before,
        toSec: after,
      }, '*');
      showToast({
        message: formatToastMessage(label, sec, before, after),
        fromSec: before,
        toSec: after,
      });
    } else {
      // Click was a no-op (hidden overlay, directJumpAhead rejected).
      // Stay silent, but tell injected.js so it can reprocess its data
      // sources — its heartbeat seek works even with controls hidden.
      reportButtonEvent(btn, 'click-noop');
    }
  }, 300);
}

let clickTimer = null;
const observer = new MutationObserver(() => {
  if (clickTimer) return;
  clickTimer = setTimeout(() => {
    clickTimer = null;
    scanForSkipButton();
  }, 150);
});

function startObserver() {
  const target = document.body;
  if (!target) return;
  observer.observe(target, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'aria-label'],
  });
}

if (document.body) {
  startObserver();
} else {
  window.addEventListener('DOMContentLoaded', startObserver, { once: true });
}

// Periodic poll — catches skip buttons that appear without triggering
// a tracked DOM mutation (e.g. CSS transitions, opacity animations).
setInterval(scanForSkipButton, 1000);

// Seeking back into a handled range is intentional. Keep that one range
// suppressed while allowing every other segment in the video to auto-skip.
document.addEventListener('seeking', (event) => {
  const video = event.target;
  if (!(video instanceof HTMLVideoElement)) return;
  const zone = doneZones.find(
    candidate => video.currentTime >= candidate.from && video.currentTime < candidate.to - 0.25
  );
  if (zone) postSegmentControl('suppress-segment', zone.from, zone.to);
}, true);

// Preserve handled ranges through same-video lifecycle events. YouTube can
// emit yt-navigate-finish without changing the video.
document.addEventListener('yt-navigate-finish', () => {
  syncDoneZonesToCurrentVideo();
  hideToast('skip-notice');
});

loadSettings();
