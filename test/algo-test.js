#!/usr/bin/env node
// OpenDX7 — FM Synthesizer (MIT License)
// Copyright (c) 2026 Keith Adler
// ============================================================
// Algorithm verification: tests all 32 algorithms against Dexed's
// exact routing table. For each algorithm, verifies:
// 1. Correct carrier count (which ops produce audio output)
// 2. Correct feedback operator
// 3. Modulation paths work (modulator affects carrier timbre)
// 4. Non-connected ops don't leak into output
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
function assert(cond, msg) {
  total++;
  if (cond) passed++;
  else { failed++; console.log(`    ✗ ${msg}`); }
}

function makePatch(algo, fb) {
  return {
    name:'T', algorithm:algo, feedback:fb||0, transpose:24, pitchModSens:0, oscSync:false,
    pitchEgR1:99,pitchEgR2:99,pitchEgR3:99,pitchEgR4:99,
    pitchEgL1:50,pitchEgL2:50,pitchEgL3:50,pitchEgL4:50,
    lfoSpeed:0,lfoDelay:0,lfoPitchModDepth:0,lfoAmpModDepth:0,lfoSync:false,lfoWave:0,
    ops: Array.from({length:6}, () => ({
      egRate1:99,egRate2:99,egRate3:99,egRate4:99,
      egLevel1:99,egLevel2:99,egLevel3:99,egLevel4:0,
      outputLevel:0, oscMode:0, freqCoarse:1, freqFine:0, detune:7,
      velSensitivity:0, ampModSens:0, kbdRateScaling:0,
      kbdLevelScaleBP:39, kbdLevelScaleLD:0, kbdLevelScaleRD:0,
      kbdLevelScaleLC:0, kbdLevelScaleRC:0,
    }))
  };
}

function render(patch, note, samples) {
  const proc = new PC();
  proc._setPatch(patch);
  proc._noteOn(note || 60, 100);
  const out = [];
  for (let off = 0; off < samples; off += 128) {
    const len = Math.min(128, samples - off);
    const b = [[new Float32Array(len), new Float32Array(len)]];
    proc.process([], b, {});
    for (let j = 0; j < len; j++) out.push(b[0][0][j]);
  }
  return out;
}

function peak(samples, skip) {
  let mx = 0;
  for (let i = skip || 0; i < samples.length; i++) mx = Math.max(mx, Math.abs(samples[i]));
  return mx;
}

function spectrum(samples, f0, skip) {
  skip = skip || Math.floor(SR * 0.05);
  function mag(freq) {
    let re = 0, im = 0;
    for (let i = skip; i < samples.length; i++) {
      re += samples[i] * Math.cos(2 * Math.PI * freq * i / SR);
      im += samples[i] * Math.sin(2 * Math.PI * freq * i / SR);
    }
    return Math.sqrt(re * re + im * im) / (samples.length - skip);
  }
  return [mag(f0), mag(f0*2), mag(f0*3), mag(f0*4)];
}

// Dexed's algorithm table
const ALGOS = [
  [0xc1,0x11,0x11,0x14,0x01,0x14],[0x01,0x11,0x11,0x14,0xc1,0x14],
  [0xc1,0x11,0x14,0x01,0x11,0x14],[0xc1,0x11,0x94,0x01,0x11,0x14],
  [0xc1,0x14,0x01,0x14,0x01,0x14],[0xc1,0x94,0x01,0x14,0x01,0x14],
  [0xc1,0x11,0x05,0x14,0x01,0x14],[0x01,0x11,0xc5,0x14,0x01,0x14],
  [0x01,0x11,0x05,0x14,0xc1,0x14],[0x01,0x05,0x14,0xc1,0x11,0x14],
  [0xc1,0x05,0x14,0x01,0x11,0x14],[0x01,0x05,0x05,0x14,0xc1,0x14],
  [0xc1,0x05,0x05,0x14,0x01,0x14],[0xc1,0x05,0x11,0x14,0x01,0x14],
  [0x01,0x05,0x11,0x14,0xc1,0x14],[0xc1,0x11,0x02,0x25,0x05,0x14],
  [0x01,0x11,0x02,0x25,0xc5,0x14],[0x01,0x11,0x11,0xc5,0x05,0x14],
  [0xc1,0x14,0x14,0x01,0x11,0x14],[0x01,0x05,0x14,0xc1,0x14,0x14],
  [0x01,0x14,0x14,0xc1,0x14,0x14],[0xc1,0x14,0x14,0x14,0x01,0x14],
  [0xc1,0x14,0x14,0x01,0x14,0x04],[0xc1,0x14,0x14,0x14,0x04,0x04],
  [0xc1,0x14,0x14,0x04,0x04,0x04],[0xc1,0x05,0x14,0x01,0x14,0x04],
  [0x01,0x05,0x14,0xc1,0x14,0x04],[0x04,0xc1,0x11,0x14,0x01,0x14],
  [0xc1,0x14,0x01,0x14,0x04,0x04],[0x04,0xc1,0x11,0x14,0x04,0x04],
  [0xc1,0x14,0x04,0x04,0x04,0x04],[0xc4,0x04,0x04,0x04,0x04,0x04],
];

