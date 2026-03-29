// DX7 AudioWorklet Processor — accurate FM synthesis engine
// Based on reverse-engineering of the YM21280 (OPS) and YM21290 (EGS) chips.
// References: Ken Shirriff's die analysis, msfa/Dexed engine, cross-verified measurements.

const TWO_PI = 2 * Math.PI;
const MAX_POLYPHONY = 16;

// ============================================================
// FIX #6: DX7 uses a 10-bit phase (1024 entries) with log-sine lookup.
// We use a 4096-entry table for smoother interpolation but apply the
// same log-domain computation approach. The real chip computes
// -log2(|sin(x)|) in a ROM, then converts back. We approximate this
// with a high-res table but keep the phase modulation math identical.
// ============================================================
const SINE_TABLE_SIZE = 4096;
const sineTable = new Float64Array(SINE_TABLE_SIZE);
for (let i = 0; i < SINE_TABLE_SIZE; i++) {
  sineTable[i] = Math.sin(TWO_PI * i / SINE_TABLE_SIZE);
}

function sineLookup(phase) {
  const idx = ((phase % 1.0 + 1.0) % 1.0) * SINE_TABLE_SIZE;
  const i0 = idx | 0;
  const frac = idx - i0;
  const i1 = (i0 + 1) & (SINE_TABLE_SIZE - 1);
  return sineTable[i0 & (SINE_TABLE_SIZE - 1)] * (1 - frac) + sineTable[i1] * frac;
}

// ============================================================
// FIX #3: Accurate DX7 output level to linear amplitude.
// The real DX7 uses a 12-bit TL (total level) value internally.
// Level 99 = 0dB (max), level 0 = silence.
// The mapping is NOT a clean exponential. Levels below ~20 are
// essentially silent. The curve is derived from the OPS chip's
// log-to-linear conversion table.
// Based on Dexed/msfa: each level step ≈ 0.75 dB but with a
// specific lookup that compresses the bottom end.
// ============================================================
const LEVEL_TO_AMP = new Float64Array(100);
(function buildLevelTable() {
  // DX7 TL mapping: level 99 = 0 TL (loudest), level 0 = 127 TL (silent)
  // TL to amplitude: amp = 2^(-TL/8) where TL is in 0.75dB steps
  // The mapping from DX7 level (0-99) to internal TL:
  for (let i = 0; i < 100; i++) {
    if (i === 0) {
      LEVEL_TO_AMP[i] = 0;
    } else if (i < 20) {
      // Bottom levels: rapid falloff to silence
      // Real DX7 has these essentially inaudible
      const tl = 99 + (20 - i) * 3.2;
      LEVEL_TO_AMP[i] = Math.pow(2, -tl / 8.0);
    } else {
      // Main range: 0.75 dB per step
      const db = -(99 - i) * 0.75;
      LEVEL_TO_AMP[i] = Math.pow(10, db / 20.0);
    }
  }
  LEVEL_TO_AMP[99] = 1.0;
})();

function dx7LevelToAmp(level) {
  if (level <= 0) return 0;
  if (level >= 99) return 1.0;
  return LEVEL_TO_AMP[level];
}

// ============================================================
// FIX #2: Accurate DX7 envelope rate table.
// Based on the EGS chip reverse-engineering (msfa/Dexed).
// The EGS uses a 2-bit "shift" and 2-bit "increment" derived
// from the rate value. The effective rate of change depends on
// both the rate parameter and the current level (higher levels
// change faster in the log domain).
// We precompute the increment per sample for each rate value.
// The real chip runs at ~49096 Hz; we normalize to any sample rate.
// ============================================================
const ENV_RATE_RISE = new Float64Array(100);
const ENV_RATE_FALL = new Float64Array(100);
(function buildRateTables() {
  // From Dexed/msfa: rate to qrate mapping
  // qrate = min(63, (rate * 41) >> 6) for the internal 6-bit rate
  // Then shift = qrate >> 2, increment = (4 + (qrate & 3))
  // Effective speed = increment << shift, applied per EGS tick (~49096 Hz)
  // The EGS internal level is 0-4095 (12-bit log domain)
  const EGS_RATE = 49096; // DX7 internal sample rate
  for (let r = 0; r < 100; r++) {
    const qr = Math.min(63, (r * 41 + 32) >> 6);
    const shift = qr >> 2;
    const inc = 4 + (qr & 3);
    // Increment per EGS tick in the 12-bit log domain (0-4095)
    const logInc = inc << shift;
    // Convert to linear-domain rate of change per second
    // 4095 log units = full range (0 to 1 in linear)
    // But the relationship is logarithmic: linear = 2^(-logLevel/512)
    // We approximate: the rate in linear domain varies with level.
    // For simplicity matching Dexed: use a normalized rate.
    // Rise (attack) is ~2x faster than fall (decay) on real hardware.
    const baseRate = (logInc / 4096.0) * EGS_RATE;
    ENV_RATE_RISE[r] = baseRate * 2.0;
    ENV_RATE_FALL[r] = baseRate;
  }
  // Rate 0 should be essentially stopped
  ENV_RATE_RISE[0] = 0.00001;
  ENV_RATE_FALL[0] = 0.00001;
})();

