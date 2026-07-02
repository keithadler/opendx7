// OpenDX7 — FM Synthesizer (MIT License)
// Copyright (c) 2026 Keith Adler
import { createDefaultPatch, generateFactoryPatches, parseSyxBank } from './dx7-patch.js';
import { drawAlgorithm } from './algo-display.js';
import { drawEnvelope, drawPitchEnvelope } from './env-display.js';
import { initKnobs, setKnobValue } from './knob.js';
import { MidiPlayer } from './midi-player.js';

// Export a single patch as a minimal SysEx file (single voice dump)
function exportPatchAsSyx(patch) {
  // Pack as a 32-voice bank with the patch in slot 1, rest as INIT
  const data = new Uint8Array(4104);
  // SysEx header: F0 43 00 09 20 00
  data[0] = 0xF0; data[1] = 0x43; data[2] = 0x00; data[3] = 0x09;
  data[4] = 0x20; data[5] = 0x00;

  // Pack the patch into slot 0 (128 bytes)
  packVoice(data, 6, patch);

  // Fill remaining 31 slots with INIT voice
  const init = createDefaultPatch();
  for (let v = 1; v < 32; v++) packVoice(data, 6 + v * 128, init);

  // Checksum
  let sum = 0;
  for (let i = 6; i < 4102; i++) sum += data[i];
  data[4102] = (-sum) & 0x7F;
  data[4103] = 0xF7;
  return data;
}

function packVoice(data, offset, patch) {
  for (let opIdx = 0; opIdx < 6; opIdx++) {
    // ops[] is in msfa/Dexed order (ops[0] = OP6), which is also the packed
    // SysEx order (OP6 first), so opIdx maps straight through.
    const op = patch.ops[opIdx];
    const o = offset + opIdx * 17;
    data[o+0] = op.egRate1 & 0x7F;
    data[o+1] = op.egRate2 & 0x7F;
    data[o+2] = op.egRate3 & 0x7F;
    data[o+3] = op.egRate4 & 0x7F;
    data[o+4] = op.egLevel1 & 0x7F;
    data[o+5] = op.egLevel2 & 0x7F;
    data[o+6] = op.egLevel3 & 0x7F;
    data[o+7] = op.egLevel4 & 0x7F;
    data[o+8] = (op.kbdLevelScaleBP || 0) & 0x7F;
    data[o+9] = (op.kbdLevelScaleLD || 0) & 0x7F;
    data[o+10] = (op.kbdLevelScaleRD || 0) & 0x7F;
    data[o+11] = ((op.kbdLevelScaleLC || 0) & 0x03) | (((op.kbdLevelScaleRC || 0) & 0x03) << 2);
    data[o+12] = ((op.kbdRateScaling || 0) & 0x07) | (((op.detune || 7) & 0x0F) << 3);
    data[o+13] = ((op.ampModSens || 0) & 0x03) | (((op.velSensitivity || 0) & 0x07) << 2);
    data[o+14] = op.outputLevel & 0x7F;
    data[o+15] = ((op.oscMode || 0) & 0x01) | (((op.freqCoarse || 1) & 0x1F) << 1);
    data[o+16] = (op.freqFine || 0) & 0x7F;
  }
  const g = offset + 102;
  data[g+0] = (patch.pitchEgR1 || 99) & 0x7F;
  data[g+1] = (patch.pitchEgR2 || 99) & 0x7F;
  data[g+2] = (patch.pitchEgR3 || 99) & 0x7F;
  data[g+3] = (patch.pitchEgR4 || 99) & 0x7F;
  data[g+4] = (patch.pitchEgL1 || 50) & 0x7F;
  data[g+5] = (patch.pitchEgL2 || 50) & 0x7F;
  data[g+6] = (patch.pitchEgL3 || 50) & 0x7F;
  data[g+7] = (patch.pitchEgL4 || 50) & 0x7F;
  data[g+8] = (patch.algorithm || 0) & 0x1F;
  data[g+9] = ((patch.feedback || 0) & 0x07) | ((patch.oscSync ? 1 : 0) << 3);
  data[g+10] = (patch.lfoSpeed || 0) & 0x7F;
  data[g+11] = (patch.lfoDelay || 0) & 0x7F;
  data[g+12] = (patch.lfoPitchModDepth || 0) & 0x7F;
  data[g+13] = (patch.lfoAmpModDepth || 0) & 0x7F;
  data[g+14] = ((patch.lfoSync ? 1 : 0) & 0x01) | (((patch.lfoWave || 0) & 0x07) << 1) | (((patch.pitchModSens || 0) & 0x07) << 4);
  data[g+15] = (patch.transpose || 24) & 0x7F;
  const name = (patch.name || 'INIT VOICE').padEnd(10).substring(0, 10);
  for (let i = 0; i < 10; i++) data[g+16+i] = name.charCodeAt(i) & 0x7F;
}

// State
let audioCtx, dx7Node, analyser, analyserData;
let dryGain, reverbNode, reverbGain, delayNode, delayFbNode, delayGain;
let currentOpIndex = 0;
let audioReady = false;

// Patches loaded at module level — always available
let patches = generateFactoryPatches();
let currentPatch = null; // No sound until user selects one

const fxState = { reverbMix:30, reverbDecay:28, delayMix:20, delayTime:340, delayFeedback:35 };

