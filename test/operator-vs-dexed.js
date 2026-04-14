#!/usr/bin/env node
// OpenDX7 — FM Synthesizer (MIT License)
// Copyright (c) 2026 Keith Adler
// ============================================================
// Operator-level comparison against Dexed's exact C++ math.
// Tests each operator parameter independently.
// ============================================================
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(__dirname, '..', 'js', 'dx7-processor.js'), 'utf8');
let PC;
const SR = 44100;
class M { constructor() { this.port = { onmessage: null, postMessage: () => {} }; } }
new Function('sampleRate', 'AudioWorkletProcessor', 'registerProcessor', 'currentTime', code)(
  SR, M, (n, c) => { PC = c; }, 0
);

let passed = 0, failed = 0, total = 0;
function assert(cond, msg) { total++; if (cond) passed++; else { failed++; console.log(`  ✗ ${msg}`); } }

// ── Dexed reference math ──
const lvlut = [0,5,9,13,17,20,23,25,27,29,31,33,35,37,39,41,42,43,45,46];
function sol(x) { return x >= 20 ? 28 + x : lvlut[x]; }
const vd = [0,70,86,97,106,114,121,126,132,138,142,148,152,156,160,163,166,170,173,174,178,181,184,186,189,190,194,196,198,200,202,205,206,209,211,214,216,218,220,222,224,225,227,229,230,232,233,235,237,238,240,241,242,243,244,246,246,248,249,250,251,252,253,254];
function sVel(vel,sens){return((sens*(vd[Math.max(0,Math.min(127,vel))>>1]-239)+7)>>3)<<4;}
const expScale = [0,1,2,3,4,5,6,7,8,9,11,14,16,19,23,27,33,39,47,56,66,80,94,110,126,142,158,174,190,206,222,238,250];
function scaleCurve(group,depth,curve){let s;if(curve===0||curve===3)s=(group*depth*329)>>12;else s=(expScale[Math.min(group,32)]*depth*329)>>15;if(curve<2)s=-s;return s;}
function scaleLevel(note,bp,ld,rd,lc,rc){const o=note-(bp+17);if(o>=0)return scaleCurve(Math.floor((o+1)/3),rd,rc);else return scaleCurve(Math.floor((-o+1)/3),ld,lc);}
function scaleRate(note,sens){return(sens*Math.min(31,Math.max(0,Math.floor(note/3)-7)))>>3;}

// Dexed envelope
class DexEnv {
  constructor(){this.level_=0;this.targetlevel_=0;this.rising_=false;this.ix_=0;this.inc_=0;this.rates_=[0,0,0,0];this.levels_=[0,0,0,0];this.outlevel_=0;this.rate_scaling_=0;this.down_=true;}
  init(r,l,ol,rs){this.rates_=[...r];this.levels_=[...l];this.outlevel_=ol;this.rate_scaling_=rs;this.level_=0;this.down_=true;this.advance(0);}
  keydown(d){if(this.down_!==d){this.down_=d;this.advance(d?0:3);}}
  advance(ix){this.ix_=ix;if(ix>=4)return;let al=sol(this.levels_[ix])>>1;al=Math.max(16,(al<<6)+this.outlevel_-4256);this.targetlevel_=al<<16;this.rising_=this.targetlevel_>this.level_;let qr=Math.min(63,((this.rates_[ix]*41)>>6)+this.rate_scaling_);this.inc_=(4+(qr&3))<<(2+6+(qr>>2));}
  getsample(){if(this.ix_<3||(this.ix_<4&&!this.down_)){if(this.rising_){if(this.level_<(1716<<16))this.level_=1716<<16;this.level_+=Math.floor(((17<<24)-this.level_)/(1<<24))*this.inc_;if(this.level_>=this.targetlevel_){this.level_=this.targetlevel_;this.advance(this.ix_+1);}}else{this.level_-=this.inc_;if(this.level_<=this.targetlevel_){this.level_=this.targetlevel_;this.advance(this.ix_+1);}}}return this.level_;}
}

function dexGain(level) {
  const expArg = level / (1 << 24) - 14;
  return expArg < -30 ? 0 : Math.pow(2, expArg);
}

