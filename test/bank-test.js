#!/usr/bin/env node
// OpenDX7 — FM Synthesizer (MIT License)
// Copyright (c) 2026 Keith Adler
// ============================================================
// Built-in bank QC
//
// The engine tests check that the synthesis is right. These check that the 32
// patches shipped with it are worth playing: that each one sounds, that it
// answers the hand, that the bank holds a consistent level so switching sounds
// does not jump in volume, and that the instruments named after struck things
// actually ring.
//
// Every assertion here was confirmed by making the patch data wrong and
// watching it fail.
// ============================================================
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SR = 48000;
const code = readFileSync(join(__dirname, '..', 'js', 'dx7-processor.js'), 'utf8');
let ProcessorClass;
class MockAWP { constructor() { this.port = { onmessage: null, postMessage: () => {} }; } }
new Function('sampleRate', 'AudioWorkletProcessor', 'registerProcessor', 'currentTime', code)(
  SR, MockAWP, (n, c) => { ProcessorClass = c; }, 0
);
const { generateFactoryPatches } = await import(join(__dirname, '..', 'js', 'dx7-patch.js'));

let passed = 0, failed = 0, total = 0;
function assert(cond, msg) {
  total++;
  if (cond) passed++; else { failed++; console.log(`  ✗ FAIL: ${msg}`); }
}
function section(name) { console.log(`\n── ${name} ──`); }

function render(patch, note, vel, onSec, offSec = 0) {
  const p = new ProcessorClass();
  p.port.onmessage({ data: { type: 'patch', patch } });
  p.port.onmessage({ data: { type: 'noteOn', note, velocity: vel } });
  const total = Math.floor((onSec + offSec) * SR), offAt = Math.floor(onSec * SR);
  const out = new Float32Array(total);
  const b = [new Float32Array(128), new Float32Array(128)];
  for (let i = 0; i < total; i += 128) {
    if (offSec && i >= offAt && i - 128 < offAt) p.port.onmessage({ data: { type: 'noteOff', note } });
    p.process([], [b], {});
    out.set(b[0].subarray(0, Math.min(128, total - i)), i);
  }
  return out;
}
const peak = (a, s = 0, e = a.length) => { let m = 0; for (let i = s; i < e; i++) m = Math.max(m, Math.abs(a[i])); return m; };
const rms = (a, s, e) => { let t = 0; for (let i = s; i < e; i++) t += a[i] * a[i]; return Math.sqrt(t / Math.max(1, e - s)); };