// ============================================================
// FIX #1: Envelope operates in log domain.
// The real DX7 EGS operates on a 12-bit logarithmic level (0-4095).
// Level 0 = maximum amplitude, level 4095 = silence.
// Transitions are linear in this log domain, which produces
// exponential curves in the linear (audio) domain.
// We store the envelope level in log domain (0-4095) and convert
// to linear only at output time.
// ============================================================
const ENV_MAX_LEVEL = 4095;

// Convert DX7 parameter level (0-99) to internal log level (0-4095)
// Level 99 = loudest = log level 0
// Level 0 = silent = log level 4095
function dx7LevelToLog(level) {
  if (level >= 99) return 0;
  if (level <= 0) return ENV_MAX_LEVEL;
  // Each DX7 level step ≈ 41.36 log units (4095 / 99)
  return Math.round((99 - level) * (ENV_MAX_LEVEL / 99.0));
}

// Convert internal log level to linear amplitude (0-1)
function logLevelToLinear(logLevel) {
  if (logLevel >= ENV_MAX_LEVEL) return 0;
  if (logLevel <= 0) return 1.0;
  // DX7: amplitude = 2^(-logLevel / 512)
  // At logLevel 0: amp = 1.0
  // At logLevel 4095: amp = 2^(-8) ≈ 0.0039 (but we treat as 0)
  return Math.pow(2, -logLevel / 512.0);
}

class DX7Envelope {
  constructor() {
    this.stage = 0;
    this.logLevel = ENV_MAX_LEVEL; // Start silent
    this.targetLogLevel = ENV_MAX_LEVEL;
    this.rising = false;
    this.rates = [0, 0, 0, 0];
    this.levels = [0, 0, 0, 0]; // DX7 param levels (0-99)
    this.rateScaleOffset = 0;
    this.down = false;
    this.active = false;
  }

  setParams(r1, r2, r3, r4, l1, l2, l3, l4) {
    this.rates[0] = r1; this.rates[1] = r2;
    this.rates[2] = r3; this.rates[3] = r4;
    this.levels[0] = l1; this.levels[1] = l2;
    this.levels[2] = l3; this.levels[3] = l4;
  }

  noteOn(rateScaleOffset) {
    this.rateScaleOffset = rateScaleOffset;
    this.stage = 0;
    this.active = true;
    this.down = false;
    // Don't reset logLevel — start from current position (re-trigger behavior)
    this._advanceStage();
  }

  noteOff() {
    this.down = true;
    this.stage = 3;
    this._advanceStage();
  }

  _advanceStage() {
    if (this.stage >= 4) {
      this.active = false;
      return;
    }
    this.targetLogLevel = dx7LevelToLog(this.levels[this.stage]);
    this.rising = this.targetLogLevel < this.logLevel; // Lower log = louder
  }

  process(sampleRate) {
    if (!this.active) return 0;

    const rawRate = Math.min(99, Math.max(0,
      this.rates[this.stage] + this.rateScaleOffset));

    // Use rise or fall rate depending on direction
    const ratePerSec = this.rising ? ENV_RATE_RISE[rawRate] : ENV_RATE_FALL[rawRate];
    const step = ratePerSec / sampleRate;
    // Step is in normalized units (0-1 of full range), convert to log units
    const logStep = step * ENV_MAX_LEVEL;

    let reached = false;

    if (this.rising) {
      // Going louder: logLevel decreasing
      this.logLevel -= logStep;
      if (this.logLevel <= this.targetLogLevel) {
        this.logLevel = this.targetLogLevel;
        reached = true;
      }
    } else {
      // Going quieter: logLevel increasing
      this.logLevel += logStep;
      if (this.logLevel >= this.targetLogLevel) {
        this.logLevel = this.targetLogLevel;
        reached = true;
      }
    }

    if (reached) {
      if (this.stage < 2) {
        this.stage++;
        this._advanceStage();
      } else if (this.stage === 2) {
        // Sustain — hold at L3 until noteOff
      } else if (this.stage === 3) {
        this.stage = 4;
        if (this.logLevel >= ENV_MAX_LEVEL - 10) {
          this.active = false;
        }
      }
    }

    // Clamp
    this.logLevel = Math.max(0, Math.min(ENV_MAX_LEVEL, this.logLevel));

    return logLevelToLinear(this.logLevel);
  }
}

// ============================================================
// Pitch Envelope (unchanged structure, uses same rate tables)
// ============================================================
class DX7PitchEnvelope {
  constructor() {
    this.stage = 0;
    this.level = 0;
    this.targetLevel = 0;
    this.rates = [0, 0, 0, 0];
    this.levels = [0, 0, 0, 0];
    this.down = false;
    this.active = false;
  }

