(() => {
  const els = {
    textInput: document.getElementById('text-input'),
    textDisplay: document.getElementById('text-display'),
    fileInput: document.getElementById('file-input'),
    uploadBtn: document.getElementById('upload-btn'),
    clearBtn: document.getElementById('clear-btn'),
    charCount: document.getElementById('char-count'),
    wordCount: document.getElementById('word-count'),
    speedSlider: document.getElementById('speed-slider'),
    speedValue: document.getElementById('speed-value'),
    speedPresets: document.querySelectorAll('.speed-preset'),
    modeOptions: document.querySelectorAll('.mode-option'),
    modeHint: document.getElementById('mode-hint'),
    voiceSelect: document.getElementById('voice-select'),
    playBtn: document.getElementById('play-btn'),
    pauseBtn: document.getElementById('pause-btn'),
    stopBtn: document.getElementById('stop-btn'),
    progressFill: document.getElementById('progress-fill'),
    unsupportedBanner: document.getElementById('unsupported-banner'),
    year: document.getElementById('year'),
  };

  els.year.textContent = new Date().getFullYear();

  const supported = 'speechSynthesis' in window;
  if (!supported) {
    els.unsupportedBanner.hidden = false;
    [els.playBtn, els.pauseBtn, els.stopBtn, els.speedSlider, ...els.speedPresets].forEach(el => el.disabled = true);
    return;
  }

  // The Web Speech API clamps utterance.rate to a minimum of 0.1: values
  // below that are silently floored by the engine and have no effect.
  // To go slower than that, words below RATE_FLOOR are spoken one at a
  // time at RATE_FLOOR with artificial silence inserted between them.
  const RATE_FLOOR = 0.1;
  const RATE_MIN = 0.02;
  const RATE_MAX = 2;

  // Mobile browsers (Android Chrome, iOS Safari) handle speechSynthesis
  // pause()/resume() unreliably - resume() frequently fails to actually
  // resume and playback just stops. They also frequently never fire the
  // 'boundary' event at all (iOS Safari essentially never does), which is
  // the only thing that drives word highlighting and position tracking in
  // a single continuous "sentences" utterance. See startPositionEstimator
  // below for how sentences mode still tracks position on those browsers.
  const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // Average speaking rate at utterance.rate = 1, used only as a fallback
  // position estimate when real 'boundary' events aren't arriving (see
  // startPositionEstimator). ~150 wpm at ~6 characters per word (incl. the
  // trailing space) is a commonly cited baseline; utterance.rate is defined
  // as a multiplier on that baseline, so we scale this by rate directly.
  const NATIVE_CHARS_PER_SEC_AT_1X = 15;

  function sliderPosToRate(pos) {
    const t = Math.min(1, Math.max(0, pos / 100));
    return RATE_MIN * Math.pow(RATE_MAX / RATE_MIN, t);
  }

  function rateToSliderPos(rate) {
    const clamped = Math.min(RATE_MAX, Math.max(RATE_MIN, rate));
    return (Math.log(clamped / RATE_MIN) / Math.log(RATE_MAX / RATE_MIN)) * 100;
  }

  let words = [];
  let voices = [];
  let state = 'idle'; // idle | playing | paused
  let utterance = null;
  let keepAliveTimer = null;
  let lastNativeOffset = 0;
  let readMode = 'sentences'; // sentences | words

  // Chunked (word-by-word) playback state
  let mode = 'native'; // native | chunked
  let chunkIndex = 0;
  let chunkTimer = null;
  let pausedInGap = false;

  // Fallback position estimate for "sentences" mode on browsers that don't
  // fire real 'boundary' events (see startPositionEstimator).
  let estimateTimer = null;
  let estimateAnchorOffset = 0;
  let estimateAnchorTime = 0;
  let estimateRate = 1;
  let lastBoundaryAt = 0;

  // Incremented on every fresh start/seek/stop so that async callbacks
  // (onend/onerror) from an utterance that was just canceled, which fire
  // after the next utterance has already started, can recognize they are
  // stale and avoid clobbering the state of the playback that replaced them.
  let playToken = 0;

  function currentRate() {
    return sliderPosToRate(parseFloat(els.speedSlider.value));
  }

  function tokenize(text) {
    const result = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      result.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    }
    return result;
  }

  function updateCounts() {
    const text = els.textInput.value;
    const trimmed = text.trim();
    const wordsArr = trimmed.length ? trimmed.split(/\s+/) : [];
    els.charCount.textContent = `${text.length} character${text.length === 1 ? '' : 's'}`;
    els.wordCount.textContent = `${wordsArr.length} word${wordsArr.length === 1 ? '' : 's'}`;
  }

  els.textInput.addEventListener('input', updateCounts);
  updateCounts();

  els.uploadBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    els.textInput.value = text;
    updateCounts();
    els.fileInput.value = '';
  });

  els.clearBtn.addEventListener('click', () => {
    stopSpeech();
    els.textInput.value = '';
    updateCounts();
  });

  function populateVoices() {
    voices = speechSynthesis.getVoices();
    const previousValue = els.voiceSelect.value;
    els.voiceSelect.innerHTML = '';

    if (voices.length === 0) {
      const opt = document.createElement('option');
      opt.textContent = 'System default';
      els.voiceSelect.appendChild(opt);
      return;
    }

    voices.forEach((v, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${v.name} (${v.lang})`;
      els.voiceSelect.appendChild(opt);
    });

    if (previousValue && voices[previousValue]) {
      els.voiceSelect.value = previousValue;
    } else {
      const defaultIndex = voices.findIndex(v => v.default);
      els.voiceSelect.value = String(defaultIndex >= 0 ? defaultIndex : 0);
    }
  }

  function selectedVoice() {
    return voices[Number(els.voiceSelect.value)] || null;
  }

  populateVoices();
  if ('onvoiceschanged' in speechSynthesis) {
    speechSynthesis.onvoiceschanged = populateVoices;
  }

  function updateSpeedLabel() {
    const rate = currentRate();
    els.speedValue.textContent = `${rate.toFixed(2)}x`;
    els.speedSlider.style.setProperty('--fill', `${els.speedSlider.value}%`);
    els.speedPresets.forEach(btn => {
      btn.classList.toggle('active', Math.abs(parseFloat(btn.dataset.speed) - rate) < 0.005);
    });

    // Below RATE_FLOOR, reading style has no effect - the engine physically
    // cannot speak that slowly except word-by-word with gaps - so the
    // toggle is disabled and the hint explains why, rather than silently
    // being ignored.
    const belowFloor = rate < RATE_FLOOR - 1e-9;
    els.modeOptions.forEach(btn => { btn.disabled = belowFloor; });
    els.modeHint.textContent = belowFloor
      ? 'Below 0.1x, playback always reads word by word with pauses between them, regardless of this setting.'
      : 'Sentences reads with natural flow. Words reads one word at a time, useful for close, deliberate listening.';
  }

  // A SpeechSynthesisUtterance's rate is fixed the moment speak() is called,
  // and its engine (native full-text vs. word-by-word) is chosen when that
  // utterance starts - neither can change on one already in flight. So a
  // change to the speed OR the reading style, while already playing,
  // restarts from exactly the current word under the new setting.
  function restartFromCurrentPositionIfPlaying() {
    if (state !== 'playing' || !words.length) return;
    const idx = mode === 'chunked' ? chunkIndex : Math.max(0, wordIndexAt(lastNativeOffset));
    playFrom(idx);
  }

  function setRate(rate) {
    els.speedSlider.value = String(rateToSliderPos(rate));
    updateSpeedLabel();
  }

  els.speedSlider.addEventListener('input', updateSpeedLabel);
  els.speedSlider.addEventListener('change', restartFromCurrentPositionIfPlaying);
  els.speedPresets.forEach(btn => {
    btn.addEventListener('click', () => {
      setRate(parseFloat(btn.dataset.speed));
      restartFromCurrentPositionIfPlaying();
    });
  });

  function setReadMode(newMode) {
    readMode = newMode;
    els.modeOptions.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === newMode);
    });
  }

  els.modeOptions.forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      setReadMode(btn.dataset.mode);
      restartFromCurrentPositionIfPlaying();
    });
  });

  setReadMode('sentences');
  setRate(0.3);

  function renderWordSpans() {
    els.textDisplay.innerHTML = '';
    words.forEach((w, i) => {
      const span = document.createElement('span');
      span.className = 'word';
      span.textContent = w.text;
      span.dataset.index = String(i);
      els.textDisplay.appendChild(span);
      els.textDisplay.appendChild(document.createTextNode(' '));
    });
  }

  els.textDisplay.addEventListener('click', (e) => {
    const span = e.target.closest('.word');
    if (!span) return;
    const idx = Number(span.dataset.index);
    if (Number.isNaN(idx) || !words[idx]) return;
    playFrom(idx);
  });

  // The last word that has started by charIndex, not an exact-bounds match:
  // charIndex sits in inter-word whitespace half the time (always true for
  // the estimated position in sentences mode, which advances continuously
  // rather than landing exactly on word starts), and a strict match would
  // fail to resolve to any word at all during such a gap.
  function wordIndexAt(charIndex) {
    let idx = -1;
    for (let i = 0; i < words.length; i++) {
      if (words[i].start <= charIndex) idx = i;
      else break;
    }
    return idx;
  }

  function highlightWordAt(charIndex) {
    const idx = wordIndexAt(charIndex);
    const spans = els.textDisplay.querySelectorAll('.word');
    spans.forEach(s => s.classList.remove('active'));
    if (idx >= 0 && spans[idx]) {
      spans[idx].classList.add('active');
      spans[idx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    const total = els.textInput.value.length || 1;
    const pct = Math.min(100, (charIndex / total) * 100);
    els.progressFill.style.width = `${pct}%`;
  }

  function setControlsState(newState) {
    state = newState;
    els.playBtn.disabled = state === 'playing';
    els.pauseBtn.disabled = state !== 'playing';
    els.stopBtn.disabled = state === 'idle';
    els.playBtn.innerHTML = state === 'paused'
      ? '<svg class="icon" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9-5.5-9-5.5z"/></svg>Resume'
      : '<svg class="icon" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9-5.5-9-5.5z"/></svg>Play';
  }

  function startKeepAlive() {
    stopKeepAlive();
    // Chrome DESKTOP silently stops long utterances after ~15s of continuous
    // speech; a periodic pause/resume avoids that. Never run this on mobile:
    // Android Chrome and iOS Safari frequently fail to actually resume after
    // pause(), which kills playback entirely instead of keeping it alive.
    if (IS_MOBILE) return;
    keepAliveTimer = setInterval(() => {
      if (mode === 'native' && speechSynthesis.speaking && !speechSynthesis.paused) {
        speechSynthesis.pause();
        speechSynthesis.resume();
      }
    }, 10000);
  }

  function stopKeepAlive() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }

  // "Sentences" mode speaks one continuous utterance and relies on the
  // browser's 'boundary' event to know which word is currently being
  // spoken. Where that event fires reliably (desktop), it stays fully in
  // control and this estimator never actually changes anything. Where it
  // doesn't (most mobile browsers), this is the only thing that advances
  // the highlight and tracked position at all, extrapolated from elapsed
  // time and the standard meaning of utterance.rate as a speed multiplier.
  function startPositionEstimator(offset, rate) {
    stopPositionEstimator();
    estimateAnchorOffset = offset;
    estimateAnchorTime = performance.now();
    estimateRate = rate;
    estimateTimer = setInterval(() => {
      if (performance.now() - lastBoundaryAt < 400) return;
      const elapsedSec = (performance.now() - estimateAnchorTime) / 1000;
      const estOffset = estimateAnchorOffset + elapsedSec * NATIVE_CHARS_PER_SEC_AT_1X * estimateRate;
      lastNativeOffset = Math.min(estOffset, els.textInput.value.length);
      highlightWordAt(lastNativeOffset);
    }, 200);
  }

  function stopPositionEstimator() {
    if (estimateTimer) {
      clearInterval(estimateTimer);
      estimateTimer = null;
    }
  }

  function onPlaybackEnd() {
    stopKeepAlive();
    stopPositionEstimator();
    setControlsState('idle');
    els.textInput.hidden = false;
    els.textDisplay.hidden = true;
    els.progressFill.style.width = '0%';
  }

  function playNativeFrom(offset) {
    mode = 'native';
    const token = playToken;
    const text = els.textInput.value;
    const rate = currentRate();
    lastNativeOffset = offset;
    highlightWordAt(offset); // instant feedback on seek, rather than waiting
                              // up to one boundary event or estimator tick
    const utt = new SpeechSynthesisUtterance(text.slice(offset));
    utt.rate = rate;
    const v = selectedVoice();
    if (v) utt.voice = v;

    utt.onboundary = (e) => {
      if (token !== playToken) return;
      if (typeof e.charIndex === 'number') {
        lastBoundaryAt = performance.now();
        lastNativeOffset = offset + e.charIndex;
        highlightWordAt(lastNativeOffset);
        // Resync the estimator to this precise point so that if boundary
        // events stop arriving partway through a long utterance, the
        // fallback estimate continues from here rather than an
        // increasingly stale starting point.
        estimateAnchorOffset = lastNativeOffset;
        estimateAnchorTime = performance.now();
      }
    };
    utt.onend = () => { if (token === playToken) onPlaybackEnd(); };
    utt.onerror = () => { if (token === playToken) onPlaybackEnd(); };

    utterance = utt;
    speechSynthesis.speak(utt);
    startKeepAlive();
    startPositionEstimator(offset, rate);
  }

  function playChunkedFrom(idx) {
    mode = 'chunked';
    chunkIndex = idx;
    playNextChunk();
  }

  function playNextChunk() {
    const token = playToken;
    if (chunkIndex >= words.length) {
      onPlaybackEnd();
      return;
    }
    const w = words[chunkIndex];
    highlightWordAt(w.start);

    // Each word is spoken at the real selected rate when that's within the
    // engine's range; only below RATE_FLOOR do we speak at the engine's
    // floor and stretch the pace out with silence between words instead.
    const rate = currentRate();
    const utt = new SpeechSynthesisUtterance(w.text);
    utt.rate = Math.max(rate, RATE_FLOOR);
    const v = selectedVoice();
    if (v) utt.voice = v;

    const startedAt = performance.now();
    utt.onend = () => {
      if (token !== playToken) return;
      const spokenMs = performance.now() - startedAt;
      const gapMultiplier = Math.max(0, RATE_FLOOR / rate - 1);
      const gapMs = spokenMs * gapMultiplier;
      chunkIndex += 1;
      pausedInGap = false;
      chunkTimer = setTimeout(() => {
        chunkTimer = null;
        if (token === playToken && state === 'playing') playNextChunk();
      }, gapMs);
    };
    utt.onerror = () => {
      if (token !== playToken) return;
      chunkIndex += 1;
      playNextChunk();
    };

    utterance = utt;
    speechSynthesis.speak(utt);
  }

  function playFrom(idx) {
    if (!words.length) {
      words = tokenize(els.textInput.value);
      renderWordSpans();
    }
    if (!words[idx]) return;

    playToken += 1;
    const token = playToken;
    const wasActive = speechSynthesis.speaking || speechSynthesis.pending;

    speechSynthesis.cancel();
    if (chunkTimer) {
      clearTimeout(chunkTimer);
      chunkTimer = null;
    }
    stopPositionEstimator();

    els.textInput.hidden = true;
    els.textDisplay.hidden = false;
    setControlsState('playing');

    const startOffset = words[idx].start;
    const useChunked = readMode === 'words' || currentRate() < RATE_FLOOR - 1e-9;

    const begin = () => {
      if (token !== playToken) return;
      if (useChunked) {
        playChunkedFrom(idx);
      } else {
        playNativeFrom(startOffset);
      }
    };

    // On mobile, starting a new utterance in the same tick as cancel()ing
    // the previous one is unreliable - it can appear to start then die a
    // few words in, because the engine hasn't finished tearing the old one
    // down yet. A short delay avoids that. Skipped when nothing was
    // playing (a fresh Play press), so that still starts instantly.
    if (wasActive && IS_MOBILE) {
      setTimeout(begin, 150);
    } else {
      begin();
    }
  }

  function speak() {
    if (state === 'paused') {
      resumeSpeech();
      return;
    }
    const text = els.textInput.value;
    if (!text.trim()) return;
    words = tokenize(text);
    renderWordSpans();
    playFrom(0);
  }

  function pauseSpeech() {
    if (mode === 'chunked' && chunkTimer) {
      // Paused during the artificial gap between words: nothing is
      // speaking, just stop the scheduled next word.
      clearTimeout(chunkTimer);
      chunkTimer = null;
      pausedInGap = true;
    } else if (mode === 'chunked' && IS_MOBILE) {
      // Paused mid-word on mobile. speechSynthesis.pause()/resume() is
      // unreliable on mobile - resume() frequently just never resumes -
      // so cancel outright instead; resuming re-speaks this one short
      // word from its start, which is imperceptible.
      playToken += 1;
      speechSynthesis.cancel();
      pausedInGap = false;
    } else if (mode === 'native' && IS_MOBILE) {
      // speechSynthesis.resume() is unreliable on mobile after pause() -
      // it frequently just never resumes. Instead of a true pause, stop
      // outright and remember exactly where we were; resuming restarts a
      // fresh utterance from that position (see resumeSpeech below).
      playToken += 1;
      stopKeepAlive();
      stopPositionEstimator();
      speechSynthesis.cancel();
    } else {
      pausedInGap = false;
      stopPositionEstimator();
      speechSynthesis.pause();
    }
    setControlsState('paused');
  }

  function resumeSpeech() {
    if (mode === 'chunked' && pausedInGap) {
      pausedInGap = false;
      playNextChunk();
    } else if (mode === 'chunked' && IS_MOBILE) {
      playNextChunk();
    } else if (mode === 'native' && IS_MOBILE) {
      playNativeFrom(lastNativeOffset);
    } else if (mode === 'native') {
      speechSynthesis.resume();
      startPositionEstimator(lastNativeOffset, currentRate());
    } else {
      speechSynthesis.resume();
    }
    setControlsState('playing');
  }

  function stopSpeech() {
    playToken += 1;
    stopKeepAlive();
    stopPositionEstimator();
    if (chunkTimer) {
      clearTimeout(chunkTimer);
      chunkTimer = null;
    }
    speechSynthesis.cancel();
    els.textInput.hidden = false;
    els.textDisplay.hidden = true;
    els.progressFill.style.width = '0%';
    setControlsState('idle');
  }

  els.playBtn.addEventListener('click', speak);
  els.pauseBtn.addEventListener('click', pauseSpeech);
  els.stopBtn.addEventListener('click', stopSpeech);

  window.addEventListener('beforeunload', () => speechSynthesis.cancel());

  setControlsState('idle');
})();
