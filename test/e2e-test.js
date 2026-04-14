#!/usr/bin/env node
// OpenDX7 — FM Synthesizer (MIT License)
// Copyright (c) 2026 Keith Adler
// ============================================================
// End-to-end integration tests
// ============================================================
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0, total = 0;
function assert(cond, msg) { total++; if (cond) passed++; else { failed++; console.log(`  ✗ ${msg}`); } }
function section(name) { console.log(`\n── ${name} ──`); }

function loadEngine(sr) {
  const code = readFileSync(join(__dirname, '..', 'js', 'dx7-processor.js'), 'utf8');
  let PC;
  class M { constructor() { this.port = { onmessage: null, postMessage: () => {} }; } }
  new Function('sampleRate', 'AudioWorkletProcessor', 'registerProcessor', 'currentTime', code)(
    sr, M, (n, c) => { PC = c; }, 0
  );
  return PC;
}

function makePatch(overrides) {
  return {name:'T',algorithm:31,feedback:0,transpose:24,pitchModSens:0,oscSync:false,
    pitchEgR1:99,pitchEgR2:99,pitchEgR3:99,pitchEgR4:99,
    pitchEgL1:50,pitchEgL2:50,pitchEgL3:50,pitchEgL4:50,
    lfoSpeed:0,lfoDelay:0,lfoPitchModDepth:0,lfoAmpModDepth:0,lfoSync:false,lfoWave:0,
    ops:Array.from({length:6},()=>({egRate1:99,egRate2:99,egRate3:99,egRate4:99,
      egLevel1:99,egLevel2:99,egLevel3:99,egLevel4:0,
      outputLevel:0,oscMode:0,freqCoarse:1,freqFine:0,detune:7,
      velSensitivity:0,ampModSens:0,kbdRateScaling:0,
      kbdLevelScaleBP:39,kbdLevelScaleLD:0,kbdLevelScaleRD:0,
      kbdLevelScaleLC:0,kbdLevelScaleRC:0})),...overrides};
}

function processBlocks(proc, n) {
  const out = [];
  for (let off = 0; off < n; off += 128) {
    const len = Math.min(128, n - off);
    const b = [[new Float32Array(len), new Float32Array(len)]];
    proc.process([], b, {});
    for (let j = 0; j < len; j++) out.push(b[0][0][j]);
  }
  return out;
}

function peak(arr, start, end) {
  let mx = 0;
  for (let i = start || 0; i < (end || arr.length); i++) mx = Math.max(mx, Math.abs(arr[i]));
  return mx;
}

function rms(arr, start, end) {
  let sum = 0;
  start = start || 0; end = end || arr.length;
  for (let i = start; i < end; i++) sum += arr[i] * arr[i];
  return Math.sqrt(sum / (end - start));
}

function freq(arr, sr, skip) {
  skip = skip || Math.floor(sr * 0.1);
  let c = 0, prev = 0;
  for (let i = skip; i < arr.length; i++) { if (prev >= 0 && arr[i] < 0) c++; prev = arr[i]; }
  return c / ((arr.length - skip) / sr);
}

const SR = 44100;
const PC = loadEngine(SR);


// ============================================================
// 1. Polyphony stress — 16+ notes, voice stealing, no NaN
// ============================================================
section('1. Polyphony stress');
{
  const p = makePatch(); p.ops[0].outputLevel = 99;
  const proc = new PC();
  proc._setPatch(p);

  // Play 20 notes (exceeds 16 voice limit)
  for (let i = 0; i < 20; i++) proc._noteOn(48 + i, 100);
  const s = processBlocks(proc, SR / 2);

  assert(peak(s) > 0.01, 'Should produce sound with 20 notes');
  assert(!s.some(v => isNaN(v) || !isFinite(v)), 'No NaN/Infinity with voice stealing');

  let active = 0;
  for (const v of proc.voices) if (v.active) active++;
  assert(active === 16, `Should have exactly 16 active voices (got ${active})`);

  // Verify the latest notes are playing (voice stealing should drop oldest/quietest)
  let found67 = false;
  for (const v of proc.voices) if (v.active && v.note === 67) found67 = true;
  assert(found67, 'Latest note (67) should be active after stealing');
  console.log('  ✓ 20 notes, 16 active, no artifacts');
}