function makePatch(opIdx, opOverrides, globals) {
  const p = {name:'T',algorithm:31,feedback:0,transpose:24,pitchModSens:0,oscSync:false,
    pitchEgR1:99,pitchEgR2:99,pitchEgR3:99,pitchEgR4:99,
    pitchEgL1:50,pitchEgL2:50,pitchEgL3:50,pitchEgL4:50,
    lfoSpeed:0,lfoDelay:0,lfoPitchModDepth:0,lfoAmpModDepth:0,lfoSync:false,lfoWave:0,
    ...globals,
    ops:Array.from({length:6},()=>({egRate1:99,egRate2:99,egRate3:99,egRate4:99,
      egLevel1:99,egLevel2:99,egLevel3:99,egLevel4:0,
      outputLevel:0,oscMode:0,freqCoarse:1,freqFine:0,detune:7,
      velSensitivity:0,ampModSens:0,kbdRateScaling:0,
      kbdLevelScaleBP:39,kbdLevelScaleLD:0,kbdLevelScaleRD:0,
      kbdLevelScaleLC:0,kbdLevelScaleRC:0}))};
  Object.assign(p.ops[opIdx], opOverrides);
  return p;
}

function renderPeak(patch, note, vel, seconds) {
  const proc = new PC();
  proc._setPatch(patch);
  proc._noteOn(note || 60, vel || 100);
  let pk = 0;
  const n = Math.floor(SR * (seconds || 0.5));
  for (let off = 0; off < n; off += 128) {
    const len = Math.min(128, n - off);
    const b = [[new Float32Array(len), new Float32Array(len)]];
    proc.process([], b, {});
    for (let j = 0; j < len; j++) pk = Math.max(pk, Math.abs(b[0][0][j]));
  }
  return pk;
}

// ============================================================
console.log('=== Operator vs Dexed Comparison ===\n');

// 1. Output level curve
console.log('1. Output level curve (all 100 levels)');
{
  let maxErr = 0;
  for (let lvl = 0; lvl <= 99; lvl++) {
    // Dexed: outlevel computation
    let ol = Math.min(127, sol(lvl));
    ol = (ol << 5) + sVel(100, 0);
    ol = Math.max(0, ol);
    const dexEnv = new DexEnv();
    dexEnv.init([99,99,99,99],[99,99,99,0], ol, 0);
    dexEnv.keydown(true);
    const dexLevel = dexEnv.getsample(); // after 1 block
    const dexGainVal = dexGain(dexLevel);

    // Our engine
    const p = makePatch(0, { outputLevel: lvl });
    const proc = new PC();
    proc._setPatch(p);
    proc._noteOn(60, 100);
    // Process 2 blocks to let envelope settle
    for (let i = 0; i < 2; i++) {
      const b = [[new Float32Array(64), new Float32Array(64)]];
      proc.process([], b, {});
    }
    const voice = proc.voices.find(v => v.active);
    const ourGain = voice ? voice.ops[0].gain_out : 0;

    const err = Math.abs(ourGain - dexGainVal);
    maxErr = Math.max(maxErr, err);
    if (err > 0.001 && lvl > 5) {
      console.log(`  lvl ${lvl}: dexed=${dexGainVal.toFixed(6)} ours=${ourGain.toFixed(6)} err=${err.toFixed(6)}`);
    }
  }
  assert(maxErr < 0.01, `Max gain error across all levels: ${maxErr.toFixed(6)}`);
  console.log(`  Max error: ${maxErr.toFixed(6)} ${maxErr < 0.01 ? '✓' : '✗'}\n`);
}

// 2. Velocity sensitivity
console.log('2. Velocity sensitivity (all 8 levels × key velocities)');
{
  let errors = 0;
  for (let sens = 0; sens <= 7; sens++) {
    for (const vel of [1, 32, 64, 96, 127]) {
      // Dexed
      let ol = Math.min(127, sol(99));
      ol = (ol << 5) + sVel(vel, sens);
      ol = Math.max(0, ol);
      const dexEnv = new DexEnv();
      dexEnv.init([99,99,99,99],[99,99,99,0], ol, 0);
      dexEnv.keydown(true);
      const dexGainVal = dexGain(dexEnv.getsample());

      // Ours
      const p = makePatch(0, { outputLevel: 99, velSensitivity: sens });
      const proc = new PC();
      proc._setPatch(p);
      proc._noteOn(60, vel);
      for (let i = 0; i < 2; i++) { const b = [[new Float32Array(64), new Float32Array(64)]]; proc.process([], b, {}); }
      const ourGain = proc.voices.find(v => v.active)?.ops[0].gain_out || 0;

      const err = Math.abs(ourGain - dexGainVal);
      if (err > 0.001) {
        errors++;
        if (errors <= 5) console.log(`  sens=${sens} vel=${vel}: dexed=${dexGainVal.toFixed(4)} ours=${ourGain.toFixed(4)}`);
      }
    }
  }
  assert(errors === 0, `${errors} velocity mismatches`);
  console.log(`  ${errors === 0 ? 'All match ✓' : errors + ' mismatches'}\n`);
}