// ============================================================
// Audio — single init, called on every note, idempotent
// ============================================================
async function ensureAudio() {
  if (audioReady) return;
  if (audioCtx) {
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    if (dx7Node) { audioReady = true; return; }
  }

  audioCtx = new AudioContext();
  await audioCtx.resume();
  await audioCtx.audioWorklet.addModule('js/dx7-processor.js');
  dx7Node = new AudioWorkletNode(audioCtx, 'dx7-processor', { outputChannelCount: [2] });

  // ── Audio routing ──
  // Clean signal path: dx7Node → dryGain → masterBus → limiter → analyser → destination
  // Effects are send-style off dx7Node, merging at masterBus.
  // A DynamicsCompressor at the end prevents any clipping from effects.
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyserData = new Float32Array(analyser.fftSize);

  // Master bus: everything merges here before the limiter
  const masterBus = audioCtx.createGain();
  masterBus.gain.value = 1.0;

  // Safety limiter — prevents effects from causing clipping
  const limiter = audioCtx.createDynamicsCompressor();
  limiter.threshold.value = -1;   // engage just below 0 dBFS
  limiter.knee.value = 0;         // hard knee
  limiter.ratio.value = 20;       // brick-wall limiting
  limiter.attack.value = 0.001;   // fast attack
  limiter.release.value = 0.05;   // quick release

  masterBus.connect(limiter);
  limiter.connect(analyser);
  analyser.connect(audioCtx.destination);

  // Dry path
  dryGain = audioCtx.createGain();
  dryGain.gain.value = 1.0;
  dx7Node.connect(dryGain);
  dryGain.connect(masterBus);

  // Reverb (send from dx7Node, isolated from dry path)
  try {
    reverbNode = audioCtx.createConvolver();
    reverbGain = audioCtx.createGain();
    reverbGain.gain.value = fxState.reverbMix / 100;
    reverbNode.buffer = createReverbIR(fxState.reverbDecay / 10);
    dx7Node.connect(reverbNode);
    reverbNode.connect(reverbGain);
    reverbGain.connect(masterBus);
  } catch(e) { console.warn('Reverb:', e); }

  // Delay (send from dx7Node, isolated from dry path)
  try {
    delayNode = audioCtx.createDelay(2.0);
    delayNode.delayTime.value = fxState.delayTime / 1000;
    delayFbNode = audioCtx.createGain();
    // Clamp feedback to prevent runaway — never exceed 0.85
    delayFbNode.gain.value = Math.min(0.85, fxState.delayFeedback / 100);
    delayGain = audioCtx.createGain();
    delayGain.gain.value = fxState.delayMix / 100;
    const lpf = audioCtx.createBiquadFilter();
    lpf.type = 'lowpass'; lpf.frequency.value = 4000;
    dx7Node.connect(delayNode);
    delayNode.connect(lpf);
    lpf.connect(delayGain);
    delayGain.connect(masterBus);
    lpf.connect(delayFbNode);
    delayFbNode.connect(delayNode);
  } catch(e) { console.warn('Delay:', e); }

  // Send patch immediately
  dx7Node.port.postMessage({ type: 'patch', patch: currentPatch });
  audioReady = true;
  startViz();
}

function createReverbIR(decay) {
  const sr = audioCtx.sampleRate, len = sr * Math.max(0.5, decay);
  const buf = audioCtx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random()*2-1) * Math.pow(1-i/len, decay*1.2);
  }
  return buf;
}

function sendPatch() {
  if (dx7Node && currentPatch) dx7Node.port.postMessage({ type: 'patch', patch: currentPatch });
}

function noteOn(n, v = 100) {
  if (!currentPatch) return;
  activeNotes.add(n);
  recordNoteOn(n);
  updateChordDisplay();
  if (!dx7Node) {
    ensureAudio().then(() => {
      dx7Node.port.postMessage({ type: 'patch', patch: currentPatch });
      dx7Node.port.postMessage({ type: 'noteOn', note: n, velocity: v });
    });
    return;
  }
  dx7Node.port.postMessage({ type: 'patch', patch: currentPatch });
  dx7Node.port.postMessage({ type: 'noteOn', note: n, velocity: v });
}

function noteOff(n) {
  activeNotes.delete(n);
  updateChordDisplay();
  if (!dx7Node) return;
  dx7Node.port.postMessage({ type: 'noteOff', note: n });
}

function updateFx(p, v) {
  fxState[p] = v;
  if (!audioCtx) return;
  if (p === 'reverbMix' && reverbGain) reverbGain.gain.value = v / 100;
  else if (p === 'reverbDecay' && reverbNode) reverbNode.buffer = createReverbIR(v / 10);
  else if (p === 'delayMix' && delayGain) delayGain.gain.value = v / 100;
  else if (p === 'delayTime' && delayNode) delayNode.delayTime.value = v / 1000;
  else if (p === 'delayFeedback' && delayFbNode) delayFbNode.gain.value = Math.min(0.85, v / 100);
}

// ============================================================
// Visualizer
// ============================================================
let vizOn = false;

function drawGrid(ctx, w, h, label) {
  ctx.fillStyle = '#080c14'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#1a2030'; ctx.lineWidth = 0.5;
  for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(0, h*i/4); ctx.lineTo(w, h*i/4); ctx.stroke(); }
  for (let i = 1; i < 8; i++) { ctx.beginPath(); ctx.moveTo(w*i/8, 0); ctx.lineTo(w*i/8, h); ctx.stroke(); }
  ctx.strokeStyle = '#1a3050'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, h/2); ctx.lineTo(w, h/2); ctx.stroke();
  ctx.fillStyle = '#2a4060'; ctx.font = '9px monospace'; ctx.textAlign = 'left';
  ctx.fillText(label, 4, 11);
}