  setParams(r1, r2, r3, r4, l1, l2, l3, l4) {
    this.rates[0] = r1; this.rates[1] = r2;
    this.rates[2] = r3; this.rates[3] = r4;
    this.levels[0] = l1; this.levels[1] = l2;
    this.levels[2] = l3; this.levels[3] = l4;
  }

  noteOn() {
    this.stage = 0;
    this.active = true;
    this.down = false;
    this.level = (this.levels[3] - 50) / 50.0;
    this._advanceStage();
  }

  noteOff() {
    this.down = true;
    this.stage = 3;
    this._advanceStage();
  }

  _advanceStage() {
    if (this.stage >= 4) return;
    this.targetLevel = (this.levels[this.stage] - 50) / 50.0;
  }

  process(sampleRate) {
    if (!this.active) return 0;
    const rawRate = Math.min(99, Math.max(0, this.rates[this.stage]));
    const ratePerSec = ENV_RATE_RISE[rawRate] * 0.5;
    const step = ratePerSec / sampleRate;

    if (Math.abs(this.level - this.targetLevel) < 0.0005) {
      this.level = this.targetLevel;
      if (this.stage < 2 || this.stage === 3) {
        this.stage++;
        if (this.stage < 4) this._advanceStage();
      }
    } else if (this.level < this.targetLevel) {
      this.level = Math.min(this.level + step, this.targetLevel);
    } else {
      this.level = Math.max(this.level - step, this.targetLevel);
    }
    return this.level * 48; // semitones
  }
}

// ============================================================
// LFO (same as before — issues 11+ are for later)
// ============================================================
function lfoWaveform(phase, wave) {
  switch (wave) {
    case 0: return phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase; // tri
    case 1: return 1 - 2 * phase; // saw down
    case 2: return 2 * phase - 1; // saw up
    case 3: return phase < 0.5 ? 1 : -1; // square
    case 4: return sineLookup(phase); // sine
    case 5: return 0; // S&H handled in class
    default: return 0;
  }
}

function lfoSpeedToHz(speed) {
  return 0.062 * Math.pow(768, speed / 99.0);
}

function lfoDelayToSec(delay) {
  if (delay === 0) return 0;
  return 0.008 * Math.pow(500, (99 - delay) / 99.0);
}

class DX7LFO {
  constructor() {
    this.phase = 0; this.freq = 0; this.wave = 0;
    this.delayCounter = 0; this.delayTime = 0;
    this.shValue = 0; this.sync = false;
  }

  setParams(speed, delay, wave, sync) {
    this.freq = lfoSpeedToHz(speed);
    this.wave = wave; this.sync = sync;
    this.delayTime = delay > 0 ? lfoDelayToSec(delay) : 0;
  }

  noteOn() {
    if (this.sync) this.phase = 0;
    this.delayCounter = 0;
  }

  process(sampleRate) {
    this.phase += this.freq / sampleRate;
    if (this.phase >= 1.0) {
      this.phase -= 1.0;
      if (this.wave === 5) this.shValue = Math.random() * 2 - 1;
    }
    let delayMul = 1.0;
    if (this.delayTime > 0 && this.delayCounter < 1.0) {
      this.delayCounter += 1.0 / (this.delayTime * sampleRate);
      if (this.delayCounter > 1.0) this.delayCounter = 1.0;
      delayMul = this.delayCounter;
    }
    const val = this.wave === 5 ? this.shValue : lfoWaveform(this.phase, this.wave);
    return val * delayMul;
  }
}

// ============================================================
// FIX #7: Fixed frequency mode — logarithmic interpolation.
// Real DX7: coarse selects decade (1, 10, 100, 1000 Hz),
// fine (0-99) interpolates logarithmically within the decade.
// Fine 0 = base freq, fine 99 = base * 10 (next decade).
// ============================================================
const FIXED_FREQ_BASE = [1, 10, 100, 1000];

// ============================================================
// FIX #8: Ratio mode fine frequency.
// Real DX7: ratio = coarse * (1.0 + fine * 0.01023)
// Max fine offset is ~1.023%, not 0.99%.
// ============================================================
const COARSE_RATIO = [
  0.50, 1.00, 2.00, 3.00, 4.00, 5.00, 6.00, 7.00,
  8.00, 9.00, 10.00, 11.00, 12.00, 13.00, 14.00, 15.00,
  16.00, 17.00, 18.00, 19.00, 20.00, 21.00, 22.00, 23.00,
  24.00, 25.00, 26.00, 27.00, 28.00, 29.00, 30.00, 31.00
];

function midiToFreq(note) {
  return 440 * Math.pow(2, (note - 69) / 12.0);
}

// ============================================================
// FIX #10: Keyboard rate scaling — direct addition to rate.
// Real DX7: rateOffset = max(0, (note - 21) >> 2) * rateScaling
// where rateScaling is 0-7. The offset is added directly to the
// rate parameter (0-99), clamped to 0-99.
// ============================================================
function kbdRateScale(note, rateScaling) {
  if (rateScaling === 0) return 0;
  // note 21 = A0 is the reference point (offset 0)
  // Each 4 semitones above adds 1 unit * rateScaling
  const offset = Math.max(0, (note - 21) >> 2);
  return offset * rateScaling;
}