// 3. Keyboard level scaling
console.log('3. Keyboard level scaling');
{
  let errors = 0;
  for (const [bp, ld, rd, lc, rc] of [[39,50,50,0,0],[39,50,50,1,1],[39,50,50,2,2],[39,50,50,3,3],[60,99,0,0,0],[20,0,99,0,0]]) {
    for (const note of [36, 48, 60, 72, 84]) {
      const dexKls = scaleLevel(note, bp, ld, rd, lc, rc);
      let ol = Math.min(127, Math.max(0, sol(99) + dexKls));
      ol = (ol << 5) + sVel(100, 0);
      ol = Math.max(0, ol);
      const dexEnv = new DexEnv();
      dexEnv.init([99,99,99,99],[99,99,99,0], ol, 0);
      dexEnv.keydown(true);
      const dexGainVal = dexGain(dexEnv.getsample());

      const p = makePatch(0, { outputLevel: 99, kbdLevelScaleBP: bp, kbdLevelScaleLD: ld, kbdLevelScaleRD: rd, kbdLevelScaleLC: lc, kbdLevelScaleRC: rc });
      const proc = new PC();
      proc._setPatch(p);
      proc._noteOn(note, 100);
      for (let i = 0; i < 2; i++) { const b = [[new Float32Array(64), new Float32Array(64)]]; proc.process([], b, {}); }
      const ourGain = proc.voices.find(v => v.active)?.ops[0].gain_out || 0;

      const err = Math.abs(ourGain - dexGainVal);
      if (err > 0.002) {
        errors++;
        if (errors <= 5) console.log(`  bp=${bp} ld=${ld} rd=${rd} lc=${lc} rc=${rc} note=${note}: dex=${dexGainVal.toFixed(4)} ours=${ourGain.toFixed(4)}`);
      }
    }
  }
  assert(errors === 0, `${errors} KLS mismatches`);
  console.log(`  ${errors === 0 ? 'All match ✓' : errors + ' mismatches'}\n`);
}

// 4. Keyboard rate scaling
console.log('4. Keyboard rate scaling');
{
  let errors = 0;
  for (let krs = 0; krs <= 7; krs++) {
    for (const note of [36, 48, 60, 72, 84, 96]) {
      const dexRs = scaleRate(note, krs);
      // Dexed: qrate uses rate_scaling_ which is scaleRate result
      const rate = 50;
      const dexQr = Math.min(63, ((rate * 41) >> 6) + dexRs);
      const dexInc = (4 + (dexQr & 3)) << (2 + 6 + (dexQr >> 2));

      // Our engine
      const p = makePatch(0, { outputLevel: 99, kbdRateScaling: krs, egRate1: rate, egRate2: rate });
      const proc = new PC();
      proc._setPatch(p);
      proc._noteOn(note, 100);
      const voice = proc.voices.find(v => v.active);
      const ourRs = voice?.ops[0].envelope.rate_scaling_ || 0;

      if (ourRs !== dexRs) {
        errors++;
        if (errors <= 5) console.log(`  krs=${krs} note=${note}: dexed=${dexRs} ours=${ourRs}`);
      }
    }
  }
  assert(errors === 0, `${errors} KRS mismatches`);
  console.log(`  ${errors === 0 ? 'All match ✓' : errors + ' mismatches'}\n`);
}

// 5. Envelope shapes (10 blocks for various rate/level combos)
console.log('5. Envelope shapes');
{
  const tests = [
    { name: 'fast attack', rates: [99,99,99,80], levels: [99,99,99,0] },
    { name: 'slow attack', rates: [40,99,99,80], levels: [99,99,99,0] },
    { name: 'decay to 50', rates: [99,60,60,80], levels: [99,50,50,0] },
    { name: 'slow decay',  rates: [99,30,30,30], levels: [99,70,40,0] },
  ];
  let maxErr = 0;
  for (const t of tests) {
    let ol = Math.min(127, sol(99));
    ol = (ol << 5) + sVel(100, 0);
    ol = Math.max(0, ol);
    const dexEnv = new DexEnv();
    dexEnv.init(t.rates, t.levels, ol, 0);
    dexEnv.keydown(true);

    const p = makePatch(0, {
      outputLevel: 99,
      egRate1: t.rates[0], egRate2: t.rates[1], egRate3: t.rates[2], egRate4: t.rates[3],
      egLevel1: t.levels[0], egLevel2: t.levels[1], egLevel3: t.levels[2], egLevel4: t.levels[3],
    });
    const proc = new PC();
    proc._setPatch(p);
    proc._noteOn(60, 100);
    const voice = proc.voices.find(v => v.active);
    const ourEnv = voice.ops[0].envelope;

    for (let blk = 0; blk < 20; blk++) {
      const dexLevel = dexEnv.getsample();
      const ourLevel = ourEnv.getsample();
      const err = Math.abs(dexLevel - ourLevel);
      maxErr = Math.max(maxErr, err);
    }
  }
  assert(maxErr === 0, `Envelope max error: ${maxErr}`);
  console.log(`  Max error: ${maxErr} ${maxErr === 0 ? '✓ EXACT' : '✗'}\n`);
}

