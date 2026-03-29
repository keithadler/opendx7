import { createDefaultPatch, generateFactoryPatches, parseSyxBank } from './dx7-patch.js';
import { drawAlgorithm } from './algo-display.js';
import { drawEnvelope, drawPitchEnvelope } from './env-display.js';

let audioCtx = null;
let dx7Node = null;
let currentPatch = null;
let currentOpIndex = 0;
let patches = [];
let midiAccess = null;

// Effects nodes
let reverbNode = null;
let delayNode = null;
let delayFeedbackNode = null;
let dryGain = null;
let reverbGain = null;
let delayGain = null;
let analyser = null;
let analyserData = null;
let freqData = null;

// Effects state
const fxState = {
  reverbMix: 30,
  reverbDecay: 28,
  delayMix: 20,
  delayTime: 340,
  delayFeedback: 35,
};

// ============================================================
// Audio init with effects chain
// ============================================================
async function initAudio() {
  if (audioCtx) return;
  audioCtx = new AudioContext();
  await audioCtx.audioWorklet.addModule('js/dx7-processor.js');
  dx7Node = new AudioWorkletNode(audioCtx, 'dx7-processor');

  // Analyser for visualizer
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyserData = new Float32Array(analyser.fftSize);
  freqData = new Uint8Array(analyser.frequencyBinCount);

  // Dry path
  dryGain = audioCtx.createGain();
  dryGain.gain.value = 0.7;

  // Reverb (convolution)
  reverbNode = audioCtx.createConvolver();
  reverbGain = audioCtx.createGain();
  reverbGain.gain.value = fxState.reverbMix / 100;
  reverbNode.buffer = createReverbIR(fxState.reverbDecay / 10);

  // Delay
  delayNode = audioCtx.createDelay(2.0);
  delayNode.delayTime.value = fxState.delayTime / 1000;
  delayFeedbackNode = audioCtx.createGain();
  delayFeedbackNode.gain.value = fxState.delayFeedback / 100;
  delayGain = audioCtx.createGain();
  delayGain.gain.value = fxState.delayMix / 100;

  const delayFilter = audioCtx.createBiquadFilter();
  delayFilter.type = 'lowpass';
  delayFilter.frequency.value = 4000;

  // Routing:
  // dx7 → dry → analyser → dest
  // dx7 → reverb → reverbGain → analyser
  // dx7 → delay → filter → delayGain → analyser
  //                delay → feedback → delay (loop)
  dx7Node.connect(dryGain);
  dx7Node.connect(reverbNode);
  dx7Node.connect(delayNode);

  dryGain.connect(analyser);
  reverbNode.connect(reverbGain);
  reverbGain.connect(analyser);

  delayNode.connect(delayFilter);
  delayFilter.connect(delayGain);
  delayGain.connect(analyser);
  delayFilter.connect(delayFeedbackNode);
  delayFeedbackNode.connect(delayNode);

  analyser.connect(audioCtx.destination);

  sendPatch();
  startVisualizer();
}

// Generate reverb impulse response
function createReverbIR(decay) {
  const sr = audioCtx.sampleRate;
  const len = sr * Math.max(0.5, decay);
  const buf = audioCtx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay * 1.2);
    }
  }
  return buf;
}

function updateFx(param, val) {
  fxState[param] = val;
  if (!audioCtx) return;
  switch (param) {
    case 'reverbMix':
      reverbGain.gain.value = val / 100;
      break;
    case 'reverbDecay':
      reverbNode.buffer = createReverbIR(val / 10);
      break;
    case 'delayMix':
      delayGain.gain.value = val / 100;
      break;
    case 'delayTime':
      delayNode.delayTime.value = val / 1000;
      break;
    case 'delayFeedback':
      delayFeedbackNode.gain.value = val / 100;
      break;
  }
}

function sendPatch() {
  if (!dx7Node || !currentPatch) return;
  dx7Node.port.postMessage({ type: 'patch', patch: currentPatch });
}

