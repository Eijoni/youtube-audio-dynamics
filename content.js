(() => {
  'use strict';

  const TARGET_PEAK_DB = -0.1;
  const TARGET_PEAK_LINEAR = Math.pow(10, TARGET_PEAK_DB / 20); // 0.988553
  const NOISE_FLOOR_LINEAR = 0.005; // ~ -46 dBFS gate so silence doesn't drift threshold or boost hiss
  const MIN_NORM_GAIN = 0.25;       // -12 dB max attenuation
  const MAX_NORM_GAIN = 16.0;       // +24 dB max boost

  const PRESETS = {
    balanced: {
      threshold: -24,  // Used when Dynamic Threshold is OFF
      headroom: 4,     // Used when Dynamic Threshold is ON (dB above avg input RMS)
      relaxCrest: 11,  // Back off threshold if video crest factor is below 11 dB
      ratio: 4,
      knee: 12,
      attack: 0.010,   // 10 ms
      release: 0.250   // 250 ms
    },
    night: {
      threshold: -36,
      headroom: -2,
      relaxCrest: 7,
      ratio: 10,
      knee: 8,
      attack: 0.003,   // 3 ms
      release: 0.200   // 200 ms
    }
  };

  const DEFAULT_SETTINGS = {
    enabled: true,
    autoBypassMusic: true,
    dynamicThreshold: true,
    preset: 'balanced',
    custom: { ...PRESETS.balanced }
  };

  let settings = structuredClone(DEFAULT_SETTINGS);
  let currentMeta = { videoId: '', title: '', author: '', shortDescription: '', category: '' };
  let musicReason = null;      // null if not music, otherwise string reason
  let manualOverrideId = null; // lets you force-enable on a specific video ID
  let lastHref = location.href;

  // Web Audio state (shared graph across Watch and Shorts video elements)
  let activeVideo = null;
  let audioCtx = null;
  let nodes = null;
  let inAnalyserBuf = null;
  let normAnalyserBuf = null;
  const videoSources = new WeakMap();
  const boundVideos = new WeakSet();

  // Dynamic threshold trackers (pre-compressor input)
  let trackedInRms = 0.1;        // ~ -20 dBFS starting guess
  let trackedInPeak = 0.25;      // ~ -12 dBFS starting guess
  let trackedSpeechSec = 0;      // Fast convergence during first 2s of each video
  let currentDynThreshold = -16; // Live smoothed threshold in dB

  // Normalizer trackers (post-compressor output)
  let trackedNormPeak = 0.25;
  let currentNormGain = 1.0;

  let lastLoopTick = performance.now();
  let dspIntervalId = null;

  // UI refs
  let ui = null;
  let mountedMode = null; // 'watch' | 'shorts' | null

  // ---------- Helpers ----------
  function isShortsPage() {
    return location.pathname.startsWith('/shorts/');
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') node.className = v;
      else if (k === 'textContent') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else {
        node.setAttribute(k, v);
      }
    }
    for (const child of children) {
      if (child != null) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function svgEl(tag, attrs = {}, children = []) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    for (const child of children) node.appendChild(child);
    return node;
  }

  function getActiveParams() {
    if (settings.preset === 'balanced') return PRESETS.balanced;
    if (settings.preset === 'night') return PRESETS.night;
    return settings.custom;
  }

  function isEffectivelyActive() {
    if (!settings.enabled) return false;
    if (settings.autoBypassMusic && musicReason && manualOverrideId !== currentMeta.videoId) {
      return false;
    }
    return true;
  }

  function getVisualState() {
    if (!settings.enabled) return 'off';
    if (settings.autoBypassMusic && musicReason && manualOverrideId !== currentMeta.videoId) {
      return 'music-bypass';
    }
    return 'active';
  }

  function saveSettings() {
    try {
      chrome.storage.sync.set({ ytAudioDynamics: settings });
    } catch (_) {}
  }

  function loadSettings() {
    try {
      chrome.storage.sync.get('ytAudioDynamics', (res) => {
        if (res && res.ytAudioDynamics) {
          const saved = res.ytAudioDynamics;
          settings = {
            enabled: typeof saved.enabled === 'boolean' ? saved.enabled : DEFAULT_SETTINGS.enabled,
            autoBypassMusic: typeof saved.autoBypassMusic === 'boolean' ? saved.autoBypassMusic : DEFAULT_SETTINGS.autoBypassMusic,
            dynamicThreshold: typeof saved.dynamicThreshold === 'boolean' ? saved.dynamicThreshold : DEFAULT_SETTINGS.dynamicThreshold,
            preset: ['balanced', 'night', 'custom'].includes(saved.preset) ? saved.preset : 'balanced',
            custom: { ...PRESETS.balanced, ...(saved.custom || {}) }
          };
          applyAudioSettings();
          syncUI();
        }
      });
    } catch (_) {}
  }

  // ---------- Music / VEVO Detection ----------
  function detectMusicReason(meta) {
    const author = (meta.author || '').trim();
    const title = (meta.title || '').trim();
    const desc = meta.shortDescription || '';
    const category = (meta.category || '').trim();

    if (/ - Topic$/i.test(author) || desc.includes('Auto-generated by YouTube.') || desc.startsWith('Provided to YouTube by ')) {
      return 'YouTube Music';
    }
    if (/vevo/i.test(author)) {
      return 'VEVO';
    }
    if (/\b(official\s*(music\s*)?video|official\s*audio|official\s*lyric\s*video)\b/i.test(title)) {
      return 'Music Video';
    }
    if (category.toLowerCase() === 'music') {
      return 'Music Category';
    }
    return null;
  }

  // ---------- Web Audio DSP Chain ----------
  function createHardCeilingCurve(ceiling) {
    const samples = 65537; // odd count so center index hits 0.0 exactly
    const curve = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / (samples - 1) - 1;
      curve[i] = Math.max(-ceiling, Math.min(ceiling, x));
    }
    return curve;
  }

  function resumeCtx() {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
  }

  function ensureAudioGraph() {
    if (nodes && audioCtx) return;

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // Dry path (untouched bypass)
    const dryGain = audioCtx.createGain();

    // Wet path:
    // 1. Undo video.volume so input analyser, compressor & normalizer always work at full scale
    const preVolGain = audioCtx.createGain();

    // 2. Pre-compressor analyser for RMS + Crest Factor dynamic threshold
    const inAnalyser = audioCtx.createAnalyser();
    inAnalyser.fftSize = 2048;
    inAnalyserBuf = new Float32Array(inAnalyser.fftSize);

    // 3. Stage 1: Configurable Dynamics Compressor (no makeup gain control)
    const compressor = audioCtx.createDynamicsCompressor();

    // 4. Stage 2: Post-compressor peak analyser + adaptive normalizer gain
    const normAnalyser = audioCtx.createAnalyser();
    normAnalyser.fftSize = 2048;
    normAnalyserBuf = new Float32Array(normAnalyser.fftSize);

    const normGain = audioCtx.createGain();

    // 5. Brickwall safety limiter + strict -0.1 dBFS ceiling
    const safetyLimiter = audioCtx.createDynamicsCompressor();
    safetyLimiter.threshold.value = -0.5;
    safetyLimiter.knee.value = 0;
    safetyLimiter.ratio.value = 20;
    safetyLimiter.attack.value = 0.001;
    safetyLimiter.release.value = 0.05;

    const hardCeiling = audioCtx.createWaveShaper();
    hardCeiling.curve = createHardCeilingCurve(TARGET_PEAK_LINEAR);
    hardCeiling.oversample = 'none';

    // 6. Re-apply YouTube's native volume slider + wet crossfade
    const postVolGain = audioCtx.createGain();
    const wetGain = audioCtx.createGain();

    dryGain.connect(audioCtx.destination);

    preVolGain.connect(inAnalyser);
    inAnalyser.connect(compressor);
    compressor.connect(normAnalyser);
    normAnalyser.connect(normGain);
    normGain.connect(safetyLimiter);
    safetyLimiter.connect(hardCeiling);
    hardCeiling.connect(postVolGain);
    postVolGain.connect(wetGain);
    wetGain.connect(audioCtx.destination);

    nodes = {
      dryGain,
      preVolGain,
      inAnalyser,
      compressor,
      normAnalyser,
      normGain,
      safetyLimiter,
      hardCeiling,
      postVolGain,
      wetGain
    };

    document.addEventListener('pointerdown', resumeCtx, { passive: true });
    startDspLoop();
  }

  function hookVideo(video) {
    if (!video || video === activeVideo) return;
    ensureAudioGraph();

    // Detach previous video element from the shared DSP graph when switching Watch <-> Shorts
    if (activeVideo && videoSources.has(activeVideo)) {
      const prevSrc = videoSources.get(activeVideo);
      try {
        prevSrc.disconnect(nodes.dryGain);
        prevSrc.disconnect(nodes.preVolGain);
      } catch (_) {}
    }

    let source = videoSources.get(video);
    if (!source) {
      source = audioCtx.createMediaElementSource(video);
      videoSources.set(video, source);
    }

    source.connect(nodes.dryGain);
    source.connect(nodes.preVolGain);
    activeVideo = video;

    if (!boundVideos.has(video)) {
      boundVideos.add(video);

      video.addEventListener('play', () => {
        if (video !== activeVideo) return;
        resumeCtx();
        syncVolumeCompensation();
        window.dispatchEvent(new Event('yt-ac-request-meta'));
      });

      video.addEventListener('volumechange', () => {
        if (video === activeVideo) syncVolumeCompensation();
      });

      video.addEventListener('loadedmetadata', () => {
        if (video !== activeVideo) return;
        syncVolumeCompensation();
        window.dispatchEvent(new Event('yt-ac-request-meta'));
      });
    }

    resetDynamicsState();
    applyAudioSettings();
    syncVolumeCompensation();
  }

  function syncVolumeCompensation() {
    if (!nodes || !audioCtx || !activeVideo) return;
    const now = audioCtx.currentTime;
    const v = activeVideo.muted ? 0 : activeVideo.volume;

    if (v < 0.01) {
      nodes.preVolGain.gain.setTargetAtTime(1.0, now, 0.01);
      nodes.postVolGain.gain.setTargetAtTime(0.0, now, 0.01);
    } else {
      nodes.preVolGain.gain.setTargetAtTime(1.0 / v, now, 0.01);
      nodes.postVolGain.gain.setTargetAtTime(v, now, 0.01);
    }
  }

  function applyAudioSettings() {
    if (!nodes || !audioCtx) return;
    const now = audioCtx.currentTime;
    const p = getActiveParams();
    const active = isEffectivelyActive();

    const thr = settings.dynamicThreshold ? currentDynThreshold : p.threshold;
    nodes.compressor.threshold.setTargetAtTime(thr, now, 0.015);
    nodes.compressor.ratio.setTargetAtTime(p.ratio, now, 0.015);
    nodes.compressor.knee.setTargetAtTime(p.knee, now, 0.015);
    nodes.compressor.attack.setTargetAtTime(p.attack, now, 0.015);
    nodes.compressor.release.setTargetAtTime(p.release, now, 0.015);

    // Pop-free 30 ms dry/wet crossfade
    nodes.wetGain.gain.setTargetAtTime(active ? 1.0 : 0.0, now, 0.015);
    nodes.dryGain.gain.setTargetAtTime(active ? 0.0 : 1.0, now, 0.015);
  }

  function resetDynamicsState() {
    trackedInRms = 0.1;
    trackedInPeak = 0.25;
    trackedSpeechSec = 0;
    currentDynThreshold = -16;

    trackedNormPeak = 0.25;
    currentNormGain = 1.0;

    if (nodes && audioCtx) {
      const now = audioCtx.currentTime;
      nodes.normGain.gain.setTargetAtTime(1.0, now, 0.02);
      if (settings.dynamicThreshold) {
        nodes.compressor.threshold.setTargetAtTime(currentDynThreshold, now, 0.02);
      }
    }
  }

  function checkUrlChange() {
    if (location.href !== lastHref) {
      lastHref = location.href;
      tryAttach();
      window.dispatchEvent(new Event('yt-ac-request-meta'));
    }
  }

  function startDspLoop() {
    if (dspIntervalId) clearInterval(dspIntervalId);
    lastLoopTick = performance.now();

    dspIntervalId = setInterval(() => {
      checkUrlChange();

      const nowMs = performance.now();
      const dt = Math.min((nowMs - lastLoopTick) / 1000, 0.25);
      lastLoopTick = nowMs;

      if (!nodes || !audioCtx || !activeVideo) return;

      const active = isEffectivelyActive();
      const playing = !activeVideo.paused && !activeVideo.ended && !activeVideo.muted && activeVideo.volume >= 0.01;
      const p = getActiveParams();

      if (active && playing && audioCtx.state === 'running') {
        // ---- Stage 1A: Dynamic Threshold (Input RMS + Crest Factor) ----
        if (settings.dynamicThreshold) {
          nodes.inAnalyser.getFloatTimeDomainData(inAnalyserBuf);

          let sumSq = 0;
          let inBlockPeak = 0;
          for (let i = 0; i < inAnalyserBuf.length; i++) {
            const s = inAnalyserBuf[i];
            sumSq += s * s;
            const a = Math.abs(s);
            if (a > inBlockPeak) inBlockPeak = a;
          }
          const inBlockRms = Math.sqrt(sumSq / inAnalyserBuf.length);

          if (inBlockRms > NOISE_FLOOR_LINEAR) {
            trackedSpeechSec += dt;

            // Fast lock-on during first 2s of speech, steady 3.5s baseline afterward
            const rmsTc = trackedSpeechSec < 2.0 ? 0.35 : 3.5;
            const rmsAlpha = 1 - Math.exp(-dt / rmsTc);
            trackedInRms += (inBlockRms - trackedInRms) * rmsAlpha;

            if (inBlockPeak > trackedInPeak) {
              trackedInPeak = inBlockPeak;
            } else {
              const peakDecayTc = trackedSpeechSec < 2.0 ? 1.5 : 5.0;
              trackedInPeak = Math.max(inBlockPeak, trackedInPeak * Math.exp(-dt / peakDecayTc));
            }

            const inRmsDb = 20 * Math.log10(Math.max(trackedInRms, 0.0001));
            const inPeakDb = 20 * Math.log10(Math.max(trackedInPeak, 0.0001));
            const crestDb = Math.max(0, inPeakDb - inRmsDb);

            // Back off threshold on already-compressed videos with low crest factor
            const relaxTarget = typeof p.relaxCrest === 'number' ? p.relaxCrest : 10;
            const crestRelax = Math.min(8, Math.max(0, relaxTarget - crestDb));

            const targetThr = Math.max(-60, Math.min(0, inRmsDb + p.headroom + crestRelax));
            const thrTc = trackedSpeechSec < 2.0 ? 0.25 : 0.8;
            const thrAlpha = 1 - Math.exp(-dt / thrTc);
            currentDynThreshold += (targetThr - currentDynThreshold) * thrAlpha;

            nodes.compressor.threshold.setTargetAtTime(currentDynThreshold, audioCtx.currentTime, 0.03);
          }
        }

        // ---- Stage 2: Post-Compressor -0.1 dBFS Peak Normalizer ----
        nodes.normAnalyser.getFloatTimeDomainData(normAnalyserBuf);

        let blockPeak = 0;
        for (let i = 0; i < normAnalyserBuf.length; i++) {
          const a = Math.abs(normAnalyserBuf[i]);
          if (a > blockPeak) blockPeak = a;
        }

        if (blockPeak > NOISE_FLOOR_LINEAR) {
          if (blockPeak > trackedNormPeak) {
            trackedNormPeak = blockPeak;
          } else {
            trackedNormPeak = Math.max(blockPeak, trackedNormPeak * Math.exp(-dt / 4.0));
          }

          const desiredGain = Math.min(
            MAX_NORM_GAIN,
            Math.max(MIN_NORM_GAIN, TARGET_PEAK_LINEAR / Math.max(trackedNormPeak, 0.001))
          );

          const tc = desiredGain < currentNormGain ? 0.025 : 0.6;
          const alpha = 1 - Math.exp(-dt / tc);
          currentNormGain += (desiredGain - currentNormGain) * alpha;

          nodes.normGain.gain.setTargetAtTime(currentNormGain, audioCtx.currentTime, 0.015);
        }
      }

      // Live meter readout only while sub-menu is visible
      if (ui && ui.panel.classList.contains('open')) {
        const liveThr = settings.dynamicThreshold ? currentDynThreshold : p.threshold;
        const gr = active ? nodes.compressor.reduction : 0;
        const normDb = active ? 20 * Math.log10(Math.max(currentNormGain, 0.0001)) : 0;
        ui.meterThr.textContent = `Thr: ${liveThr.toFixed(0)} dB`;
        ui.meterGr.textContent = `GR: ${gr.toFixed(1)} dB`;
        ui.meterNorm.textContent = `Norm: ${normDb >= 0 ? '+' : ''}${normDb.toFixed(1)} dB`;
      }
    }, 30);
  }

  // ---------- Player UI Injection ----------
  function buildIconSvg() {
    return svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
      svgEl('g', { class: 'yt-ac-bars' }, [
        svgEl('rect', { x: '4', y: '10', width: '2.5', height: '8', rx: '1.2' }),
        svgEl('rect', { x: '8.5', y: '6', width: '2.5', height: '12', rx: '1.2' }),
        svgEl('rect', { x: '13', y: '8', width: '2.5', height: '10', rx: '1.2' }),
        svgEl('rect', { x: '17.5', y: '11', width: '2.5', height: '7', rx: '1.2' })
      ]),
      svgEl('circle', { class: 'yt-ac-dot', cx: '20', cy: '5', r: '2.5' })
    ]);
  }

  function makeSlider(label, min, max, step, formatFn, onInput) {
    let currentFormat = formatFn;
    const labelSpan = el('span', { textContent: label });
    const valSpan = el('span', { className: 'yt-ac-slider-val' });
    const input = el('input', {
      type: 'range',
      className: 'yt-ac-slider',
      min: String(min),
      max: String(max),
      step: String(step),
      onInput: (e) => {
        const num = parseFloat(e.target.value);
        valSpan.textContent = currentFormat(num);
        onInput(num);
      }
    });

    const row = el('div', { className: 'yt-ac-slider-row' }, [
      el('div', { className: 'yt-ac-slider-label' }, [labelSpan, valSpan]),
      input
    ]);

    return {
      row,
      reconfigure(cfg) {
        labelSpan.textContent = cfg.label;
        input.min = String(cfg.min);
        input.max = String(cfg.max);
        input.step = String(cfg.step);
        currentFormat = cfg.formatFn;
      },
      setValue(v) {
        input.value = String(v);
        valSpan.textContent = currentFormat(v);
      }
    };
  }

  function createUIOnce() {
    if (ui) return;

    const btn = el('button', {
      id: 'yt-ac-btn',
      type: 'button',
      className: 'ytp-button yt-ac-btn',
      title: 'Audio Dynamics (Compressor + -0.1 dB Normalizer)',
      'aria-label': 'Audio Dynamics',
      'data-state': getVisualState(),
      onClick: (e) => {
        e.stopPropagation();
        panel.classList.toggle('open');
        syncUI();
      }
    }, [buildIconSvg()]);

    // Prevent Shorts click-to-pause from firing when interacting with the button
    for (const evt of ['pointerdown', 'mousedown', 'mouseup', 'dblclick']) {
      btn.addEventListener(evt, (e) => e.stopPropagation());
    }

    const statusBar = el('div', { className: 'yt-ac-status' });

    const masterToggle = el('button', {
      type: 'button',
      className: 'yt-ac-toggle',
      role: 'switch',
      'aria-checked': 'true',
      onClick: () => {
        if (settings.enabled && settings.autoBypassMusic && musicReason && manualOverrideId !== currentMeta.videoId) {
          manualOverrideId = currentMeta.videoId;
        } else {
          settings.enabled = !settings.enabled;
          if (!settings.enabled) manualOverrideId = null;
          saveSettings();
        }
        applyAudioSettings();
        syncUI();
      }
    });

    const presetButtons = {};
    const presetsRow = el('div', { className: 'yt-ac-presets' }, [
      ['balanced', 'Balanced'],
      ['night', 'Night Mode'],
      ['custom', 'Custom']
    ].map(([key, label]) => {
      const b = el('button', {
        type: 'button',
        className: 'yt-ac-preset-btn',
        textContent: label,
        onClick: () => {
          settings.preset = key;
          saveSettings();
          applyAudioSettings();
          syncUI();
        }
      });
      presetButtons[key] = b;
      return b;
    }));

    const onCustomChange = (param, val) => {
      if (settings.preset !== 'custom') {
        settings.custom = { ...getActiveParams() };
        settings.preset = 'custom';
      }
      settings.custom[param] = val;
      saveSettings();
      applyAudioSettings();
      syncUI();
    };

    const sliders = {
      threshold: makeSlider(
        'Headroom (Auto)',
        -12,
        12,
        1,
        (v) => `${v >= 0 ? '+' : ''}${v} dB`,
        (v) => onCustomChange(settings.dynamicThreshold ? 'headroom' : 'threshold', v)
      ),
      ratio: makeSlider('Ratio', 1, 20, 0.5, (v) => `${v}:1`, (v) => onCustomChange('ratio', v)),
      knee: makeSlider('Knee', 0, 40, 1, (v) => `${v} dB`, (v) => onCustomChange('knee', v)),
      attack: makeSlider('Attack', 1, 200, 1, (v) => `${v} ms`, (v) => onCustomChange('attack', v / 1000)),
      release: makeSlider('Release', 10, 1000, 10, (v) => `${v} ms`, (v) => onCustomChange('release', v / 1000))
    };

    const dynamicThrCheckbox = el('input', {
      type: 'checkbox',
      onChange: (e) => {
        settings.dynamicThreshold = e.target.checked;
        saveSettings();
        applyAudioSettings();
        syncUI();
      }
    });

    const autoMusicCheckbox = el('input', {
      type: 'checkbox',
      onChange: (e) => {
        settings.autoBypassMusic = e.target.checked;
        manualOverrideId = null;
        saveSettings();
        applyAudioSettings();
        syncUI();
      }
    });

    const meterThr = el('span', { textContent: 'Thr: -16 dB' });
    const meterGr = el('span', { textContent: 'GR: 0.0 dB' });
    const meterNorm = el('span', { textContent: 'Norm: +0.0 dB' });

    const panel = el('div', {
      id: 'yt-ac-panel',
      className: 'yt-ac-panel'
    }, [
      el('div', { className: 'yt-ac-header' }, [
        el('span', { className: 'yt-ac-title', textContent: 'Audio Dynamics' }),
        masterToggle
      ]),
      statusBar,
      presetsRow,
      el('div', { className: 'yt-ac-sliders' }, [
        sliders.threshold.row,
        sliders.ratio.row,
        sliders.knee.row,
        sliders.attack.row,
        sliders.release.row
      ]),
      el('label', { className: 'yt-ac-option' }, [
        dynamicThrCheckbox,
        el('span', { textContent: 'Dynamic threshold (auto-fit)' })
      ]),
      el('label', { className: 'yt-ac-option', style: 'border-top:none;padding-top:5px;' }, [
        autoMusicCheckbox,
        el('span', { textContent: 'Auto-disable on Music / VEVO' })
      ]),
      el('div', { className: 'yt-ac-meter' }, [meterThr, meterGr, meterNorm])
    ]);

    // Prevent clicks, keys, and wheel scrolls inside the sub-menu from affecting YouTube or Shorts
    for (const evt of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup', 'wheel']) {
      panel.addEventListener(evt, (e) => e.stopPropagation());
    }

    ui = {
      btn,
      panel,
      statusBar,
      masterToggle,
      presetButtons,
      sliders,
      dynamicThrCheckbox,
      autoMusicCheckbox,
      meterThr,
      meterGr,
      meterNorm
    };
  }

  function mountUI() {
    const shorts = isShortsPage();

    if (shorts) {
      const shortsPlayer = document.getElementById('shorts-player');
      if (!shortsPlayer) return;
      createUIOnce();

      const needsMount =
        mountedMode !== 'shorts' ||
        !shortsPlayer.contains(ui.btn) ||
        !shortsPlayer.contains(ui.panel);

      if (needsMount) {
        const keepOpen = mountedMode === 'shorts' && ui.panel.classList.contains('open');
        ui.btn.className = 'yt-ac-btn yt-ac-btn-shorts';
        ui.panel.className = keepOpen
          ? 'yt-ac-panel yt-ac-panel-shorts open'
          : 'yt-ac-panel yt-ac-panel-shorts';
        shortsPlayer.appendChild(ui.btn);
        shortsPlayer.appendChild(ui.panel);
        mountedMode = 'shorts';
        syncUI();
      }
      return;
    }

    const player = document.getElementById('movie_player');
    const rightControls = player?.querySelector('.ytp-right-controls');
    if (!player || !rightControls) return;
    createUIOnce();

    const needsMount =
      mountedMode !== 'watch' ||
      !rightControls.contains(ui.btn) ||
      !player.contains(ui.panel);

    if (needsMount) {
      const keepOpen = mountedMode === 'watch' && ui.panel.classList.contains('open');
      ui.btn.className = 'ytp-button yt-ac-btn';
      ui.panel.className = keepOpen ? 'yt-ac-panel open' : 'yt-ac-panel';

      const settingsBtn = rightControls.querySelector('.ytp-settings-button');
      if (settingsBtn) settingsBtn.before(ui.btn);
      else rightControls.prepend(ui.btn);

      player.appendChild(ui.panel);
      mountedMode = 'watch';
      syncUI();
    }
  }

  function syncUI() {
    if (!ui) return;
    const state = getVisualState();
    const p = getActiveParams();

    ui.btn.setAttribute('data-state', state);
    ui.statusBar.setAttribute('data-state', state);
    ui.masterToggle.setAttribute('aria-checked', String(state === 'active'));

    if (state === 'active') {
      ui.statusBar.textContent = manualOverrideId === currentMeta.videoId && musicReason
        ? `Active (Override: ${musicReason})`
        : 'Active — Compressing & Normalizing';
      ui.btn.title = 'Audio Dynamics: ON';
    } else if (state === 'music-bypass') {
      ui.statusBar.textContent = `Auto-bypassed (${musicReason}) — Toggle to override`;
      ui.btn.title = `Audio Dynamics: Auto-bypassed (${musicReason})`;
    } else {
      ui.statusBar.textContent = 'Bypassed (Manual)';
      ui.btn.title = 'Audio Dynamics: OFF';
    }

    for (const [key, b] of Object.entries(ui.presetButtons)) {
      b.classList.toggle('selected', settings.preset === key);
    }

    if (settings.dynamicThreshold) {
      ui.sliders.threshold.reconfigure({
        label: 'Headroom (Auto)',
        min: -12,
        max: 12,
        step: 1,
        formatFn: (v) => `${v >= 0 ? '+' : ''}${v} dB`
      });
      ui.sliders.threshold.setValue(p.headroom);
    } else {
      ui.sliders.threshold.reconfigure({
        label: 'Threshold',
        min: -60,
        max: 0,
        step: 1,
        formatFn: (v) => `${v} dB`
      });
      ui.sliders.threshold.setValue(p.threshold);
    }

    ui.sliders.ratio.setValue(p.ratio);
    ui.sliders.knee.setValue(p.knee);
    ui.sliders.attack.setValue(Math.round(p.attack * 1000));
    ui.sliders.release.setValue(Math.round(p.release * 1000));
    ui.dynamicThrCheckbox.checked = settings.dynamicThreshold;
    ui.autoMusicCheckbox.checked = settings.autoBypassMusic;
  }

  // Close panel when clicking outside or pressing Escape
  document.addEventListener('click', (e) => {
    if (ui && ui.panel.classList.contains('open') && !ui.panel.contains(e.target) && !ui.btn.contains(e.target)) {
      ui.panel.classList.remove('open');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui && ui.panel.classList.contains('open')) {
      ui.panel.classList.remove('open');
    }
  });

  // ---------- Metadata & SPA Lifecycle ----------
  window.addEventListener('yt-ac-meta', (e) => {
    const nextMeta = e.detail || {};
    const changedVideo = Boolean(nextMeta.videoId && nextMeta.videoId !== currentMeta.videoId);
    currentMeta = nextMeta;
    musicReason = nextMeta.pending ? null : detectMusicReason(currentMeta);

    if (changedVideo) {
      manualOverrideId = null;
      resetDynamicsState();
    }

    applyAudioSettings();
    syncUI();
  });

  function getTargetVideo() {
    if (isShortsPage()) {
      return (
        document.querySelector('#shorts-player video.html5-main-video') ||
        document.querySelector('ytd-reel-video-renderer[is-active] video')
      );
    }
    return document.querySelector('#movie_player video.html5-main-video');
  }

  function tryAttach() {
    const video = getTargetVideo();
    if (video) hookVideo(video);
    mountUI();
  }

  const observer = new MutationObserver(() => {
    checkUrlChange();
    tryAttach();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('yt-navigate-finish', () => {
    lastHref = location.href;
    tryAttach();
    window.dispatchEvent(new Event('yt-ac-request-meta'));
  });

  window.addEventListener('yt-page-data-updated', () => {
    tryAttach();
    window.dispatchEvent(new Event('yt-ac-request-meta'));
  });

  loadSettings();
  tryAttach();
  window.dispatchEvent(new Event('yt-ac-request-meta'));
})();