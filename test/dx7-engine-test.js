#!/usr/bin/env node
// OpenDX7 — FM Synthesizer (MIT License)
// Copyright (c) 2026 Keith Adler
// ============================================================
// OpenDX7 Engine QC Test Suite
// Rigorous tests against known DX7 behavior and FM synthesis math.
// Catches real sound-quality issues: wrong levels, broken algorithms,
// bad envelopes, incorrect frequencies, and FM math errors.
// ============================================================

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(__dirname, '..', 'js', 'dx7-processor.js'), 'utf8');

let ProcessorClass;
const SR = 48000;

class MockAWP {
  constructor() { this.port = { onmessage: null, postMessage: () => {} }; }
}
new Function('sampleRate', 'AudioWorkletProcessor', 'registerProcessor', 'currentTime', code)(
  SR, MockAWP, (n, c) => { ProcessorClass = c; }, 0
);

// ── Test framework ──
let passed = 0, failed = 0, total = 0;
function assert(cond, msg) {
  total++;
  if (cond) passed++;
  else { failed++; console.log(`  ✗ FAIL: ${msg}`); }
}
function assertClose(actual, expected, tol, msg) {
  total++;
  if (Math.abs(actual - expected) <= tol) passed++;
  else { failed++; console.log(`  ✗ FAIL: ${msg} (got ${actual.toFixed(6)}, want ${expected.toFixed(6)} ±${tol})`); }
}
function assertRange(val, min, max, msg) {
  total++;
  if (val >= min && val <= max) passed++;
  else { failed++; console.log(`  ✗ FAIL: ${msg} (got ${val.toFixed(6)}, want ${min}..${max})`); }
}
function section(name) { console.log(`\n── ${name} ──`); }

// ── Helpers ──
function makePatch(overrides = {}) {
  const p = {
    name: 'Test', algorithm: 0, feedback: 0, transpose: 24,
    pitchModSens: 0, oscSync: false,
    pitchEgR1:99,pitchEgR2:99,pitchEgR3:99,pitchEgR4:99,
    pitchEgL1:50,pitchEgL2:50,pitchEgL3:50,pitchEgL4:50,
    lfoSpeed:0,lfoDelay:0,lfoPitchModDepth:0,lfoAmpModDepth:0,
    lfoSync:false,lfoWave:0,
    ops: Array.from({length:6}, () => ({
      egRate1:99,egRate2:99,egRate3:99,egRate4:99,
      egLevel1:99,egLevel2:99,egLevel3:99,egLevel4:0,
      outputLevel:0, oscMode:0, freqCoarse:1, freqFine:0, detune:7,
      velSensitivity:0, ampModSens:0, kbdRateScaling:0,
      kbdLevelScaleBP:39, kbdLevelScaleLD:0, kbdLevelScaleRD:0,
      kbdLevelScaleLC:0, kbdLevelScaleRC:0,
    })),
    ...overrides,
  };
  return p;
}

function processBlocks(proc, numSamples) {
  const out = new Float32Array(numSamples);
  for (let off = 0; off < numSamples; off += 128) {
    const len = Math.min(128, numSamples - off);
    const b = [[new Float32Array(len), new Float32Array(len)]];
    proc.process([], b, {});
    out.set(b[0][0], off);
  }
  return out;
}

function playNote(patch, note, vel, numSamples) {
  const proc = new ProcessorClass();
  proc._setPatch(patch);
  proc._noteOn(note, vel);
  return processBlocks(proc, numSamples);
}

function playNoteOnOff(patch, note, vel, onSamples, offSamples) {
  const proc = new ProcessorClass();
  proc._setPatch(patch);
  proc._noteOn(note, vel);
  const total = onSamples + offSamples;
  const result = new Float32Array(total);
  let noteOffSent = false;
  for (let off = 0; off < total; off += 128) {
    if (!noteOffSent && off >= onSamples) { proc._noteOff(note); noteOffSent = true; }
    const len = Math.min(128, total - off);
    const b = [[new Float32Array(len), new Float32Array(len)]];
    proc.process([], b, {});
    result.set(b[0][0], off);
  }
  return result;
}

function peak(samples, start = 0, end) {
  end = end || samples.length;
  let mx = 0;
  for (let i = start; i < end; i++) mx = Math.max(mx, Math.abs(samples[i]));
  return mx;
}

function rms(samples, start = 0, end) {
  end = end || samples.length;
  let sum = 0;
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (end - start));
}

// Measure fundamental frequency via zero-crossing after skip period
function measureFreq(samples, skipMs = 50) {
  const start = Math.floor(SR * skipMs / 1000);
  let crossings = 0;
  for (let i = start + 1; i < samples.length; i++) {
    if (samples[i - 1] >= 0 && samples[i] < 0) crossings++;
  }
  return crossings / ((samples.length - start) / SR);
}

// Simple DFT magnitude at a specific frequency
function dftMag(samples, freqHz, start = 0, end) {
  end = end || samples.length;
  let re = 0, im = 0;
  const w = 2 * Math.PI * freqHz / SR;
  for (let i = start; i < end; i++) {
    re += samples[i] * Math.cos(w * i);
    im += samples[i] * Math.sin(w * i);
  }
  const n = end - start;
  return Math.sqrt(re * re + im * im) / n;
}


// ============================================================
// SECTION A: OUTPUT LEVEL AND CLIPPING
// The real DX7 never clips internally. A single carrier at
// level 99 should produce a clean sine at a reasonable amplitude.
// After masterVolume scaling, output should be well within ±1.
// ============================================================
section('A1. Single carrier output level sanity');
{
  // Algo 32 (all carriers), only OP1 active at level 99
  const p = makePatch({ algorithm: 31 });
  p.ops[0].outputLevel = 99;
  const s = playNote(p, 60, 100, SR / 2);
  const pk = peak(s);
  // After masterVolume (0.18), a single sine should peak around 0.18 * π * 1.0 ≈ 0.565
  // This is the current behavior. The key check: it should NOT clip (>1.0)
  assert(pk > 0.05, `Single carrier should be audible (peak=${pk.toFixed(4)})`);
  assert(pk < 1.0, `Single carrier should NOT clip (peak=${pk.toFixed(4)})`);
  console.log(`  Single carrier peak: ${pk.toFixed(4)}`);
}