function startViz() {
  if (vizOn) return; vizOn = true;
  const wC = document.getElementById('waveform-canvas');
  if (!wC) return;
  const wX = wC.getContext('2d');

  // Create voice dots
  const dotsEl = document.getElementById('voice-dots');
  if (dotsEl) {
    dotsEl.innerHTML = '';
    for (let i = 0; i < 16; i++) {
      const d = document.createElement('div');
      d.className = 'voice-dot';
      d.id = `vdot-${i}`;
      dotsEl.appendChild(d);
    }
  }

  (function draw() {
    requestAnimationFrame(draw);
    if (!analyser) return;
    const ww = wC.width, wh = wC.height;
    analyser.getFloatTimeDomainData(analyserData);

    // Waveform
    drawGrid(wX, ww, wh, 'WAVEFORM');
    wX.strokeStyle = '#4af'; wX.lineWidth = 1.5;
    wX.beginPath();
    // Auto-scale waveform to fill the canvas
    let wPeak = 0;
    for (let i = 0; i < analyserData.length; i++) wPeak = Math.max(wPeak, Math.abs(analyserData[i]));
    const wScale = wPeak > 0.001 ? 0.9 / wPeak : 1; // fill 90% of height

    const wStep = Math.max(1, Math.floor(analyserData.length / ww));
    for (let i = 0; i < ww; i++) {
      const y = (analyserData[i * wStep] * wScale * -0.5 + 0.5) * wh;
      i === 0 ? wX.moveTo(0, y) : wX.lineTo(i, y);
    }
    wX.stroke();

    // Peak and RMS
    let pk = 0, rmsSum = 0;
    for (let i = 0; i < analyserData.length; i++) {
      const a = Math.abs(analyserData[i]);
      pk = Math.max(pk, a);
      rmsSum += analyserData[i] * analyserData[i];
    }
    const rmsVal = Math.sqrt(rmsSum / analyserData.length);
    const pkDb = pk > 0.0001 ? 20 * Math.log10(pk) : -Infinity;
    const rmsDb = rmsVal > 0.0001 ? 20 * Math.log10(rmsVal) : -Infinity;

    const pkFill = document.getElementById('peak-fill');
    const rmsFill = document.getElementById('rms-fill');
    const pkDbEl = document.getElementById('peak-db');
    const rmsDbEl = document.getElementById('rms-db');
    if (pkFill) pkFill.style.width = Math.min(100, pk * 120) + '%';
    if (rmsFill) rmsFill.style.width = Math.min(100, rmsVal * 200) + '%';
    if (pkDbEl) pkDbEl.textContent = isFinite(pkDb) ? pkDb.toFixed(1) + ' dB' : '-∞ dB';
    if (rmsDbEl) rmsDbEl.textContent = isFinite(rmsDb) ? rmsDb.toFixed(1) + ' dB' : '-∞ dB';

    // Update voice dots from activeNotes
    const noteCount = activeNotes.size;
    for (let i = 0; i < 16; i++) {
      const dot = document.getElementById(`vdot-${i}`);
      if (dot) dot.classList.toggle('active', i < noteCount);
    }
  })();
}

// ============================================================
// Patches
// ============================================================
function loadPatch(i) {
  clearAllKeys();
  if (dx7Node) {
    dx7Node.port.postMessage({ type: 'panic' });
    // Reset performance controls
    dx7Node.port.postMessage({ type: 'pitchBend', value: 8192 });
    dx7Node.port.postMessage({ type: 'modWheel', value: 0 });
    dx7Node.port.postMessage({ type: 'aftertouch', value: 0 });
    dx7Node.port.postMessage({ type: 'sustain', value: false });
  }
  // Kill effects tails
  if (audioCtx && dryGain) {
    dryGain.gain.setValueAtTime(0, audioCtx.currentTime);
    if (reverbGain) reverbGain.gain.setValueAtTime(0, audioCtx.currentTime);
    if (delayGain) delayGain.gain.setValueAtTime(0, audioCtx.currentTime);
    if (delayFbNode) delayFbNode.gain.setValueAtTime(0, audioCtx.currentTime);
    setTimeout(() => {
      if (dryGain) dryGain.gain.setValueAtTime(1.0, audioCtx.currentTime);
      if (reverbGain) reverbGain.gain.setValueAtTime(fxState.reverbMix / 100, audioCtx.currentTime);
      if (delayGain) delayGain.gain.setValueAtTime(fxState.delayMix / 100, audioCtx.currentTime);
      if (delayFbNode) delayFbNode.gain.setValueAtTime(Math.min(0.85, fxState.delayFeedback / 100), audioCtx.currentTime);
    }, 50);
  }
  // Reset operator mutes
  document.querySelectorAll('.op-tab').forEach(t => t.classList.remove('muted'));
  // Reset pitch bend wheel visual
  const pbThumb = document.getElementById('pitch-bend-thumb');
  if (pbThumb) { pbThumb.style.bottom = 'calc(50% - 9px)'; pbThumb.style.transform = 'none'; }
  // Reset mod wheel visual
  const mwThumb = document.getElementById('mod-wheel-thumb');
  if (mwThumb) mwThumb.style.bottom = '0';
  // Reset operator index to 0
  currentOpIndex = 0;
  currentPatch = JSON.parse(JSON.stringify(patches[i]));
  sendPatch();
  updateUI();
}

function updatePatchSelect() {
  const s = document.getElementById('patch-select');
  if (!s) return;
  s.innerHTML = '';
  // Placeholder
  const ph = document.createElement('option');
  ph.value = '-1';
  ph.textContent = '-- Select a sound --';
  ph.disabled = true;
  ph.selected = currentPatch === null;
  s.appendChild(ph);
  patches.forEach((p, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = `${String(i + 1).padStart(2, '0')} ${p.name}`;
    s.appendChild(o);
  });
}

// ============================================================
// UI
// ============================================================
function updateUI() {
  if (!currentPatch) return;
  const algoEl = document.getElementById('algo-num');
  if (algoEl) algoEl.textContent = currentPatch.algorithm + 1;
  const algoCanvas = document.getElementById('algo-canvas');
  if (algoCanvas) drawAlgorithm(algoCanvas, currentPatch.algorithm);
  const fbEl = document.getElementById('feedback');
  if (fbEl) setKnobValue(fbEl, currentPatch.feedback);
  // Voice name
  const nameEl = document.getElementById('voice-name');
  if (nameEl) nameEl.value = currentPatch.name || '';
  syncOpKnobs();
  syncGlobalKnobs();
  syncFxKnobs();
  updateEnv();
  updatePitchEnv();
}

function syncOpKnobs() {
  if (!currentPatch) return;
  const op = currentPatch.ops[currentOpIndex];
  document.querySelectorAll('.op-tab').forEach((t, i) => t.classList.toggle('active', i === currentOpIndex));
  document.querySelectorAll('.op-knob').forEach(k => {
    const p = k.getAttribute('data-param');
    if (op[p] !== undefined) setKnobValue(k, op[p]);
  });
  syncOscModeUI();
}

function syncOscModeUI() {
  if (!currentPatch) return;
  const op = currentPatch.ops[currentOpIndex];
  const btn = document.getElementById('osc-mode-btn');
  const label = document.getElementById('freq-coarse-label');
  if (btn) {
    btn.textContent = op.oscMode === 0 ? 'RATIO' : 'FIXED';
    btn.classList.toggle('active', op.oscMode === 1);
  }
  if (label) label.textContent = op.oscMode === 0 ? 'Ratio' : 'Freq';
}