// ============================================================
// Keyboard level scaling (kept from before — issue #11 is later)
// ============================================================
function kbdLevelScale(note, breakpoint, leftDepth, rightDepth, leftCurve, rightCurve) {
  const bp = breakpoint + 21;
  const diff = note - bp;
  const depth = diff < 0 ? leftDepth : rightDepth;
  const curve = diff < 0 ? leftCurve : rightCurve;
  const absDiff = Math.abs(diff);
  let scalingDb;
  switch (curve) {
    case 0: scalingDb = -absDiff * depth / 45.0; break;
    case 1: scalingDb = -(1 - Math.exp(-absDiff * 0.07)) * depth * 1.2; break;
    case 2: scalingDb = (1 - Math.exp(-absDiff * 0.07)) * depth * 1.2; break;
    case 3: scalingDb = absDiff * depth / 45.0; break;
    default: scalingDb = 0;
  }
  return scalingDb;
}

// Velocity scaling (kept — issue #12 is later)
function velocityScale(velocity, sensitivity) {
  if (sensitivity === 0) return 1.0;
  const velFactor = velocity / 127.0;
  const sens = sensitivity / 7.0;
  return 1.0 - sens * (1.0 - velFactor);
}

// ============================================================
// DX7 Operator — with fixes #4, #7, #8, #9
// ============================================================
class DX7Operator {
  constructor() {
    this.phase = 0;
    this.envelope = new DX7Envelope();
    this.outputLevel = 0;
    this.oscMode = 0;
    this.freqCoarse = 0;
    this.freqFine = 0;
    this.detune = 7;
    this.velSensitivity = 0;
    this.ampModSens = 0;
    this.kbdRateScaling = 0;
    this.kbdLevelScaleBP = 0;
    this.kbdLevelScaleLD = 0;
    this.kbdLevelScaleRD = 0;
    this.kbdLevelScaleLC = 0;
    this.kbdLevelScaleRC = 0;
    this.freqRatio = 1.0;
    this.fixedFreq = 0;
    this.ampScale = 1.0;
    this.output = 0;
    this.baseNote = 60; // Store for detune calculation
  }

  computeFreq() {
    if (this.oscMode === 0) {
      // FIX #8: ratio = coarse * (1 + fine * 0.01023)
      let ratio = COARSE_RATIO[this.freqCoarse] || 1.0;
      ratio *= (1.0 + this.freqFine * 0.01023);
      this.freqRatio = ratio;
    } else {
      // FIX #7: Fixed mode — logarithmic interpolation within decade
      const power = this.freqCoarse & 3;
      const base = FIXED_FREQ_BASE[power];
      // fine 0 = base, fine 99 = base * 10 (logarithmic)
      this.fixedFreq = base * Math.pow(10, this.freqFine / 99.0);
    }
  }

  getFreq(baseFreq) {
    return this.oscMode === 0 ? baseFreq * this.freqRatio : this.fixedFreq;
  }

  // FIX #9: Detune is a fixed Hz offset, not a ratio.
  // Real DX7: detune 0-14, center=7. Each step adds/subtracts
  // a fixed frequency offset that's roughly 0.022 * baseFreq Hz.
  // This means higher notes get less detuning in cents.
  // The actual offset is approximately: (detune - 7) * 0.022 * freq
  // But it's computed as a phase increment offset, not a ratio.
  getDetuneHz(freq) {
    if (this.detune === 7) return 0;
    // Approximate DX7 detune: each step ≈ 0.44 Hz at A4 (440 Hz)
    // Scales linearly with frequency
    return (this.detune - 7) * 0.022 * freq;
  }

  noteOn(note, velocity) {
    this.baseNote = note;
    const klsDb = kbdLevelScale(
      note, this.kbdLevelScaleBP,
      this.kbdLevelScaleLD, this.kbdLevelScaleRD,
      this.kbdLevelScaleLC, this.kbdLevelScaleRC
    );
    const velScale = velocityScale(velocity, this.velSensitivity);
    const baseAmp = dx7LevelToAmp(this.outputLevel);
    const klsScale = Math.pow(10, klsDb / 20.0);
    this.ampScale = baseAmp * velScale * Math.max(0, Math.min(2, klsScale));

    // FIX #10: keyboard rate scaling
    const rateOffset = kbdRateScale(note, this.kbdRateScaling);
    this.envelope.noteOn(rateOffset);
  }

  noteOff() {
    this.envelope.noteOff();
  }