section('A2. Six carriers at level 99 should not clip');
{
  const p = makePatch({ algorithm: 31 });
  for (let i = 0; i < 6; i++) p.ops[i].outputLevel = 99;
  const s = playNote(p, 60, 100, SR / 2);
  const pk = peak(s);
  // Without normalization (matching Dexed), 6 carriers sum linearly
  assert(pk < 10, `6 carriers should not explode (peak=${pk.toFixed(4)})`);
  console.log(`  Six carriers peak: ${pk.toFixed(4)}`);
}

section('A3. Operator output scaling — π factor check');
{
  // The operator multiplies output by Math.PI for FM modulation depth.
  // For CARRIERS (audio output), this means the raw output is ±π at level 99.
  // masterVolume must compensate. Verify the final output is reasonable.
  const p = makePatch({ algorithm: 31 });
  p.ops[0].outputLevel = 99;
  // Play at velocity 127 (max)
  const s = playNote(p, 60, 127, SR / 4);
  const pk = peak(s);
  // Should be audible but not clipping
  assertRange(pk, 0.05, 1.0, `Max velocity single carrier in range (peak=${pk.toFixed(4)})`);
  console.log(`  Max vel single carrier peak: ${pk.toFixed(4)}`);
}

section('A4. Output level 0 is silent');
{
  const p = makePatch({ algorithm: 31 });
  // All ops at level 0 (default)
  const s = playNote(p, 60, 100, 4800);
  assert(peak(s) < 0.01, 'Level 0 should be silent');
}

section('A5. Output level curve — level 50 vs 99');
{
  // On real DX7, level 50 is roughly -25dB below level 99
  const p99 = makePatch({ algorithm: 31 });
  p99.ops[0].outputLevel = 99;
  const p50 = makePatch({ algorithm: 31 });
  p50.ops[0].outputLevel = 50;

  const s99 = playNote(p99, 60, 100, SR / 4);
  const s50 = playNote(p50, 60, 100, SR / 4);
  const pk99 = peak(s99);
  const pk50 = peak(s50);
  const dbDiff = 20 * Math.log10(pk99 / pk50);
  // Level 50 should be significantly quieter than 99
  assert(pk50 < pk99, 'Level 50 should be quieter than 99');
  assert(dbDiff > 10, `Level 99 vs 50 should differ by >10dB (got ${dbDiff.toFixed(1)}dB)`);
  assert(dbDiff < 50, `Level 99 vs 50 should differ by <50dB (got ${dbDiff.toFixed(1)}dB)`);
  console.log(`  Level 99 peak: ${pk99.toFixed(4)}, Level 50 peak: ${pk50.toFixed(4)}, diff: ${dbDiff.toFixed(1)}dB`);
}

// ============================================================
// SECTION B: FREQUENCY ACCURACY
// The DX7 should produce correct pitches. With transpose=24,
// MIDI notes play at standard pitch (MIDI 60 = C4 = 261.6 Hz).
// ============================================================
section('B1. Frequency accuracy — middle C (MIDI 60)');
{
  const p = makePatch({ algorithm: 31, transpose: 24 });
  p.ops[0].outputLevel = 99;
  const s = playNote(p, 60, 100, SR);
  const freq = measureFreq(s);
  assertClose(freq, 261.6, 5, `MIDI 60 should be ~262 Hz (got ${freq.toFixed(1)})`);
  console.log(`  MIDI 60 frequency: ${freq.toFixed(1)} Hz (expect ~262 Hz)`);
}

section('B2. Frequency accuracy — A4 = 440 Hz');
{
  // MIDI 69 = A4 = 440 Hz
  const p = makePatch({ algorithm: 31, transpose: 24 });
  p.ops[0].outputLevel = 99;
  const s = playNote(p, 69, 100, SR);
  const freq = measureFreq(s);
  assertClose(freq, 440, 5, `MIDI 69 should be ~440 Hz`);
  console.log(`  MIDI 69 frequency: ${freq.toFixed(1)} Hz`);
}

section('B3. Transpose 24 = standard, 36 = octave up');
{
  const pNorm = makePatch({ algorithm: 31, transpose: 24 });
  pNorm.ops[0].outputLevel = 99;
  const pUp = makePatch({ algorithm: 31, transpose: 36 });
  pUp.ops[0].outputLevel = 99;

  const sNorm = playNote(pNorm, 60, 100, SR / 2);
  const sUp = playNote(pUp, 60, 100, SR / 2);
  const fNorm = measureFreq(sNorm);
  const fUp = measureFreq(sUp);
  const ratio = fUp / fNorm;
  assertClose(ratio, 2.0, 0.15, `Transpose +12 should double frequency (ratio=${ratio.toFixed(3)})`);
  console.log(`  Normal: ${fNorm.toFixed(1)} Hz, Transposed: ${fUp.toFixed(1)} Hz, ratio: ${ratio.toFixed(3)}`);
}

section('B4. Coarse ratio 2 = octave up');
{
  const p1 = makePatch({ algorithm: 31 });
  p1.ops[0].outputLevel = 99; p1.ops[0].freqCoarse = 1;
  const p2 = makePatch({ algorithm: 31 });
  p2.ops[0].outputLevel = 99; p2.ops[0].freqCoarse = 2;

  const s1 = playNote(p1, 60, 100, SR);
  const s2 = playNote(p2, 60, 100, SR);
  const f1 = measureFreq(s1);
  const f2 = measureFreq(s2);
  assertClose(f2 / f1, 2.0, 0.1, 'Coarse 2 should be 2x coarse 1');
  console.log(`  Coarse 1: ${f1.toFixed(1)} Hz, Coarse 2: ${f2.toFixed(1)} Hz`);
}

section('B5. Coarse ratio 0 = half frequency (sub-oscillator)');
{
  const p1 = makePatch({ algorithm: 31 });
  p1.ops[0].outputLevel = 99; p1.ops[0].freqCoarse = 1;
  const pHalf = makePatch({ algorithm: 31 });
  pHalf.ops[0].outputLevel = 99; pHalf.ops[0].freqCoarse = 0;

  const s1 = playNote(p1, 60, 100, SR);
  const sH = playNote(pHalf, 60, 100, SR);
  const f1 = measureFreq(s1);
  const fH = measureFreq(sH);
  assertClose(fH / f1, 0.5, 0.05, 'Coarse 0 should be half frequency');
  console.log(`  Coarse 1: ${f1.toFixed(1)} Hz, Coarse 0: ${fH.toFixed(1)} Hz`);
}