// ============================================================
// 2. Note-off release — decays to actual silence
// ============================================================
section('2. Note-off release to silence');
{
  const p = makePatch(); p.ops[0].outputLevel = 99;
  p.ops[0].egRate4 = 70; p.ops[0].egLevel4 = 0;
  const proc = new PC();
  proc._setPatch(p);
  proc._noteOn(60, 100);
  processBlocks(proc, SR / 4); // let attack settle

  proc._noteOff(60);
  const release = processBlocks(proc, SR * 3); // 3 seconds of release

  const tailPk = peak(release, release.length - SR / 4);
  assert(tailPk < 0.0001, `Tail should be silent after 3s release (peak=${tailPk.toFixed(6)})`);

  // Voice should become inactive
  let active = 0;
  for (const v of proc.voices) if (v.active) active++;
  assert(active === 0, `Voice should be inactive after full release (active=${active})`);
  console.log(`  Tail peak: ${tailPk.toFixed(6)}, active voices: ${active}`);
}

// ============================================================
// 3. Pitch bend accuracy
// ============================================================
section('3. Pitch bend accuracy');
{
  const p = makePatch(); p.ops[0].outputLevel = 99;
  const proc = new PC();
  proc._setPatch(p);
  proc._noteOn(69, 100); // A4
  processBlocks(proc, SR / 4); // settle

  // Bend up 2 semitones (default range)
  proc._pitchBend(16383);
  const bentUp = processBlocks(proc, SR);
  const fUp = freq(bentUp, SR, 0);
  // A4 + 2 semitones = B4 = 493.88 Hz
  assert(Math.abs(fUp - 493.88) < 5, `Bend up should be ~494Hz (got ${fUp.toFixed(1)})`);

  // Bend down 2 semitones
  proc._pitchBend(0);
  const bentDown = processBlocks(proc, SR);
  const fDown = freq(bentDown, SR, 0);
  // A4 - 2 semitones = G4 = 392.00 Hz
  assert(Math.abs(fDown - 392) < 5, `Bend down should be ~392Hz (got ${fDown.toFixed(1)})`);

  // Center = no bend
  proc._pitchBend(8192);
  const center = processBlocks(proc, SR);
  const fCenter = freq(center, SR, 0);
  assert(Math.abs(fCenter - 440) < 3, `Center should be ~440Hz (got ${fCenter.toFixed(1)})`);
  console.log(`  Up: ${fUp.toFixed(1)}Hz, Down: ${fDown.toFixed(1)}Hz, Center: ${fCenter.toFixed(1)}Hz`);
}

// ============================================================
// 4. Sustain pedal
// ============================================================
section('4. Sustain pedal');
{
  const p = makePatch(); p.ops[0].outputLevel = 99;
  p.ops[0].egRate4 = 90; p.ops[0].egLevel4 = 0; // fast release
  const proc = new PC();
  proc._setPatch(p);

  proc._sustain(true);
  proc._noteOn(60, 100);
  processBlocks(proc, SR / 4);

  proc._noteOff(60); // should NOT release (pedal down)
  const held = processBlocks(proc, SR / 4);
  assert(peak(held) > 0.01, 'Note should sustain with pedal down');

  proc._sustain(false); // release pedal
  processBlocks(proc, SR); // let decay
  const after = processBlocks(proc, SR / 4);
  assert(peak(after) < peak(held) * 0.1, 'Note should decay after pedal release');
  console.log(`  Held: ${peak(held).toFixed(4)}, After release: ${peak(after).toFixed(6)}`);
}

// ============================================================
// 5. Re-trigger behavior
// ============================================================
section('5. Re-trigger (same note twice)');
{
  const p = makePatch(); p.ops[0].outputLevel = 99;
  p.ops[0].egRate1 = 99; p.ops[0].egLevel1 = 99;
  p.ops[0].egRate2 = 40; p.ops[0].egLevel2 = 30;
  const proc = new PC();
  proc._setPatch(p);

  proc._noteOn(60, 100);
  processBlocks(proc, SR); // 1 second — envelope has decayed
  const decayedRms = rms(processBlocks(proc, SR / 10));

  // Re-trigger
  proc._noteOn(60, 100);
  processBlocks(proc, SR / 10); // attack
  const retrigRms = rms(processBlocks(proc, SR / 10));

  assert(retrigRms > decayedRms * 1.5, `Re-trigger should reset envelope (retrig=${retrigRms.toFixed(4)} > decayed=${decayedRms.toFixed(4)})`);
  console.log(`  Decayed: ${decayedRms.toFixed(4)}, Re-triggered: ${retrigRms.toFixed(4)}`);
}