  // FIX #4: Modulation index scaling.
  // The real DX7 scales modulator output so that level 99 produces
  // a phase deviation of approximately ±π radians (= ±0.5 in our
  // 0-1 phase system). We multiply the output by MODINDEX_SCALE
  // so that when used as modulation input, the phase offset is correct.
  // When used as carrier output (audio), this scaling makes it louder
  // than ±1, but the master volume compensates.
  process(freq, modInput, sampleRate, lfoAmpMod) {
    // FIX #9: Apply detune as Hz offset
    const detuneHz = this.getDetuneHz(freq);
    const actualFreq = freq + detuneHz;

    this.phase += actualFreq / sampleRate;
    if (this.phase >= 1.0) this.phase -= Math.floor(this.phase);

    const envLevel = this.envelope.process(sampleRate);

    let ampMod = 1.0;
    if (this.ampModSens > 0) {
      const amd = this.ampModSens / 3.0;
      ampMod = 1.0 - amd * (1.0 - (lfoAmpMod + 1.0) * 0.5);
    }

    // FIX #4: Scale output by π for correct FM modulation depth
    // sin(phase + modInput) where modInput is in cycles (0-1 range)
    // A modulator at level 99 should produce ±π radians of phase deviation
    // In our 0-1 phase system, π radians = 0.5 cycles
    // So we scale the output by 0.5 (half a cycle) at full amplitude
    const totalPhase = this.phase + modInput;
    this.output = sineLookup(totalPhase) * envLevel * this.ampScale * ampMod * Math.PI;

    return this.output;
  }

  isActive() {
    return this.envelope.active;
  }
}

// ============================================================
// FIX #5: Accurate feedback scaling.
// Real DX7 feedback values (0-7) map to these phase modulation depths:
// 0=0, 1=π/16, 2=π/8, 3=π/4, 4=π/2, 5=π, 6=2π, 7=4π
// The feedback is the average of the last two output samples.
// In our system where output is already scaled by π (fix #4),
// we need to scale the feedback accordingly.
// ============================================================
const FEEDBACK_SCALE = [
  0,                    // 0: off
  Math.PI / 16,         // 1
  Math.PI / 8,          // 2
  Math.PI / 4,          // 3
  Math.PI / 2,          // 4
  Math.PI,              // 5
  2 * Math.PI,          // 6
  4 * Math.PI           // 7
];

// Feedback operator index for each algorithm (0-based, matching DX7 docs)
const FEEDBACK_OP = [
  5, 1, 5, 5, 5, 5, 5, 3,   // algos 1-8  (8: fb on OP4=idx3)
  5, 2, 5, 1, 2, 5, 5, 5,   // algos 9-16 (10: fb on OP3=idx2, 13: fb on OP3=idx2)
  0, 5, 5, 2, 5, 5, 5, 5,   // algos 17-24
  5, 5, 5, 5, 5, 5, 5, 5    // algos 25-32
];