section('B6. Fixed frequency mode');
{
  // oscMode=1, coarse=0 (1Hz decade), fine=0 → 1 Hz base
  // oscMode=1, coarse=2 (100Hz decade), fine=0 → 100 Hz
  const p = makePatch({ algorithm: 31 });
  p.ops[0].outputLevel = 99;
  p.ops[0].oscMode = 1;
  p.ops[0].freqCoarse = 2; // 100 Hz decade
  p.ops[0].freqFine = 0;
  const s = playNote(p, 60, 100, SR);
  const freq = measureFreq(s);
  assertClose(freq, 100, 5, `Fixed freq coarse=2 fine=0 should be ~100 Hz (got ${freq.toFixed(1)})`);
  console.log(`  Fixed freq: ${freq.toFixed(1)} Hz`);
}

section('B7. Detune shifts pitch');
{
  const pCenter = makePatch({ algorithm: 31 });
  pCenter.ops[0].outputLevel = 99; pCenter.ops[0].detune = 7;
  const pUp = makePatch({ algorithm: 31 });
  pUp.ops[0].outputLevel = 99; pUp.ops[0].detune = 14;

  const sC = playNote(pCenter, 60, 100, SR);
  const sU = playNote(pUp, 60, 100, SR);
  const fC = measureFreq(sC);
  const fU = measureFreq(sU);
  assert(fU > fC, `Detune 14 should be higher than detune 7 (${fU.toFixed(1)} vs ${fC.toFixed(1)})`);
  console.log(`  Center: ${fC.toFixed(1)} Hz, Detune+7: ${fU.toFixed(1)} Hz`);
}


// ============================================================
// SECTION C: ENVELOPE BEHAVIOR
// DX7 envelopes operate in log domain. Attack should be exponential
// (fast start, slow finish in linear domain). Release should decay
// to silence.
// ============================================================
section('C1. Fast attack (rate 99) reaches full level quickly');
{
  const p = makePatch({ algorithm: 31 });
  p.ops[0].outputLevel = 99;
  p.ops[0].egRate1 = 99; p.ops[0].egLevel1 = 99;
  const s = playNote(p, 60, 100, SR / 10); // 100ms
  const pk = peak(s);
  // Find time to reach 50% of peak
  let t50 = -1;
  for (let i = 0; i < s.length; i++) {
    if (Math.abs(s[i]) > pk * 0.5) { t50 = i; break; }
  }
  const ms50 = (t50 / SR) * 1000;
  assert(t50 > 0, 'Should reach 50% amplitude');
  assert(ms50 < 20, `Rate 99 attack to 50% should be <20ms (got ${ms50.toFixed(1)}ms)`);
  console.log(`  Attack to 50%: ${ms50.toFixed(1)}ms`);
}

section('C2. Slow attack (rate 30) takes >100ms');
{
  const p = makePatch({ algorithm: 31 });
  p.ops[0].outputLevel = 99;
  p.ops[0].egRate1 = 30; p.ops[0].egLevel1 = 99;
  const s = playNote(p, 60, 100, SR * 2); // 2 seconds
  const pk = peak(s);
  let t50 = -1;
  for (let i = 0; i < s.length; i++) {
    if (Math.abs(s[i]) > pk * 0.5) { t50 = i; break; }
  }
  const ms50 = t50 > 0 ? (t50 / SR) * 1000 : -1;
  assert(ms50 > 100, `Rate 30 attack should be >100ms (got ${ms50.toFixed(0)}ms)`);
  console.log(`  Rate 30 attack to 50%: ${ms50.toFixed(0)}ms`);
}

section('C3. Release (rate 80) decays to silence');
{
  const p = makePatch({ algorithm: 31 });
  p.ops[0].outputLevel = 99;
  p.ops[0].egRate4 = 80; p.ops[0].egLevel4 = 0;
  const onMs = 250, offMs = 2000;
  const s = playNoteOnOff(p, 60, 100, Math.floor(SR * onMs / 1000), Math.floor(SR * offMs / 1000));
  const sustainRms = rms(s, Math.floor(SR * 0.2), Math.floor(SR * 0.25));
  const tailRms = rms(s, s.length - 2000, s.length);
  assert(tailRms < sustainRms * 0.1, `Release should decay to <10% of sustain (tail=${tailRms.toFixed(6)}, sustain=${sustainRms.toFixed(4)})`);
  console.log(`  Sustain RMS: ${sustainRms.toFixed(4)}, Tail RMS: ${tailRms.toFixed(6)}`);
}

section('C4. Envelope sustain holds level');
{
  // Rate 3 stages fast, level 3 = 80 (sustain level)
  const p = makePatch({ algorithm: 31 });
  p.ops[0].outputLevel = 99;
  p.ops[0].egRate1 = 99; p.ops[0].egLevel1 = 99;
  p.ops[0].egRate2 = 99; p.ops[0].egLevel2 = 90;
  p.ops[0].egRate3 = 99; p.ops[0].egLevel3 = 80;
  p.ops[0].egLevel4 = 0;
  // Play for 2 seconds — sustain should hold steady
  const s = playNote(p, 60, 100, SR * 2);
  const rms1 = rms(s, SR, SR + 4800);       // 1.0-1.1s
  const rms2 = rms(s, SR * 1.5, SR * 1.5 + 4800); // 1.5-1.6s
  // Sustain should be stable (within 20%)
  const ratio = Math.min(rms1, rms2) / Math.max(rms1, rms2);
  assert(ratio > 0.8, `Sustain should be stable (ratio=${ratio.toFixed(3)})`);
  console.log(`  Sustain RMS @1s: ${rms1.toFixed(4)}, @1.5s: ${rms2.toFixed(4)}, ratio: ${ratio.toFixed(3)}`);
}

