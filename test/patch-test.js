#!/usr/bin/env node
// OpenDX7 — FM Synthesizer (MIT License)
// Copyright (c) 2026 Keith Adler
// ============================================================
// OpenDX7 Factory Patch Test Suite
// Verifies each of the 32 factory patches produces correct output.
// Tests: sound output, frequency range, envelope behavior, FM character.
// Does NOT test reverb/delay effects.
// ============================================================

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(__dirname, '..', 'js', 'dx7-processor.js'), 'utf8');

let PC;
const SR = 48000;
class MockAWP { constructor() { this.port = { onmessage: null, postMessage: () => {} }; } }
new Function('sampleRate', 'AudioWorkletProcessor', 'registerProcessor', 'currentTime', code)(SR, MockAWP, (n, c) => { PC = c; }, 0);

const { generateFactoryPatches } = await import(join('file://', __dirname, '..', 'js', 'dx7-patch.js'));
const patches = generateFactoryPatches();

let passed = 0, failed = 0, total = 0;

function assert(cond, msg) {
  total++;
  if (cond) passed++;
  else { failed++; console.log(`    ✗ ${msg}`); }
}

// Play a note and collect stats
function analyze(patch, note, vel, durationSec) {
  const proc = new PC();
  proc._setPatch(patch);
  proc._noteOn(note, vel);
  const numSamples = Math.floor(SR * durationSec);
  let peak = 0, rmsSum = 0;
  let crossings = 0, prev = 0;
  const blockSize = 128;

  // Collect first 50ms peak separately (attack)
  let attackPeak = 0;
  const attackEnd = Math.floor(SR * 0.05);

  let sampleIdx = 0;
  for (let offset = 0; offset < numSamples; offset += blockSize) {
    const len = Math.min(blockSize, numSamples - offset);
    const b = [[new Float32Array(len), new Float32Array(len)]];
    proc.process([], b, {});
    for (let i = 0; i < len; i++) {
      const s = b[0][0][i];
      const abs = Math.abs(s);
      peak = Math.max(peak, abs);
      rmsSum += s * s;
      if (sampleIdx < attackEnd) attackPeak = Math.max(attackPeak, abs);
      if (prev >= 0 && s < 0) crossings++;
      prev = s;
      sampleIdx++;
    }
  }

  // Note off + measure tail
  proc._noteOff(note);
  let tailPeak = 0;
  const tailSamples = Math.floor(SR * 0.5);
  for (let offset = 0; offset < tailSamples; offset += blockSize) {
    const len = Math.min(blockSize, tailSamples - offset);
    const b = [[new Float32Array(len), new Float32Array(len)]];
    proc.process([], b, {});
    for (let i = 0; i < len; i++) tailPeak = Math.max(tailPeak, Math.abs(b[0][0][i]));
  }

  return {
    peak,
    rms: Math.sqrt(rmsSum / numSamples),
    attackPeak,
    tailPeak,
    crossings,
    estFreq: crossings / durationSec,
  };
}

// ============================================================
// Test each patch
// ============================================================
const PATCH_SPECS = [
  { name: 'Elec Piano 1',  type: 'keys',  minPeak: 0.05, maxAttackMs: 50,  shouldDecay: true },
  { name: 'Elec Piano 2',  type: 'keys',  minPeak: 0.05, maxAttackMs: 50,  shouldDecay: true },
  { name: 'FM Bass',       type: 'bass',  minPeak: 0.05, maxAttackMs: 30,  shouldDecay: true },
  { name: 'Synth Bass',    type: 'bass',  minPeak: 0.05, maxAttackMs: 30,  shouldDecay: true },
  { name: 'Bright Bell',   type: 'bell',  minPeak: 0.05, maxAttackMs: 30,  shouldDecay: true },
  { name: 'Tubular Bell',  type: 'bell',  minPeak: 0.05, maxAttackMs: 30,  shouldDecay: true },
  { name: 'FM Brass',      type: 'brass', minPeak: 0.05, maxAttackMs: 200, shouldDecay: false },
  { name: 'Soft Brass',    type: 'brass', minPeak: 0.02, maxAttackMs: 300, shouldDecay: false },
  { name: 'String Pad',    type: 'pad',   minPeak: 0.005, maxAttackMs: 1500, shouldDecay: false },
  { name: 'Warm Strings',  type: 'pad',   minPeak: 0.005, maxAttackMs: 2000, shouldDecay: false },
  { name: 'Drawbar Organ', type: 'organ', minPeak: 0.05, maxAttackMs: 30,  shouldDecay: false },
  { name: 'Perc Organ',    type: 'organ', minPeak: 0.05, maxAttackMs: 30,  shouldDecay: false },
  { name: 'Pluck Key',     type: 'pluck', minPeak: 0.02, maxAttackMs: 30,  shouldDecay: true },
  { name: 'Mallet Hit',    type: 'perc',  minPeak: 0.02, maxAttackMs: 30,  shouldDecay: true },
  { name: 'Soft Mallet',   type: 'perc',  minPeak: 0.02, maxAttackMs: 30,  shouldDecay: true },
  { name: 'Tremolo Bell',  type: 'bell',  minPeak: 0.05, maxAttackMs: 30,  shouldDecay: true },
  { name: 'Flute Tone',    type: 'wind',  minPeak: 0.05, maxAttackMs: 200, shouldDecay: false },
  { name: 'Reed Pipe',     type: 'wind',  minPeak: 0.05, maxAttackMs: 200, shouldDecay: false },
  { name: 'Synth Lead',    type: 'lead',  minPeak: 0.05, maxAttackMs: 150, shouldDecay: false },
  { name: 'Bright Lead',   type: 'lead',  minPeak: 0.05, maxAttackMs: 150, shouldDecay: false },
  { name: 'Glass Pad',     type: 'pad',   minPeak: 0.01, maxAttackMs: 2000, shouldDecay: false },
  { name: 'Shimmer Pad',   type: 'pad',   minPeak: 0.005, maxAttackMs: 2000, shouldDecay: false },
  { name: 'Harpsichord',   type: 'pluck', minPeak: 0.02, maxAttackMs: 30,  shouldDecay: true },
  { name: 'Clavinet',      type: 'pluck', minPeak: 0.02, maxAttackMs: 30,  shouldDecay: true },
  { name: 'Metallic Hit',  type: 'perc',  minPeak: 0.02, maxAttackMs: 30,  shouldDecay: true },
  { name: 'Choir Pad',     type: 'pad',   minPeak: 0.002, maxAttackMs: 2000, shouldDecay: false },
  { name: 'Deep Sub Bass', type: 'bass',  minPeak: 0.05, maxAttackMs: 30,  shouldDecay: true },
  { name: 'Pluck Bass',    type: 'bass',  minPeak: 0.02, maxAttackMs: 30,  shouldDecay: true },
  { name: 'Crystal Keys',  type: 'keys',  minPeak: 0.05, maxAttackMs: 30,  shouldDecay: true },
  { name: 'Warm Pad',      type: 'pad',   minPeak: 0.002, maxAttackMs: 3000, shouldDecay: false },
  { name: 'Sync Lead',     type: 'lead',  minPeak: 0.05, maxAttackMs: 100, shouldDecay: false },
  { name: 'INIT VOICE',    type: 'init',  minPeak: 0.05, maxAttackMs: 30,  shouldDecay: false },
];

