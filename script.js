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
    if (mode === 'native' && utterance) utterance.rate = rate;
    els.speedPresets.forEach(btn => {
      btn.classList.toggle('active', Math.abs(parseFloat(btn.dataset.speed) - rate) < 0.005);
    });
  }

  function setRate(rate) {
    els.speedSlider.value = String(rateToSliderPos(rate));
    updateSpeedLabel();
  }

  els.speedSlider.addEventListener('input', updateSpeedLabel);
  els.speedPresets.forEach(btn => {
    btn.addEventListener('click', () => setRate(parseFloat(btn.dataset.speed)));
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
    // Chrome silently stops long utterances after ~15s of continuous speech;
    // a periodic pause/resume avoids that. Only relevant in native mode,
    // since chunked mode never speaks a single utterance that long.
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
      if (typeof e.charIndex === 'number') highlightWordAt(offset + e.charIndex);
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
    playToken += 1;
    speechSynthesis.cancel();
    if (chunkTimer) {
      clearTimeout(chunkTimer);
      chunkTimer = null;
    }

    if (!words.length) {
      words = tokenize(els.textInput.value);
      renderWordSpans();
    }
    if (!words[idx]) return;

    els.textInput.hidden = true;
    els.textDisplay.hidden = false;

    if (currentRate() >= RATE_FLOOR - 1e-9) {
      playNativeFrom(words[idx].start);
    } else {
      playChunkedFrom(idx);
    }
    setControlsState('playing');
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