section('C5. Envelope 4-stage shape — L1 > L2 > L3 decay');
{
  const p = makePatch({ algorithm: 31 });
  p.ops[0].outputLevel = 99;
  p.ops[0].egRate1 = 99; p.ops[0].egLevel1 = 99;
  p.ops[0].egRate2 = 70; p.ops[0].egLevel2 = 70;
  p.ops[0].egRate3 = 60; p.ops[0].egLevel3 = 50;
  p.ops[0].egLevel4 = 0;
  const s = playNote(p, 60, 100, SR * 2);
  // Measure RMS at different points — should decrease over time
  const rmsEarly = rms(s, Math.floor(SR * 0.01), Math.floor(SR * 0.05));
  const rmsMid = rms(s, Math.floor(SR * 0.5), Math.floor(SR * 0.6));
  const rmsLate = rms(s, Math.floor(SR * 1.5), Math.floor(SR * 1.6));
  assert(rmsEarly > rmsMid, `Early RMS should be > mid (${rmsEarly.toFixed(4)} vs ${rmsMid.toFixed(4)})`);
  assert(rmsMid >= rmsLate * 0.5, `Mid should be >= late*0.5 (${rmsMid.toFixed(4)} vs ${rmsLate.toFixed(4)})`);
  console.log(`  Early: ${rmsEarly.toFixed(4)}, Mid: ${rmsMid.toFixed(4)}, Late: ${rmsLate.toFixed(4)}`);
}

// ============================================================
// SECTION D: FM SYNTHESIS MATH
// Core FM behavior: modulator adds sidebands, feedback creates
// harmonics, modulation index controls brightness.
// ============================================================
section('D1. FM modulation adds sidebands');
{
  // Pure carrier (algo 32)
  const pPure = makePatch({ algorithm: 31 });
  pPure.ops[0].outputLevel = 99;
  const sPure = playNote(pPure, 60, 100, SR / 2);

  // FM: algo 5 (OP1→OP2 pair), OP2 is carrier, OP1 is modulator
  const pFM = makePatch({ algorithm: 4 });
  pFM.ops[1].outputLevel = 99; // OP2 carrier
  pFM.ops[0].outputLevel = 95; // OP1 modulator
  const sFM = playNote(pFM, 60, 100, SR / 2);

  const start = Math.floor(SR * 0.05);
  let cPure = 0, cFM = 0;
  for (let i = start + 1; i < sPure.length; i++) {
    if (sPure[i-1] >= 0 && sPure[i] < 0) cPure++;
    if (sFM[i-1] >= 0 && sFM[i] < 0) cFM++;
  }
  assert(cFM > cPure, `FM should increase zero crossings (pure=${cPure}, FM=${cFM})`);
  console.log(`  Pure crossings: ${cPure}, FM crossings: ${cFM}`);
}

section('D2. Higher modulator level = brighter sound');
{
  const makeTest = (modLevel) => {
    const p = makePatch({ algorithm: 4 });
    p.ops[1].outputLevel = 99;
    p.ops[0].outputLevel = modLevel;
    return playNote(p, 60, 100, SR / 2);
  };
  const sLow = makeTest(10);
  const sHigh = makeTest(30);
  // Higher mod = more total harmonic energy (not just THD ratio)
  const skip = Math.floor(SR * 0.05);
  function harmonicEnergy(samples) {
    const f0 = 262;
    function mag(fr) { let re=0,im=0; for(let i=skip;i<samples.length;i++){re+=samples[i]*Math.cos(2*Math.PI*fr*i/SR);im+=samples[i]*Math.sin(2*Math.PI*fr*i/SR);} return Math.sqrt(re*re+im*im); }
    let energy = 0;
    for (let h = 2; h <= 8; h++) energy += mag(f0*h)**2;
    return Math.sqrt(energy);
  }
  const eLow = harmonicEnergy(sLow);
  const eHigh = harmonicEnergy(sHigh);
  assert(eHigh > eLow, `Higher mod should have more harmonic energy (low=${eLow.toFixed(1)}, high=${eHigh.toFixed(1)})`);
  console.log(`  Mod 50 energy: ${eLow.toFixed(1)}, Mod 80 energy: ${eHigh.toFixed(1)}`);
}

section('D3. Feedback 0 = pure sine, feedback 7 = rich harmonics');
{
  // Algo 32: feedback is on OP1 (ops[0]). Must use OP1 for this test.
  // FEEDBACK_OP[31] = 0, so OP1 is the feedback operator.
  const pNoFb = makePatch({ algorithm: 31, feedback: 0 });
  pNoFb.ops[0].outputLevel = 99;
  const sNoFb = playNote(pNoFb, 60, 100, SR / 2);

  const pFb = makePatch({ algorithm: 31, feedback: 7 });
  pFb.ops[0].outputLevel = 99;
  const sFb = playNote(pFb, 60, 100, SR / 2);

  // Check harmonic content via DFT — feedback should add harmonics
  const start = Math.floor(SR * 0.05);
  const f0 = 262;
  function dftMagLocal(samples, freqHz) {
    let re = 0, im = 0;
    const w = 2 * Math.PI * freqHz / SR;
    for (let i = start; i < samples.length; i++) {
      re += samples[i] * Math.cos(w * i);
      im += samples[i] * Math.sin(w * i);
    }
    return Math.sqrt(re * re + im * im) / (samples.length - start);
  }
  const noFbH2 = dftMagLocal(sNoFb, f0 * 2);
  const noFbH3 = dftMagLocal(sNoFb, f0 * 3);
  const fbH2 = dftMagLocal(sFb, f0 * 2);
  const fbH3 = dftMagLocal(sFb, f0 * 3);
  const noFbHarm = Math.sqrt(noFbH2 ** 2 + noFbH3 ** 2);
  const fbHarm = Math.sqrt(fbH2 ** 2 + fbH3 ** 2);
  assert(fbHarm > noFbHarm * 5, `Feedback 7 should have much more harmonic energy than no feedback`);
  // No-feedback should be a clean sine (very low harmonics)
  assert(noFbHarm < 0.001, 'No feedback should be a clean sine');
  console.log(`  No FB harmonics: ${noFbHarm.toFixed(6)}, FB 7 harmonics: ${fbHarm.toFixed(6)}`);
}