function syncGlobalKnobs() {
  if (!currentPatch) return;
  document.querySelectorAll('.global-knob').forEach(k => {
    const p = k.getAttribute('data-param');
    if (currentPatch[p] !== undefined) setKnobValue(k, currentPatch[p]);
  });
  document.querySelectorAll('.global-sel').forEach(s => {
    const p = s.getAttribute('data-param');
    if (currentPatch[p] !== undefined) s.value = currentPatch[p];
  });
  const syncBtn = document.getElementById('lfo-sync-btn');
  if (syncBtn) syncBtn.classList.toggle('active', !!currentPatch.lfoSync);
}

function syncFxKnobs() {
  // FX now uses presets, no individual knobs to sync
}

function updateEnv() {
  if (!currentPatch) return;
  const op = currentPatch.ops[currentOpIndex];
  const c = document.getElementById('env-canvas');
  if (c) drawEnvelope(c, op.egRate1, op.egRate2, op.egRate3, op.egRate4,
    op.egLevel1, op.egLevel2, op.egLevel3, op.egLevel4);
}

function updatePitchEnv() {
  if (!currentPatch) return;
  const c = document.getElementById('pitch-env-canvas');
  if (c) drawPitchEnvelope(c, currentPatch.pitchEgR1, currentPatch.pitchEgR2,
    currentPatch.pitchEgR3, currentPatch.pitchEgR4, currentPatch.pitchEgL1,
    currentPatch.pitchEgL2, currentPatch.pitchEgL3, currentPatch.pitchEgL4);
}

// ============================================================
// MIDI
// ============================================================
async function initMIDI() {
  try {
    const ma = await navigator.requestMIDIAccess();
    const bind = () => { for (const inp of ma.inputs.values()) inp.onmidimessage = onMIDI; };
    bind();
    ma.onstatechange = bind;
  } catch(e) { /* no MIDI */ }
}

async function onMIDI(msg) {
  const [st, d1, d2] = msg.data;
  const cmd = st & 0xF0;
  const kbd = document.getElementById('keyboard');
  if (cmd === 0x90 && d2 > 0) {
    if (!currentPatch) return;
    await ensureAudio();
    noteOn(d1, d2);
    if (kbd && kbd.setNote) kbd.setNote(1, d1);
  } else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) {
    noteOff(d1);
    if (kbd && kbd.setNote) kbd.setNote(0, d1);
  } else if (cmd === 0xB0 && dx7Node) {
    if (d1 === 64) dx7Node.port.postMessage({ type: 'sustain', value: d2 >= 64 });
    else if (d1 === 1) {
      dx7Node.port.postMessage({ type: 'modWheel', value: d2 });
      // Update on-screen mod wheel
      const mwThumb = document.getElementById('mod-wheel-thumb');
      if (mwThumb) mwThumb.style.bottom = (d2 / 127 * 100) + '%';
    }
  } else if (cmd === 0xE0 && dx7Node) {
    const val = d1 | (d2 << 7);
    dx7Node.port.postMessage({ type: 'pitchBend', value: val });
    // Update on-screen pitch bend
    const pbThumb = document.getElementById('pitch-bend-thumb');
    if (pbThumb) {
      pbThumb.style.bottom = `calc(${(val / 16383) * 100}% - 9px)`;
      pbThumb.style.transform = 'none';
    }
  } else if (cmd === 0xD0 && dx7Node) {
    dx7Node.port.postMessage({ type: 'aftertouch', value: d1 });
  }
}

// ============================================================
// Chord & Key Detection
// ============================================================
const NOTE_NAMES = ['C','D♭','D','E♭','E','F','G♭','G','A♭','A','B♭','B'];
const activeNotes = new Set();
const recentChords = [];
let lastNoteTime = 0;
let idleTimer = null;
const IDLE_CLEAR_SEC = 8;

// Rolling history of every note played (MIDI note + timestamp)
const noteHistory = [];
const KEY_HISTORY_SEC = 30; // look back 30 seconds

const CHORD_TYPES = [
  { name:'',     intervals:[0,4,7],    w:1.0 },
  { name:'m',    intervals:[0,3,7],    w:1.0 },
  { name:'7',    intervals:[0,4,7,10], w:0.95 },
  { name:'m7',   intervals:[0,3,7,10], w:0.95 },
  { name:'maj7', intervals:[0,4,7,11], w:0.95 },
  { name:'dim',  intervals:[0,3,6],    w:0.9 },
  { name:'aug',  intervals:[0,4,8],    w:0.9 },
  { name:'sus4', intervals:[0,5,7],    w:0.85 },
  { name:'sus2', intervals:[0,2,7],    w:0.85 },
  { name:'6',    intervals:[0,4,7,9],  w:0.9 },
  { name:'m6',   intervals:[0,3,7,9],  w:0.9 },
  { name:'9',    intervals:[0,4,7,10,14], w:0.85 },
  { name:'add9', intervals:[0,4,7,14], w:0.85 },
  { name:'dim7', intervals:[0,3,6,9],  w:0.9 },
  { name:'m7♭5', intervals:[0,3,6,10], w:0.9 },
  { name:'5',    intervals:[0,7],      w:0.7 },
];

// Krumhansl-Kessler key profiles
const MAJOR_PROFILE = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const MINOR_PROFILE = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];

function recordNoteOn(midiNote) {
  noteHistory.push({ pc: midiNote % 12, note: midiNote, time: Date.now() });
  const cutoff = Date.now() - KEY_HISTORY_SEC * 1000;
  while (noteHistory.length > 0 && noteHistory[0].time < cutoff) noteHistory.shift();

  // Reset idle timer
  lastNoteTime = Date.now();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(clearHarmonyState, IDLE_CLEAR_SEC * 1000);
}

function clearHarmonyState() {
  recentChords.length = 0;
  noteHistory.length = 0;
  currentKey = null;
  keyConfidence = 0;
  keySwitchCounter = 0;
  pendingKey = null;
  const keyEl = document.getElementById('key-value');
  const chordEl = document.getElementById('chord-display');
  if (keyEl) keyEl.textContent = '—';
  if (chordEl) chordEl.textContent = '—';
}

