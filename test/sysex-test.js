#!/usr/bin/env node
// OpenDX7 — FM Synthesizer (MIT License)
// Copyright (c) 2026 Keith Adler
// ============================================================
// SysEx Import/Export Test
// Tests roundtrip: create patch → export .syx → re-import → verify all params match.
// Also validates the binary format against Dexed's packed voice spec.
// ============================================================
import { createDefaultPatch, generateFactoryPatches, parseSyxBank } from '../js/dx7-patch.js';

let passed = 0, failed = 0, total = 0;
function assert(cond, msg) {
  total++;
  if (cond) passed++;
  else { failed++; console.log(`  ✗ ${msg}`); }
}

// Port the packVoice function from main.js for testing
function packVoice(data, offset, patch) {
  for (let opIdx = 0; opIdx < 6; opIdx++) {
    const op = patch.ops[5 - opIdx];
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

function exportBank(patches) {
  const data = new Uint8Array(4104);
  data[0] = 0xF0; data[1] = 0x43; data[2] = 0x00; data[3] = 0x09;
  data[4] = 0x20; data[5] = 0x00;
  for (let v = 0; v < 32; v++) {
    packVoice(data, 6 + v * 128, patches[v] || createDefaultPatch());
  }
  let sum = 0;
  for (let i = 6; i < 4102; i++) sum += data[i];
  data[4102] = (-sum) & 0x7F;
  data[4103] = 0xF7;
  return data;
}

// ============================================================
// Test 1: SysEx header format
// ============================================================
console.log('1. SysEx header format');
{
  const syx = exportBank([createDefaultPatch()]);
  assert(syx[0] === 0xF0, 'Starts with F0');
  assert(syx[1] === 0x43, 'Yamaha ID 0x43');
  assert(syx[2] === 0x00, 'Channel 0');
  assert(syx[3] === 0x09, 'Format 9 (32-voice)');
  assert(syx[4] === 0x20, 'Byte count high');
  assert(syx[5] === 0x00, 'Byte count low');
  assert(syx[4103] === 0xF7, 'Ends with F7');
  assert(syx.length === 4104, `Length is 4104 (got ${syx.length})`);

  // Verify checksum
  let sum = 0;
  for (let i = 6; i < 4102; i++) sum += syx[i];
  assert(((sum + syx[4102]) & 0x7F) === 0, 'Checksum valid');
}

// ============================================================
// Test 2: Roundtrip — INIT voice
// ============================================================
console.log('\n2. Roundtrip: INIT voice');
{
  const orig = createDefaultPatch();
  const syx = exportBank([orig]);
  const imported = parseSyxBank(syx);
  assert(imported.length === 32, `Imported 32 patches (got ${imported.length})`);

  const p = imported[0];
  assert(p.algorithm === orig.algorithm, `Algorithm: ${p.algorithm} === ${orig.algorithm}`);
  assert(p.feedback === orig.feedback, `Feedback: ${p.feedback} === ${orig.feedback}`);
  assert(p.transpose === orig.transpose, `Transpose: ${p.transpose} === ${orig.transpose}`);

  for (let i = 0; i < 6; i++) {
    const o = orig.ops[i], r = p.ops[i];
    assert(r.outputLevel === o.outputLevel, `OP${i+1} level: ${r.outputLevel} === ${o.outputLevel}`);
    assert(r.freqCoarse === o.freqCoarse, `OP${i+1} coarse: ${r.freqCoarse} === ${o.freqCoarse}`);
    assert(r.freqFine === o.freqFine, `OP${i+1} fine: ${r.freqFine} === ${o.freqFine}`);
    assert(r.detune === o.detune, `OP${i+1} detune: ${r.detune} === ${o.detune}`);
    assert(r.egRate1 === o.egRate1, `OP${i+1} R1: ${r.egRate1} === ${o.egRate1}`);
    assert(r.egLevel1 === o.egLevel1, `OP${i+1} L1: ${r.egLevel1} === ${o.egLevel1}`);
  }
}

// ============================================================
// Test 3: Roundtrip — complex patch with all params set
// ============================================================
console.log('\n3. Roundtrip: complex patch');
{
  const orig = createDefaultPatch();
  orig.name = 'TEST PATCH';
  orig.algorithm = 21;
  orig.feedback = 5;
  orig.transpose = 36;
  orig.oscSync = true;
  orig.lfoSpeed = 45;
  orig.lfoDelay = 30;
  orig.lfoPitchModDepth = 60;
  orig.lfoAmpModDepth = 40;
  orig.lfoWave = 3;
  orig.lfoSync = true;
  orig.pitchModSens = 5;
  orig.pitchEgR1 = 80; orig.pitchEgR2 = 60; orig.pitchEgR3 = 40; orig.pitchEgR4 = 70;
  orig.pitchEgL1 = 70; orig.pitchEgL2 = 40; orig.pitchEgL3 = 50; orig.pitchEgL4 = 50;

  for (let i = 0; i < 6; i++) {
    const op = orig.ops[i];
    op.egRate1 = 90 - i*5; op.egRate2 = 70 - i*3; op.egRate3 = 50 + i*2; op.egRate4 = 60 + i;
    op.egLevel1 = 99; op.egLevel2 = 80 - i*5; op.egLevel3 = 60 - i*3; op.egLevel4 = i * 5;
    op.outputLevel = 99 - i * 10;
    op.freqCoarse = i + 1;
    op.freqFine = i * 15;
    op.detune = 7 + i - 3;
    op.oscMode = i === 3 ? 1 : 0;
    op.velSensitivity = Math.min(7, i);
    op.ampModSens = Math.min(3, i);
    op.kbdRateScaling = Math.min(7, i);
    op.kbdLevelScaleBP = 39 + i;
    op.kbdLevelScaleLD = i * 10;
    op.kbdLevelScaleRD = i * 8;
    op.kbdLevelScaleLC = Math.min(3, i);
    op.kbdLevelScaleRC = Math.min(3, (i + 1) % 4);
  }

  const syx = exportBank([orig]);
  const imported = parseSyxBank(syx);
  const p = imported[0];

  assert(p.name.trim() === 'TEST PATCH', `Name: "${p.name.trim()}" === "TEST PATCH"`);
  assert(p.algorithm === 21, `Algorithm: ${p.algorithm}`);
  assert(p.feedback === 5, `Feedback: ${p.feedback}`);
  assert(p.transpose === 36, `Transpose: ${p.transpose}`);
  assert(p.oscSync === true, `OscSync: ${p.oscSync}`);
  assert(p.lfoSpeed === 45, `LFO speed: ${p.lfoSpeed}`);
  assert(p.lfoDelay === 30, `LFO delay: ${p.lfoDelay}`);
  assert(p.lfoPitchModDepth === 60, `LFO PMD: ${p.lfoPitchModDepth}`);
  assert(p.lfoAmpModDepth === 40, `LFO AMD: ${p.lfoAmpModDepth}`);
  assert(p.lfoWave === 3, `LFO wave: ${p.lfoWave}`);
  assert(p.lfoSync === true, `LFO sync: ${p.lfoSync}`);
  assert(p.pitchModSens === 5, `PMS: ${p.pitchModSens}`);
  assert(p.pitchEgR1 === 80, `Pitch R1: ${p.pitchEgR1}`);
  assert(p.pitchEgL1 === 70, `Pitch L1: ${p.pitchEgL1}`);

  let opErrors = 0;
  for (let i = 0; i < 6; i++) {
    const o = orig.ops[i], r = p.ops[i];
    const fields = ['egRate1','egRate2','egRate3','egRate4','egLevel1','egLevel2','egLevel3','egLevel4',
      'outputLevel','freqCoarse','freqFine','detune','oscMode','velSensitivity','ampModSens',
      'kbdRateScaling','kbdLevelScaleBP','kbdLevelScaleLD','kbdLevelScaleRD','kbdLevelScaleLC','kbdLevelScaleRC'];
    for (const f of fields) {
      total++;
      if (r[f] === o[f]) passed++;
      else { failed++; opErrors++; console.log(`  ✗ OP${i+1}.${f}: got ${r[f]}, want ${o[f]}`); }
    }
  }
  if (opErrors === 0) console.log('  All operator params match ✓');
}

// ============================================================
// Test 4: Roundtrip all 32 factory patches
// ============================================================
console.log('\n4. Roundtrip: all 32 factory patches');
{
  const factory = generateFactoryPatches();
  const syx = exportBank(factory);
  const imported = parseSyxBank(syx);

  assert(imported.length === 32, `Got 32 patches (${imported.length})`);

  let mismatches = 0;
  for (let v = 0; v < Math.min(factory.length, imported.length); v++) {
    const orig = factory[v];
    const imp = imported[v];
    // Check key params
    if (imp.algorithm !== orig.algorithm) { mismatches++; console.log(`  ✗ Patch ${v+1} "${orig.name}" algo: ${imp.algorithm} !== ${orig.algorithm}`); }
    if (imp.feedback !== orig.feedback) { mismatches++; console.log(`  ✗ Patch ${v+1} "${orig.name}" fb: ${imp.feedback} !== ${orig.feedback}`); }
    for (let i = 0; i < 6; i++) {
      if (imp.ops[i].outputLevel !== orig.ops[i].outputLevel) {
        mismatches++;
        console.log(`  ✗ Patch ${v+1} "${orig.name}" OP${i+1} level: ${imp.ops[i].outputLevel} !== ${orig.ops[i].outputLevel}`);
      }
    }
  }
  total += 32; passed += 32 - mismatches; failed += mismatches;
  if (mismatches === 0) console.log('  All 32 factory patches roundtrip correctly ✓');
}

// ============================================================
// Test 5: Dexed compatibility — verify packed byte layout
// ============================================================
console.log('\n5. Dexed packed voice byte layout');
{
  // Create a patch with known values and verify specific bytes
  const p = createDefaultPatch();
  p.ops[5].egRate1 = 77;  // OP6 is stored first (index 0 in packed data)
  p.ops[5].outputLevel = 88;
  p.ops[5].freqCoarse = 3;
  p.ops[5].oscMode = 1;
  p.ops[5].detune = 10;
  p.ops[5].velSensitivity = 5;
  p.ops[5].ampModSens = 2;
  p.algorithm = 15;
  p.feedback = 6;

  const syx = exportBank([p]);
  const d = syx;
  const off = 6; // skip header

  // OP6 is at offset 0 (first 17 bytes)
  assert(d[off + 0] === 77, `OP6 R1 byte = 77 (got ${d[off+0]})`);
  assert(d[off + 14] === 88, `OP6 level byte = 88 (got ${d[off+14]})`);
  // byte 15: oscMode(bit0) | freqCoarse(bits1-5) = 1 | (3<<1) = 7
  assert(d[off + 15] === (1 | (3 << 1)), `OP6 mode/coarse byte = ${1|(3<<1)} (got ${d[off+15]})`);
  // byte 12: kbdRateScaling(bits0-2) | detune(bits3-6) = 0 | (10<<3) = 80
  assert(d[off + 12] === (0 | (10 << 3)), `OP6 krs/detune byte = ${0|(10<<3)} (got ${d[off+12]})`);
  // byte 13: ampModSens(bits0-1) | velSensitivity(bits2-4) = 2 | (5<<2) = 22
  assert(d[off + 13] === (2 | (5 << 2)), `OP6 ams/vel byte = ${2|(5<<2)} (got ${d[off+13]})`);

  // Global params at offset 102
  const g = off + 102;
  assert(d[g + 8] === 15, `Algorithm byte = 15 (got ${d[g+8]})`);
  // byte 9: feedback(bits0-2) | oscSync(bit3) = 6 | 0 = 6
  assert(d[g + 9] === 6, `Feedback byte = 6 (got ${d[g+9]})`);
}

// ============================================================
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
if (failed > 0) { console.log('SOME TESTS FAILED'); process.exit(1); }
else console.log('ALL SYSEX TESTS PASSED ✓');