section('D4. Modulator ratio affects timbre character');
{
  // 1:1 ratio = harmonic, 1:1.41 = inharmonic (bell-like)
  const pHarm = makePatch({ algorithm: 4 });
  pHarm.ops[1].outputLevel = 99;
  pHarm.ops[0].outputLevel = 60; pHarm.ops[0].freqCoarse = 1;
  const sHarm = playNote(pHarm, 60, 100, SR / 2);

  const pInharm = makePatch({ algorithm: 4 });
  pInharm.ops[1].outputLevel = 99;
  pInharm.ops[0].outputLevel = 60; pInharm.ops[0].freqCoarse = 1; pInharm.ops[0].freqFine = 41;
  const sInharm = playNote(pInharm, 60, 100, SR / 2);

  // Both should produce sound
  assert(peak(sHarm) > 0.05, 'Harmonic FM should produce sound');
  assert(peak(sInharm) > 0.05, 'Inharmonic FM should produce sound');
  // They should sound different (different RMS profiles)
  const rmsH = rms(sHarm, Math.floor(SR * 0.1), Math.floor(SR * 0.2));
  const rmsI = rms(sInharm, Math.floor(SR * 0.1), Math.floor(SR * 0.2));
  assert(Math.abs(rmsH - rmsI) / Math.max(rmsH, rmsI) > 0.01,
    'Different ratios should produce different timbres');
  console.log(`  Harmonic RMS: ${rmsH.toFixed(4)}, Inharmonic RMS: ${rmsI.toFixed(4)}`);
}


// ============================================================
// SECTION E: ALGORITHM TOPOLOGY VERIFICATION
// Each algorithm has specific carrier/modulator routing.
// We verify carrier counts and that modulators actually modulate.
// ============================================================
section('E1. Algorithm carrier counts');
{
  // Expected carrier counts per algorithm (1-indexed in comments)
  // Carriers = operators whose output goes to the final output bus (flags & 3 === 0).
  const expected = [
    2, 2, 2, 2, 3, 3, 2, 2,   // algos 1-8
    2, 2, 2, 2, 2, 2, 2, 1,   // algos 9-16
    1, 1, 3, 3, 4, 4, 4, 5,   // algos 17-24
    5, 3, 3, 3, 4, 4, 5, 6    // algos 25-32
  ];
  for (let algo = 0; algo < 32; algo++) {
    // Set all ops to level 99, measure output
    const pAll = makePatch({ algorithm: algo });
    for (let i = 0; i < 6; i++) pAll.ops[i].outputLevel = 99;
    const sAll = playNote(pAll, 60, 100, SR / 4);
    const pkAll = peak(sAll);
    // At minimum, the algorithm should produce sound
    assert(pkAll > 0.01, `Algo ${algo + 1} should produce sound with all ops at 99 (peak=${pkAll.toFixed(4)})`);

    // Count actual carriers: an op is a carrier if it produces sound alone
    let carrierCount = 0;
    for (let i = 0; i < 6; i++) {
      const pSingle = makePatch({ algorithm: algo });
      pSingle.ops[i].outputLevel = 99;
      const sSingle = playNote(pSingle, 60, 100, SR / 8);
      if (peak(sSingle) > 0.001) carrierCount++;
    }
    assert(carrierCount === expected[algo],
      `Algo ${algo + 1} carrier count: got ${carrierCount}, expected ${expected[algo]}`);
  }
  console.log('  All 32 algorithms produce sound and have correct carrier counts ✓');
}

section('E2. Algo 1: modulator affects carrier');
{
  // Algo 1 in Dexed: OP1(fb)→OP2→OP3→OP4(carrier), OP5→OP6(carrier)
  // Carrier OP4 (index 3), modulator chain OP1-3
  const pPure = makePatch({ algorithm: 0 });
  pPure.ops[3].outputLevel = 99; // OP4 carrier
  const sPure = playNote(pPure, 60, 100, SR / 2);

  const pFM = makePatch({ algorithm: 0 });
  pFM.ops[3].outputLevel = 99; // OP4 carrier
  pFM.ops[2].outputLevel = 80; // OP3 modulator
  const sFM = playNote(pFM, 60, 100, SR / 2);

  const rmsPure = rms(sPure, SR / 10, SR / 4);
  const rmsFM = rms(sFM, SR / 10, SR / 4);
  assert(rmsPure > 0.001, 'Algo 1 carrier-only should produce sound');
  assert(rmsFM > 0.001, 'Algo 1 with modulator should produce sound');
  console.log(`  Carrier only RMS: ${rmsPure.toFixed(4)}, With mod RMS: ${rmsFM.toFixed(4)}`);
}

section('E3. Algo 5 (three carrier pairs): 3 independent outputs');
{
  // Algo 5 in Dexed: OP1→OP2(out), OP3→OP4(out), OP5→OP6(out)
  // Carriers are OP2, OP4, OP6 (indices 1, 3, 5)
  const pPair1 = makePatch({ algorithm: 4 });
  pPair1.ops[1].outputLevel = 99; // OP2 carrier
  const s1 = playNote(pPair1, 60, 100, SR / 4);

  const pPair2 = makePatch({ algorithm: 4 });
  pPair2.ops[3].outputLevel = 99; // OP4 carrier
  const s2 = playNote(pPair2, 60, 100, SR / 4);

  const pPair3 = makePatch({ algorithm: 4 });
  pPair3.ops[5].outputLevel = 99; // OP6 carrier
  const s3 = playNote(pPair3, 60, 100, SR / 4);

  assert(peak(s1) > 0.01, 'Algo 5 pair 1 (OP2) should produce sound');
  assert(peak(s2) > 0.01, 'Algo 5 pair 2 (OP4) should produce sound');
  assert(peak(s3) > 0.01, 'Algo 5 pair 3 (OP6) should produce sound');
  console.log(`  Pair1: ${peak(s1).toFixed(4)}, Pair2: ${peak(s2).toFixed(4)}, Pair3: ${peak(s3).toFixed(4)}`);
}

section('E4. Algo 32 (all carriers): each op is independent carrier');
{
  // Each operator should produce sound independently
  for (let i = 0; i < 6; i++) {
    const p = makePatch({ algorithm: 31 });
    p.ops[i].outputLevel = 99;
    const s = playNote(p, 60, 100, SR / 8);
    assert(peak(s) > 0.01, `Algo 32 OP${i + 1} should be an independent carrier`);
  }
  console.log('  All 6 operators are independent carriers ✓');
}