function detectChord(notes) {
  if (notes.length < 2) return null;
  const sorted = [...notes].sort((a, b) => a - b);
  const bass = sorted[0] % 12;
  const pcs = [...new Set(sorted.map(n => n % 12))].sort((a, b) => a - b);
  if (pcs.length < 2) return null;

  let bestMatch = null, bestScore = -1;

  // Try each pitch class as root, but prefer the bass note
  for (const root of pcs) {
    const intervals = pcs.map(p => (p - root + 12) % 12).sort((a, b) => a - b);
    for (const ct of CHORD_TYPES) {
      let matched = 0;
      for (const iv of ct.intervals) {
        if (intervals.includes(iv % 12)) matched++;
      }
      const coverage = matched / ct.intervals.length;
      const extras = pcs.length - matched;
      let score = coverage * ct.w - extras * 0.15;
      // Bonus if root is the bass note (strong voicing indicator)
      if (root === bass) score += 0.15;
      // Bonus for more complete chords
      if (matched === ct.intervals.length) score += 0.1;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = { root: NOTE_NAMES[root], type: ct.name, score };
      }
    }
  }
  return bestMatch && bestMatch.score > 0.45 ? bestMatch : null;
}

function pearsonCorrelation(x, y) {
  const n = x.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i]; sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i]; sumY2 += y[i] * y[i];
  }
  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  return den === 0 ? 0 : num / den;
}

// Key detection state — hysteresis prevents flipping on passing chords
let currentKey = null;
let keyConfidence = 0;
let keySwitchCounter = 0;
let pendingKey = null;
const KEY_SWITCH_THRESHOLD = 3;
const KEY_HYSTERESIS = 0.06;

function detectKey() {
  if (noteHistory.length < 3) return currentKey;

  const now = Date.now();
  const pcHist = new Float64Array(12);

  for (const entry of noteHistory) {
    const age = (now - entry.time) / 1000;
    const weight = Math.exp(-age / 15);
    pcHist[entry.pc] += weight;
    if (entry.note < 60) pcHist[entry.pc] += weight * 0.5;
  }

  for (const n of activeNotes) {
    pcHist[n % 12] += 2.0;
  }

  if (pcHist.every(v => v === 0)) return currentKey;

  // Score all 24 keys
  const scores = [];
  for (let root = 0; root < 12; root++) {
    const rotated = new Float64Array(12);
    for (let i = 0; i < 12; i++) rotated[i] = pcHist[(root + i) % 12];
    scores.push({ name: NOTE_NAMES[root] + ' major', corr: pearsonCorrelation(rotated, MAJOR_PROFILE) });
    scores.push({ name: NOTE_NAMES[root] + ' minor', corr: pearsonCorrelation(rotated, MINOR_PROFILE) });
  }
  scores.sort((a, b) => b.corr - a.corr);

  const best = scores[0];
  if (best.corr < 0.3) return currentKey;

  // No key yet — accept immediately
  if (!currentKey) {
    currentKey = best.name;
    keyConfidence = 0.5;
    return currentKey;
  }

  // Re-evaluate current key's correlation against the CURRENT histogram
  const currentCorr = scores.find(s => s.name === currentKey)?.corr ?? 0;

  // Same key still winning — reinforce
  if (best.name === currentKey) {
    keyConfidence = Math.min(1.0, keyConfidence + 0.05);
    keySwitchCounter = 0;
    pendingKey = null;
    return currentKey;
  }

  // Different key winning — needs to beat current by margin
  const margin = best.corr - currentCorr;
  if (margin > KEY_HYSTERESIS) {
    if (best.name === pendingKey) {
      keySwitchCounter++;
    } else {
      pendingKey = best.name;
      keySwitchCounter = 1;
    }
    if (keySwitchCounter >= KEY_SWITCH_THRESHOLD) {
      currentKey = best.name;
      keyConfidence = 0.4;
      keySwitchCounter = 0;
      pendingKey = null;
    }
  } else {
    keySwitchCounter = Math.max(0, keySwitchCounter - 1);
    if (keySwitchCounter === 0) pendingKey = null;
  }

  return currentKey;
}

// ── Next chord suggestions based on common progressions ──
function suggestNextChords(keyName, currentChord) {
  if (!keyName || !currentChord) return [];

  const parts = keyName.split(' ');
  const keyRoot = parts[0];
  const isMinor = parts[1] === 'minor';
  const rootIdx = NOTE_NAMES.indexOf(keyRoot);
  if (rootIdx < 0) return [];

  // Scale degrees for major and minor keys (semitone offsets)
  // Major: I ii iii IV V vi vii°
  // Minor: i ii° III iv v VI VII
  const majorDegrees = [0, 2, 4, 5, 7, 9, 11];
  const minorDegrees = [0, 2, 3, 5, 7, 8, 10];
  const majorQualities = ['', 'm', 'm', '', '', 'm', 'dim'];
  const minorQualities = ['m', 'dim', '', 'm', 'm', '', ''];

  const degrees = isMinor ? minorDegrees : majorDegrees;
  const qualities = isMinor ? minorQualities : majorQualities;

  // Build diatonic chords for this key
  const diatonic = degrees.map((d, i) => ({
    name: NOTE_NAMES[(rootIdx + d) % 12] + qualities[i],
    degree: i // 0-based scale degree
  }));

  // Common chord progressions (by scale degree, 0-based)
  // Maps current degree → likely next degrees (ordered by probability)
  const majorTransitions = {
    0: [3, 4, 5],   // I → IV, V, vi
    1: [4, 3, 0],   // ii → V, IV, I
    2: [5, 3, 1],   // iii → vi, IV, ii
    3: [4, 0, 1],   // IV → V, I, ii
    4: [0, 5, 3],   // V → I, vi, IV
    5: [3, 1, 4],   // vi → IV, ii, V
    6: [0, 5, 3],   // vii° → I, vi, IV
  };
  const minorTransitions = {
    0: [3, 4, 6],   // i → iv, v, VII
    1: [4, 0, 6],   // ii° → v, i, VII
    2: [5, 3, 0],   // III → VI, iv, i
    3: [4, 0, 6],   // iv → v, i, VII
    4: [0, 5, 3],   // v → i, VI, iv
    5: [3, 6, 4],   // VI → iv, VII, v
    6: [0, 5, 3],   // VII → i, VI, iv
  };

  const transitions = isMinor ? minorTransitions : majorTransitions;

  // Find current chord's scale degree
  if (!currentChord) return diatonic.slice(0, 3).map(c => c.name);

  const chordStr = currentChord.root + currentChord.type;
  let currentDegree = -1;
  for (let i = 0; i < diatonic.length; i++) {
    if (diatonic[i].name === chordStr) { currentDegree = i; break; }
  }

  // If current chord isn't diatonic, suggest tonic, IV, V
  if (currentDegree < 0) {
    return [diatonic[0].name, diatonic[3].name, diatonic[4].name];
  }

  const nextDegrees = transitions[currentDegree] || [0, 3, 4];
  return nextDegrees.map(d => diatonic[d].name);
}

