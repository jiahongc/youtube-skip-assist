// Runs in YouTube's page context (world: "MAIN", document_start).
// 1. Skips Jump ahead segments from timelyActionsOverlayViewModel
// 2. Skips chapters whose titles match ad/break/sponsor patterns

(function () {
  'use strict';

  const settings = {
    skipJumpAhead: true,
    skipAdChapter: true,
  };

  const DEBUG_PREFIX = '[AutoSkip]';
  const jumpAheadDebug = {
    currentVideoId: null,
    sources: {},
    blockers: {},
    extractedBeforeFilter: [],
    filteredOut: [],
    activeSegments: [],
    domButtonSightings: [],
    armEvents: [],
    lastSkip: null,
    lastProcess: null,
  };

  function cloneForDebug(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  }

  function getDebugSnapshot() {
    const video = document.querySelector('video');
    return {
      pageUrl: window.location.href,
      urlVideoId: getCurrentVideoId(),
      trackedVideoId: currentVideoId,
      pageDataVideoId: getDataVideoId(getPageData()),
      playerResponseVideoId: getDataVideoId(getPlayerResponse()),
      currentTimeMs: video ? Math.round(video.currentTime * 1000) : null,
      durationMs: video && Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null,
      paused: video ? video.paused : null,
      readyState: video ? video.readyState : null,
      musicVideo: isMusicVideo,
      settings: { ...settings },
      activeSegments: activeSegments.map(serializeSegment),
      jumpAhead: cloneForDebug(jumpAheadDebug),
    };
  }

  function printJumpAheadDebug() {
    const snapshot = cloneForDebug(jumpAheadDebug);
    console.log(DEBUG_PREFIX, 'jumpAhead snapshot', snapshot);
    return snapshot;
  }

  function printDebugSnapshot() {
    const snapshot = getDebugSnapshot();
    console.log(DEBUG_PREFIX, 'snapshot', snapshot);
    return snapshot;
  }

  function reprocessForDebug() {
    processAllSources();
    attachHandlerIfReady();
    return printDebugSnapshot();
  }

  // One-shot diagnosis. Re-scans all sources, then prints a plain-English
  // verdict for why nothing skipped (or that it should have) plus a compact
  // object with only the fields that matter. Returns the object so it can be
  // copied to the clipboard with copy(__autoskipDebug.diagnose()).
  function diagnoseForDebug() {
    processAllSources();
    attachHandlerIfReady();
    const snap = getDebugSnapshot();
    const j = snap.jumpAhead;
    const ms = snap.currentTimeMs;
    const armed = snap.activeSegments || [];
    const coveringNow = armed.filter(
      s => !s.done && ms != null && ms >= s.triggerMs && ms < s.seekTargetMs
    );

    let verdict;
    if (!snap.settings.skipJumpAhead) {
      verdict = 'DISABLED: Jump Ahead toggle is off in the popup.';
    } else if (snap.musicVideo) {
      verdict = 'BLOCKED: detected as a music video (music guard).';
    } else if (snap.paused) {
      verdict = 'PAUSED: skips only fire during playback. Press play.';
    } else if (ms != null && ms < SKIP_GRACE_MS) {
      verdict = `GRACE: still in the opening ${SKIP_GRACE_MS / 1000}s; skips suppressed.`;
    } else if (coveringNow.length) {
      verdict = 'ARMED & COVERING NOW: a segment covers the current time but ' +
        'has not fired — check lastSkip (verify-failed?) or whether you seeked back ' +
        'into a done segment.';
    } else if (armed.length) {
      verdict = 'ARMED ELSEWHERE: segments exist but none covers the current ' +
        'time. Either you are not inside a skip zone, or the trigger/target ' +
        'window is wrong (compare armed[].triggerMs/seekTargetMs to currentTimeMs).';
    } else if (j.filteredOut && j.filteredOut.length) {
      verdict = 'EXTRACTED BUT FILTERED: data was found but dropped. See ' +
        'filteredOut[].reason (no-seek-target => YouTube changed the onTap ' +
        'shape; inspect filteredOut[].onTap).';
    } else if (j.domButtonSightings && j.domButtonSightings.length) {
      verdict = 'DOM-ONLY: YouTube rendered its own button but no data source ' +
        'yielded a segment. Likely an unrecognized payload shape; capture this object.';
    } else {
      verdict = 'NO DATA: no source produced jump-ahead data and YouTube never ' +
        'rendered its own button. Most likely this video has no Jump Ahead to skip. ' +
        'Confirm by moving the mouse — if no native "Jump ahead" button appears, ' +
        'there is nothing to skip and this is expected.';
    }

    const out = {
      verdict,
      url: snap.pageUrl,
      currentTimeMs: ms,
      durationMs: snap.durationMs,
      paused: snap.paused,
      musicVideo: snap.musicVideo,
      settings: snap.settings,
      videoIds: {
        url: snap.urlVideoId,
        tracked: snap.trackedVideoId,
        pageData: snap.pageDataVideoId,
        playerResponse: snap.playerResponseVideoId,
      },
      armed,
      coveringNow,
      sources: j.sources,
      blockers: j.blockers,
      extractedBeforeFilter: j.extractedBeforeFilter,
      filteredOut: j.filteredOut,
      domButtonSightings: j.domButtonSightings,
      armEvents: j.armEvents,
      lastProcess: j.lastProcess,
      lastSkip: j.lastSkip,
    };

    // Race evidence is historical — surface it regardless of the current
    // moment's verdict so an intermittent miss explains itself.
    const lateArms = (j.armEvents || []).filter(e => e.timing === 'armed-after-window');
    if (lateArms.length) {
      console.log(DEBUG_PREFIX,
        `RACE LOST x${lateArms.length}: a segment armed AFTER playback passed it ` +
        `(data arrived too late to auto-skip). See armEvents[].`, lateArms);
    }

    console.log(DEBUG_PREFIX, 'diagnose:', verdict);
    console.log(DEBUG_PREFIX, 'diagnose detail', out);
    return out;
  }

  window.__autoskipDebug = window.__autoskipDebug || {};
  window.__autoskipDebug.jumpAhead = jumpAheadDebug;
  window.__autoskipDebug.printJumpAhead = printJumpAheadDebug;
  window.__autoskipDebug.snapshot = getDebugSnapshot;
  window.__autoskipDebug.printSnapshot = printDebugSnapshot;
  window.__autoskipDebug.reprocess = reprocessForDebug;
  window.__autoskipDebug.diagnose = diagnoseForDebug;
  window.__autoskipDebug.help = [
    '__autoskipDebug.diagnose()  // start here — prints a verdict',
    'copy(__autoskipDebug.diagnose())  // copy detail to clipboard',
    '__autoskipDebug.printSnapshot()',
    '__autoskipDebug.reprocess()',
  ];

  function debugLog(...args) {
    console.debug(DEBUG_PREFIX, ...args);
  }

  // ── Watch YouTube globals ─────────────────────────────────────────────
  // YouTube assigns ytInitialPlayerResponse / ytInitialData on page load
  // but may NOT update them during SPA navigation.  By installing property
  // setters BEFORE YouTube's code runs (we execute at document_start), we
  // can detect the exact moment a fresh value is assigned and immediately
  // trigger processing — no polling delay, no stale-data race.

  let _globalUpdateTimer = null;

  function onGlobalDataUpdated() {
    clearTimeout(_globalUpdateTimer);
    _globalUpdateTimer = setTimeout(() => {
      processAllSources();
      attachHandlerIfReady();
    }, 50);
  }

  // Sentinel used to verify our setter is still active.
  const WATCH_SENTINEL = Symbol('autoskip');

  function watchGlobal(prop) {
    let value = window[prop];
    try {
      Object.defineProperty(window, prop, {
        get() { return value; },
        set(newValue) {
          value = newValue;
          if (newValue && typeof newValue === 'object') onGlobalDataUpdated();
        },
        configurable: true,
        enumerable: true,
      });
      // Tag the descriptor so we can detect if it's been overwritten.
      window[prop + '__autoskip'] = WATCH_SENTINEL;
    } catch (_) {}
  }

  function ensureWatchers() {
    for (const prop of ['ytInitialData', 'ytInitialPlayerResponse']) {
      if (window[prop + '__autoskip'] !== WATCH_SENTINEL) {
        watchGlobal(prop);
      }
    }
  }

  watchGlobal('ytInitialData');
  watchGlobal('ytInitialPlayerResponse');

  // YouTube's code may overwrite our property descriptors.
  // Periodically re-install them if that happens.
  setInterval(ensureWatchers, 10000);

  // ── Helpers ──────────────────────────────────────────────────────────────

  function findDeep(obj, key, depth) {
    if (!obj || typeof obj !== 'object' || (depth || 0) > 20) return null;
    if (obj[key] !== undefined) return obj[key];
    for (const v of Object.values(obj)) {
      const r = findDeep(v, key, (depth || 0) + 1);
      if (r !== null) return r;
    }
    return null;
  }

  // Collect EVERY occurrence of a key, not just the first. Payloads can
  // contain multiple timelyActions lists (e.g. overlay + preloaded data).
  function findDeepAll(obj, key, out, depth, seen) {
    if (!obj || typeof obj !== 'object' || (depth || 0) > 20) return;
    if (!seen) seen = new WeakSet();
    if (seen.has(obj)) return;
    seen.add(obj);
    if (obj[key] !== undefined) out.push(obj[key]);
    for (const v of Object.values(obj)) {
      findDeepAll(v, key, out, (depth || 0) + 1, seen);
    }
  }

  function getPageData() {
    if (window.ytInitialData) return window.ytInitialData;
    try { return window.ytcfg?.get?.('INITIAL_DATA'); } catch (_) {}
    return null;
  }

  function getPlayerResponse() {
    if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;
    try { return window.ytcfg?.get?.('PLAYER_RESPONSE'); } catch (_) {}
    return null;
  }

  // Live player API — always reflects the CURRENT video, immune to the
  // stale-globals problem on SPA navigation and cache-hit navigation where
  // ytInitialData/ytInitialPlayerResponse keep the previous video's data.
  function getLivePlayerResponse() {
    try {
      const player = document.getElementById('movie_player');
      if (player && typeof player.getPlayerResponse === 'function') {
        return player.getPlayerResponse();
      }
    } catch (_) {}
    return null;
  }

  function getDataVideoId(data) {
    const candidates = [
      data?.videoDetails?.videoId,
      data?.playerResponse?.videoDetails?.videoId,
      data?.currentVideoEndpoint?.watchEndpoint?.videoId,
      data?.endpoint?.watchEndpoint?.videoId,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate) return candidate;
    }
    return null;
  }

  function resetJumpAheadDebug(videoId) {
    jumpAheadDebug.currentVideoId = videoId || null;
    jumpAheadDebug.sources = {};
    jumpAheadDebug.blockers = {};
    jumpAheadDebug.extractedBeforeFilter = [];
    jumpAheadDebug.filteredOut = [];
    jumpAheadDebug.activeSegments = [];
    jumpAheadDebug.domButtonSightings = [];
    jumpAheadDebug.armEvents = [];
    jumpAheadDebug.lastSkip = null;
    jumpAheadDebug.lastProcess = null;
  }

  function serializeSegment(seg) {
    return {
      label: seg.label,
      triggerMs: seg.triggerMs,
      seekTargetMs: seg.seekTargetMs,
      source: seg.source || null,
      done: Boolean(seg.done),
      pending: Boolean(seg.pending),
    };
  }

  function recordJumpAheadSource(name, details) {
    jumpAheadDebug.sources[name] = {
      ...(jumpAheadDebug.sources[name] || {}),
      ...details,
      updatedAt: Date.now(),
    };
  }

  // Debug arrays survive the whole video (reset only on navigation), so
  // entries are deduped and capped to stay bounded across repeated polls.
  const DEBUG_LIST_CAP = 50;

  function pushDebugEntry(list, key, entry) {
    if (list.some(e => e.key === key)) return;
    list.push({ key, at: Date.now(), ...entry });
    if (list.length > DEBUG_LIST_CAP) list.shift();
  }

  function recordJumpAheadExtraction(sourceName, segments) {
    for (const seg of segments) {
      pushDebugEntry(
        jumpAheadDebug.extractedBeforeFilter,
        `${sourceName}|${seg.triggerMs}|${seg.seekTargetMs}|${seg.label}`,
        { sourceName, ...serializeSegment(seg) }
      );
    }
  }

  function recordJumpAheadFiltered(sourceName, details) {
    pushDebugEntry(
      jumpAheadDebug.filteredOut,
      `${sourceName}|${details.triggerMs ?? ''}|${details.reason}`,
      { sourceName, ...details }
    );
  }

  function collectChapterLists(node, out, depth, seen) {
    if (!node || typeof node !== 'object' || (depth || 0) > 20) return;
    if (!seen) seen = new WeakSet();
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node) && node.length) {
      const chapterItems = node
        .map(item => item?.chapterRenderer || item?.macroMarkersListItemRenderer?.chapterRenderer)
        .filter(Boolean);
      if (chapterItems.length === node.length) {
        out.push(chapterItems);
        return;
      }
    }

    if (node.chapterRenderer && typeof node.chapterRenderer === 'object') {
      out.push([node.chapterRenderer]);
      return;
    }

    for (const v of Object.values(node)) collectChapterLists(v, out, (depth || 0) + 1, seen);
  }

  function chapterPointFromRenderer(c) {
    if (!c || typeof c !== 'object') return null;
    const title = c.title?.simpleText || c.title?.runs?.[0]?.text || '';
    const startMs = parseInt(c.timeRangeStartMillis, 10);
    if (!Number.isFinite(startMs)) return null;
    return { title, startMs };
  }

  function parseTimestampToMs(value) {
    if (!value || typeof value !== 'string') return null;
    const parts = value.trim().split(':').map(part => parseInt(part, 10));
    if (!parts.length || parts.some(n => !Number.isFinite(n))) return null;
    let seconds = 0;
    for (const part of parts) seconds = seconds * 60 + part;
    return seconds * 1000;
  }

  function collectDomChapterPoints() {
    const selectors = [
      '.ytp-chapter-title-content',
      '.ytp-chapter-hover-container',
      'ytd-macro-markers-list-item-renderer',
      '[class*="chapter"]',
    ];

    const candidates = [];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;

        const timeMatch = text.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/);
        const titleMatch = text.match(/[\p{L}][\p{L}\p{N}\s'&/\-]{1,}/u);
        if (!timeMatch || !titleMatch) continue;

        const startMs = parseTimestampToMs(timeMatch[0]);
        const title = titleMatch[0].trim();
        if (!Number.isFinite(startMs) || !title) continue;
        candidates.push({ title, startMs });
      }
    }

    return Array.from(new Map(
      candidates.map(ch => [`${ch.startMs}|${ch.title.toLowerCase()}`, ch])
    ).values()).sort((a, b) => a.startMs - b.startMs);
  }

  function collectChapterFallbackPoints(node, out, depth, seen) {
    if (!node || typeof node !== 'object' || (depth || 0) > 20) return;
    if (!seen) seen = new WeakSet();
    if (seen.has(node)) return;
    seen.add(node);

    const direct = chapterPointFromRenderer(node.chapterRenderer) ||
      chapterPointFromRenderer(node.macroMarkersListItemRenderer?.chapterRenderer);
    if (direct) out.push(direct);

    for (const v of Object.values(node)) collectChapterFallbackPoints(v, out, (depth || 0) + 1, seen);
  }

  const MUSIC_TITLE_PATTERN = /\b(official music video|music video|lyric video|official audio|visualizer)\b/i;
  const MUSIC_CHANNEL_PATTERN = /\bofficial artist channel\b/i;
  let isMusicVideo = false;
  let hasSentMusicState = false;

  function isLikelyMusicVideoByMetadata() {
    const player = getPlayerResponse();
    if (!player || typeof player !== 'object') return false;

    const category = player?.microformat?.playerMicroformatRenderer?.category || '';
    if (typeof category === 'string' && category.toLowerCase() === 'music') return true;

    const title = player?.videoDetails?.title || '';
    const owner = player?.videoDetails?.author || '';
    const keywords = Array.isArray(player?.videoDetails?.keywords) ? player.videoDetails.keywords.join(' ') : '';

    let weakSignals = 0;
    if (MUSIC_TITLE_PATTERN.test(title)) weakSignals++;
    if (MUSIC_CHANNEL_PATTERN.test(owner)) weakSignals++;
    if (/\b(lyrics?|official audio|visualizer)\b/i.test(keywords)) weakSignals++;
    return weakSignals >= 2;
  }

  function isLikelyMusicVideoByDom() {
    const genre = document.querySelector('meta[itemprop="genre"]')?.getAttribute('content') || '';
    return /\bmusic\b/i.test(genre);
  }

  function refreshMusicGuard() {
    const nextIsMusic = isLikelyMusicVideoByMetadata() || isLikelyMusicVideoByDom();
    const changed = nextIsMusic !== isMusicVideo;
    isMusicVideo = nextIsMusic;

    if (changed || !hasSentMusicState) {
      hasSentMusicState = true;
      window.postMessage({ source: 'autoskip', type: 'music-video-state', isMusicVideo }, '*');
    }

    if (changed && isMusicVideo) reset();
  }

  // ── Language & Pattern Detection ────────────────────────────────────────

  const INTRO_CHAPTER_PATTERN = /\b(intro|introduction|opening|cold open|welcome)\b/i;
  const INTRO_AD_ALLOW_PATTERN = /\b(ad|sponsor|sponsored|promo|promotion|paid|commercial|partner(?:ship)?|brought to you by)\b/i;

  const LANG_PATTERNS = Object.freeze({
    en: {
      strong:  /\b(ad(?:vert(?:isement)?)?\s*break|commercial(?:\s*break)?|sponsor(?:ed|ship)?(?:\s*(?:segment|section|message))?|paid\s*(?:promotion|partnership)|brought to you by|in partnership with|brand deal|promo(?:tion)?|ad read|product placement)\b/i,
      weak:    /\b(partner(?:ship)?|message from|word from|thanks to)\b/i,
      context: /\b(sponsor|promo|paid|commercial|advert(?:isement)?)\b/i,
      exclude: /\b(spring break|coffee break|breakdown|adventure)\b/i,
    },
    es: {
      strong:  /\b(pausa\s*publicitaria|patrocinado|patrocinio|publicidad|segmento\s*patrocinado|promoci[oó]n\s*pagada|cortes[ií]a\s*de)\b/i,
      weak:    /\b(colaboraci[oó]n|anuncio|mensaje\s*de|gracias\s*a)\b/i,
      context: /\b(patrocin|promoci[oó]n|pagad[oa]|publicidad)\b/i,
      exclude: /\b(descanso|aventura|an[aá]lisis)\b/i,
    },
    pt: {
      strong:  /\b(intervalo\s*comercial|patrocinado|patroc[ií]nio|publicidade|publi|promo[cç][aã]o\s*paga|oferecimento)\b/i,
      weak:    /\b(parceria|an[uú]ncio|mensagem\s*de|apoio\s*de)\b/i,
      context: /\b(patroc[ií]n|promo[cç]|pag[oa]|comercial|publicidade)\b/i,
      exclude: /\b(descanso|aventura|an[aá]lise)\b/i,
    },
    de: {
      strong:  /\b(werbepause|werbung|gesponsert|bezahlte\s*werbung|anzeige|pr[aä]sentiert\s*von|in\s*zusammenarbeit\s*mit|dauerwerbesendung)\b/i,
      weak:    /\b(partnerschaft|nachricht\s*von|dank\s*an)\b/i,
      context: /\b(sponsor|werbung|bezahlt|anzeige)\b/i,
      exclude: /\b(abenteuer|zusammenbruch)\b/i,
    },
    fr: {
      strong:  /\b(coupure\s*pub|publicit[eé]|sponsoris[eé]|partenariat\s*pay[eé]|pr[eé]sent[eé]\s*par|placement\s*de\s*produit)\b/i,
      weak:    /\b(partenariat|message\s*de|merci\s*[aà])\b/i,
      context: /\b(sponsor|promo|pay[eé]|pub(?:licit[eé])?)\b/i,
      exclude: /\b(aventure|panne)\b/i,
    },
    ja: {
      strong:  /(広告|スポンサー|(?:^|[\s【「])CM(?:$|[\s】」])|プロモーション|タイアップ|案件)/,
      weak:    /(提供|協賛|提供元|協力|(?:^|[\s【「])PR(?:$|[\s】」]))/,
      context: /(広告|宣伝|プロモ|スポンサー)/,
      exclude: /(休憩|冒険)/,
    },
    ko: {
      strong:  /(광고|스폰서|협찬|유료\s*광고|프로모션|PPL|브랜드\s*콘텐츠)/,
      weak:    /(협력|제공)/,
      context: /(광고|홍보|프로모|스폰서|PPL)/,
      exclude: /(휴식|모험)/,
    },
  });

  let cachedLang = null;

  function detectVideoLanguage(playerResponse) {
    if (cachedLang) return cachedLang;

    const audioLang = playerResponse?.microformat?.playerMicroformatRenderer?.defaultAudioLanguage;
    if (audioLang) {
      const code = audioLang.substring(0, 2);
      if (LANG_PATTERNS[code]) { cachedLang = code; return code; }
    }

    const defaultLang = playerResponse?.microformat?.playerMicroformatRenderer?.defaultLanguage;
    if (defaultLang) {
      const code = defaultLang.substring(0, 2);
      if (LANG_PATTERNS[code]) { cachedLang = code; return code; }
    }

    cachedLang = 'en';
    return 'en';
  }

  // Exclude blocks weak matches only, not strong
  function matchesAdPatterns(t, p) {
    if (p.exclude.test(t)) return p.strong.test(t);
    return p.strong.test(t) || (p.weak.test(t) && p.context.test(t));
  }

  function isAdChapterTitle(title, lang) {
    if (!title || title.length > 200) return false;
    const t = title.trim();
    if (INTRO_CHAPTER_PATTERN.test(t) && !INTRO_AD_ALLOW_PATTERN.test(t)) return false;
    const patterns = LANG_PATTERNS[lang] || LANG_PATTERNS['en'];
    if (matchesAdPatterns(t, patterns)) return true;
    return lang !== 'en' && matchesAdPatterns(t, LANG_PATTERNS['en']);
  }

  function isIntroChapterTitle(title) {
    if (!title) return false;
    return INTRO_CHAPTER_PATTERN.test(title) && !INTRO_AD_ALLOW_PATTERN.test(title);
  }

  function applySettings(next) {
    const normalized = {
      skipJumpAhead: next?.skipJumpAhead !== false,
      skipAdChapter: next?.skipAdChapter !== false,
    };
    const changed = normalized.skipJumpAhead !== settings.skipJumpAhead ||
      normalized.skipAdChapter !== settings.skipAdChapter;

    settings.skipJumpAhead = normalized.skipJumpAhead;
    settings.skipAdChapter = normalized.skipAdChapter;
    if (!changed) return;

    reset();
    processAllSources();
    attachHandlerIfReady();
  }

  // ── Extract Jump ahead segments ──────────────────────────────────────────

  // Cache chapter extraction only. Jump Ahead extraction is intentionally
  // re-evaluated because YouTube can populate skip metadata later.
  let chapterCache = new WeakMap();

  // IMPORTANT: seek-target extraction must stay an explicit ordered path.
  // onTap contains MULTIPLE seekToVideoTimestampCommands; a blind deep
  // search returns the wrong one (caused a regression — see git history).
  // We only broaden across known command-wrapper shapes, first-match within
  // each list, in priority order.
  function extractSeekTargetFromOnTap(onTap) {
    if (!onTap || typeof onTap !== 'object') return null;

    const commandLists = [
      onTap.serialCommand?.commands,
      onTap.commandExecutorCommand?.commands,
    ];
    for (const commands of commandLists) {
      if (!Array.isArray(commands)) continue;
      for (const cmd of commands) {
        const seek = cmd?.innertubeCommand?.seekToVideoTimestampCommand ||
          cmd?.seekToVideoTimestampCommand;
        const target = parseInt(seek?.offsetFromVideoStartMilliseconds, 10);
        if (Number.isFinite(target) && target > 0) return target;
      }
    }

    const direct = onTap.innertubeCommand?.seekToVideoTimestampCommand ||
      onTap.seekToVideoTimestampCommand;
    const target = parseInt(direct?.offsetFromVideoStartMilliseconds, 10);
    if (Number.isFinite(target) && target > 0) return target;

    return null;
  }

  // Shape summary for debugging payload drift: which keys exist on onTap
  // and inside each command, without dumping the whole payload.
  function describeOnTapForDebug(onTap) {
    if (!onTap || typeof onTap !== 'object') return null;
    const desc = { keys: Object.keys(onTap) };
    const commands = onTap.serialCommand?.commands || onTap.commandExecutorCommand?.commands;
    if (Array.isArray(commands)) {
      desc.commandKeys = commands.map(cmd => Object.keys(cmd?.innertubeCommand || cmd || {}));
    }
    return desc;
  }

  function extractJumpAheadSegments(data, sourceName) {
    if (!data || typeof data !== 'object') return [];

    // Match the timelyActions list by key, anywhere in the payload — the
    // wrapping container (timelyActionsOverlayViewModel today) is the part
    // YouTube renames/relocates between experiments.
    const actionLists = [];
    findDeepAll(data, 'timelyActions', actionLists, 0, new WeakSet());

    const segments = [];
    for (const timelyActions of actionLists) {
      if (!Array.isArray(timelyActions)) continue;

      for (const action of timelyActions) {
        const vm = action?.timelyActionViewModel;
        if (!vm) {
          recordJumpAheadFiltered(sourceName, {
            reason: 'no-view-model',
            actionKeys: action && typeof action === 'object' ? Object.keys(action) : null,
          });
          continue;
        }
        const label = vm?.content?.buttonViewModel?.title ||
          vm?.content?.buttonViewModel?.accessibilityText ||
          'YouTube Jump Ahead';

        const triggerMs = parseInt(vm.startTimeMilliseconds ?? vm.startTimeMs, 10);
        if (isNaN(triggerMs)) {
          recordJumpAheadFiltered(sourceName, {
            label,
            reason: 'no-trigger-time',
            vmKeys: Object.keys(vm),
          });
          continue;
        }

        const onTap = vm.rendererContext?.commandContext?.onTap;
        const seekTargetMs = extractSeekTargetFromOnTap(onTap);
        if (!seekTargetMs) {
          recordJumpAheadFiltered(sourceName, {
            label,
            triggerMs,
            reason: 'no-seek-target',
            onTap: describeOnTapForDebug(onTap),
          });
          continue;
        }

        const delta = seekTargetMs - triggerMs;
        if (delta < 1000 || delta > 900000) {
          recordJumpAheadFiltered(sourceName, {
            label,
            triggerMs,
            seekTargetMs,
            reason: 'delta-out-of-bounds',
          });
          continue;
        }

        segments.push({ label, triggerMs, seekTargetMs, source: 'timely-actions' });
      }
    }
    return segments;
  }

  function decodeEntityKey(entityKey) {
    if (!entityKey || typeof entityKey !== 'string') return '';
    try { return atob(decodeURIComponent(entityKey)); } catch (_) {}
    try { return atob(entityKey); } catch (_) {}
    return '';
  }

  function extractRecursiveTiming(node, depth) {
    if (!node || typeof node !== 'object' || (depth || 0) > 12) return null;

    const keys = Object.keys(node);
    const startKey = keys.find(key => /^start.*(?:ms|millis|milliseconds)$/i.test(key));
    const endKey = keys.find(key => /^end.*(?:ms|millis|milliseconds)$/i.test(key));
    const durationKey = keys.find(key => /^duration.*(?:ms|millis|milliseconds)$/i.test(key));

    if (startKey) {
      const triggerMs = parseInt(node[startKey], 10);
      let seekTargetMs = endKey ? parseInt(node[endKey], 10) : NaN;
      if (!Number.isFinite(seekTargetMs) && durationKey) {
        const durationMs = parseInt(node[durationKey], 10);
        if (Number.isFinite(durationMs) && durationMs > 0) {
          seekTargetMs = triggerMs + durationMs;
        }
      }

      if (Number.isFinite(triggerMs) && Number.isFinite(seekTargetMs) && seekTargetMs > triggerMs + 500) {
        return { triggerMs, seekTargetMs };
      }
    }

    for (const value of Object.values(node)) {
      const result = extractRecursiveTiming(value, (depth || 0) + 1);
      if (result) return result;
    }

    return null;
  }

  function extractSmartSkipSegments(data) {
    if (!data || typeof data !== 'object') return [];
    const mutations = data?.frameworkUpdates?.entityBatchUpdate?.mutations;
    if (!Array.isArray(mutations) || !mutations.length) return [];

    const segments = [];
    for (const mutation of mutations) {
      if (!mutation?.entityKey || !mutation?.payload) continue;
      if (!decodeEntityKey(mutation.entityKey).includes('SMART_SKIP')) continue;

      const directTiming = extractRecursiveTiming(mutation.payload, 0);
      if (directTiming) {
        segments.push({
          label: 'YouTube Jump Ahead',
          triggerMs: directTiming.triggerMs,
          seekTargetMs: directTiming.seekTargetMs,
          source: 'smart-skip-recursive',
        });
        continue;
      }

      const list = mutation.payload?.macroMarkersListEntity?.markersList?.markers;
      if (!Array.isArray(list)) continue;

      const orderedMarkers = list
        .map(marker => ({
          startMs: parseInt(marker?.startMillis, 10),
          durationMs: parseInt(marker?.durationMillis, 10),
        }))
        .filter(marker => Number.isFinite(marker.startMs))
        .sort((a, b) => a.startMs - b.startMs);

      for (let i = 0; i < orderedMarkers.length; i++) {
        const marker = orderedMarkers[i];
        let seekTargetMs = null;

        if (Number.isFinite(marker.durationMs) && marker.durationMs > 0) {
          seekTargetMs = marker.startMs + marker.durationMs;
        } else if (orderedMarkers[i + 1]?.startMs > marker.startMs) {
          seekTargetMs = orderedMarkers[i + 1].startMs;
        }

        if (!Number.isFinite(seekTargetMs) || seekTargetMs <= marker.startMs + 500) continue;
        segments.push({
          label: 'YouTube Jump Ahead',
          triggerMs: marker.startMs,
          seekTargetMs,
          source: 'smart-skip-marker',
        });
      }
    }

    return segments;
  }

  function dedupeJumpAheadSegments(segments) {
    return Array.from(new Map(
      segments
        .filter(seg => Number.isFinite(seg?.triggerMs) && Number.isFinite(seg?.seekTargetMs) && seg.seekTargetMs > seg.triggerMs)
        .map(seg => [`${seg.triggerMs}|${seg.seekTargetMs}|${seg.label}`, seg])
    ).values()).sort((a, b) => a.triggerMs - b.triggerMs);
  }

  function collectJumpAheadSegments(data, sourceName) {
    const timelySegments = extractJumpAheadSegments(data, sourceName);
    const smartSkipSegments = extractSmartSkipSegments(data);
    const combined = dedupeJumpAheadSegments([...timelySegments, ...smartSkipSegments]);

    recordJumpAheadSource(sourceName, {
      dataVideoId: getDataVideoId(data),
      timelySegments: timelySegments.length,
      smartSkipSegments: smartSkipSegments.length,
      combinedSegments: combined.length,
    });
    recordJumpAheadExtraction(sourceName, combined);
    debugLog('jump-ahead source', sourceName, {
      dataVideoId: getDataVideoId(data),
      timelySegments: timelySegments.length,
      smartSkipSegments: smartSkipSegments.length,
      combinedSegments: combined.length,
    });

    return combined;
  }

  // ── Extract chapter-break segments ──────────────────────────────────────

  function extractChapterSegments(data, lang) {
    if (!data || typeof data !== 'object') return [];
    if (chapterCache.has(data)) return chapterCache.get(data);
    const segments = [];

    // Keep chapter collections separate so "next chapter" stays in the same list.
    const chapterLists = [];
    collectChapterLists(data, chapterLists, 0, new WeakSet());
    const normalizedLists = chapterLists
      .map(rawList => rawList.map(chapterPointFromRenderer).filter(Boolean).sort((a, b) => a.startMs - b.startMs))
      .filter(list => list.length >= 2);

    // Fallback when chapter data isn't in expected list shapes.
    if (!normalizedLists.length) {
      const fallbackPoints = [];
      collectChapterFallbackPoints(data, fallbackPoints, 0, new WeakSet());
      const deduped = Array.from(new Map(
        fallbackPoints.map(ch => [`${ch.startMs}|${ch.title}`, ch])
      ).values()).sort((a, b) => a.startMs - b.startMs);
      if (deduped.length >= 2) normalizedLists.push(deduped);
    }
    if (!normalizedLists.length) return segments;

    for (const chapters of normalizedLists) {
      if (!chapters.length) continue;

      for (let i = 0; i < chapters.length; i++) {
        const ch = chapters[i];
        if (!isAdChapterTitle(ch.title, lang)) continue;

        const nextChapter = chapters[i + 1];
        if (!nextChapter) continue;

        segments.push({
          label: 'Skipped chapter: ' + ch.title,
          triggerMs: ch.startMs,
          seekTargetMs: nextChapter.startMs,
        });
      }
    }

    chapterCache.set(data, segments);
    return segments;
  }

  function extractChapterSegmentsFromPoints(points, lang) {
    const segments = [];
    if (!Array.isArray(points) || points.length < 2) return segments;

    for (let i = 0; i < points.length - 1; i++) {
      const ch = points[i];
      const nextChapter = points[i + 1];
      if (!isAdChapterTitle(ch.title, lang)) continue;
      if (nextChapter.startMs <= ch.startMs) continue;

      segments.push({
        label: 'Skipped chapter: ' + ch.title,
        triggerMs: ch.startMs,
        seekTargetMs: nextChapter.startMs,
      });
    }

    return segments;
  }

  function extractIntroSegmentsFromPoints(points) {
    const segments = [];
    if (!Array.isArray(points) || points.length < 2) return segments;

    for (let i = 0; i < points.length - 1; i++) {
      const ch = points[i];
      const nextChapter = points[i + 1];
      if (!isIntroChapterTitle(ch.title)) continue;
      if (nextChapter.startMs <= ch.startMs) continue;
      segments.push({
        label: ch.title,
        triggerMs: ch.startMs,
        seekTargetMs: nextChapter.startMs,
      });
    }

    return segments;
  }

  // ── Arm the auto-skip handler ────────────────────────────────────────────

  let activeSegments = [];
  let handledRanges = [];
  let handledVideoId = getCurrentVideoId();
  let lastCompletedSkip = null;
  let lastSkipNoticeKey = null;
  let handler = null;
  let seekingHandler = null;
  let attachedVideo = null;
  let pendingRetryTimers = [];
  let heartbeatInterval = null;
  let currentVideoId = null;

  function getCurrentVideoId() {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('v') || null;
    } catch (_) { return null; }
  }

  const LISTEN_EVENTS = ['timeupdate', 'playing', 'seeked'];
  const UNDO_PLAYBACK_WINDOW_MS = 7000;
  const SKIP_NOTICE_REALTIME_MS = 5000;

  // Don't auto-skip in the opening seconds of playback. Avoids the jarring
  // "skipped the instant I opened the video" when YouTube ships a jump-ahead
  // or chapter segment with a very low trigger time.
  const SKIP_GRACE_MS = 5000;

  function clearSkipNotice() {
    if (lastSkipNoticeKey === null) return;
    lastSkipNoticeKey = null;
    window.postMessage({ source: 'autoskip', type: 'skip-notice-hide' }, '*');
  }

  function syncHandledRangesForVideo(videoId) {
    if (videoId === handledVideoId) return;
    handledVideoId = videoId;
    handledRanges = [];
    lastCompletedSkip = null;
    clearSkipNotice();
  }

  function normalizeRange(fromSec, toSec) {
    const fromMs = Number(fromSec) * 1000;
    const toMs = Number(toSec) * 1000;
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null;
    return { fromMs, toMs };
  }

  function rangeMatchesSegment(range, seg) {
    return Math.abs(range.toMs - seg.seekTargetMs) < 2500 &&
      range.fromMs >= seg.triggerMs - 1500 &&
      range.fromMs < seg.seekTargetMs;
  }

  function isSegmentHandled(seg) {
    return handledRanges.some(range => rangeMatchesSegment(range, seg));
  }

  function rememberHandledRange(fromSec, toSec) {
    syncHandledRangesForVideo(getCurrentVideoId());
    const range = normalizeRange(fromSec, toSec);
    if (!range) return null;
    const exists = handledRanges.some(
      item => Math.abs(item.fromMs - range.fromMs) < 500 && Math.abs(item.toMs - range.toMs) < 500
    );
    if (!exists) handledRanges.push(range);

    for (const seg of activeSegments) {
      if (!rangeMatchesSegment(range, seg)) continue;
      seg.done = true;
      seg.pending = false;
    }
    clearSkipNotice();
    jumpAheadDebug.activeSegments = activeSegments.map(serializeSegment);
    return range;
  }

  function recordCompletedSkip(fromSec, toSec) {
    const range = rememberHandledRange(fromSec, toSec);
    if (!range) return;
    lastCompletedSkip = range;
  }

  function clearUndoForRange(fromSec, toSec) {
    const range = normalizeRange(fromSec, toSec);
    if (!range || !lastCompletedSkip) return;
    if (Math.abs(range.fromMs - lastCompletedSkip.fromMs) < 500 &&
        Math.abs(range.toMs - lastCompletedSkip.toMs) < 500) {
      lastCompletedSkip = null;
    }
  }

  function seekToSegmentStart(fromSec, toSec) {
    const range = rememberHandledRange(fromSec, toSec);
    if (!range) return false;
    const video = document.querySelector('video');
    if (!video) return false;

    const from = range.fromMs / 1000;
    const player = document.getElementById('movie_player');
    if (player && typeof player.seekTo === 'function') {
      player.seekTo(from, true);
    } else {
      video.currentTime = from;
    }
    lastCompletedSkip = null;
    window.postMessage({
      source: 'autoskip',
      type: 'segment-undone',
      fromSec: from,
      toSec: range.toMs / 1000,
    }, '*');
    return true;
  }

  function isEditableTarget(event) {
    const target = event.composedPath?.()[0] || event.target;
    return target instanceof Element && Boolean(
      target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')
    );
  }

  function getPlaybackRate(video) {
    const rate = Number(video?.playbackRate);
    return Number.isFinite(rate) && rate > 0 ? rate : 1;
  }

  function updateSkipNotice(video, currentMs) {
    const noticeLeadMs = SKIP_NOTICE_REALTIME_MS * getPlaybackRate(video);
    if (isMusicVideo || video.paused || currentMs < Math.max(0, SKIP_GRACE_MS - noticeLeadMs)) {
      clearSkipNotice();
      return;
    }

    let upcoming = null;
    for (const seg of activeSegments) {
      if (seg.done || seg.pending || isSegmentHandled(seg)) continue;
      const effectiveTriggerMs = Math.max(seg.triggerMs, SKIP_GRACE_MS);
      const remainingMs = effectiveTriggerMs - currentMs;
      if (remainingMs <= 0 || remainingMs > noticeLeadMs) continue;
      if (!upcoming || effectiveTriggerMs < upcoming.effectiveTriggerMs) {
        upcoming = { seg, effectiveTriggerMs, remainingMs };
      }
    }

    if (!upcoming) {
      clearSkipNotice();
      return;
    }

    const key = `${upcoming.seg.triggerMs}|${upcoming.seg.seekTargetMs}`;
    if (key === lastSkipNoticeKey) return;
    lastSkipNoticeKey = key;
    window.postMessage({
      source: 'autoskip',
      type: 'skip-notice',
      fromSec: upcoming.seg.triggerMs / 1000,
      toSec: upcoming.seg.seekTargetMs / 1000,
    }, '*');
  }

  // YouTube normally handles ArrowLeft as a five-second rewind. Immediately
  // after an auto-skip, make the first press a precise undo instead.
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' || event.repeat || event.altKey || event.ctrlKey ||
        event.metaKey || event.shiftKey || isEditableTarget(event)) return;
    if (!lastCompletedSkip) return;

    const video = document.querySelector('video');
    if (!video) return;
    const currentMs = video.currentTime * 1000;
    if (currentMs < lastCompletedSkip.toMs - 1500 ||
        currentMs > lastCompletedSkip.toMs + UNDO_PLAYBACK_WINDOW_MS) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    seekToSegmentStart(lastCompletedSkip.fromMs / 1000, lastCompletedSkip.toMs / 1000);
  }, true);

  // Standalone skip-check — called by event listeners AND heartbeat
  function checkSkipPoints(video) {
    if (!video) return;
    const ms = video.currentTime * 1000;
    if (lastCompletedSkip &&
        (ms < lastCompletedSkip.fromMs - 1500 ||
         ms > lastCompletedSkip.toMs + UNDO_PLAYBACK_WINDOW_MS)) {
      lastCompletedSkip = null;
    }
    updateSkipNotice(video, ms);
    if (isMusicVideo || video.paused || !activeSegments.length) return;
    if (ms < SKIP_GRACE_MS) return;

    // Handled ranges survive same-video lifecycle resets. If the user seeks
    // back, they intentionally want to watch that section.

    for (const seg of activeSegments) {
      if (seg.done || seg.pending || isSegmentHandled(seg)) continue;
      // Trigger anywhere between start and end of the skip zone
      if (ms >= seg.triggerMs && ms < seg.seekTargetMs - 500) {
        clearSkipNotice();
        const fromSec = seg.triggerMs / 1000;
        const toSec = seg.seekTargetMs / 1000;
        jumpAheadDebug.lastSkip = {
          phase: 'attempt',
          attemptedAt: Date.now(),
          currentTimeMs: Math.round(ms),
          segment: serializeSegment(seg),
        };
        debugLog('attempt skip', jumpAheadDebug.lastSkip);

        // Block duplicate checks while the seek is being verified. If the
        // user seeks back during this window, the seeking handler below marks
        // only this range as handled instead of immediately skipping it again.
        seg.pending = true;
        lastCompletedSkip = normalizeRange(fromSec, toSec);

        // Tell content.js a data-driven skip is in progress so it doesn't
        // also click the DOM button for the same segment.
        window.postMessage({ source: 'autoskip', type: 'skip-in-progress', fromSec, toSec }, '*');

        const player = document.getElementById('movie_player');
        if (player && typeof player.seekTo === 'function') {
          player.seekTo(toSec, true);
        } else {
          video.currentTime = toSec;
        }

        setTimeout(() => {
          const after = video.currentTime * 1000;
          seg.pending = false;
          if (after >= seg.seekTargetMs - 2000) {
            seg.done = true;
            recordCompletedSkip(fromSec, toSec);
            const skipSec = Math.round((after - ms) / 1000);
            jumpAheadDebug.lastSkip = {
              phase: 'success',
              attemptedAt: Date.now(),
              currentTimeMs: Math.round(after),
              seconds: skipSec,
              segment: serializeSegment(seg),
            };
            debugLog('skip success', jumpAheadDebug.lastSkip);
            window.postMessage({ source: 'autoskip', type: 'skipped', seconds: skipSec, label: seg.label, fromSec, toSec }, '*');
            jumpAheadDebug.activeSegments = activeSegments.map(serializeSegment);
          } else {
            jumpAheadDebug.lastSkip = {
              phase: 'verify-failed',
              attemptedAt: Date.now(),
              currentTimeMs: Math.round(after),
              segment: serializeSegment(seg),
            };
            debugLog('skip verification failed', jumpAheadDebug.lastSkip);
          }
        }, 500);
        break;
      }
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatInterval = setInterval(() => {
      if (attachedVideo) checkSkipPoints(attachedVideo);
    }, 500);
  }

  function stopHeartbeat() {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  }

  function detachHandler() {
    if (handler && attachedVideo) {
      for (const evt of LISTEN_EVENTS) attachedVideo.removeEventListener(evt, handler);
    }
    if (seekingHandler && attachedVideo) {
      attachedVideo.removeEventListener('seeking', seekingHandler);
    }
  }

  function attachHandlerIfReady() {
    const video = document.querySelector('video');
    if (!video) return false;

    if (handler && attachedVideo === video) return true;

    detachHandler();

    handler = () => checkSkipPoints(video);
    seekingHandler = () => {
      const ms = video.currentTime * 1000;
      const pendingSegment = activeSegments.find(
        seg => seg.pending && ms >= seg.triggerMs && ms < seg.seekTargetMs - 250
      );
      if (pendingSegment) {
        rememberHandledRange(pendingSegment.triggerMs / 1000, pendingSegment.seekTargetMs / 1000);
        lastCompletedSkip = null;
      }
    };

    for (const evt of LISTEN_EVENTS) video.addEventListener(evt, handler);
    video.addEventListener('seeking', seekingHandler);
    startHeartbeat();
    attachedVideo = video;
    return true;
  }

  // Record WHEN a segment armed relative to current playback. This is the
  // smoking gun for the intermittent "sometimes skips, sometimes not" race:
  //   armed-before-trigger → data won the race, will auto-skip normally
  //   armed-mid-window      → armed late but still inside the zone; the next
  //                           heartbeat (≤500ms) fires it
  //   armed-after-window    → data lost the race: playback already passed the
  //                           whole segment before it armed, so it can never
  //                           auto-fire (you watched the sponsor)
  function recordArmEvent(seg, nowMs) {
    let timing = 'armed-before-trigger';
    if (nowMs != null && Number.isFinite(seg.seekTargetMs)) {
      if (nowMs >= seg.seekTargetMs - 500) timing = 'armed-after-window';
      else if (nowMs >= seg.triggerMs) timing = 'armed-mid-window';
    }
    jumpAheadDebug.armEvents.push({
      timing,
      label: seg.label,
      triggerMs: seg.triggerMs,
      seekTargetMs: seg.seekTargetMs,
      playbackMs: nowMs == null ? null : Math.round(nowMs),
      source: seg.source || null,
      at: Date.now(),
    });
    if (jumpAheadDebug.armEvents.length > 30) jumpAheadDebug.armEvents.shift();
  }

  function armSkip(newSegments) {
    if (!newSegments.length) return;

    const video = attachedVideo || document.querySelector('video');
    const nowMs = video && Number.isFinite(video.currentTime) ? video.currentTime * 1000 : null;

    // Merge, avoiding duplicates by full skip window and label.
    for (const seg of newSegments) {
      if (!activeSegments.some(s => s.triggerMs === seg.triggerMs && s.seekTargetMs === seg.seekTargetMs && s.label === seg.label)) {
        activeSegments.push({ ...seg, done: isSegmentHandled(seg), pending: false });
        recordArmEvent(seg, nowMs);
      }
    }

    jumpAheadDebug.activeSegments = activeSegments.map(serializeSegment);
    attachHandlerIfReady();
  }

  function clearPendingRetryTimers() {
    for (const t of pendingRetryTimers) clearTimeout(t);
    pendingRetryTimers = [];
  }

  let backgroundPoll = null;
  let backgroundPollStart = 0;
  let _slowPoll = null;

  function scheduleProcessRetries() {
    clearPendingRetryTimers();
    stopBackgroundPoll();

    // Fast burst for the first 20s after navigation
    const delays = [0, 300, 600, 1000, 1500, 2000, 3000, 5000, 8000, 11000, 15000, 20000];
    for (const delay of delays) {
      const timer = setTimeout(() => {
        processAllSources();
        attachHandlerIfReady();
      }, delay);
      pendingRetryTimers.push(timer);
    }

    // Background poll — catches data that arrives late.
    // Fast (3s) for the first 60s, then slow (5s) until segments are found.
    // processAllSources() uses WeakMap caches so re-processing is free.
    backgroundPollStart = Date.now();
    backgroundPoll = setInterval(() => {
      processAllSources();
      attachHandlerIfReady();
      // After 60s of fast polling, slow down but keep going until we have data.
      if (Date.now() - backgroundPollStart > 60000 && activeSegments.length) {
        stopBackgroundPoll();
      }
    }, 3000);

    // Slow poll that never stops — catches cases where the 60s fast poll
    // found nothing and the property watcher was overwritten by YouTube.
    if (!_slowPoll) {
      _slowPoll = setInterval(() => {
        if (activeSegments.length) return; // already have data, no-op
        ensureWatchers();
        processAllSources();
        attachHandlerIfReady();
      }, 5000);
    }
  }

  function stopBackgroundPoll() {
    if (backgroundPoll) { clearInterval(backgroundPoll); backgroundPoll = null; }
  }

  function shouldInspectNetworkUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return false;
    if (!rawUrl.includes('/youtubei/v1/')) return false;
    return /\/youtubei\/v1\/(?:next|player|browse|updated_metadata|reel\/reel_item_watch)/.test(rawUrl);
  }

  function parseJsonPayload(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.replace(/^\uFEFF/, '').trimStart();
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
    try { return JSON.parse(trimmed); } catch (_) { return null; }
  }

  function processNetworkPayload(url, payload) {
    if (!payload || typeof payload !== 'object') return;
    recordJumpAheadSource('network-payload', { lastUrl: String(url).slice(0, 120) });
    process(payload, 'network-payload');
    attachHandlerIfReady();
  }

  function processAllSources() {
    const pageData = getPageData();
    const playerResponse = getPlayerResponse();
    const livePlayerResponse = getLivePlayerResponse();
    const chapterPoints = collectDomChapterPoints();
    const urlVideoId = getCurrentVideoId();
    const lang = detectVideoLanguage(playerResponse);
    currentVideoId = urlVideoId;
    // Debug state resets only on video change (reset()), not per run —
    // otherwise network-payload source records get wiped before snapshots.
    jumpAheadDebug.currentVideoId = urlVideoId;

    // Check if the global data objects belong to the current video.
    // If stale, skip the globals but STILL process DOM chapters —
    // those always reflect the current video.
    const dataVideoId = playerResponse?.videoDetails?.videoId || null;
    const globalsStale = urlVideoId && dataVideoId && urlVideoId !== dataVideoId;

    let jumpAhead = [];
    let chapters = [];
    let introSegments = [];

    refreshMusicGuard();
    jumpAheadDebug.blockers.musicVideo = isMusicVideo;
    jumpAheadDebug.blockers.globalsStale = Boolean(globalsStale);
    if (isMusicVideo) return;

    if (settings.skipJumpAhead) {
      for (const source of [
        { name: 'pageData', data: pageData },
        { name: 'playerResponse', data: playerResponse },
        { name: 'livePlayer', data: livePlayerResponse },
      ]) {
        if (!source.data) continue;

        const sourceVideoId = getDataVideoId(source.data);
        if (urlVideoId && sourceVideoId && sourceVideoId !== urlVideoId) {
          recordJumpAheadSource(source.name, {
            dataVideoId: sourceVideoId,
            staleSource: true,
            combinedSegments: 0,
          });
          debugLog('skip stale source', source.name, {
            currentVideoId: urlVideoId,
            sourceVideoId,
          });
          continue;
        }

        // livePlayer objects come from player internals — never let one
        // malformed source take down the whole processing pass.
        try {
          jumpAhead = [
            ...jumpAhead,
            ...collectJumpAheadSegments(source.data, source.name),
          ];
        } catch (err) {
          recordJumpAheadSource(source.name, { error: String(err) });
        }
      }
    }

    if (settings.skipAdChapter) {
      if (!globalsStale) {
        chapters = [
          ...extractChapterSegments(pageData, lang),
          ...extractChapterSegments(playerResponse, lang),
        ];
      }
      // DOM chapters are always for the current video — process regardless.
      chapters = [...chapters, ...extractChapterSegmentsFromPoints(chapterPoints, lang)];
    }

    introSegments = extractIntroSegmentsFromPoints(chapterPoints);

    const all = [...chapters, ...jumpAhead];
    if (all.length) armSkip(all);

    // activeSegments debug view is owned by armSkip()/reset() — it must
    // reflect the real armed list, not just this run's extraction.
    jumpAheadDebug.lastProcess = {
      processedAt: Date.now(),
      currentVideoId: urlVideoId,
      globalsStale: Boolean(globalsStale),
      chapterSegments: chapters.length,
      introSegments: introSegments.length,
      jumpAheadSegments: jumpAhead.length,
      armedSegments: all.length,
      armedTotal: activeSegments.length,
    };
    debugLog('processAllSources', jumpAheadDebug.lastProcess);
  }

  // ── Process a data payload ───────────────────────────────────────────────

  function process(data, sourceName) {
    const name = sourceName || 'network-payload';
    refreshMusicGuard();
    jumpAheadDebug.currentVideoId = getCurrentVideoId();
    jumpAheadDebug.blockers.musicVideo = isMusicVideo;
    if (isMusicVideo) return;

    const lang = detectVideoLanguage(getPlayerResponse());
    let jumpAhead = [];
    try {
      jumpAhead = settings.skipJumpAhead ? collectJumpAheadSegments(data, name) : [];
    } catch (err) {
      recordJumpAheadSource(name, { error: String(err) });
    }
    let chapters = [];
    try {
      chapters = settings.skipAdChapter ? extractChapterSegments(data, lang) : [];
    } catch (_) {}

    const all = [...jumpAhead, ...chapters];
    if (all.length) armSkip(all);

    jumpAheadDebug.lastProcess = {
      processedAt: Date.now(),
      currentVideoId: getCurrentVideoId(),
      source: name,
      chapterSegments: chapters.length,
      jumpAheadSegments: jumpAhead.length,
      armedSegments: all.length,
      armedTotal: activeSegments.length,
    };
    debugLog('process(payload)', jumpAheadDebug.lastProcess);
  }

  // ── Reset on video change ────────────────────────────────────────────────

  function reset() {
    const nextVideoId = getCurrentVideoId();
    syncHandledRangesForVideo(nextVideoId);
    currentVideoId = nextVideoId;
    activeSegments = [];
    clearSkipNotice();
    cachedLang = null;
    isMusicVideo = false;
    hasSentMusicState = false;
    chapterCache = new WeakMap();
    clearPendingRetryTimers();
    stopBackgroundPoll();
    stopHeartbeat();
    detachHandler();
    handler = null;
    seekingHandler = null;
    attachedVideo = null;
    resetJumpAheadDebug(currentVideoId);
    debugLog('reset', { currentVideoId });
  }

  // Deduplicated navigation handler — used by all navigation triggers.
  function onVideoChange() {
    reset();
    refreshMusicGuard();
    scheduleProcessRetries();
  }

  // ── Triggers ─────────────────────────────────────────────────────────────

  // Publish initial music guard state as soon as possible.
  refreshMusicGuard();

  // 1. Initial page load — poll for ytInitialData, then kick off the same
  // retry/slow-poll cadence we use for SPA navigation. Direct page loads
  // (pasted URL, refresh, new tab) never fire yt-navigate-finish, so
  // without this the data path only scans once — any later population of
  // timelyActionsOverlayViewModel would be missed until the user's mouse
  // movement triggered a DOM mutation observed by content.js.
  let attempts = 0;
  const poll = setInterval(() => {
    attempts++;
    if (getPageData() || getPlayerResponse()) {
      clearInterval(poll);
      scheduleProcessRetries();
    } else if (attempts > 50) {
      clearInterval(poll);
      // Data never arrived via globals — still start the slow poll so
      // late-arriving network responses or DOM chapter nodes eventually
      // get processed without user interaction.
      scheduleProcessRetries();
    }
  }, 200);

  // Attach the video handler + heartbeat as soon as a <video> element
  // exists, independent of whether segments have been extracted yet.
  // checkSkipPoints() is a cheap no-op until activeSegments is populated,
  // and attaching early guarantees we don't miss the first timeupdate
  // after segments arrive.
  attachHandlerIfReady();

  // 2. SPA navigation. The event detail carries the fresh watch response —
  // parse it directly. On SPA/cache-hit navigation the window globals often
  // keep the PREVIOUS video's data (correctly skipped as stale) and no
  // interceptable network request fires, so without this the data path can
  // arm nothing until the user's mouse wakes the player controls.
  document.addEventListener('yt-navigate-finish', (e) => {
    onVideoChange();
    if (e?.detail && typeof e.detail === 'object') {
      process(e.detail, 'navigate-detail');
      attachHandlerIfReady();
    }
  });

  // 3. YouTube data-ready events
  for (const evt of [
    'yt-page-data-updated',
    'yt-navigate-cache-hit',
    'yt-player-updated',
    'yt-page-data-fetched',
    'yt-navigate-redirect',
  ]) {
    document.addEventListener(evt, () => {
      processAllSources();
      attachHandlerIfReady();
    });
  }

  // 4. Track video element lifecycle — detects replacements and new loads.
  let monitoredVideo = null;

  function monitorVideoElement() {
    const video = document.querySelector('video');
    if (!video || video === monitoredVideo) return;

    monitoredVideo = video;
    video.addEventListener('loadedmetadata', () => {
      const newId = getCurrentVideoId();
      if (newId && newId !== currentVideoId) {
        onVideoChange();
      } else {
        attachHandlerIfReady();
      }
    });

    attachHandlerIfReady();
  }

  // Re-attach when video element appears or is replaced.
  let lastObservedVideo = null;
  const rootObserver = new MutationObserver(() => {
    const currentVideo = document.querySelector('video');
    if (!currentVideo || currentVideo === lastObservedVideo) return;
    lastObservedVideo = currentVideo;
    monitorVideoElement();
    if (!handler || attachedVideo !== currentVideo) attachHandlerIfReady();
  });
  rootObserver.observe(document.documentElement || document, { childList: true, subtree: true });

  // 5. Intercept history.pushState / replaceState
  function onHistoryChange() {
    const newId = getCurrentVideoId();
    if (newId && newId !== currentVideoId) onVideoChange();
  }

  for (const method of ['pushState', 'replaceState']) {
    const orig = history[method];
    history[method] = function (...args) {
      const result = orig.apply(this, args);
      onHistoryChange();
      return result;
    };
  }
  window.addEventListener('popstate', onHistoryChange);

  // 6. URL-change polling — ultimate fallback
  let lastPolledVideoId = getCurrentVideoId();
  setInterval(() => {
    const newId = getCurrentVideoId();
    if (newId && newId !== lastPolledVideoId) {
      lastPolledVideoId = newId;
      if (newId !== currentVideoId) onVideoChange();
    }
  }, 2000);

  // content.js saw YouTube's own jump/skip button in the DOM. The button's
  // presence means YouTube has segment data client-side RIGHT NOW — if our
  // data path armed nothing covering the current time, reprocess all
  // sources (incl. the live player API) instead of relying on a DOM click
  // that silently no-ops while controls are hidden.
  let lastDomTriggeredReprocess = 0;

  function onDomButtonEvent(data) {
    jumpAheadDebug.domButtonSightings.push({
      kind: data.kind || 'sighting',
      label: String(data.label || '').slice(0, 80),
      visible: Boolean(data.visible),
      at: Date.now(),
    });
    if (jumpAheadDebug.domButtonSightings.length > 20) {
      jumpAheadDebug.domButtonSightings.shift();
    }

    const video = document.querySelector('video');
    if (!video) return;
    const ms = video.currentTime * 1000;
    const covered = activeSegments.some(
      s => !s.done && ms >= s.triggerMs && ms < s.seekTargetMs
    );
    if (covered) return;

    const now = Date.now();
    if (now - lastDomTriggeredReprocess < 1500) return;
    lastDomTriggeredReprocess = now;
    processAllSources();
    attachHandlerIfReady();
  }

  // Messages from content.js (settings + DOM button events)
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (e.origin !== window.location.origin) return;
    const data = e.data;
    if (!data || typeof data !== 'object') return;
    if (data.source === 'autoskip-config' && data.type === 'settings') {
      applySettings(data.settings);
      return;
    }
    if (data.source === 'autoskip-dom' && data.type === 'jump-button-event') {
      onDomButtonEvent(data);
      return;
    }
    if (data.source === 'autoskip-dom' && data.type === 'segment-skipped') {
      recordCompletedSkip(data.fromSec, data.toSec);
      return;
    }
    if (data.source === 'autoskip-control' && data.type === 'suppress-segment') {
      rememberHandledRange(data.fromSec, data.toSec);
      clearUndoForRange(data.fromSec, data.toSec);
      return;
    }
    if (data.source === 'autoskip-control' && data.type === 'undo-segment') {
      seekToSegmentStart(data.fromSec, data.toSec);
    }
  });

  // 7. Intercept /next, /player API responses
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const resp = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (shouldInspectNetworkUrl(url)) {
        resp.clone().text().then(raw => {
          const payload = parseJsonPayload(raw);
          if (payload) processNetworkPayload(url, payload);
        }).catch(() => {});
      }
    } catch (_) {}
    return resp;
  };

  const origXHROpen = XMLHttpRequest.prototype.open;
  const origXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__autoskipUrl = typeof url === 'string' ? url : (url?.toString?.() || '');
    return origXHROpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        const url = this.__autoskipUrl || '';
        if (!shouldInspectNetworkUrl(url)) return;
        if (this.responseType === 'json' && this.response && typeof this.response === 'object') {
          processNetworkPayload(url, this.response);
          return;
        }
        if (this.responseType && this.responseType !== '' && this.responseType !== 'text') return;
        const payload = parseJsonPayload(typeof this.responseText === 'string' ? this.responseText : '');
        if (payload) processNetworkPayload(url, payload);
      } catch (_) {}
    });
    return origXHRSend.apply(this, args);
  };
})();