function noteOn(note, velocity = 100) {
  if (!dx7Node) return;
  dx7Node.port.postMessage({ type: 'noteOn', note, velocity });
}

function noteOff(note) {
  if (!dx7Node) return;
  dx7Node.port.postMessage({ type: 'noteOff', note });
}

// ============================================================
// Visualizer
// ============================================================
let vizRunning = false;

function startVisualizer() {
  if (vizRunning) return;
  vizRunning = true;
  const waveCanvas = document.getElementById('waveform-canvas');
  const specCanvas = document.getElementById('spectrum-canvas');
  const wCtx = waveCanvas.getContext('2d');
  const sCtx = specCanvas.getContext('2d');

  function draw() {
    if (!vizRunning) return;
    requestAnimationFrame(draw);

    // Waveform
    analyser.getFloatTimeDomainData(analyserData);
    const ww = waveCanvas.width, wh = waveCanvas.height;
    wCtx.fillStyle = '#000';
    wCtx.fillRect(0, 0, ww, wh);
    wCtx.strokeStyle = '#0f0';
    wCtx.lineWidth = 1;
    wCtx.beginPath();
    const sliceW = ww / analyserData.length;
    for (let i = 0; i < analyserData.length; i++) {
      const y = (analyserData[i] * 0.5 + 0.5) * wh;
      if (i === 0) wCtx.moveTo(0, y);
      else wCtx.lineTo(i * sliceW, y);
    }
    wCtx.stroke();
    // Center line
    wCtx.strokeStyle = '#1a1a1a';
    wCtx.beginPath();
    wCtx.moveTo(0, wh / 2);
    wCtx.lineTo(ww, wh / 2);
    wCtx.stroke();

    // Spectrum
    analyser.getByteFrequencyData(freqData);
    const sw = specCanvas.width, sh = specCanvas.height;
    sCtx.fillStyle = '#000';
    sCtx.fillRect(0, 0, sw, sh);
    const barCount = 64;
    const barW = sw / barCount;
    const step = Math.floor(freqData.length / barCount);
    for (let i = 0; i < barCount; i++) {
      const val = freqData[i * step] / 255;
      const h = val * sh;
      const g = Math.floor(val * 200);
      sCtx.fillStyle = `rgb(${g},${Math.min(255, g + 55)},0)`;
      sCtx.fillRect(i * barW + 1, sh - h, barW - 2, h);
    }

    // VU meters
    let peak = 0;
    for (let i = 0; i < analyserData.length; i++) {
      peak = Math.max(peak, Math.abs(analyserData[i]));
    }
    const pct = Math.min(100, peak * 150);
    const vuL = document.getElementById('vu-l');
    const vuR = document.getElementById('vu-r');
    if (vuL) vuL.style.width = pct + '%';
    if (vuR) vuR.style.width = pct * 0.95 + '%';
  }
  draw();
}

// ============================================================
// SVG-style Knob system (drawn on canvas)
// ============================================================
const knobInstances = new Map(); // canvas element → { param, min, max, value, target }