// Loudness while the note is actually sounding. A fixed window laid over a
// short pluck averages in silence and calls the patch quiet when it is brief.
function gatedLoudness(a) {
  const pk = peak(a);
  if (!pk) return 0;
  const gate = pk * 0.0316, W = Math.floor(0.01 * SR);
  let sum = 0, n = 0;
  for (let i = 0; i + W <= a.length; i += W) {
    const r = rms(a, i, i + W);
    if (r >= gate) { sum += r * r * W; n += W; }
  }
  return n ? Math.sqrt(sum / n) : 0;
}
// Spectral centroid over a short window, so an attack transient is not averaged away.
function centroid(a, from, N = 1024) {
  const re = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = (a[from + i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  let num = 0, den = 0;
  const K = Math.floor(N * 8000 / SR);
  for (let k = 1; k < K; k++) {
    let sr = 0, si = 0; const w = 2 * Math.PI * k / N;
    for (let i = 0; i < N; i++) { sr += re[i] * Math.cos(w * i); si += re[i] * Math.sin(w * i); }
    const m = Math.hypot(sr, si); num += m * (k * SR / N); den += m;
  }
  return den > 0 ? num / den : 0;
}

const patches = generateFactoryPatches();
const byName = Object.fromEntries(patches.map(p => [p.name, p]));

section('B1. The bank is the shape it claims to be');
assert(patches.length === 32, `bank should hold 32 patches (has ${patches.length})`);
assert(new Set(patches.map(p => p.name)).size === 32, 'every patch should have a distinct name');

section('B2. Every patch makes a sound');
for (const p of patches) {
  const a = render(p, 60, 100, 0.5);
  assert(peak(a) > 0.01, `${p.name} should produce audible output (peak ${peak(a).toFixed(4)})`);
}
console.log(`  all ${patches.length} patches sound ✓`);

section('B3. The bank holds a level');
{
  const loud = patches.map(p => ({
    name: p.name,
    l: [48, 60, 72].reduce((s, n) => s + gatedLoudness(render(p, n, 100, 2.0)), 0) / 3,
  }));
  const med = loud.map(x => x.l).sort((a, b) => a - b)[Math.floor(loud.length / 2)];
  const db = x => 20 * Math.log10(x.l / med);
  const loudest = loud.reduce((a, b) => (b.l > a.l ? b : a));
  // Nothing may blast: the top of the bank is the dangerous end, because that
  // is what makes someone reach for the volume when they change patch.
  assert(db(loudest) < 3.0, `loudest patch ${loudest.name} is ${db(loudest).toFixed(1)} dB over the median`);
  const inBand = loud.filter(x => Math.abs(db(x)) <= 6).length;
  assert(inBand >= 29, `at least 29 patches should sit within 6 dB of the median (got ${inBand})`);
  console.log(`  loudest is ${db(loudest).toFixed(1)} dB over median, ${inBand} of 32 within 6 dB ✓`);
}

section('B4. Playing harder does something');
{
  // A drawbar organ is not touch sensitive on the real instrument, and an INIT
  // sine is a blank sheet. Everything else has to answer the hand.
  const exempt = new Set(['Drawbar Organ', 'INIT VOICE']);
  let dead = [];
  for (const p of patches) {
    if (exempt.has(p.name)) continue;
    const soft = peak(render(p, 60, 30, 0.6));
    const hard = peak(render(p, 60, 127, 0.6));
    if (!(hard / Math.max(soft, 1e-9) >= 1.3)) dead.push(`${p.name} (${(hard / soft).toFixed(2)}x)`);
  }
  assert(dead.length === 0, `these patches ignore velocity: ${dead.join(', ')}`);
  console.log(`  ${patches.length - exempt.size} of ${patches.length} patches respond to velocity ✓`);
}

section('B5. The electric pianos have a tine');
for (const name of ['Elec Piano 1', 'Elec Piano 2']) {
  const p = byName[name];
  const a = render(p, 60, 110, 1.0);
  const atk = centroid(a, 0), body = centroid(a, Math.floor(0.5 * SR));
  // The tine is a high modulator that dies fast: bright at the strike, mellow
  // a moment later. Without it the patch is a sine and the instrument is gone.
  assert(atk > 1200, `${name} should strike bright (centroid ${atk.toFixed(0)} Hz)`);
  assert(atk / body > 4, `${name}'s tine should decay away (${atk.toFixed(0)} -> ${body.toFixed(0)} Hz)`);
  const soft = centroid(render(p, 60, 30, 0.5), 0);
  assert(atk / soft > 1.5, `${name} should open up with velocity (${soft.toFixed(0)} -> ${atk.toFixed(0)} Hz)`);
  console.log(`  ${name}: ${atk.toFixed(0)} Hz at the strike, ${body.toFixed(0)} Hz in the body ✓`);
}

section('B6. Struck instruments ring');
for (const [name, minAt500ms] of [['Mallet Hit', 0.12], ['Harpsichord', 0.12], ['Clavinet', 0.06]]) {
  const a = render(byName[name], 60, 110, 2.0);
  const start = rms(a, Math.floor(0.02 * SR), Math.floor(0.05 * SR));
  const later = rms(a, Math.floor(0.5 * SR), Math.floor(0.55 * SR));
  assert(later / start > minAt500ms,
    `${name} should still be sounding half a second in (${(later / start * 100).toFixed(0)}% of its start)`);
  console.log(`  ${name}: ${(later / start * 100).toFixed(0)}% of its opening level at 500 ms ✓`);
}

section('B7. Nothing clicks when a key is released');
for (const p of patches) {
  const a = render(p, 60, 110, 1.0, 0.5);
  const off = Math.floor(1.0 * SR);
  let step = 0;
  for (let i = off; i < off + 600 && i < a.length; i++) step = Math.max(step, Math.abs(a[i] - a[i - 1]));
  assert(step < peak(a) * 0.5, `${p.name} steps ${(step / peak(a)).toFixed(2)} of its peak at note-off`);
}
console.log('  no discontinuity at note-off in any patch ✓');

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
if (failed > 0) { console.log('SOME BANK TESTS FAILED'); process.exit(1); }
else console.log('ALL BANK TESTS PASSED ✓');