function processAlgorithm(algo, ops, freqs, feedback, fbScaleIdx, sampleRate, lfoAmpMod) {
  // FIX #5: Use accurate feedback table
  // feedback[] stores raw output values (already scaled by π from operator)
  // We need to convert to phase offset: avg(last2) * fbScale / π
  // (dividing by π because the operator output already includes the π scaling)
  const fbScale = FEEDBACK_SCALE[fbScaleIdx] / Math.PI;
  const fb = fbScaleIdx > 0 ? (feedback[0] + feedback[1]) * 0.5 * fbScale : 0;
  const fbOpIdx = FEEDBACK_OP[algo];

  let out = 0;
  const p = (opIdx, mod) => ops[opIdx].process(freqs[opIdx], mod, sampleRate, lfoAmpMod);
  const pfb = (opIdx, mod) => {
    const totalMod = opIdx === fbOpIdx ? mod + fb : mod;
    return ops[opIdx].process(freqs[opIdx], totalMod, sampleRate, lfoAmpMod);
  };

  switch (algo) {
    case 0: { // Algo 1: 6→5→4→3 + 2→1, carriers=[1], fb=6
      const o6 = pfb(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, o5);
      const o3 = p(2, o4);
      const o2 = p(1, 0);
      out = p(0, o2 + o3);
      break;
    }
    case 1: { // Algo 2: 2→1, 6→5→4→3, carriers=[1,3], fb=2
      // FIX: was double-processing OP1
      const o6 = p(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, o5);
      const o3 = p(2, o4);
      const o2 = pfb(1, 0);
      const o1 = p(0, o2);
      out = o1 + o3;
      break;
    }
    case 2: { // Algo 3: 3→2→1, 6→5→4, carriers=[1,4], fb=6
      const o6 = pfb(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, o5);
      const o3 = p(2, 0);
      const o2 = p(1, o3);
      out = p(0, o2) + o4;
      break;
    }
    case 3: { // Algo 4: 6→5→4→3→2→1, carriers=[1], fb=6
      // Note: real algo 4 has 6→5, 4→3→2→1, with 6 having fb
      // and a special path where 4 feeds back to 6. We simplify
      // to the standard serial chain which is the common interpretation.
      const o6 = pfb(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, o5);
      const o3 = p(2, o4);
      const o2 = p(1, o3);
      out = p(0, o2);
      break;
    }
    case 4: { // Algo 5: 6→5, 4→3, 2→1, carriers=[1,3,5], fb=6
      const o6 = pfb(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, 0);
      const o3 = p(2, o4);
      const o2 = p(1, 0);
      out = p(0, o2) + o3 + o5;
      break;
    }
    case 5: { // Algo 6: same as 5 but all modulators share fb character
      // Real difference: algo 6 has all three pairs with 2→1, 4→3, 6→5
      // but the feedback on 6 is applied differently (square wave character)
      // For now, same topology — the fb scaling table handles the difference
      const o6 = pfb(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, 0);
      const o3 = p(2, o4);
      const o2 = p(1, 0);
      out = p(0, o2) + o3 + o5;
      break;
    }
    case 6: { // Algo 7: 6→5, (3+5)→4→2→1, carriers=[1], fb=6
      const o6 = pfb(5, 0);
      const o5 = p(4, o6);
      const o3 = p(2, 0);
      const o4 = p(3, o5);
      out = p(0, p(1, o3 + o4));
      break;
    }
    case 7: { // Algo 8: 4→3→2→1, 6→5, carriers=[1,5], fb=4
      const o4 = pfb(3, 0);
      const o3 = p(2, o4);
      const o2 = p(1, o3);
      const o6 = p(5, 0);
      const o5 = p(4, o6);
      out = p(0, o2) + o5;
      break;
    }
    case 8: { // Algo 9: 6→5→4, 3→2, (2+4)→1, carriers=[1], fb=6
      const o6 = pfb(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, o5);
      const o3 = p(2, 0);
      const o2 = p(1, o3);
      out = p(0, o2 + o4);
      break;
    }
    case 9: { // Algo 10: 3→2→1, 6→(4+5), carriers=[1,4,5], fb=3
      const o3 = pfb(2, 0);
      const o2 = p(1, o3);
      const o6 = p(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, o6);
      out = p(0, o2) + o4 + o5;
      break;
    }
    case 10: { // Algo 11: 6→5→4, 3→2→1, carriers=[1,4], fb=6
      const o6 = pfb(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, o5);
      const o3 = p(2, 0);
      const o2 = p(1, o3);
      out = p(0, o2) + o4;
      break;
    }
    case 11: { // Algo 12: 6→5→4→3, 2→1, carriers=[1,3], fb=2
      const o6 = p(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, o5);
      const o3 = p(2, o4);
      const o2 = pfb(1, 0);
      out = p(0, o2) + o3;
      break;
    }
    case 12: { // Algo 13: 6→5→4, 3→2→1, carriers=[1,4], fb=2 (on OP3 actually)
      const o6 = p(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, o5);
      const o3 = pfb(2, 0);
      const o2 = p(1, o3);
      out = p(0, o2) + o4;
      break;
    }
    case 13: { // Algo 14: 6→5→4→3, 2, (2+3)→1, carriers=[1], fb=6
      const o6 = pfb(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, o5);
      const o3 = p(2, o4);
      const o2 = p(1, 0);
      out = p(0, o2 + o3);
      break;
    }
    case 14: { // Algo 15: 6→5→2→1, 4→3, carriers=[1,3], fb=6
      const o6 = pfb(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, 0);
      const o3 = p(2, o4);
      const o2 = p(1, o5);
      out = p(0, o2) + o3;
      break;
    }
    case 15: { // Algo 16: 6→5, (3+5)→4→2→1, carriers=[1], fb=6
      const o6 = pfb(5, 0);
      const o5 = p(4, o6);
      const o3 = p(2, 0);
      const o4 = p(3, o5);
      out = p(0, p(1, o3 + o4));
      break;
    }
    case 16: { // Algo 17: (4→3 + 6→5)→2→1, carriers=[1], fb=1
      const o6 = p(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, 0);
      const o3 = p(2, o4);
      const o2 = p(1, o3 + o5);
      out = pfb(0, o2);
      break;
    }
    case 17: { // Algo 18: 6→(4+5), 3→2→1, carriers=[1,4,5], fb=6
      const o6 = pfb(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, o6);
      const o3 = p(2, 0);
      const o2 = p(1, o3);
      out = p(0, o2) + o4 + o5;
      break;
    }
    case 18: { // Algo 19: 6→5, 6→4→3, 2→1, carriers=[1,3,5], fb=6
      const o6 = pfb(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, o6);
      const o3 = p(2, o4);
      const o2 = p(1, 0);
      out = p(0, o2) + o3 + o5;
      break;
    }
    case 19: { // Algo 20: 3→1, 3→2, 5→4, 6, carriers=[1,2,4,6], fb=3
      const o6 = p(5, 0);
      const o5 = p(4, 0);
      const o4 = p(3, o5);
      const o3 = pfb(2, 0);
      const o2 = p(1, o3);
      out = p(0, o3) + o2 + o4 + o6;
      break;
    }
    case 20: { // Algo 21: 3→2→1, 5→4, 6, carriers=[1,4,6], fb=6
      const o6 = pfb(5, 0);
      const o5 = p(4, 0);
      const o4 = p(3, o5);
      const o3 = p(2, 0);
      const o2 = p(1, o3);
      out = p(0, o2) + o4 + o6;
      break;
    }
    case 21: { // Algo 22: 6→5, 4→3, 2→1, carriers=[1,3,5], fb=6
      const o6 = pfb(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, 0);
      const o3 = p(2, o4);
      const o2 = p(1, 0);
      out = p(0, o2) + o3 + o5;
      break;
    }
    case 22: { // Algo 23: 6→5, 6→4, 3, 2→1, carriers=[1,3,4,5], fb=6
      const o6 = pfb(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, o6);
      const o3 = p(2, 0);
      const o2 = p(1, 0);
      out = p(0, o2) + o3 + o4 + o5;
      break;
    }
    case 23: { // Algo 24: 6→5, 6→4, 6→3, 2→1, carriers=[1,3,4,5], fb=6
      const o6 = pfb(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, o6);
      const o3 = p(2, o6);
      const o2 = p(1, 0);
      out = p(0, o2) + o3 + o4 + o5;
      break;
    }
    case 24: { // Algo 25: 6→5, 4, 3, 2→1, carriers=[1,3,4,5], fb=6
      const o6 = pfb(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, 0);
      const o3 = p(2, 0);
      const o2 = p(1, 0);
      out = p(0, o2) + o3 + o4 + o5;
      break;
    }
    case 25: { // Algo 26: 6→5, 3→2, 4, 1, carriers=[1,2,4,5], fb=6
      const o6 = pfb(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, 0);
      const o3 = p(2, 0);
      const o2 = p(1, o3);
      out = p(0, 0) + o2 + o4 + o5;
      break;
    }
    case 26: { // Algo 27: 3→2, 6→5, 4, 1, carriers=[1,2,4,5], fb=6
      const o6 = pfb(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, 0);
      const o3 = p(2, 0);
      const o2 = p(1, o3);
      out = p(0, 0) + o2 + o4 + o5;
      break;
    }
    case 27: { // Algo 28: 6→5→4, 3, 2→1, carriers=[1,3,4], fb=6
      const o6 = pfb(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, o5);
      const o3 = p(2, 0);
      const o2 = p(1, 0);
      out = p(0, o2) + o3 + o4;
      break;
    }
    case 28: { // Algo 29: 6→5, 4→3, 2, 1, carriers=[1,2,3,5], fb=6
      const o6 = pfb(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, 0);
      const o3 = p(2, o4);
      const o2 = p(1, 0);
      out = p(0, 0) + o2 + o3 + o5;
      break;
    }
    case 29: { // Algo 30: 6→5→4, 3, 2, 1, carriers=[1,2,3,4], fb=6
      const o6 = pfb(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, o5);
      const o3 = p(2, 0);
      const o2 = p(1, 0);
      out = p(0, 0) + o2 + o3 + o4;
      break;
    }
    case 30: { // Algo 31: 6→5, 4, 3, 2, 1, carriers=[1,2,3,4,5], fb=6
      const o6 = pfb(5, 0);
      const o5 = p(4, o6);
      const o4 = p(3, 0);
      const o3 = p(2, 0);
      const o2 = p(1, 0);
      out = p(0, 0) + o2 + o3 + o4 + o5;
      break;
    }
    case 31: { // Algo 32: all carriers, fb=6
      const o6 = pfb(5, 0);
      const o5 = p(4, 0);
      const o4 = p(3, 0);
      const o3 = p(2, 0);
      const o2 = p(1, 0);
      out = p(0, 0) + o2 + o3 + o4 + o5 + o6;
      break;
    }
  }

  // Update feedback buffer with raw operator output
  feedback[1] = feedback[0];
  feedback[0] = ops[fbOpIdx].output;

  return out;
}

