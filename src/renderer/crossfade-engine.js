// ─── Dual Audio Engine (preload + crossfade + gapless + watchdog) ───
// Closure-based module. Created via DualAudioEngine(audioA, audioB, opts).
// Communicates back to the player UI through onTransition / onTimeUpdate / onStall callbacks.

window.DualAudioEngine = function DualAudioEngine(audioA, audioB, opts) {
  'use strict';

  const { getState, getStreamUrl, onTransition, onTimeUpdate, onStall } = opts;

  // ─── Constants ───
  const CROSSFADE_MAX = 12;
  const VOLUME_SCALE = 0.3;

  // ─── Private state ───
  let audio = audioA;
  let activeAudio = audioA;
  let standbyAudio = audioB;

  let crossfadeInProgress = false;
  let crossfadeTriggered = false;
  let _cfAnimFrame = null;
  let _cfStartTime = null;
  let _cfDuration = 0;
  let _cfOldAudio = null;
  let _cfStartVolume = 0;
  let _cfPrevQueueIndex = null;
  let _cfPaused = false;
  let _cfPausedElapsed = 0;
  let _cfGeneration = 0;
  let preloadedTrack = null;
  let preloadedUrl = null;
  let preloadTriggered = false;

  // ─── Watchdog state ───
  let _watchdogLastTime = -1;
  let _watchdogStallTicks = 0;

  // ─── Preloading system ───

  function getNextTrack() {
    const s = getState();
    if (!s.queue.length) return null;
    if (s.repeat === 'one') return null;
    if (s.repeat === 'all') {
      let nextIdx = s.queueIndex + 1;
      if (nextIdx >= s.queue.length) nextIdx = 0;
      return s.queue[nextIdx] || null;
    }
    const nextIdx = s.queueIndex + 1;
    if (nextIdx >= s.queue.length) return null;
    return s.queue[nextIdx];
  }

  function triggerPreload() {
    if (preloadTriggered) return;
    preloadTriggered = true;
    preloadNextTrack();
  }

  async function preloadNextTrack() {
    if (crossfadeInProgress) return;
    const next = getNextTrack();
    if (!next) return;
    if (preloadedTrack && preloadedTrack.id === next.id && preloadedUrl) return;
    try {
      const url = await getStreamUrl(next.url, getState().audioQuality);
      const currentNext = getNextTrack();
      if (!currentNext || currentNext.id !== next.id) return;
      preloadedTrack = next;
      preloadedUrl = url;
      standbyAudio.src = url;
      standbyAudio.load();
    } catch (err) {
      console.warn('Preload failed (will fallback):', err);
      preloadedTrack = null;
      preloadedUrl = null;
    }
  }

  function clearPreload() {
    preloadedTrack = null;
    preloadedUrl = null;
    preloadTriggered = false;
    if (!crossfadeInProgress) {
      standbyAudio.removeAttribute('src');
      standbyAudio.load();
    }
  }

  function checkPreload() {
    if (!preloadTriggered && audio.duration > 0 && audio.currentTime > 0) {
      triggerPreload();
    }
  }

  // ─── Gapless swap (crossfade OFF) ───

  function doGaplessSwap() {
    if (!preloadedTrack) {
      onTransition({ type: 'ended-no-preload' });
      return;
    }
    advanceQueueIndex();
    swapAudioElements();
    const s = getState();
    audio.volume = s.volume * VOLUME_SCALE;
    audio.play().catch(() => {
      onTransition({ type: 'gapless-play-failed' });
      return;
    });
    s.isPlaying = true;
    s.isLoading = false;
    const track = s.queue[s.queueIndex];
    onTransition({ type: 'gapless-complete', track });
    preloadTriggered = false;
    triggerPreload();
  }

  function advanceQueueIndex() {
    const s = getState();
    if (s.repeat === 'all') {
      s.queueIndex = (s.queueIndex + 1) % s.queue.length;
    } else {
      s.queueIndex++;
    }
  }

  function swapAudioElements() {
    const oldActive = activeAudio;
    unbindAudioEvents(oldActive);
    oldActive.pause();
    oldActive.removeAttribute('src');
    oldActive.load();

    activeAudio = standbyAudio;
    standbyAudio = oldActive;
    audio = activeAudio;
    bindAudioEvents(audio);
    preloadedTrack = null;
    preloadedUrl = null;
  }

  // ─── Crossfade system ───

  function checkCrossfadeTrigger() {
    const s = getState();
    if (s.crossfade <= 0) return;
    if (crossfadeInProgress || crossfadeTriggered) return;
    if (!audio.duration || audio.duration === Infinity) return;
    if (audio.duration < s.crossfade * 2) return;
    const remaining = audio.duration - audio.currentTime;
    if (remaining <= s.crossfade && remaining > 0) {
      crossfadeTriggered = true;
      startCrossfade();
    }
  }

  async function startCrossfade() {
    const nextTrack = getNextTrack();
    if (!nextTrack) { crossfadeTriggered = false; return; }

    crossfadeInProgress = true;
    _cfOldAudio = activeAudio;
    _cfStartVolume = activeAudio.volume;
    const gen = ++_cfGeneration;

    try {
      if (preloadedTrack && preloadedTrack.id === nextTrack.id && preloadedUrl) {
        // standbyAudio already has the URL loaded
      } else {
        const url = await getStreamUrl(nextTrack.url, getState().audioQuality);
        if (gen !== _cfGeneration) return;
        standbyAudio.src = url;
        standbyAudio.load();
        preloadedTrack = nextTrack;
        preloadedUrl = url;
      }

      standbyAudio.volume = 0;
      await standbyAudio.play();
      if (gen !== _cfGeneration) return;

      _cfPrevQueueIndex = getState().queueIndex;
      advanceQueueIndex();

      const track = getState().queue[getState().queueIndex];
      onTransition({ type: 'crossfade-start', track });

      _cfOldAudio.removeEventListener('ended', onAudioEnded);

      const s = getState();
      _cfDuration = s.crossfade * 1000;
      _cfStartTime = null;
      _cfPaused = false;
      _cfPausedElapsed = 0;
      _cfAnimFrame = requestAnimationFrame(crossfadeTick);
    } catch (err) {
      if (gen !== _cfGeneration) return;
      console.warn('Crossfade failed, falling back:', err);
      cancelCrossfade();
      crossfadeTriggered = true;
      const track = getState().queue[getState().queueIndex];
      onTransition({ type: 'crossfade-cancel', track });
    }
  }

  function crossfadeTick(timestamp) {
    if (!crossfadeInProgress || _cfPaused) return;
    if (!_cfStartTime) _cfStartTime = timestamp;

    const elapsed = timestamp - _cfStartTime;
    const t = Math.min(elapsed / _cfDuration, 1);

    const masterVol = getState().volume * VOLUME_SCALE;
    const fadeOutBase = masterVol;
    if (_cfOldAudio) _cfOldAudio.volume = Math.cos(t * Math.PI / 2) * fadeOutBase;
    standbyAudio.volume = Math.sin(t * Math.PI / 2) * masterVol;

    if (t >= 1) {
      completeCrossfade(_cfOldAudio);
    } else {
      _cfAnimFrame = requestAnimationFrame(crossfadeTick);
    }
  }

  function completeCrossfade(oldAudio) {
    if (!crossfadeInProgress) return;
    _cfGeneration++;
    if (_cfAnimFrame) { cancelAnimationFrame(_cfAnimFrame); _cfAnimFrame = null; }

    _cfStartTime = null;
    _cfPaused = false;
    _cfPausedElapsed = 0;
    _cfPrevQueueIndex = null;
    _cfOldAudio = null;

    oldAudio.pause();
    oldAudio.removeAttribute('src');
    oldAudio.load();
    unbindAudioEvents(oldAudio);

    activeAudio = standbyAudio;
    standbyAudio = oldAudio;
    audio = activeAudio;
    bindAudioEvents(audio);
    audio.volume = getState().volume * VOLUME_SCALE;

    preloadedTrack = null;
    preloadedUrl = null;
    crossfadeInProgress = false;
    crossfadeTriggered = false;

    preloadTriggered = false;
    triggerPreload();
    onTransition({ type: 'crossfade-complete' });
  }

  function cancelCrossfade() {
    if (!crossfadeInProgress) return;
    _cfGeneration++;
    if (_cfAnimFrame) { cancelAnimationFrame(_cfAnimFrame); _cfAnimFrame = null; }

    standbyAudio.pause();
    standbyAudio.removeAttribute('src');
    standbyAudio.load();
    audio.volume = getState().volume * VOLUME_SCALE;

    if (_cfPrevQueueIndex !== null) {
      getState().queueIndex = _cfPrevQueueIndex;
      _cfPrevQueueIndex = null;
    }

    activeAudio.removeEventListener('ended', onAudioEnded);
    activeAudio.addEventListener('ended', onAudioEnded);

    _cfOldAudio = null;
    _cfStartTime = null;
    _cfPaused = false;
    _cfPausedElapsed = 0;
    crossfadeInProgress = false;
    crossfadeTriggered = false;
    preloadedTrack = null;
    preloadedUrl = null;
  }

  function instantCompleteCrossfade() {
    if (!crossfadeInProgress || !_cfOldAudio) return;
    _cfOldAudio.volume = 0;
    standbyAudio.volume = getState().volume * VOLUME_SCALE;
    completeCrossfade(_cfOldAudio);
  }

  // ─── Pause / Resume during crossfade ───

  function pauseFade() {
    if (!crossfadeInProgress || _cfPaused) return;
    if (_cfOldAudio) _cfOldAudio.pause();
    standbyAudio.pause();
    _cfPaused = true;
    _cfPausedElapsed = performance.now() - (_cfStartTime || performance.now());
    if (_cfAnimFrame) { cancelAnimationFrame(_cfAnimFrame); _cfAnimFrame = null; }
  }

  function resumeFade() {
    if (!crossfadeInProgress || !_cfPaused) return;
    if (_cfOldAudio) _cfOldAudio.play().catch(() => {});
    standbyAudio.play().catch(() => {});
    _cfPaused = false;
    if (getState().crossfade <= 0) {
      instantCompleteCrossfade();
    } else {
      _cfStartTime = performance.now() - _cfPausedElapsed;
      _cfAnimFrame = requestAnimationFrame(crossfadeTick);
    }
  }

  // ─── Consume preloaded track (used by playTrack) ───

  function consumePreloaded(trackId) {
    if (!preloadedTrack || preloadedTrack.id !== trackId || !preloadedUrl) return null;
    const oldActive = activeAudio;
    unbindAudioEvents(oldActive);
    oldActive.pause();
    oldActive.removeAttribute('src');
    oldActive.load();

    activeAudio = standbyAudio;
    standbyAudio = oldActive;
    audio = activeAudio;
    bindAudioEvents(audio);
    preloadedTrack = null;
    preloadedUrl = null;
    return audio;
  }

  // ─── Audio event handlers ───

  function onAudioEnded() {
    if (crossfadeInProgress) return;
    const s = getState();
    if (preloadedTrack && s.repeat !== 'one') {
      doGaplessSwap();
    } else {
      onTransition({ type: 'ended-no-preload' });
    }
  }

  function onAudioTimeUpdate() {
    onTimeUpdate();
    checkPreload();
    checkCrossfadeTrigger();
  }

  function onAudioSeeked() {
    if (crossfadeInProgress) instantCompleteCrossfade();
    onTransition({ type: 'seeked' });
  }

  function onAudioError() {
    const s = getState();
    const nextIdx = s.queueIndex + 1;
    const hasNext = nextIdx < s.queue.length;
    onTransition({ type: 'error', hasNext, nextIndex: nextIdx });
  }

  function onAudioCanPlayThrough() {
    triggerPreload();
  }

  function bindAudioEvents(el) {
    el.addEventListener('ended', onAudioEnded);
    el.addEventListener('timeupdate', onAudioTimeUpdate);
    el.addEventListener('seeked', onAudioSeeked);
    el.addEventListener('error', onAudioError);
    el.addEventListener('canplaythrough', onAudioCanPlayThrough);
  }

  function unbindAudioEvents(el) {
    el.removeEventListener('ended', onAudioEnded);
    el.removeEventListener('timeupdate', onAudioTimeUpdate);
    el.removeEventListener('seeked', onAudioSeeked);
    el.removeEventListener('error', onAudioError);
    el.removeEventListener('canplaythrough', onAudioCanPlayThrough);
  }

  // ─── Watchdog timer ───

  const _watchdogHandle = setInterval(() => {
    const s = getState();
    if (crossfadeInProgress || !s.isPlaying || s.isLoading || audio.paused) {
      _watchdogLastTime = -1;
      _watchdogStallTicks = 0;
      return;
    }
    const ct = audio.currentTime;
    if (_watchdogLastTime >= 0 && ct === _watchdogLastTime && ct > 0) {
      _watchdogStallTicks++;
      if (_watchdogStallTicks >= 4) {
        console.warn('Watchdog: playback stalled at', ct, '— advancing');
        _watchdogStallTicks = 0;
        _watchdogLastTime = -1;
        onStall();
      }
    } else {
      _watchdogStallTicks = 0;
    }
    _watchdogLastTime = ct;
  }, 2000);

  // ─── Initialize: bind events on first active audio ───
  bindAudioEvents(audio);

  // ─── Public API ───
  return {
    VOLUME_SCALE,
    CROSSFADE_MAX,
    isInProgress()       { return crossfadeInProgress; },
    isTriggered()        { return crossfadeTriggered; },
    isFadePaused()       { return _cfPaused; },
    getActiveSource()    { return crossfadeInProgress ? standbyAudio : audio; },
    getActiveAudio()     { return audio; },
    getPreloaded()       { return preloadedTrack ? { track: preloadedTrack, url: preloadedUrl } : null; },
    instantComplete()    { instantCompleteCrossfade(); },
    clearPreload()       { clearPreload(); },
    resetTrigger()       { crossfadeTriggered = false; },
    markTriggered()      { crossfadeTriggered = true; },
    resetPreloadFlag()   { preloadTriggered = false; },
    applyVolume(vol)     { if (!crossfadeInProgress) audio.volume = vol * VOLUME_SCALE; },
    pauseFade()          { pauseFade(); },
    resumeFade()         { resumeFade(); },
    consumePreloaded(id) { return consumePreloaded(id); },
    setSource(url)       { audio.src = url; audio.load(); },
    destroy() {
      clearInterval(_watchdogHandle);
      unbindAudioEvents(audio);
    }
  };
};