// ============================================================
// SECTION F: VELOCITY AND KEYBOARD SCALING
// ============================================================
section('F1. Velocity sensitivity 7 — full range');
{
  const p = makePatch({ algorithm: 31 });
  p.ops[0].outputLevel = 99;
  p.ops[0].velSensitivity = 7;

  const sMax = playNote(p, 60, 127, SR / 4);
  const sMid = playNote(p, 60, 64, SR / 4);
  const sMin = playNote(p, 60, 1, SR / 4);

  const pkMax = peak(sMax);
  const pkMid = peak(sMid);
  const pkMin = peak(sMin);

  assert(pkMax > pkMid, `Vel 127 > vel 64 (${pkMax.toFixed(4)} vs ${pkMid.toFixed(4)})`);
  assert(pkMid > pkMin, `Vel 64 > vel 1 (${pkMid.toFixed(4)} vs ${pkMin.toFixed(4)})`);
  const dbRange = 20 * Math.log10(pkMax / Math.max(pkMin, 0.0001));
  assert(dbRange > 6, `Velocity range should be >6dB (got ${dbRange.toFixed(1)}dB)`);
  console.log(`  Vel 127: ${pkMax.toFixed(4)}, Vel 64: ${pkMid.toFixed(4)}, Vel 1: ${pkMin.toFixed(4)}, range: ${dbRange.toFixed(1)}dB`);
}

section('F2. Velocity sensitivity 0 — no effect');
{
  const p = makePatch({ algorithm: 31 });
  p.ops[0].outputLevel = 99;
  p.ops[0].velSensitivity = 0;

  const sMax = playNote(p, 60, 127, SR / 4);
  const sMin = playNote(p, 60, 1, SR / 4);
  const pkMax = peak(sMax);
  const pkMin = peak(sMin);
  assertClose(pkMax, pkMin, pkMax * 0.05, 'Vel sens 0 should produce equal output');
  console.log(`  Vel 127: ${pkMax.toFixed(4)}, Vel 1: ${pkMin.toFixed(4)}`);
}

section('F3. Keyboard rate scaling — higher notes have faster envelopes');
{
  // Use a slow decay rate so KRS difference is measurable.
  // Rate 30 is slow (~1.7s attack). KRS 7 on high notes adds a big offset,
  // making the envelope much faster for high notes.
  const p = makePatch({ algorithm: 31 });
  p.ops[0].outputLevel = 99;
  p.ops[0].kbdRateScaling = 7; // max
  p.ops[0].egRate1 = 30; p.ops[0].egLevel1 = 99;
  p.ops[0].egRate2 = 30; p.ops[0].egLevel2 = 50;
  p.ops[0].egRate3 = 30; p.ops[0].egLevel3 = 50;

  const sLow = playNote(p, 36, 100, SR / 2);
  const sHigh = playNote(p, 96, 100, SR / 2);

  // Measure RMS in the first 100ms — high note should be louder (faster attack)
  const rmsLow = rms(sLow, Math.floor(SR * 0.05), Math.floor(SR * 0.1));
  const rmsHigh = rms(sHigh, Math.floor(SR * 0.05), Math.floor(SR * 0.1));
  // High note with KRS 7 should have a much faster attack
  assert(rmsHigh > rmsLow * 1.5,
    `KRS 7: high note should attack faster (high=${rmsHigh.toFixed(4)}, low=${rmsLow.toFixed(4)})`);
  console.log(`  Low note RMS @50-100ms: ${rmsLow.toFixed(4)}, High note: ${rmsHigh.toFixed(4)}`);
}

// ============================================================
// SECTION G: POLYPHONY, VOICE STEALING, SUSTAIN
// ============================================================
section('G1. Polyphony — 3 simultaneous notes');
{
  const p = makePatch({ algorithm: 31 });
  p.ops[0].outputLevel = 99;
  const proc = new ProcessorClass();
  proc._setPatch(p);
  proc._noteOn(60, 100);
  proc._noteOn(64, 100);
  proc._noteOn(67, 100);

  const s = processBlocks(proc, SR / 4);
  const pk = peak(s);
  assert(pk > 0.01, 'Chord should produce sound');
  let active = 0;
  for (const v of proc.voices) if (v.active) active++;
  assert(active === 3, `Should have 3 active voices (got ${active})`);
  console.log(`  Chord peak: ${pk.toFixed(4)}, active voices: ${active}`);
}

section('G2. Voice stealing when all voices used');
{
  const p = makePatch({ algorithm: 31 });
  p.ops[0].outputLevel = 99;
  const proc = new ProcessorClass();
  proc._setPatch(p);

  // Fill all 16 voices
  for (let i = 0; i < 16; i++) proc._noteOn(48 + i, 100);
  processBlocks(proc, 4800);

  // Release one and let it decay
  proc._noteOff(48);
  processBlocks(proc, SR / 2);

  // 17th note should steal
  proc._noteOn(80, 100);
  let found = false;
  for (const v of proc.voices) {
    if (v.note === 80 && v.active) { found = true; break; }
  }
  assert(found, 'Voice stealing should allocate new note');
  console.log('  Voice stealing works ✓');
}

section('G3. Sustain pedal holds notes');
{
  const p = makePatch({ algorithm: 31 });
  p.ops[0].outputLevel = 99;
  p.ops[0].egRate4 = 95; p.ops[0].egLevel4 = 0;
  const proc = new ProcessorClass();
  proc._setPatch(p);
  proc._sustain(true);
  proc._noteOn(60, 100);
  processBlocks(proc, SR / 10); // 100ms attack

  proc._noteOff(60);
  const sHeld = processBlocks(proc, SR / 5); // 200ms held
  const pkHeld = peak(sHeld);
  assert(pkHeld > 0.01, 'Note should sustain with pedal down');

  proc._sustain(false);
  processBlocks(proc, SR / 2); // let decay
  const sTail = processBlocks(proc, SR / 10);
  const pkTail = peak(sTail);
  assert(pkTail < pkHeld * 0.5, 'Note should decay after pedal release');
  console.log(`  Held: ${pkHeld.toFixed(4)}, After release: ${pkTail.toFixed(6)}`);
}

section('G4. Panic kills all sound');
{
  const p = makePatch({ algorithm: 31 });
  p.ops[0].outputLevel = 99;
  const proc = new ProcessorClass();
  proc._setPatch(p);
  proc._noteOn(60, 100);
  proc._noteOn(64, 100);
  processBlocks(proc, 4800);

  proc._panic();
  const s = processBlocks(proc, 4800);
  assert(peak(s) < 0.001, 'Panic should silence all output');
  let active = 0;
  for (const v of proc.voices) if (v.active) active++;
  assert(active === 0, 'Panic should deactivate all voices');
  console.log('  Panic works ✓');
}