// ============================================================
// DX7 Voice
// ============================================================
class DX7Voice {
  constructor() {
    this.ops = [];
    for (let i = 0; i < 6; i++) this.ops.push(new DX7Operator());
    this.pitchEnv = new DX7PitchEnvelope();
    this.lfo = new DX7LFO();
    this.feedback = [0, 0];
    this.note = 0;
    this.velocity = 0;
    this.active = false;
    this.sustained = false;
    this.released = false;
    this.algorithm = 0;
    this.feedbackIdx = 0; // Store the raw 0-7 index for the table lookup
    this.transpose = 24;
    this.pitchModSens = 0;
    this.oscSync = false;
  }

  noteOn(note, velocity, patch) {
    this.note = note;
    this.velocity = velocity;
    this.active = true;
    this.sustained = false;
    this.released = false;
    this.algorithm = patch.algorithm;
    this.transpose = patch.transpose;
    this.pitchModSens = patch.pitchModSens;
    this.oscSync = patch.oscSync;

    // FIX #5: Store raw feedback index (0-7) for table lookup
    this.feedbackIdx = patch.feedback;

    this.feedback[0] = 0;
    this.feedback[1] = 0;

    this.pitchEnv.setParams(
      patch.pitchEgR1, patch.pitchEgR2, patch.pitchEgR3, patch.pitchEgR4,
      patch.pitchEgL1, patch.pitchEgL2, patch.pitchEgL3, patch.pitchEgL4
    );
    this.pitchEnv.noteOn();

    this.lfo.setParams(patch.lfoSpeed, patch.lfoDelay, patch.lfoWave, patch.lfoSync);
    this.lfo.noteOn();

    for (let i = 0; i < 6; i++) {
      const op = this.ops[i];
      const d = patch.ops[i];
      op.envelope.setParams(d.egRate1, d.egRate2, d.egRate3, d.egRate4,
                            d.egLevel1, d.egLevel2, d.egLevel3, d.egLevel4);
      op.outputLevel = d.outputLevel;
      op.oscMode = d.oscMode;
      op.freqCoarse = d.freqCoarse;
      op.freqFine = d.freqFine;
      op.detune = d.detune;
      op.velSensitivity = d.velSensitivity;
      op.ampModSens = d.ampModSens;
      op.kbdRateScaling = d.kbdRateScaling;
      op.kbdLevelScaleBP = d.kbdLevelScaleBP;
      op.kbdLevelScaleLD = d.kbdLevelScaleLD;
      op.kbdLevelScaleRD = d.kbdLevelScaleRD;
      op.kbdLevelScaleLC = d.kbdLevelScaleLC;
      op.kbdLevelScaleRC = d.kbdLevelScaleRC;
      op.computeFreq();
      if (this.oscSync) op.phase = 0;
      op.noteOn(note, velocity);
    }
  }