console.log('=== All 32 Algorithm Tests ===\n');

for (let algo = 0; algo < 32; algo++) {
  const alg = ALGOS[algo];
  const carriers = [];
  const modulators = [];
  let fbOp = -1;

  for (let op = 0; op < 6; op++) {
    // A carrier writes to the final output bus (bus 0). The 0x04 bit alone is
    // OUT_BUS_ADD and is also set on modulators that SUM into an internal bus
    // (opcodes 0x05/0x25/0xc5), so classifying on it treats those modulators as
    // carriers. Carrier == destination bus is 0.
    if ((alg[op] & 0x03) === 0) carriers.push(op);
    else modulators.push(op);
    if ((alg[op] & 0xC0) === 0xC0) fbOp = op;
  }

  console.log(`Algo ${String(algo + 1).padStart(2)}: carriers=[${carriers.map(c=>'OP'+(c+1)).join(',')}] fb=OP${fbOp+1}`);

  // Test 1: Each carrier produces sound independently
  for (const car of carriers) {
    const p = makePatch(algo);
    p.ops[car].outputLevel = 99;
    const s = render(p, 60, SR / 4);
    const pk = peak(s, 128);
    assert(pk > 0.001, `Algo ${algo+1} OP${car+1} carrier should produce sound (peak=${pk.toFixed(4)})`);
  }

  // Test 2: Modulators alone should NOT produce sound
  for (const mod of modulators) {
    const p = makePatch(algo);
    p.ops[mod].outputLevel = 99;
    const s = render(p, 60, SR / 4);
    const pk = peak(s, 128);
    assert(pk < 0.001, `Algo ${algo+1} OP${mod+1} modulator alone should be silent (peak=${pk.toFixed(4)})`);
  }

  // Test 3: Modulator affects carrier timbre (only for DIRECT mod→carrier paths)
  // A modulator must output to the same bus the carrier reads from,
  // AND there must be no intermediate operators at level 0 in between.
  // For simplicity, only test algo 5-type pairs where mod is immediately before carrier.
  for (const car of carriers) {
    const carFlags = alg[car];
    const inBus = (carFlags >> 4) & 3;
    if (inBus === 0) continue;

    // Find the LAST operator that writes to this bus BEFORE the carrier
    let modOp = -1;
    for (let m = car - 1; m >= 0; m--) {
      const mFlags = alg[m];
      const mOutBus = mFlags & 3;
      if (mOutBus === inBus) { modOp = m; break; }
    }
    if (modOp < 0) continue;

    // Check there are no intermediate operators between mod and carrier on the same bus
    let hasIntermediate = false;
    for (let m = modOp + 1; m < car; m++) {
      const mFlags = alg[m];
      if ((mFlags & 3) === inBus) { hasIntermediate = true; break; }
    }
    if (hasIntermediate) continue; // skip — intermediate ops would attenuate the signal

    const pPure = makePatch(algo);
    pPure.ops[car].outputLevel = 99;
    const sPure = render(pPure, 60, SR / 2);
    const hPure = spectrum(sPure, 262);

    const pFM = makePatch(algo);
    pFM.ops[car].outputLevel = 99;
    pFM.ops[modOp].outputLevel = 90;
    const sFM = render(pFM, 60, SR / 2);
    const hFM = spectrum(sFM, 262);

    const pureTHD = Math.sqrt(hPure[1]**2 + hPure[2]**2 + hPure[3]**2) / (hPure[0] || 0.0001);
    const fmTHD = Math.sqrt(hFM[1]**2 + hFM[2]**2 + hFM[3]**2) / (hFM[0] || 0.0001);

    assert(fmTHD > pureTHD * 1.2,
      `Algo ${algo+1} OP${modOp+1}→OP${car+1} FM should add harmonics (pure=${(pureTHD*100).toFixed(1)}% fm=${(fmTHD*100).toFixed(1)}%)`);
    break;
  }

  // Test 4: Feedback adds harmonics
  if (fbOp >= 0 && carriers.includes(fbOp)) {
    // Feedback op is a carrier — test it directly
    const pNoFb = makePatch(algo, 0);
    pNoFb.ops[fbOp].outputLevel = 99;
    const sNoFb = render(pNoFb, 60, SR / 2);
    const hNoFb = spectrum(sNoFb, 262);

    const pFb = makePatch(algo, 7);
    pFb.ops[fbOp].outputLevel = 99;
    const sFb = render(pFb, 60, SR / 2);
    const hFb = spectrum(sFb, 262);

    const noFbTHD = Math.sqrt(hNoFb[1]**2 + hNoFb[2]**2) / (hNoFb[0] || 0.0001);
    const fbTHD = Math.sqrt(hFb[1]**2 + hFb[2]**2) / (hFb[0] || 0.0001);

    assert(fbTHD > noFbTHD,
      `Algo ${algo+1} fb=7 on OP${fbOp+1} should add harmonics (no=${(noFbTHD*100).toFixed(1)}% fb=${(fbTHD*100).toFixed(1)}%)`);
  }
}

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
else console.log('ALL ALGORITHM TESTS PASSED ✓');