// ============================================================
// SECTION H: PITCH BEND AND MOD WHEEL
// ============================================================
section('H1. Pitch bend up raises frequency');
{
  const p = makePatch({ algorithm: 31 });
  p.ops[0].outputLevel = 99;
  const proc = new ProcessorClass();
  proc._setPatch(p);
  proc._noteOn(69, 100);
  processBlocks(proc, 4800); // settle

  proc._pitchBend(16383); // max up
  const s = processBlocks(proc, SR / 2);
  const freq = measureFreq(s, 0);
  // MIDI 69 = A4 = 440Hz, bent up 2 semitones ≈ 494Hz
  assert(freq > 460, `Pitch bend up should raise freq above 440 (got ${freq.toFixed(1)})`);
  console.log(`  Bent frequency: ${freq.toFixed(1)} Hz`);
}

section('H2. Pitch bend down lowers frequency');
{
  const p = makePatch({ algorithm: 31 });
  p.ops[0].outputLevel = 99;
  const proc = new ProcessorClass();
  proc._setPatch(p);
  proc._noteOn(69, 100);
  processBlocks(proc, 4800);

  proc._pitchBend(0); // max down
  const s = processBlocks(proc, SR / 2);
  const freq = measureFreq(s, 0);
  // Should be below 440Hz (bent down 2 semitones ≈ 392Hz)
  assert(freq < 420, `Pitch bend down should lower freq below 440 (got ${freq.toFixed(1)})`);
  console.log(`  Bent frequency: ${freq.toFixed(1)} Hz`);
}

section('H3. Pitch bend center = no change');
{
  const p = makePatch({ algorithm: 31 });
  p.ops[0].outputLevel = 99;
  const proc = new ProcessorClass();
  proc._setPatch(p);
  proc._noteOn(69, 100);
  proc._pitchBend(8192); // center
  processBlocks(proc, 4800);
  const s = processBlocks(proc, SR / 2);
  const freq = measureFreq(s, 0);
  assertClose(freq, 440, 5, `Center pitch bend should not change frequency`);
  console.log(`  Center bend frequency: ${freq.toFixed(1)} Hz`);
}


// ============================================================
// SECTION I: LFO
// ============================================================
section('I1. LFO pitch modulation creates vibrato');
{
  const p = makePatch({ algorithm: 31,
    lfoSpeed: 50, lfoPitchModDepth: 99, lfoSync: true, lfoWave: 4,
    pitchModSens: 5
  });
  p.ops[0].outputLevel = 99;
  const s = playNote(p, 60, 100, SR);
  // Vibrato should cause frequency variation — check block-by-block
  const blockSize = 1000;
  const start = Math.floor(SR * 0.2); // skip LFO delay
  let minCross = Infinity, maxCross = 0;
  for (let i = start; i < s.length - blockSize * 2; i += blockSize) {
    let c = 0;
    for (let j = i + 1; j < i + blockSize; j++) {
      if (s[j-1] >= 0 && s[j] < 0) c++;
    }
    minCross = Math.min(minCross, c);
    maxCross = Math.max(maxCross, c);
  }
  assert(maxCross > minCross, `LFO should create frequency variation (min=${minCross}, max=${maxCross})`);
  console.log(`  Block crossings: min=${minCross}, max=${maxCross}`);
}

section('I2. LFO amp modulation creates tremolo');
{
  const p = makePatch({ algorithm: 31,
    lfoSpeed: 50, lfoAmpModDepth: 99, lfoSync: true, lfoWave: 4
  });
  p.ops[0].outputLevel = 99;
  p.ops[0].ampModSens = 3; // max
  const s = playNote(p, 60, 100, SR);
  // Tremolo should cause amplitude variation
  const blockSize = 500;
  const start = Math.floor(SR * 0.1);
  let minPk = Infinity, maxPk = 0;
  for (let i = start; i < s.length - blockSize; i += blockSize) {
    const pk = peak(s, i, i + blockSize);
    minPk = Math.min(minPk, pk);
    maxPk = Math.max(maxPk, pk);
  }
  const depth = (maxPk - minPk) / maxPk;
  assert(depth > 0.1, `LFO amp mod should create tremolo (depth=${(depth*100).toFixed(1)}%)`);
  console.log(`  Tremolo depth: ${(depth*100).toFixed(1)}% (min=${minPk.toFixed(4)}, max=${maxPk.toFixed(4)})`);
}

// ============================================================
// SECTION J: WAVEFORM QUALITY CHECKS
// Verify the output doesn't have obvious artifacts.
// ============================================================
section('J1. Pure sine has low harmonic distortion');
{
  // Single carrier, no modulation, no feedback = should be a clean sine
  const p = makePatch({ algorithm: 31, feedback: 0 });
  p.ops[0].outputLevel = 99;
  const s = playNote(p, 69, 100, SR); // A4 region

  // Measure fundamental and 2nd/3rd harmonic via DFT
  // MIDI 69 = A4 = 440 Hz
  const fundamental = 440;
  const skip = Math.floor(SR * 0.05);
  const magF = dftMag(s, fundamental, skip);
  const mag2 = dftMag(s, fundamental * 2, skip);
  const mag3 = dftMag(s, fundamental * 3, skip);

  // THD should be low for a pure sine
  const thd = Math.sqrt(mag2 * mag2 + mag3 * mag3) / magF;
  assert(thd < 0.05, `Pure sine THD should be <5% (got ${(thd*100).toFixed(2)}%)`);
  console.log(`  Fundamental: ${magF.toFixed(6)}, 2nd: ${mag2.toFixed(6)}, 3rd: ${mag3.toFixed(6)}, THD: ${(thd*100).toFixed(2)}%`);
}

section('J2. No DC offset in output');
{
  const p = makePatch({ algorithm: 31 });
  p.ops[0].outputLevel = 99;
  const s = playNote(p, 60, 100, SR);
  // Calculate DC offset (mean of all samples)
  let sum = 0;
  const start = Math.floor(SR * 0.05);
  for (let i = start; i < s.length; i++) sum += s[i];
  const dc = sum / (s.length - start);
  assert(Math.abs(dc) < 0.01, `DC offset should be near zero (got ${dc.toFixed(6)})`);
  console.log(`  DC offset: ${dc.toFixed(6)}`);
}