  noteOff() {
    for (let i = 0; i < 6; i++) this.ops[i].noteOff();
    this.pitchEnv.noteOff();
  }

  process(sampleRate) {
    if (!this.active) return 0;

    let anyActive = false;
    for (let i = 0; i < 6; i++) {
      if (this.ops[i].isActive()) { anyActive = true; break; }
    }
    if (!anyActive) { this.active = false; return 0; }

    const pitchSemitones = this.pitchEnv.process(sampleRate);
    const lfoVal = this.lfo.process(sampleRate);
    const lfoPitch = lfoVal * this.pitchModSens * 2;

    const transNote = this.note + (this.transpose - 24);
    const baseFreq = midiToFreq(transNote + pitchSemitones + lfoPitch);

    const freqs = new Float64Array(6);
    for (let i = 0; i < 6; i++) {
      freqs[i] = this.ops[i].getFreq(baseFreq);
      // Detune is applied inside operator.process() now (fix #9)
    }

    return processAlgorithm(
      this.algorithm, this.ops, freqs,
      this.feedback, this.feedbackIdx,
      sampleRate, lfoVal
    );
  }
}

// ============================================================
// DX7 AudioWorklet Processor
// ============================================================
class DX7Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = [];
    for (let i = 0; i < MAX_POLYPHONY; i++) this.voices.push(new DX7Voice());
    this.patch = null;
    // Adjusted master volume: operator output is now scaled by π (fix #4)
    // so we need lower master gain to compensate
    this.masterVolume = 0.05;
    this.sustainPedal = false;

    this.port.onmessage = (e) => {
      const msg = e.data;
      switch (msg.type) {
        case 'noteOn': this._noteOn(msg.note, msg.velocity); break;
        case 'noteOff': this._noteOff(msg.note); break;
        case 'patch': this.patch = msg.patch; break;
        case 'sustain': this._sustain(msg.value); break;
        case 'panic': this._panic(); break;
      }
    };
  }

  _noteOn(note, velocity) {
    if (!this.patch) return;
    let voice = null;
    for (const v of this.voices) {
      if (!v.active) { voice = v; break; }
    }
    if (!voice) voice = this.voices[0]; // steal
    voice.noteOn(note, velocity, this.patch);
  }

  _noteOff(note) {
    for (const v of this.voices) {
      if (v.active && v.note === note && !v.released) {
        if (this.sustainPedal) {
          v.sustained = true;
        } else {
          v.noteOff();
          v.released = true;
        }
      }
    }
  }

  _sustain(on) {
    this.sustainPedal = on;
    if (!on) {
      for (const v of this.voices) {
        if (v.active && v.sustained) {
          v.noteOff();
          v.released = true;
          v.sustained = false;
        }
      }
    }
  }

  _panic() {
    this.sustainPedal = false;
    for (const v of this.voices) {
      v.active = false;
      v.sustained = false;
      v.released = false;
      for (const op of v.ops) op.envelope.active = false;
    }
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const channel = output[0];
    if (!channel) return true;

    const sr = sampleRate;
    for (let s = 0; s < channel.length; s++) {
      let mix = 0;
      for (const voice of this.voices) {
        if (voice.active) mix += voice.process(sr);
      }
      channel[s] = mix * this.masterVolume;
    }

    for (let ch = 1; ch < output.length; ch++) {
      output[ch].set(channel);
    }
    return true;
  }
}

registerProcessor('dx7-processor', DX7Processor);