function drawKnob(canvas, value, min, max) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const cx = w / 2, cy = h / 2;
  const r = Math.min(w, h) / 2 - 3;
  const norm = (value - min) / (max - min);

  // Angle: 225° to -45° (270° sweep)
  const startAngle = (225 * Math.PI) / 180;
  const endAngle = (-45 * Math.PI) / 180;
  const sweep = (270 * Math.PI) / 180;
  const angle = startAngle - norm * sweep;

  ctx.clearRect(0, 0, w, h);

  // Track (background arc)
  ctx.beginPath();
  ctx.arc(cx, cy, r, endAngle, startAngle);
  ctx.strokeStyle = '#2a2a2a';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Value arc
  ctx.beginPath();
  ctx.arc(cx, cy, r, angle, startAngle);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Knob body
  const grad = ctx.createRadialGradient(cx - 2, cy - 2, 0, cx, cy, r - 2);
  grad.addColorStop(0, '#444');
  grad.addColorStop(1, '#1a1a1a');
  ctx.beginPath();
  ctx.arc(cx, cy, r - 4, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Pointer line
  const px = cx + Math.cos(angle) * (r - 8);
  const py = cy - Math.sin(angle) * (r - 8);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(px, py);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Value text
  ctx.fillStyle = '#888';
  ctx.font = `${Math.max(8, r / 2.5)}px 'JetBrains Mono', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(value, cx, cy + r + 8);
}

function initKnobs() {
  document.querySelectorAll('.knob').forEach(canvas => {
    const param = canvas.dataset.param;
    const min = parseInt(canvas.dataset.min);
    const max = parseInt(canvas.dataset.max);
    const target = canvas.dataset.target; // 'op', 'global', 'fx'
    let value = min;

    // Get initial value
    if (target === 'op' && currentPatch) {
      value = currentPatch.ops[currentOpIndex][param] ?? min;
    } else if (target === 'global' && currentPatch) {
      value = currentPatch[param] ?? min;
    } else if (target === 'fx') {
      value = fxState[param] ?? min;
    }

    knobInstances.set(canvas, { param, min, max, value, target });
    drawKnob(canvas, value, min, max);

    // Drag interaction
    let dragging = false;
    let startY = 0;
    let startVal = 0;

    canvas.addEventListener('mousedown', (e) => {
      dragging = true;
      startY = e.clientY;
      startVal = knobInstances.get(canvas).value;
      e.preventDefault();
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const inst = knobInstances.get(canvas);
      const step = e.shiftKey ? 1 : Math.max(1, Math.round((inst.max - inst.min) / 50));
      const dir = e.deltaY < 0 ? 1 : -1;
      inst.value = Math.max(inst.min, Math.min(inst.max, inst.value + dir * step));
      drawKnob(canvas, inst.value, inst.min, inst.max);
      applyKnobValue(inst);
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const inst = knobInstances.get(canvas);
      const dy = startY - e.clientY;
      const range = inst.max - inst.min;
      const sensitivity = e.shiftKey ? 400 : 150;
      const newVal = Math.round(startVal + (dy / sensitivity) * range);
      inst.value = Math.max(inst.min, Math.min(inst.max, newVal));
      drawKnob(canvas, inst.value, inst.min, inst.max);
      applyKnobValue(inst);
    });

    document.addEventListener('mouseup', () => { dragging = false; });
  });
}

function applyKnobValue(inst) {
  if (inst.target === 'op' && currentPatch) {
    currentPatch.ops[currentOpIndex][inst.param] = inst.value;
    if (inst.param.startsWith('eg')) updateEnvelopeDisplay();
    sendPatch();
  } else if (inst.target === 'global' && currentPatch) {
    currentPatch[inst.param] = inst.value;
    if (inst.param.startsWith('pitchEg')) updatePitchEnvelopeDisplay();
    sendPatch();
  } else if (inst.target === 'fx') {
    updateFx(inst.param, inst.value);
  }
}

function refreshKnobs() {
  knobInstances.forEach((inst, canvas) => {
    if (inst.target === 'op' && currentPatch) {
      inst.value = currentPatch.ops[currentOpIndex][inst.param] ?? inst.min;
    } else if (inst.target === 'global' && currentPatch) {
      inst.value = currentPatch[inst.param] ?? inst.min;
    } else if (inst.target === 'fx') {
      inst.value = fxState[inst.param] ?? inst.min;
    }
    drawKnob(canvas, inst.value, inst.min, inst.max);
  });
}

// ============================================================
// Patch management
// ============================================================
function loadPatch(index) {
  currentPatch = JSON.parse(JSON.stringify(patches[index]));
  sendPatch();
  updateUI();
}

function updatePatchSelect() {
  const sel = document.getElementById('patch-select');
  sel.innerHTML = '';
  patches.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${(i + 1).toString().padStart(2, '0')} ${p.name}`;
    sel.appendChild(opt);
  });
}