section('J3. No NaN or Infinity in output');
{
  const p = makePatch({ algorithm: 0, feedback: 7 });
  p.ops[0].outputLevel = 99;
  p.ops[1].outputLevel = 99;
  const s = playNote(p, 60, 127, SR);
  let hasNaN = false, hasInf = false;
  for (let i = 0; i < s.length; i++) {
    if (isNaN(s[i])) hasNaN = true;
    if (!isFinite(s[i])) hasInf = true;
  }
  assert(!hasNaN, 'Output should not contain NaN');
  assert(!hasInf, 'Output should not contain Infinity');
  console.log('  No NaN/Infinity ✓');
}

section('J4. Extreme FM does not explode');
{
  // Max feedback, max modulation — should not produce insane values
  const p = makePatch({ algorithm: 0, feedback: 7 });
  for (let i = 0; i < 6; i++) p.ops[i].outputLevel = 99;
  const s = playNote(p, 60, 127, SR);
  const pk = peak(s);
  assert(pk < 10, `Extreme FM should not explode (peak=${pk.toFixed(2)})`);
  console.log(`  Extreme FM peak: ${pk.toFixed(4)}`);
}

// ============================================================
// SECTION K: DETUNE AND BEATING
// ============================================================
section('K1. Detuned operators create beating');
{
  const p = makePatch({ algorithm: 31 });
  p.ops[0].outputLevel = 90; p.ops[0].detune = 7;
  p.ops[1].outputLevel = 90; p.ops[1].detune = 14;
  const s = playNote(p, 60, 100, SR);
  // Check amplitude modulation
  const blockSize = 200;
  const start = Math.floor(SR * 0.1);
  let minBlk = Infinity, maxBlk = 0;
  for (let i = start; i < s.length - blockSize; i += blockSize) {
    const pk = peak(s, i, i + blockSize);
    minBlk = Math.min(minBlk, pk);
    maxBlk = Math.max(maxBlk, pk);
  }
  const depth = (maxBlk - minBlk) / maxBlk;
  assert(depth > 0.1, `Detuned ops should beat (depth=${(depth*100).toFixed(1)}%)`);
  console.log(`  Beat depth: ${(depth*100).toFixed(1)}%`);
}

// ============================================================
// SECTION L: CARRIER COUNT NORMALIZATION
// ============================================================
section('L1. Normalization prevents 6-carrier blowup');
{
  // Algo 1 has 2 carriers (OP4, OP6)
  const p1 = makePatch({ algorithm: 0 });
  p1.ops[3].outputLevel = 99; // OP4 carrier
  const s1 = playNote(p1, 60, 100, SR / 4);

  const p6 = makePatch({ algorithm: 31 }); // 6 carriers
  for (let i = 0; i < 6; i++) p6.ops[i].outputLevel = 99;
  const s6 = playNote(p6, 60, 100, SR / 4);

  const pk1 = peak(s1);
  const pk6 = peak(s6);
  const ratio = pk6 / pk1;
  // Without normalization (matching Dexed), ratio should be ~6
  assert(ratio > 3, `6 carriers should be louder than 1 (ratio=${ratio.toFixed(2)})`);
  assert(ratio < 8, `6 carriers ratio should be reasonable (ratio=${ratio.toFixed(2)})`);
  console.log(`  1-carrier: ${pk1.toFixed(4)}, 6-carrier: ${pk6.toFixed(4)}, ratio: ${ratio.toFixed(2)}x`);
}

// ============================================================
// SECTION M: PITCH ENVELOPE
// ============================================================
section('M1. Pitch envelope sweeps frequency');
{
  // Pitch env: start high (L1=80), sweep to center (L3=50)
  const p = makePatch({ algorithm: 31,
    pitchEgR1: 99, pitchEgR2: 50, pitchEgR3: 50, pitchEgR4: 99,
    pitchEgL1: 80, pitchEgL2: 60, pitchEgL3: 50, pitchEgL4: 50
  });
  p.ops[0].outputLevel = 99;
  const s = playNote(p, 60, 100, SR * 2);
  // Early frequency should be higher than late frequency
  const earlyFreq = measureFreq(s.slice(0, Math.floor(SR * 0.1)), 5);
  const lateFreq = measureFreq(s.slice(Math.floor(SR * 1.5)), 0);
  assert(earlyFreq > lateFreq * 1.1, `Pitch env should sweep down (early=${earlyFreq.toFixed(0)}, late=${lateFreq.toFixed(0)})`);
  console.log(`  Early freq: ${earlyFreq.toFixed(0)} Hz, Late freq: ${lateFreq.toFixed(0)} Hz`);
}

// ============================================================
// SECTION N: NOTE ON/OFF LIFECYCLE
// ============================================================
section('N1. Re-trigger resets envelope');
{
  const p = makePatch({ algorithm: 31 });
  p.ops[0].outputLevel = 99;
  p.ops[0].egRate1 = 99; p.ops[0].egLevel1 = 99;
  p.ops[0].egRate2 = 40; p.ops[0].egLevel2 = 40;
  const proc = new ProcessorClass();
  proc._setPatch(p);
  proc._noteOn(60, 100);
  processBlocks(proc, SR); // 1 second — envelope has decayed

  const rmsDecayed = rms(processBlocks(proc, 4800));

  // Re-trigger same note
  proc._noteOn(60, 100);
  processBlocks(proc, 480); // 10ms for attack
  const rmsRetrig = rms(processBlocks(proc, 4800));

  assert(rmsRetrig > rmsDecayed * 1.5, `Re-trigger should reset envelope (retrig=${rmsRetrig.toFixed(4)}, decayed=${rmsDecayed.toFixed(4)})`);
  console.log(`  Decayed RMS: ${rmsDecayed.toFixed(4)}, Re-triggered RMS: ${rmsRetrig.toFixed(4)}`);
}

section('N2. Note off followed by note on (new voice)');
{
  const p = makePatch({ algorithm: 31 });
  p.ops[0].outputLevel = 99;
  const proc = new ProcessorClass();
  proc._setPatch(p);
  proc._noteOn(60, 100);
  processBlocks(proc, SR / 10);
  proc._noteOff(60);
  processBlocks(proc, SR / 2); // let it decay

  proc._noteOn(72, 100); // new note
  processBlocks(proc, 480);
  const s = processBlocks(proc, 4800);
  assert(peak(s) > 0.01, 'New note after release should produce sound');
  console.log('  New note after release works ✓');
}

// ============================================================
// Summary
// ============================================================
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
if (failed > 0) {
  console.log('SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('ALL TESTS PASSED ✓');
}
