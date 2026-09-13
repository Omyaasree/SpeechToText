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
  // resume and playback just stops. Desktop-only workarounds below are
  // gated behind this so they can't break mobile in the process of fixing
  // a desktop-only bug.
  const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

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

  // Chunked (ultra-slow) playback state
  let mode = 'native'; // native | chunked
  let chunkIndex = 0;
  let chunkTimer = null;
  let pausedInGap = false;

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
  }

  // A SpeechSynthesisUtterance's rate is fixed the moment speak() is called;
  // changing utterance.rate afterward has no effect on browsers. The only
  // way to actually change speed mid-playback is to restart from exactly
  // where we are, at the new rate - which is also how a rate change can
  // cross the RATE_FLOOR boundary between native and chunked playback.
  function applyRateChangeIfPlaying() {
    if (state !== 'playing' || !words.length) return;
    let idx;
    if (mode === 'chunked') {
      idx = chunkIndex;
    } else {
      idx = words.findIndex(w => lastNativeOffset >= w.start && lastNativeOffset < w.end);
      if (idx < 0) idx = 0;
    }
    playFrom(idx);
  }

  function setRate(rate) {
    els.speedSlider.value = String(rateToSliderPos(rate));
    updateSpeedLabel();
  }

  els.speedSlider.addEventListener('input', updateSpeedLabel);
  els.speedSlider.addEventListener('change', applyRateChangeIfPlaying);
  els.speedPresets.forEach(btn => {
    btn.addEventListener('click', () => {
      setRate(parseFloat(btn.dataset.speed));
      applyRateChangeIfPlaying();
    });
  });
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

  function highlightWordAt(charIndex) {
    const idx = words.findIndex(w => charIndex >= w.start && charIndex < w.end);
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

  function onPlaybackEnd() {
    stopKeepAlive();
    setControlsState('idle');
    els.textInput.hidden = false;
    els.textDisplay.hidden = true;
    els.progressFill.style.width = '0%';
  }

  function playNativeFrom(offset) {
    mode = 'native';
    const token = playToken;
    const text = els.textInput.value;
    const utt = new SpeechSynthesisUtterance(text.slice(offset));
    utt.rate = currentRate();
    const v = selectedVoice();
    if (v) utt.voice = v;

    utt.onboundary = (e) => {
      if (token !== playToken) return;
      if (typeof e.charIndex === 'number') {
        lastNativeOffset = offset + e.charIndex;
        highlightWordAt(lastNativeOffset);
      }
    };
    utt.onend = () => { if (token === playToken) onPlaybackEnd(); };
    utt.onerror = () => { if (token === playToken) onPlaybackEnd(); };

    utterance = utt;
    speechSynthesis.speak(utt);
    startKeepAlive();
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

    const utt = new SpeechSynthesisUtterance(w.text);
    utt.rate = RATE_FLOOR;
    const v = selectedVoice();
    if (v) utt.voice = v;

    const startedAt = performance.now();
    utt.onend = () => {
      if (token !== playToken) return;
      const spokenMs = performance.now() - startedAt;
      const gapMultiplier = Math.max(0, RATE_FLOOR / currentRate() - 1);
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

    els.textInput.hidden = true;
    els.textDisplay.hidden = false;
    setControlsState('playing');

    const startOffset = words[idx].start;
    const useChunked = currentRate() < RATE_FLOOR - 1e-9;

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
      clearTimeout(chunkTimer);
      chunkTimer = null;
      pausedInGap = true;
    } else if (mode === 'native' && IS_MOBILE) {
      // speechSynthesis.resume() is unreliable on mobile after pause() -
      // it frequently just never resumes. Instead of a true pause, stop
      // outright and remember exactly where we were; resuming restarts a
      // fresh utterance from that position (see resumeSpeech below).
      playToken += 1;
      stopKeepAlive();
      speechSynthesis.cancel();
    } else {
      pausedInGap = false;
      speechSynthesis.pause();
    }
    setControlsState('paused');
  }

  function resumeSpeech() {
    if (mode === 'chunked' && pausedInGap) {
      pausedInGap = false;
      playNextChunk();
    } else if (mode === 'native' && IS_MOBILE) {
      playNativeFrom(lastNativeOffset);
    } else {
      speechSynthesis.resume();
    }
    setControlsState('playing');
  }

  function stopSpeech() {
    playToken += 1;
    stopKeepAlive();
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