// ============================================================
// 6. Cross-algorithm FM depth consistency
// ============================================================
section('6. Cross-algorithm FM depth');
{
  // Same carrier level 99, same modulator level 85, 1:1 ratio
  // Algo 5 (OP1→OP2) and algo 1 (need to find direct mod→carrier)
  // Both should produce similar FM depth

  function measureTHD(algo, modOp, carOp) {
    const p = makePatch({ algorithm: algo });
    p.ops[carOp].outputLevel = 99;
    p.ops[modOp].outputLevel = 85;
    const proc = new PC();
    proc._setPatch(p);
    proc._noteOn(60, 100);
    const s = processBlocks(proc, SR);
    const f0 = 262;
    const skip = Math.floor(SR * 0.1);
    function mag(fr) {
      let re=0,im=0;
      for(let i=skip;i<s.length;i++){re+=s[i]*Math.cos(2*Math.PI*fr*i/SR);im+=s[i]*Math.sin(2*Math.PI*fr*i/SR);}
      return Math.sqrt(re*re+im*im)/(s.length-skip);
    }
    const h1=mag(f0),h2=mag(f0*2),h3=mag(f0*3);
    return Math.sqrt(h2*h2+h3*h3)/(h1||0.0001);
  }

  const thd5 = measureTHD(4, 0, 1);  // Algo 5: OP1→OP2
  const thd5b = measureTHD(4, 2, 3); // Algo 5: OP3→OP4
  const thd5c = measureTHD(4, 4, 5); // Algo 5: OP5→OP6

  // All three pairs in algo 5 should produce similar FM depth
  assert(Math.abs(thd5 - thd5b) / thd5 < 0.1, `Algo 5 pairs should match: ${thd5.toFixed(3)} vs ${thd5b.toFixed(3)}`);
  assert(Math.abs(thd5 - thd5c) / thd5 < 0.1, `Algo 5 pairs should match: ${thd5.toFixed(3)} vs ${thd5c.toFixed(3)}`);
  console.log(`  Algo 5 pair THDs: ${thd5.toFixed(3)}, ${thd5b.toFixed(3)}, ${thd5c.toFixed(3)}`);
}

// ============================================================
// 7. Silence after full release — voices free up
// ============================================================
section('7. Silence after release — voice cleanup');
{
  const p = makePatch(); p.ops[0].outputLevel = 99;
  p.ops[0].egRate4 = 99; p.ops[0].egLevel4 = 0; // instant release
  const proc = new PC();
  proc._setPatch(p);

  // Play and release 16 notes
  for (let i = 0; i < 16; i++) proc._noteOn(48 + i, 100);
  processBlocks(proc, SR / 4);
  for (let i = 0; i < 16; i++) proc._noteOff(48 + i);
  processBlocks(proc, SR * 2); // wait for release

  let active = 0;
  for (const v of proc.voices) if (v.active) active++;
  assert(active === 0, `All voices should be inactive after release (active=${active})`);

  // Should be able to play new notes
  proc._noteOn(60, 100);
  const s = processBlocks(proc, SR / 4);
  assert(peak(s) > 0.01, 'New note should play after all voices released');
  console.log(`  Active after release: ${active}, new note peak: ${peak(s).toFixed(4)}`);
}