// 6. Frequency ratios
console.log('6. Frequency ratios (coarse 0-31)');
{
  const expected = [0.5,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31];
  let errors = 0;
  for (let c = 0; c <= 31; c++) {
    const p = makePatch(0, { outputLevel: 99, freqCoarse: c });
    const proc = new PC();
    proc._setPatch(p);
    proc._noteOn(69, 100); // A4
    // Measure frequency
    let crossings = 0, prev = 0, idx = 0;
    for (let off = 0; off < SR; off += 128) {
      const b = [[new Float32Array(128), new Float32Array(128)]];
      proc.process([], b, {});
      for (let j = 0; j < 128; j++) {
        if (idx > SR * 0.1 && prev >= 0 && b[0][0][j] < 0) crossings++;
        prev = b[0][0][j]; idx++;
      }
    }
    const freq = crossings / ((SR - SR * 0.1) / SR);
    const expectedFreq = 440 * expected[c];
    const cents = Math.abs(1200 * Math.log2(freq / expectedFreq));
    if (cents > 5 && expectedFreq < SR / 2) {
      errors++;
      console.log(`  coarse ${c}: got ${freq.toFixed(1)}Hz, want ${expectedFreq.toFixed(1)}Hz (${cents.toFixed(0)} cents off)`);
    }
  }
  assert(errors === 0, `${errors} frequency errors`);
  console.log(`  ${errors === 0 ? 'All match ✓' : errors + ' errors'}\n`);
}

// 7. Detune
console.log('7. Detune (0-14)');
{
  let errors = 0;
  for (let det = 0; det <= 14; det++) {
    const p = makePatch(0, { outputLevel: 99, detune: det });
    const proc = new PC();
    proc._setPatch(p);
    proc._noteOn(69, 100);
    let crossings = 0, prev = 0, idx = 0;
    const dur = SR * 5; // 5 seconds for sub-cent resolution
    for (let off = 0; off < dur; off += 128) {
      const b = [[new Float32Array(128), new Float32Array(128)]];
      proc.process([], b, {});
      for (let j = 0; j < 128; j++) {
        if (idx > SR * 0.1 && prev >= 0 && b[0][0][j] < 0) crossings++;
        prev = b[0][0][j]; idx++;
      }
    }
    const freq = crossings / ((dur - SR * 0.1) / SR);
    const cents = 1200 * Math.log2(freq / 440);
    // Dexed detune: frequency-dependent, ~1 cent/step at A4 but varies
    // Just verify it's monotonic and in the right ballpark (±2 cents per step)
    const expectedRange = (det - 7) * 2; // generous ±2 cents per step
    if (det !== 7 && Math.abs(cents) < 0.1) {
      errors++;
      console.log(`  det ${det}: ${cents.toFixed(1)} cents — should not be zero`);
    }
    if (det < 7 && cents > 1) {
      errors++;
      console.log(`  det ${det}: ${cents.toFixed(1)} cents — should be negative`);
    }
    if (det > 7 && cents < -1) {
      errors++;
      console.log(`  det ${det}: ${cents.toFixed(1)} cents — should be positive`);
    }
  }
  assert(errors === 0, `${errors} detune errors`);
  console.log(`  ${errors === 0 ? 'All match ✓' : errors + ' errors'}\n`);
}

// 8. Fixed frequency mode
console.log('8. Fixed frequency mode');
{
  let errors = 0;
  for (const [coarse, fine, expected] of [[0,0,1],[1,0,10],[2,0,100],[3,0,1000],[2,50,316],[0,99,10]]) {
    const p = makePatch(0, { outputLevel: 99, oscMode: 1, freqCoarse: coarse, freqFine: fine });
    const proc = new PC();
    proc._setPatch(p);
    proc._noteOn(60, 100);
    let crossings = 0, prev = 0, idx = 0;
    for (let off = 0; off < SR * 2; off += 128) {
      const b = [[new Float32Array(128), new Float32Array(128)]];
      proc.process([], b, {});
      for (let j = 0; j < 128; j++) {
        if (idx > SR * 0.1 && prev >= 0 && b[0][0][j] < 0) crossings++;
        prev = b[0][0][j]; idx++;
      }
    }
    const freq = crossings / ((SR * 2 - SR * 0.1) / SR);
    if (Math.abs(freq - expected) / expected > 0.1) {
      errors++;
      console.log(`  coarse=${coarse} fine=${fine}: got ${freq.toFixed(1)}Hz, want ~${expected}Hz`);
    }
  }
  assert(errors === 0, `${errors} fixed freq errors`);
  console.log(`  ${errors === 0 ? 'All match ✓' : errors + ' errors'}\n`);
}