function updateChordDisplay() {
  const notes = [...activeNotes].sort((a, b) => a - b);
  const chordEl = document.getElementById('chord-display');
  const notesEl = document.getElementById('chord-notes');
  const keyEl = document.getElementById('key-value');
  const recentEl = document.getElementById('recent-chords');

  if (notes.length === 0) {
    if (chordEl) chordEl.textContent = '—';
    if (notesEl) notesEl.innerHTML = '&nbsp;';
    const key = detectKey();
    if (keyEl && key) keyEl.textContent = key;
    return;
  }

  // Show note names with octave
  const noteNames = notes.map(n => NOTE_NAMES[n % 12] + Math.floor(n / 12 - 1));
  if (notesEl) notesEl.textContent = noteNames.join(' · ');

  // Detect chord or show note
  const chord = detectChord(notes);
  if (chord) {
    const chordStr = chord.root + chord.type;
    if (chordEl) chordEl.textContent = chordStr;
    if (recentChords.length === 0 || recentChords[recentChords.length - 1].str !== chordStr) {
      recentChords.push({ root: chord.root, type: chord.type, str: chordStr });
      if (recentChords.length > 16) recentChords.shift();
    }
  } else if (notes.length === 1) {
    const noteName = noteNames[0];
    if (chordEl) chordEl.textContent = noteName;
    // Add single notes to recent too
    if (recentChords.length === 0 || recentChords[recentChords.length - 1].str !== noteName) {
      recentChords.push({ root: NOTE_NAMES[notes[0] % 12], type: '', str: noteName });
      if (recentChords.length > 16) recentChords.shift();
    }
  } else {
    const label = noteNames.map(n => n.replace(/\d+/, '')).join('/');
    if (chordEl) chordEl.textContent = label;
  }

  // Update key detection
  const key = detectKey();
  if (keyEl) keyEl.textContent = key || '—';

  // Suggest next chords based on key and current chord
  const suggestions = suggestNextChords(key, chord);
  const nextEl = document.getElementById('next-chords');
  if (nextEl && suggestions.length > 0) {
    const colors = ['#4f4', '#ee4', '#f64'];
    nextEl.innerHTML = suggestions.map((s, i) =>
      `<span class="next-chord" style="color:${colors[i]}">${s}</span>`
    ).join('');
  }

  // Update recent display
  if (recentEl) {
    recentEl.innerHTML = recentChords.slice(-8).map(c =>
      `<span class="recent-chord">${c.str}</span>`
    ).join('');
  }
}

// ============================================================
// Pitch Bend & Mod Wheel (on-screen)
// ============================================================
function setupWheels() {
  const pbTrack = document.getElementById('pitch-bend-track');
  const pbThumb = document.getElementById('pitch-bend-thumb');
  const mwTrack = document.getElementById('mod-wheel-track');
  const mwThumb = document.getElementById('mod-wheel-thumb');

  if (!pbTrack || !mwTrack) return;

  let pbDragging = false, mwDragging = false;

  function setPitchBend(normVal) {
    // normVal: 0 = bottom (max down), 1 = top (max up), 0.5 = center
    const clamped = Math.max(0, Math.min(1, normVal));
    const pct = clamped * 100;
    if (pbThumb) {
      pbThumb.style.bottom = `calc(${pct}% - 9px)`;
      pbThumb.style.transform = 'none';
    }
    // Convert to 14-bit MIDI value: 0=max down, 8192=center, 16383=max up
    const midiVal = Math.round(clamped * 16383);
    if (dx7Node) dx7Node.port.postMessage({ type: 'pitchBend', value: midiVal });
  }

  function setModWheel(normVal) {
    // normVal: 0 = bottom (off), 1 = top (max)
    const clamped = Math.max(0, Math.min(1, normVal));
    if (mwThumb) mwThumb.style.bottom = (clamped * 100) + '%';
    const midiVal = Math.round(clamped * 127);
    if (dx7Node) dx7Node.port.postMessage({ type: 'modWheel', value: midiVal });
  }

  function trackY(track, clientY) {
    const rect = track.getBoundingClientRect();
    return 1 - (clientY - rect.top) / rect.height;
  }

  // Pitch bend — snaps to center on release
  pbTrack.addEventListener('pointerdown', (e) => {
    pbDragging = true;
    pbTrack.setPointerCapture(e.pointerId);
    setPitchBend(trackY(pbTrack, e.clientY));
  });
  pbTrack.addEventListener('pointermove', (e) => {
    if (pbDragging) setPitchBend(trackY(pbTrack, e.clientY));
  });
  pbTrack.addEventListener('pointerup', () => {
    pbDragging = false;
    setPitchBend(0.5); // snap to center
  });
  pbTrack.addEventListener('pointercancel', () => {
    pbDragging = false;
    setPitchBend(0.5);
  });

  // Mod wheel — stays where you leave it
  mwTrack.addEventListener('pointerdown', (e) => {
    mwDragging = true;
    mwTrack.setPointerCapture(e.pointerId);
    setModWheel(trackY(mwTrack, e.clientY));
  });
  mwTrack.addEventListener('pointermove', (e) => {
    if (mwDragging) setModWheel(trackY(mwTrack, e.clientY));
  });
  mwTrack.addEventListener('pointerup', () => { mwDragging = false; });
  mwTrack.addEventListener('pointercancel', () => { mwDragging = false; });

  // Initialize pitch bend centered
  setPitchBend(0.5);
}

// ============================================================
// Computer keyboard
// ============================================================
const KEY_MAP = {
  'a':60,'w':61,'s':62,'e':63,'d':64,'f':65,'t':66,'g':67,
  'y':68,'h':69,'u':70,'j':71,'k':72,'o':73,'l':74,'p':75,
  ';':76,"'":77,'z':48,'x':50,'c':52,'v':53,'b':55,'n':57,'m':59
};
const heldKeys = new Set();

