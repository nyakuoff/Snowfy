// ─── LUFS Loudness Normalizer (ITU-R BS.1770 + EBU R128) ───
// Closure-based module. Created via LoudnessNormalizer(audioA, audioB).
// Analyzes tracks using OfflineAudioContext, applies gain via Web Audio GainNodes.

window.LoudnessNormalizer = function LoudnessNormalizer(audioA, audioB) {
  'use strict';

  // ─── Constants ───
  const DEFAULT_TARGET = -14; // LUFS (Spotify standard)
  const RAMP_TIME = 0.4;     // seconds — smooth gain transition
  const PEAK_CEILING = -0.5; // dBFS — gain cap to prevent clipping

  // BS.1770 gating parameters
  const BLOCK_DURATION = 0.4; // 400ms blocks
  const BLOCK_OVERLAP = 0.75; // 75% overlap → 100ms step
  const ABSOLUTE_GATE = -70;  // LUFS
  const RELATIVE_GATE = -10;  // LU below ungated loudness

  // K-weighting filter coefficients (pre-computed for common sample rates)
  // Stage 1: High-shelf boost (~+4dB above 1.5kHz)
  // Stage 2: High-pass rolloff (~-∞ below 50Hz)
  const K_WEIGHTS = {
    48000: {
      shelf: { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [1, -1.69065929318241, 0.73248077421585] },
      hp:    { b: [1.0, -2.0, 1.0], a: [1, -1.99004745483398, 0.99007225036621] }
    },
    44100: {
      shelf: { b: [1.53090959966428, -2.65116903469122, 1.16903097776360], a: [1, -1.66363794709474, 0.71238064688380] },
      hp:    { b: [1.0, -2.0, 1.0], a: [1, -1.98916967210520, 0.98919159781614] }
    }
  };

  // ─── State ───
  let _enabled = false;
  let _target = DEFAULT_TARGET;
  let _audioCtx = null;
  let _sourceA = null;
  let _sourceB = null;
  let _gainA = null;
  let _gainB = null;
  const _cache = new Map();       // trackId → { lufs, peak }
  const _inflight = new Map();    // trackId → Promise

  // ─── Audio Context + Gain Nodes ───

  function initAudioContext() {
    if (_audioCtx) return;
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    _sourceA = _audioCtx.createMediaElementSource(audioA);
    _sourceB = _audioCtx.createMediaElementSource(audioB);
    _gainA = _audioCtx.createGain();
    _gainB = _audioCtx.createGain();
    _sourceA.connect(_gainA).connect(_audioCtx.destination);
    _sourceB.connect(_gainB).connect(_audioCtx.destination);
  }

  function getGainNode(audioEl) {
    if (!_audioCtx) return null;
    return audioEl === audioA ? _gainA : audioEl === audioB ? _gainB : null;
  }

  // ─── K-weighting via biquad filters ───

  function getKWeightCoeffs(sampleRate) {
    if (K_WEIGHTS[sampleRate]) return K_WEIGHTS[sampleRate];
    // Fallback: use 48kHz coefficients (close enough for 96kHz etc.)
    return K_WEIGHTS[48000];
  }

  function applyBiquad(samples, b, a) {
    // Direct Form II transposed — in-place
    const n = samples.length;
    let z1 = 0, z2 = 0;
    for (let i = 0; i < n; i++) {
      const x = samples[i];
      const y = b[0] * x + z1;
      z1 = b[1] * x - a[1] * y + z2;
      z2 = b[2] * x - a[2] * y;
      samples[i] = y;
    }
  }

  // ─── BS.1770 LUFS Measurement ───

  function measureLUFS(audioBuffer) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length;
    const coeffs = getKWeightCoeffs(sampleRate);

    // Channel weights per ITU-R BS.1770 (LFE excluded)
    // Front L/R = 1.0, Center = 1.0, Surround L/R = 1.41
    const channelWeight = [];
    for (let ch = 0; ch < numChannels; ch++) {
      channelWeight.push(ch >= 3 ? 1.41 : 1.0); // Surround channels get +1.5dB
    }

    // Apply K-weighting to each channel
    const kWeighted = [];
    for (let ch = 0; ch < numChannels; ch++) {
      const data = audioBuffer.getChannelData(ch).slice(); // copy
      applyBiquad(data, coeffs.shelf.b, coeffs.shelf.a);
      applyBiquad(data, coeffs.hp.b, coeffs.hp.a);
      kWeighted.push(data);
    }

    // Compute per-block mean square for each channel, then sum weighted
    const blockSamples = Math.round(BLOCK_DURATION * sampleRate);
    const stepSamples = Math.round(blockSamples * (1 - BLOCK_OVERLAP));
    const blocks = [];

    for (let start = 0; start + blockSamples <= length; start += stepSamples) {
      let blockPower = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        const data = kWeighted[ch];
        let sumSq = 0;
        for (let i = start; i < start + blockSamples; i++) {
          sumSq += data[i] * data[i];
        }
        blockPower += channelWeight[ch] * (sumSq / blockSamples);
      }
      blocks.push(blockPower);
    }

    if (!blocks.length) return { lufs: -Infinity, peak: 0 };

    // Step 1: Absolute gate (-70 LUFS)
    const absThreshold = Math.pow(10, (ABSOLUTE_GATE + 0.691) / 10);
    const ungated = blocks.filter(p => p > absThreshold);
    if (!ungated.length) return { lufs: -Infinity, peak: 0 };

    // Ungated loudness
    const ungatedMean = ungated.reduce((s, p) => s + p, 0) / ungated.length;
    const ungatedLUFS = -0.691 + 10 * Math.log10(ungatedMean);

    // Step 2: Relative gate (ungated - 10 LU)
    const relThreshold = Math.pow(10, (ungatedLUFS + RELATIVE_GATE + 0.691) / 10);
    const gated = blocks.filter(p => p > relThreshold);
    if (!gated.length) return { lufs: ungatedLUFS, peak: 0 };

    const gatedMean = gated.reduce((s, p) => s + p, 0) / gated.length;
    const lufs = -0.691 + 10 * Math.log10(gatedMean);

    // True peak (sample peak from original buffer — not K-weighted)
    let peak = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        const abs = Math.abs(data[i]);
        if (abs > peak) peak = abs;
      }
    }

    return { lufs, peak };
  }

  // ─── Analysis ───

  async function analyzeLUFS(url, trackId) {
    if (_cache.has(trackId)) return _cache.get(trackId);
    if (_inflight.has(trackId)) return _inflight.get(trackId);

    const promise = (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
        const arrayBuf = await response.arrayBuffer();

        // Decode in an OfflineAudioContext (no playback, fast)
        const tempCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, 1, 48000);
        const audioBuffer = await tempCtx.decodeAudioData(arrayBuf);

        const result = measureLUFS(audioBuffer);
        _cache.set(trackId, result);
        console.log(`[Normalizer] ${trackId}: ${result.lufs.toFixed(1)} LUFS, peak ${(20 * Math.log10(result.peak || 1e-10)).toFixed(1)} dBFS`);
        return result;
      } catch (err) {
        console.warn('[Normalizer] Analysis failed:', err);
        return null;
      } finally {
        _inflight.delete(trackId);
      }
    })();

    _inflight.set(trackId, promise);
    return promise;
  }

  // ─── Gain Computation ───

  function computeGain(trackId) {
    const data = _cache.get(trackId);
    if (!data || data.lufs === -Infinity) return 1.0;

    let gainDB = _target - data.lufs;
    // Cap gain to prevent clipping: peak + gain <= PEAK_CEILING
    const peakDBFS = 20 * Math.log10(data.peak || 1e-10);
    const maxGainDB = PEAK_CEILING - peakDBFS;
    if (gainDB > maxGainDB) gainDB = maxGainDB;
    // Never boost silence — if gain would be absurdly high, skip
    if (gainDB > 24) return 1.0;
    return Math.pow(10, gainDB / 20);
  }

  // ─── Apply / Reset ───

  function applyGain(audioEl, trackId) {
    if (!_enabled || !_audioCtx) return;
    const node = getGainNode(audioEl);
    if (!node) return;
    const gain = computeGain(trackId);
    node.gain.setTargetAtTime(gain, _audioCtx.currentTime, RAMP_TIME / 3);
  }

  function resetGain(audioEl) {
    if (!_audioCtx) return;
    const node = getGainNode(audioEl);
    if (!node) return;
    node.gain.setTargetAtTime(1.0, _audioCtx.currentTime, RAMP_TIME / 3);
  }

  async function analyzeAndApply(audioEl, url, trackId) {
    if (!_enabled) return;
    if (!_audioCtx) initAudioContext();

    if (_cache.has(trackId)) {
      applyGain(audioEl, trackId);
      return;
    }

    // Play at unity while analyzing in background
    const node = getGainNode(audioEl);
    if (node) node.gain.setTargetAtTime(1.0, _audioCtx.currentTime, 0.05);

    const result = await analyzeLUFS(url, trackId);
    if (!result) return;

    // Verify the track is still playing on this element
    if (audioEl.src && audioEl.src === url) {
      applyGain(audioEl, trackId);
    }
  }

  async function preAnalyze(url, trackId) {
    if (!_enabled) return;
    if (_cache.has(trackId) || _inflight.has(trackId)) return;
    analyzeLUFS(url, trackId); // fire-and-forget
  }

  // ─── Configuration ───

  function setEnabled(val) {
    _enabled = !!val;
    if (!_enabled) {
      resetGain(audioA);
      resetGain(audioB);
    }
  }

  function setTarget(lufs) {
    _target = lufs;
  }

  function clearCache() {
    _cache.clear();
    _inflight.clear();
  }

  function destroy() {
    clearCache();
    if (_audioCtx) {
      _audioCtx.close().catch(() => {});
      _audioCtx = null;
    }
  }

  // ─── Public API ───
  return {
    initAudioContext,
    setEnabled,
    setTarget,
    isEnabled()            { return _enabled; },
    getTarget()            { return _target; },
    getCachedLUFS(trackId) { return _cache.get(trackId) || null; },
    analyzeAndApply,
    preAnalyze,
    applyGain,
    resetGain,
    clearCache,
    destroy
  };
};