// ============================================================
// UI Update
// ============================================================
function updateUI() {
  if (!currentPatch) return;
  document.getElementById('algo-num').textContent = currentPatch.algorithm + 1;
  drawAlgorithm(document.getElementById('algo-canvas'), currentPatch.algorithm);
  updateOperatorUI();
  updateEnvelopeDisplay();
  updatePitchEnvelopeDisplay();
  refreshKnobs();
  updateGlobalSelects();
}

function updateOperatorUI() {
  document.querySelectorAll('.op-tab').forEach((tab, i) => {
    tab.classList.toggle('active', i === currentOpIndex);
  });
  refreshKnobs();
}

function updateGlobalSelects() {
  document.querySelectorAll('.global-param').forEach(el => {
    const param = el.dataset.param;
    if (el.type === 'checkbox') {
      el.checked = currentPatch[param];
    } else if (el.tagName === 'SELECT') {
      el.value = currentPatch[param];
    }
  });
}

function updateEnvelopeDisplay() {
  if (!currentPatch) return;
  const op = currentPatch.ops[currentOpIndex];
  drawEnvelope(document.getElementById('env-canvas'),
    op.egRate1, op.egRate2, op.egRate3, op.egRate4,
    op.egLevel1, op.egLevel2, op.egLevel3, op.egLevel4);
}

function updatePitchEnvelopeDisplay() {
  if (!currentPatch) return;
  drawPitchEnvelope(document.getElementById('pitch-env-canvas'),
    currentPatch.pitchEgR1, currentPatch.pitchEgR2,
    currentPatch.pitchEgR3, currentPatch.pitchEgR4,
    currentPatch.pitchEgL1, currentPatch.pitchEgL2,
    currentPatch.pitchEgL3, currentPatch.pitchEgL4);
}

// ============================================================
// Keyboard
// ============================================================
function buildKeyboard() {
  const keyboard = document.getElementById('keyboard');
  const startNote = 36, endNote = 96;
  const noteNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const blackNotes = [1,3,6,8,10];

  for (let note = startNote; note <= endNote; note++) {
    const isBlack = blackNotes.includes(note % 12);
    const key = document.createElement('div');
    key.className = `key ${isBlack ? 'key-black' : 'key-white'}`;
    key.dataset.note = note;

    if (!isBlack && (note % 12 === 0)) {
      const label = document.createElement('span');
      label.className = 'key-label';
      label.textContent = `C${Math.floor(note / 12) - 1}`;
      key.appendChild(label);
    }

    key.addEventListener('mousedown', async (e) => {
      e.preventDefault(); await initAudio();
      key.classList.add('active'); noteOn(note);
    });
    key.addEventListener('mouseup', () => { key.classList.remove('active'); noteOff(note); });
    key.addEventListener('mouseleave', () => {
      if (key.classList.contains('active')) { key.classList.remove('active'); noteOff(note); }
    });
    key.addEventListener('mouseenter', (e) => {
      if (e.buttons === 1) { key.classList.add('active'); noteOn(note); }
    });
    key.addEventListener('touchstart', async (e) => {
      e.preventDefault(); await initAudio();
      key.classList.add('active'); noteOn(note);
    });
    key.addEventListener('touchend', (e) => {
      e.preventDefault(); key.classList.remove('active'); noteOff(note);
    });

    keyboard.appendChild(key);
  }
}

// ============================================================
// Computer keyboard + MIDI
// ============================================================
const KEY_MAP = {
  'a':60,'w':61,'s':62,'e':63,'d':64,'f':65,'t':66,'g':67,
  'y':68,'h':69,'u':70,'j':71,'k':72,'o':73,'l':74,'p':75,
  ';':76,"'":77, 'z':48,'x':50,'c':52,'v':53,'b':55,'n':57,'m':59
};
const activeKeys = new Set();