document.addEventListener('keydown', async (e) => {
  if (e.repeat || ['SELECT','INPUT','TEXTAREA'].includes(e.target.tagName)) return;
  const n = KEY_MAP[e.key.toLowerCase()];
  if (n !== undefined && !heldKeys.has(e.key.toLowerCase())) {
    if (!currentPatch) return; // No sound selected — ignore
    await ensureAudio();
    heldKeys.add(e.key.toLowerCase());
    noteOn(n);
    const kbd = document.getElementById('keyboard');
    if (kbd && kbd.setNote) kbd.setNote(1, n);
  }
});

document.addEventListener('keyup', (e) => {
  const n = KEY_MAP[e.key.toLowerCase()];
  if (n !== undefined) {
    heldKeys.delete(e.key.toLowerCase());
    noteOff(n);
    const kbd = document.getElementById('keyboard');
    if (kbd && kbd.setNote) kbd.setNote(0, n);
  }
});

// ============================================================
// Event wiring
// ============================================================
function clearAllKeys() {
  heldKeys.clear();
  activeNotes.clear();
  updateChordDisplay();
  const kbd = document.getElementById('keyboard');
  if (kbd && kbd.setNote) {
    for (let n = 36; n <= 96; n++) kbd.setNote(0, n);
  }
}