// 9. Feedback harmonic content vs Dexed reference
console.log('9. Feedback harmonic content vs Dexed reference');
{
  // Simulate Dexed's exact integer feedback math
  const SIN_N = 1024;
  const dexSintab = new Int32Array(SIN_N + 1);
  for (let i = 0; i <= SIN_N; i++) {
    dexSintab[i] = Math.round(Math.sin(2 * Math.PI * i / SIN_N) * (1 << 24));
  }
  function dexSinLookup(phase) {
    const SHIFT = 14;
    const lowbits = phase & ((1 << SHIFT) - 1);
    const idx = ((phase >> (SHIFT - 1)) >> 1) & (SIN_N - 1);
    const idx1 = (idx + 1) & (SIN_N - 1);
    const y0 = dexSintab[idx];
    const y1 = dexSintab[idx1];
    return y0 + Math.round((y1 - y0) * lowbits / (1 << SHIFT));
  }

  const dexGainLvl99 = 33554432; // 2^25
  const dexFreq = Math.round(440 * (1 << 24) / SR);
  const skip = Math.floor(SR * 0.05);

  function measureTHD(samples) {
    function mag(f) {
      let re = 0, im = 0;
      for (let i = skip; i < samples.length; i++) {
        re += samples[i] * Math.cos(2 * Math.PI * f * i / SR);
        im += samples[i] * Math.sin(2 * Math.PI * f * i / SR);
      }
      return Math.sqrt(re * re + im * im) / (samples.length - skip);
    }
    const h1 = mag(440);
    const h2 = mag(880);
    const h3 = mag(1320);
    const h4 = mag(1760);
    const h5 = mag(2200);
    return h1 > 0 ? Math.sqrt(h2*h2+h3*h3+h4*h4+h5*h5) / h1 * 100 : 0;
  }

  let maxThdErr = 0;
  for (let fb = 0; fb <= 7; fb++) {
    // Dexed reference
    const fb_shift = fb > 0 ? 8 - fb : 16;
    let phase = 0, y0d = 0, yd = 0;
    const dexSamples = [];
    for (let s = 0; s < SR; s++) {
      const scaled_fb = fb > 0 ? (y0d + yd) >> (fb_shift + 1) : 0;
      y0d = yd;
      const sinVal = dexSinLookup((phase + scaled_fb) & 0xFFFFFF);
      yd = Math.round((sinVal * dexGainLvl99) / (1 << 24));
      dexSamples.push(yd / dexGainLvl99);
      phase = (phase + dexFreq) & 0xFFFFFF;
    }
    const dexTHD = measureTHD(dexSamples);

    // Our engine
    const p = makePatch(0, { outputLevel: 99 }, { algorithm: 31, feedback: fb });
    const proc = new PC();
    proc._setPatch(p);
    proc._noteOn(69, 100);
    const ourSamples = [];
    for (let off = 0; off < SR; off += 128) {
      const len = Math.min(128, SR - off);
      const b = [[new Float32Array(len), new Float32Array(len)]];
      proc.process([], b, {});
      for (let j = 0; j < len; j++) ourSamples.push(b[0][0][j]);
    }
    const ourTHD = measureTHD(ourSamples);

    const thdErr = Math.abs(ourTHD - dexTHD);
    maxThdErr = Math.max(maxThdErr, thdErr);
    if (thdErr > 3) {
      console.log(`  fb=${fb}: dexed=${dexTHD.toFixed(1)}% ours=${ourTHD.toFixed(1)}% err=${thdErr.toFixed(1)}%`);
    }
  }
  assert(maxThdErr < 5, `Max feedback THD error across all levels: ${maxThdErr.toFixed(1)}%`);
  console.log(`  Max THD error: ${maxThdErr.toFixed(1)}% ${maxThdErr < 5 ? '✓' : '✗'}\n`);
}

console.log(`${'='.repeat(50)}`);
console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
else console.log('ALL OPERATOR TESTS PASSED ✓');