document.addEventListener('keydown', async (e) => {
  if (e.repeat || e.target.tagName === 'SELECT') return;
  const note = KEY_MAP[e.key.toLowerCase()];
  if (note !== undefined && !activeKeys.has(e.key.toLowerCase())) {
    await initAudio();
    activeKeys.add(e.key.toLowerCase());
    noteOn(note);
    const keyEl = document.querySelector(`.key[data-note="${note}"]`);
    if (keyEl) keyEl.classList.add('active');
  }
});

document.addEventListener('keyup', (e) => {
  const note = KEY_MAP[e.key.toLowerCase()];
  if (note !== undefined) {
    activeKeys.delete(e.key.toLowerCase());
    noteOff(note);
    const keyEl = document.querySelector(`.key[data-note="${note}"]`);
    if (keyEl) keyEl.classList.remove('active');
  }
});

async function initMIDI() {
  try {
    midiAccess = await navigator.requestMIDIAccess();
    for (const input of midiAccess.inputs.values()) input.onmidimessage = handleMIDI;
    midiAccess.onstatechange = () => {
      for (const input of midiAccess.inputs.values()) input.onmidimessage = handleMIDI;
    };
  } catch (e) { console.log('MIDI not available:', e); }
}

function handleMIDI(msg) {
  const [status, data1, data2] = msg.data;
  const cmd = status & 0xF0;
  if (cmd === 0x90 && data2 > 0) {
    initAudio().then(() => noteOn(data1, data2));
  } else if (cmd === 0x80 || (cmd === 0x90 && data2 === 0)) {
    noteOff(data1);
  } else if (cmd === 0xB0 && data1 === 64) {
    if (dx7Node) dx7Node.port.postMessage({ type: 'sustain', value: data2 >= 64 });
  }
}

// ============================================================
// Event handlers
// ============================================================
function setupEventHandlers() {
  document.getElementById('patch-select').addEventListener('change', async (e) => {
    await initAudio(); loadPatch(parseInt(e.target.value));
  });

  document.getElementById('load-syx-btn').addEventListener('click', () => {
    document.getElementById('syx-file').click();
  });

  document.getElementById('syx-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const data = new Uint8Array(await file.arrayBuffer());
    const loaded = parseSyxBank(data);
    if (loaded.length > 0) {
      patches = loaded; updatePatchSelect();
      await initAudio(); loadPatch(0);
    }
  });

  document.getElementById('panic-btn').addEventListener('click', () => {
    if (dx7Node) dx7Node.port.postMessage({ type: 'panic' });
    document.querySelectorAll('.key.active').forEach(k => k.classList.remove('active'));
  });

  document.getElementById('algo-dec').addEventListener('click', () => {
    currentPatch.algorithm = (currentPatch.algorithm - 1 + 32) % 32;
    sendPatch(); updateUI();
  });
  document.getElementById('algo-inc').addEventListener('click', () => {
    currentPatch.algorithm = (currentPatch.algorithm + 1) % 32;
    sendPatch(); updateUI();
  });

  document.querySelectorAll('.op-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      currentOpIndex = parseInt(tab.dataset.op);
      updateOperatorUI(); updateEnvelopeDisplay();
    });
  });

  // Global selects/checkboxes
  document.querySelectorAll('.global-param').forEach(el => {
    el.addEventListener('input', () => {
      const param = el.dataset.param;
      if (el.type === 'checkbox') currentPatch[param] = el.checked;
      else currentPatch[param] = parseInt(el.value);
      sendPatch();
    });
  });
}

// ============================================================
// Init
// ============================================================
function init() {
  patches = generateFactoryPatches();
  updatePatchSelect();
  currentPatch = JSON.parse(JSON.stringify(patches[0]));
  buildKeyboard();
  initKnobs();
  setupEventHandlers();
  updateUI();
  initMIDI();
}

document.addEventListener('DOMContentLoaded', init);