function setup() {
  document.getElementById('patch-select')?.addEventListener('change', async (e) => {
    clearAllKeys();
    await ensureAudio(); loadPatch(parseInt(e.target.value));
  });
  document.getElementById('patch-prev')?.addEventListener('click', async () => {
    const sel = document.getElementById('patch-select');
    if (!sel) return;
    const cur = parseInt(sel.value);
    const next = cur <= 0 ? patches.length - 1 : cur - 1;
    sel.value = next;
    clearAllKeys(); await ensureAudio(); loadPatch(next);
  });
  document.getElementById('patch-next')?.addEventListener('click', async () => {
    const sel = document.getElementById('patch-select');
    if (!sel) return;
    const cur = parseInt(sel.value);
    const next = cur >= patches.length - 1 ? 0 : cur + 1;
    sel.value = next;
    clearAllKeys(); await ensureAudio(); loadPatch(next);
  });
  document.getElementById('load-syx-btn')?.addEventListener('click', () =>
    document.getElementById('syx-file')?.click());
  document.getElementById('syx-file')?.addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const loaded = parseSyxBank(new Uint8Array(await f.arrayBuffer()));
    if (loaded.length) {
      patches = loaded;
      updatePatchSelect();
      await ensureAudio();
      const sel = document.getElementById('patch-select');
      if (sel) sel.value = 0;
      loadPatch(0);
    }
  });
  // Demo MIDI player
  const midiPlayer = new MidiPlayer(
    (note, vel) => { noteOn(note, vel); const kbd = document.getElementById('keyboard'); if (kbd?.setNote) kbd.setNote(1, note); },
    (note) => { noteOff(note); const kbd = document.getElementById('keyboard'); if (kbd?.setNote) kbd.setNote(0, note); }
  );
  document.getElementById('demo-select')?.addEventListener('change', async function() {
    midiPlayer.stop();
    if (!this.value) return;
    // Select Crystal Keys (index 28) for demos
    const sel = document.getElementById('patch-select');
    if (sel) { sel.value = 28; }
    loadPatch(28);
    await ensureAudio();
    await midiPlayer.loadUrl(this.value);
    midiPlayer.play();
    this.value = '';
  });

  document.getElementById('panic-btn')?.addEventListener('click', () => {
    midiPlayer.stop();
    if (dx7Node) dx7Node.port.postMessage({ type: 'panic' });
    clearAllKeys();

    // Kill effects tails by momentarily muting everything
    if (dryGain) dryGain.gain.setValueAtTime(0, audioCtx.currentTime);
    if (reverbGain) reverbGain.gain.setValueAtTime(0, audioCtx.currentTime);
    if (delayGain) delayGain.gain.setValueAtTime(0, audioCtx.currentTime);
    if (delayFbNode) delayFbNode.gain.setValueAtTime(0, audioCtx.currentTime);

    // Restore after a brief silence to flush all buffers
    setTimeout(() => {
      if (dryGain) dryGain.gain.setValueAtTime(1.0, audioCtx.currentTime);
      if (reverbGain) reverbGain.gain.setValueAtTime(fxState.reverbMix / 100, audioCtx.currentTime);
      if (delayGain) delayGain.gain.setValueAtTime(fxState.delayMix / 100, audioCtx.currentTime);
      if (delayFbNode) delayFbNode.gain.setValueAtTime(Math.min(0.85, fxState.delayFeedback / 100), audioCtx.currentTime);
    }, 200);
  });

  document.getElementById('algo-dec')?.addEventListener('click', () => {
    currentPatch.algorithm = (currentPatch.algorithm - 1 + 32) % 32; sendPatch(); updateUI();
  });
  document.getElementById('algo-inc')?.addEventListener('click', () => {
    currentPatch.algorithm = (currentPatch.algorithm + 1) % 32; sendPatch(); updateUI();
  });
  document.getElementById('feedback')?.addEventListener('input', function () {
    currentPatch.feedback = parseInt(this.dataset.value); sendPatch();
  });

  // Operator mute state
  const opMuted = [false, false, false, false, false, false];

  document.querySelectorAll('.op-tab').forEach(t => {
    t.addEventListener('click', (e) => {
      const idx = parseInt(t.dataset.op);
      if (e.shiftKey) {
        // Shift+click = toggle mute
        opMuted[idx] = !opMuted[idx];
        t.classList.toggle('muted', opMuted[idx]);
        if (currentPatch) {
          // Store original level and set to 0 when muted
          if (opMuted[idx]) {
            currentPatch.ops[idx]._savedLevel = currentPatch.ops[idx].outputLevel;
            currentPatch.ops[idx].outputLevel = 0;
          } else {
            currentPatch.ops[idx].outputLevel = currentPatch.ops[idx]._savedLevel || 0;
          }
          sendPatch();
          if (idx === currentOpIndex) syncOpKnobs();
        }
      } else {
        currentOpIndex = idx;
        syncOpKnobs();
        updateEnv();
      }
    });
  });

  // Oscillator mode toggle (Ratio/Fixed)
  document.getElementById('osc-mode-btn')?.addEventListener('click', () => {
    if (!currentPatch) return;
    const op = currentPatch.ops[currentOpIndex];
    op.oscMode = op.oscMode === 0 ? 1 : 0;
    syncOscModeUI();
    sendPatch();
  });

  // Voice name editor
  document.getElementById('voice-name')?.addEventListener('input', function() {
    if (currentPatch) currentPatch.name = this.value.substring(0, 10);
  });

  // Poly/Mono toggle
  document.getElementById('poly-mode-btn')?.addEventListener('click', function() {
    this.textContent = this.textContent === 'POLY' ? 'MONO' : 'POLY';
    this.classList.toggle('active', this.textContent === 'MONO');
    // TODO: wire to processor when mono mode is implemented
  });

  // Save patch as .syx file
  document.getElementById('save-patch-btn')?.addEventListener('click', () => {
    if (!currentPatch) return;
    const syx = exportPatchAsSyx(currentPatch);
    const blob = new Blob([syx], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (currentPatch.name.trim() || 'patch') + '.syx';
    a.click();
    URL.revokeObjectURL(url);
  });
  document.querySelectorAll('.op-knob').forEach(k => {
    k.addEventListener('input', function () {
      currentPatch.ops[currentOpIndex][this.getAttribute('data-param')] = parseInt(this.dataset.value);
      if (this.getAttribute('data-param').startsWith('eg')) updateEnv();
      sendPatch();
    });
  });
  document.querySelectorAll('.global-knob').forEach(k => {
    k.addEventListener('input', function () {
      const p = this.getAttribute('data-param');
      currentPatch[p] = parseInt(this.dataset.value);
      if (p.startsWith('pitchEg')) updatePitchEnv();
      sendPatch();
    });
  });
  document.querySelectorAll('.global-sel').forEach(s => {
    s.addEventListener('change', function () {
      currentPatch[this.getAttribute('data-param')] = parseInt(this.value); sendPatch();
    });
  });

  // LFO Sync toggle
  document.getElementById('lfo-sync-btn')?.addEventListener('click', function() {
    if (!currentPatch) return;
    currentPatch.lfoSync = !currentPatch.lfoSync;
    this.classList.toggle('active', currentPatch.lfoSync);
    sendPatch();
  });

  // FX presets
  const FX_PRESETS = {
    'dry':          { reverbMix:0,  reverbDecay:10, delayMix:0,  delayTime:200, delayFeedback:0,  desc:'No effects. Pure DX7 output.' },
    'small-room':   { reverbMix:20, reverbDecay:12, delayMix:0,  delayTime:200, delayFeedback:0,  desc:'Tight, intimate room. Great for electric pianos.' },
    'studio':       { reverbMix:25, reverbDecay:22, delayMix:15, delayTime:340, delayFeedback:25, desc:'Balanced reverb + subtle delay. Good for everything.' },
    'concert-hall': { reverbMix:40, reverbDecay:45, delayMix:8,  delayTime:500, delayFeedback:20, desc:'Large hall with long tail. Beautiful for pads and strings.' },
    'cathedral':    { reverbMix:55, reverbDecay:70, delayMix:5,  delayTime:600, delayFeedback:15, desc:'Massive space with very long decay. Ethereal.' },
    'plate':        { reverbMix:35, reverbDecay:18, delayMix:0,  delayTime:200, delayFeedback:0,  desc:'Classic plate reverb. Bright and smooth.' },
    'slapback':     { reverbMix:10, reverbDecay:8,  delayMix:40, delayTime:80,  delayFeedback:10, desc:'Quick single echo. Rockabilly, vintage keys.' },
    'tape-delay':   { reverbMix:15, reverbDecay:15, delayMix:35, delayTime:375, delayFeedback:45, desc:'Warm repeating echoes like a tape machine.' },
    'ping-pong':    { reverbMix:10, reverbDecay:12, delayMix:30, delayTime:250, delayFeedback:55, desc:'Rhythmic bouncing echoes. Great for leads.' },
    'ambient':      { reverbMix:50, reverbDecay:55, delayMix:25, delayTime:500, delayFeedback:40, desc:'Lush wash of reverb and delay. Cinematic.' },
    '80s-shimmer':  { reverbMix:45, reverbDecay:40, delayMix:20, delayTime:440, delayFeedback:35, desc:'The iconic 80s sound. Big reverb, rhythmic delay.' },
    'spring':       { reverbMix:30, reverbDecay:10, delayMix:0,  delayTime:200, delayFeedback:0,  desc:'Short, bright spring reverb. Vintage vibe.' },
  };

  document.getElementById('fx-preset')?.addEventListener('change', function() {
    const preset = FX_PRESETS[this.value];
    if (!preset) return;
    for (const [k, v] of Object.entries(preset)) {
      if (k !== 'desc') updateFx(k, v);
    }
    const descEl = document.getElementById('fx-desc');
    if (descEl) descEl.textContent = preset.desc;
  });

  const kbd = document.getElementById('keyboard');
  if (kbd) {
    kbd.addEventListener('change', async (e) => {
      await ensureAudio();
      if (e.note) {
        const [state, note] = e.note;
        if (state) noteOn(note); else noteOff(note);
      }
    });
  }
}

// ============================================================
// Boot
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  updatePatchSelect();

  // Idle visualizer
  const wC = document.getElementById('waveform-canvas');
  if (wC) drawGrid(wC.getContext('2d'), wC.width, wC.height, 'WAVEFORM · select a sound');

  // Keyboard sizing
  function resizeKbd() {
    const kbd = document.getElementById('keyboard');
    const strip = document.querySelector('.perf-strip');
    if (kbd) {
      const stripW = strip ? strip.offsetWidth : 0;
      kbd.width = window.innerWidth - stripW;
      kbd.height = 200;
    }
  }
  const waitKbd = setInterval(() => {
    if (customElements.get('webaudio-keyboard')) { clearInterval(waitKbd); resizeKbd(); }
  }, 50);
  setTimeout(resizeKbd, 2000); // fallback
  window.addEventListener('resize', resizeKbd);

  setup();
  setupWheels();
  initKnobs();
  updateUI();

  initMIDI();
});