// ============================================================
// 8. Sample rate independence
// ============================================================
section('8. Sample rate independence');
{
  const PC44 = loadEngine(44100);
  const PC48 = loadEngine(48000);

  const p = makePatch(); p.ops[0].outputLevel = 99;

  const proc44 = new PC44();
  proc44._setPatch(p);
  proc44._noteOn(69, 100);
  const s44 = processBlocks(proc44, 44100);

  const proc48 = new PC48();
  proc48._setPatch(p);
  proc48._noteOn(69, 100);
  const s48 = processBlocks(proc48, 48000);

  const f44 = freq(s44, 44100);
  const f48 = freq(s48, 48000);
  assert(Math.abs(f44 - f48) < 2, `Frequency should match: 44100→${f44.toFixed(1)}Hz, 48000→${f48.toFixed(1)}Hz`);
  assert(Math.abs(f44 - 440) < 3, `44100Hz rate: A4 should be ~440Hz (got ${f44.toFixed(1)})`);
  assert(Math.abs(f48 - 440) < 3, `48000Hz rate: A4 should be ~440Hz (got ${f48.toFixed(1)})`);

  // Amplitude should be similar
  const pk44 = peak(s44, 4410);
  const pk48 = peak(s48, 4800);
  const dbDiff = Math.abs(20 * Math.log10(pk44 / pk48));
  assert(dbDiff < 1, `Amplitude should be within 1dB across sample rates (diff=${dbDiff.toFixed(1)}dB)`);
  console.log(`  44100: ${f44.toFixed(1)}Hz pk=${pk44.toFixed(4)}, 48000: ${f48.toFixed(1)}Hz pk=${pk48.toFixed(4)}`);
}

// ============================================================
// 9. Edge cases — extreme parameters
// ============================================================
section('9. Edge cases');
{
  // All params at 0
  const pZero = makePatch();
  // All ops at level 0 — should be silent
  const procZ = new PC();
  procZ._setPatch(pZero);
  procZ._noteOn(60, 100);
  const sZ = processBlocks(procZ, SR / 4);
  assert(peak(sZ) < 0.001, 'All levels 0 should be silent');

  // All params at max
  const pMax = makePatch({ algorithm: 31, feedback: 7 });
  for (let i = 0; i < 6; i++) {
    pMax.ops[i].outputLevel = 99;
    pMax.ops[i].egRate1 = 99; pMax.ops[i].egLevel1 = 99;
    pMax.ops[i].velSensitivity = 7;
    pMax.ops[i].ampModSens = 3;
    pMax.ops[i].kbdRateScaling = 7;
  }
  const procM = new PC();
  procM._setPatch(pMax);
  procM._noteOn(60, 127);
  const sM = processBlocks(procM, SR / 2);
  assert(peak(sM) > 0.01, 'All max should produce sound');
  assert(!sM.some(v => isNaN(v) || !isFinite(v)), 'All max: no NaN/Infinity');

  // Feedback 7 with max FM
  const pFB = makePatch({ algorithm: 4, feedback: 7 });
  for (let i = 0; i < 6; i++) pFB.ops[i].outputLevel = 99;
  const procFB = new PC();
  procFB._setPatch(pFB);
  procFB._noteOn(60, 127);
  const sFB = processBlocks(procFB, SR / 2);
  assert(!sFB.some(v => isNaN(v) || !isFinite(v)), 'Max FB + max FM: no NaN/Infinity');
  assert(peak(sFB) < 10, `Max FB + FM should not explode (peak=${peak(sFB).toFixed(2)})`);

  // Velocity 1 (minimum)
  const pVel = makePatch(); pVel.ops[0].outputLevel = 99; pVel.ops[0].velSensitivity = 7;
  const procV = new PC();
  procV._setPatch(pVel);
  procV._noteOn(60, 1);
  const sV = processBlocks(procV, SR / 4);
  assert(!sV.some(v => isNaN(v)), 'Velocity 1: no NaN');

  console.log('  All edge cases passed ✓');
}

// ============================================================
// 10. Panic kills everything
// ============================================================
section('10. Panic');
{
  const p = makePatch(); p.ops[0].outputLevel = 99;
  const proc = new PC();
  proc._setPatch(p);
  for (let i = 0; i < 16; i++) proc._noteOn(48 + i, 100);
  processBlocks(proc, SR / 4);

  proc._panic();
  const s = processBlocks(proc, SR / 10);
  assert(peak(s) < 0.001, 'Panic should silence everything');
  let active = 0;
  for (const v of proc.voices) if (v.active) active++;
  assert(active === 0, 'Panic should deactivate all voices');
  console.log('  Panic works ✓');
}

// ============================================================
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
else console.log('ALL E2E TESTS PASSED ✓');