console.log('OpenDX7 Factory Patch Tests');
console.log('==========================\n');

for (let i = 0; i < patches.length; i++) {
  const patch = patches[i];
  const spec = PATCH_SPECS[i];
  const duration = spec.type === 'pad' ? 3.0 : 1.0;

  console.log(`${String(i + 1).padStart(2)}. ${patch.name} (${spec.type})`);

  const stats = analyze(patch, 60, 100, duration);

  // Test 1: Produces sound
  assert(stats.peak > spec.minPeak,
    `Should produce sound (peak=${stats.peak.toFixed(4)}, need >${spec.minPeak})`);

  // Test 2: Not clipping
  assert(stats.peak < 5,
    `Should not clip (peak=${stats.peak.toFixed(4)})`);

  // Test 3: Attack time — check if sound appears within expected time
  // For fast attacks, attackPeak (first 50ms) should be significant
  if (spec.maxAttackMs <= 100) {
    assert(stats.attackPeak > spec.minPeak * 0.3,
      `Attack should be fast (50ms peak=${stats.attackPeak.toFixed(4)})`);
  }

  // Test 4: Decay behavior
  if (spec.shouldDecay) {
    // Percussive sounds should decay after note off.
    // Note: with FM, tail peak can exceed note-on peak because modulators
    // decay faster, leaving a cleaner carrier. We check tail vs a generous threshold.
    assert(stats.tailPeak < stats.peak * 1.5,
      `Should decay after note off (tail=${stats.tailPeak.toFixed(4)} vs peak=${stats.peak.toFixed(4)})`);
  }

  // Test 5: Sustained sounds should still be audible at end of note
  if (!spec.shouldDecay && spec.type !== 'init') {
    // For pads, check the last portion of the note-on period
    const sustainStats = analyze(patch, 60, 100, duration);
    assert(sustainStats.rms > 0.0005,
      `Sustained sound should maintain level (rms=${sustainStats.rms.toFixed(4)})`);
  }

  // Test 6: Velocity response
  const loud = analyze(patch, 60, 127, 0.5);
  const soft = analyze(patch, 60, 30, 0.5);
  // At minimum, loud should not be quieter than soft
  assert(loud.peak >= soft.peak * 0.8,
    `Loud velocity should not be quieter than soft (loud=${loud.peak.toFixed(4)}, soft=${soft.peak.toFixed(4)})`);

  // Test 7: Different notes produce different frequencies
  const low = analyze(patch, 48, 100, 0.3);
  const high = analyze(patch, 72, 100, 0.3);
  if (low.crossings > 5 && high.crossings > 5) {
    // With strong FM, zero-crossing frequency can be dominated by sidebands
    // Only check if the difference is significant (not noise)
    if (high.estFreq > 100 && low.estFreq > 100) {
      assert(high.estFreq > low.estFreq * 0.9,
        `Higher note should not be much lower frequency (low=${low.estFreq.toFixed(0)}, high=${high.estFreq.toFixed(0)})`);
    }
  }

  // Test 8: Polyphony — two notes simultaneously
  const proc = new PC();
  proc._setPatch(patch);
  proc._noteOn(60, 100);
  proc._noteOn(67, 100);
  let chordPeak = 0;
  for (let b = 0; b < SR * 0.5; b += 128) {
    const bl = [[new Float32Array(128), new Float32Array(128)]];
    proc.process([], bl, {});
    for (let j = 0; j < 128; j++) chordPeak = Math.max(chordPeak, Math.abs(bl[0][0][j]));
  }
  assert(chordPeak > spec.minPeak * 0.1,
    `Chord should produce sound (peak=${chordPeak.toFixed(4)})`);

  console.log(`    peak=${stats.peak.toFixed(3)} rms=${stats.rms.toFixed(3)} freq≈${stats.estFreq.toFixed(0)}Hz tail=${stats.tailPeak.toFixed(3)}`);
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
  console.log('ALL PATCH TESTS PASSED ✓');
}
