// test_dsp.js - Automated Verification of Strobe Tuner Heterodyning, Lowpass & Savitzky-Golay Derivatives

import assert from "node:assert";

console.log("Starting DSP and Savitzky-Golay Verification...");

const sampleRate = 48000;
const blockLen = 128;
const targetHz = 440.0;
const inputHz = 440.5; // +0.5 Hz detuned input tone

const phaseStep = (2.0 * Math.PI * targetHz) / sampleRate;
const cS = Math.cos(phaseStep);
const sS = Math.sin(phaseStep);

// Filter setup (rejection factor for 15dB)
const REJECTION_FACTOR = Math.sqrt(Math.pow(10.0, 15.0 / 20.0) - 1.0);
const minDist = 440.0 * (1.0 - Math.pow(2.0, -1.0 / 12.0)); // ~24.7 Hz
const cutoffHz = Math.min(25.0, Math.max(0.5, minDist / REJECTION_FACTOR));
const alpha = Math.exp((-2.0 * Math.PI * cutoffHz) / sampleRate);
const oma = 1.0 - alpha;

let oscI = 1.0;
let oscQ = 0.0;
let iA1 = 0.0,
  qA1 = 0.0,
  iA2 = 0.0,
  qA2 = 0.0;

const historyI = new Float32Array(5);
const historyQ = new Float32Array(5);

const dt = blockLen / sampleRate;
const inv10dt = 1.0 / (10.0 * dt);

let inputPhase = 0.0;
const inputStep = (2.0 * Math.PI * inputHz) / sampleRate;

// Run 200 blocks to settle filter transient response
let lastOmega = 0.0;
let lastMag = 0.0;

for (let b = 0; b < 200; b++) {
  for (let i = 0; i < blockLen; i++) {
    const s = Math.sin(inputPhase);
    inputPhase += inputStep;

    const nextI = oscI * cS - oscQ * sS;
    const nextQ = oscI * sS + oscQ * cS;
    oscI = nextI;
    oscQ = nextQ;

    const iSample = s * oscI;
    const qSample = -s * oscQ;

    iA1 = alpha * iA1 + oma * iSample;
    qA1 = alpha * qA1 + oma * qSample;
    iA2 = alpha * iA2 + oma * iA1;
    qA2 = alpha * qA2 + oma * qA1;
  }

  // Unit re-normalization
  const magOsc = Math.hypot(oscI, oscQ);
  if (magOsc > 1e-6) {
    oscI /= magOsc;
    oscQ /= magOsc;
  }

  // Update SG history
  historyI[0] = historyI[1];
  historyI[1] = historyI[2];
  historyI[2] = historyI[3];
  historyI[3] = historyI[4];
  historyI[4] = iA2;

  historyQ[0] = historyQ[1];
  historyQ[1] = historyQ[2];
  historyQ[2] = historyQ[3];
  historyQ[3] = historyQ[4];
  historyQ[4] = qA2;

  if (b >= 50) {
    const dI =
      (-2.0 * historyI[0] - historyI[1] + historyI[3] + 2.0 * historyI[4]) *
      inv10dt;
    const dQ =
      (-2.0 * historyQ[0] - historyQ[1] + historyQ[3] + 2.0 * historyQ[4]) *
      inv10dt;
    const delayedI = historyI[2];
    const delayedQ = historyQ[2];

    const power = delayedI * delayedI + delayedQ * delayedQ;
    const mag = Math.sqrt(power);
    const omega = (delayedI * dQ - delayedQ * dI) / power;

    lastOmega = omega;
    lastMag = mag;
  }
}

// Expected frequency difference is: deltaF = inputHz - targetHz = 440.5 - 440.0 = +0.5 Hz
// Expected angular velocity omega = 2 * PI * deltaF = +PI rad/s ~ +3.14159 rad/s (positive for sharp = rotating right)
const expectedOmega = (inputHz - targetHz) * 2.0 * Math.PI;
console.log(
  `Measured omega: ${lastOmega.toFixed(4)} rad/s, Expected: ~${expectedOmega.toFixed(4)} rad/s`,
);
console.log(`Measured phasor magnitude: ${lastMag.toFixed(4)}`);

// Verify that magnitude is positive and significant
assert(
  lastMag > 0.1,
  "Phasor magnitude must be well above 0 for resonant frequency",
);

// Verify that angular velocity matches the detuning frequency within 5%
const measuredFreq = lastOmega / (2.0 * Math.PI);
const expectedFreq = inputHz - targetHz;
const error = Math.abs(measuredFreq - expectedFreq);
console.log(
  `Measured frequency difference: ${measuredFreq.toFixed(3)} Hz (Error: ${error.toFixed(4)} Hz)`,
);
assert(error < 0.05, `Frequency error must be under 0.05 Hz, got ${error}`);

// ----------------------------------------------------------------------------
// VERIFY POWER THRESHOLD GATING & LOG BRIGHTNESS SCALING
// ----------------------------------------------------------------------------
console.log("Verifying Power Threshold & Log Brightness Scaling...");

const floorDb = -55.0;
const dynamicRangeDb = 30.0;
const powerFloor = Math.pow(10.0, floorDb / 10.0);
const logPowerFloor = (floorDb / 10.0) * Math.LN10;
const invLogRange = 10.0 / (dynamicRangeDb * Math.LN10);

// Test 1: Signal below noise floor (-60 dB)
const silentMag = Math.pow(10.0, -60.0 / 20.0);
const silentPower = silentMag * silentMag;
assert(silentPower <= powerFloor, "Silent power must be <= powerFloor");

// Test 2: Signal within dynamic range (-40 dB, halfway between -55 and -25)
const midMag = Math.pow(10.0, -40.0 / 20.0);
const midPower = midMag * midMag;
assert(midPower > powerFloor, "Mid power must be > powerFloor");

const expectedBrightness = (-40.0 - floorDb) / dynamicRangeDb; // (-40 - -55) / 30 = 15 / 30 = 0.5
const testBrightness = Math.min(
  1.0,
  (Math.log(midPower) - logPowerFloor) * invLogRange,
);
assert(
  Math.abs(testBrightness - expectedBrightness) < 1e-6,
  `Brightness mismatch: expected ${expectedBrightness}, got ${testBrightness}`,
);

// Test 3: Loud signal above ceiling (-20 dB)
const loudMag = Math.pow(10.0, -20.0 / 20.0);
const loudPower = loudMag * loudMag;
const loudBrightness = Math.min(
  1.0,
  Math.max(0.0, (Math.log(loudPower) - logPowerFloor) * invLogRange),
);
assert.strictEqual(loudBrightness, 1.0, "Loud brightness must saturate to 1.0");

// Test 4: Boundary condition at threshold with float32 precision
const f32PowerFloor = new Float32Array(1);
const f32LogPowerFloor = new Float32Array(1);
f32PowerFloor[0] = Math.pow(10.0, floorDb / 10.0);
f32LogPowerFloor[0] = Math.log(f32PowerFloor[0]);

const thresholdPower = f32PowerFloor[0] * (1.0 + 1e-7);
const thresholdBrightness = Math.min(
  1.0,
  Math.max(0.0, (Math.log(thresholdPower) - f32LogPowerFloor[0]) * invLogRange),
);
assert(
  thresholdBrightness >= 0.0,
  `Threshold brightness must be non-negative, got ${thresholdBrightness}`,
);

// ----------------------------------------------------------------------------
// VERIFY NORMALIZED PITCH DEVIATION METRIC (SHARP / FLAT METER)
// ----------------------------------------------------------------------------
console.log("Verifying Normalized Pitch Deviation Meter calculations...");

const a4Hz = 440.0;
const prevNoteHz = a4Hz * Math.pow(2.0, -1.0 / 12.0); // G#4 ~ 415.305 Hz
const nextNoteHz = a4Hz * Math.pow(2.0, 1.0 / 12.0); // A#4 ~ 466.164 Hz

// Exact logarithmic halfway boundary is the geometric mean (sqrt(f1 * f2) = 50 cents)
const maxFlatHz = a4Hz - Math.sqrt(a4Hz * prevNoteHz); // ~ 12.176 Hz (50 cents flat)
const maxSharpHz = Math.sqrt(a4Hz * nextNoteHz) - a4Hz; // ~ 12.894 Hz (50 cents sharp)

// Verify exact correspondence to 2^(1/24) (50 cents)
const expected50CentsFlatHz = a4Hz * (1.0 - Math.pow(2.0, -1.0 / 24.0));
const expected50CentsSharpHz = a4Hz * (Math.pow(2.0, 1.0 / 24.0) - 1.0);
assert(
  Math.abs(maxFlatHz - expected50CentsFlatHz) < 1e-6,
  "maxFlatHz must match exact 50-cent logarithmic boundary",
);
assert(
  Math.abs(maxSharpHz - expected50CentsSharpHz) < 1e-6,
  "maxSharpHz must match exact 50-cent logarithmic boundary",
);

assert(
  maxFlatHz > 0 && maxSharpHz > 0,
  "Halfway boundaries must be positive numbers",
);
assert(
  maxSharpHz > maxFlatHz,
  "Sharp boundary in Hz must be larger than flat boundary due to log spacing",
);

// Test A: Sharp detuning deviation (+0.5 Hz input from earlier simulation)
const measuredDeltaHz = lastOmega / (2.0 * Math.PI);
const expectedDeltaHz = inputHz - targetHz; // +0.5 Hz
assert(
  Math.abs(measuredDeltaHz - expectedDeltaHz) < 0.05,
  `measuredDeltaHz should be close to +0.5 Hz, got ${measuredDeltaHz}`,
);

let devSharp =
  measuredDeltaHz > 0
    ? measuredDeltaHz / maxSharpHz
    : measuredDeltaHz / maxFlatHz;
devSharp = Math.min(1.0, Math.max(-1.0, devSharp));
const expectedDevSharp = 0.5 / maxSharpHz;
assert(
  Math.abs(devSharp - expectedDevSharp) < 0.01,
  `Deviation mismatch: expected ~${expectedDevSharp.toFixed(4)}, got ${devSharp.toFixed(4)}`,
);
console.log(
  `Sharp deviation (+0.5 Hz): measured = ${devSharp.toFixed(4)}, expected = ${expectedDevSharp.toFixed(4)}`,
);

// Test B: Flat detuning (-0.5 Hz)
const flatDeltaHz = -0.5;
let devFlat =
  flatDeltaHz < 0 ? flatDeltaHz / maxFlatHz : flatDeltaHz / maxSharpHz;
devFlat = Math.min(1.0, Math.max(-1.0, devFlat));
const expectedDevFlat = -0.5 / maxFlatHz;
assert(
  Math.abs(devFlat - expectedDevFlat) < 1e-6,
  `Flat deviation mismatch: expected ${expectedDevFlat}, got ${devFlat}`,
);
assert(devFlat < 0, "Flat deviation must be negative");

// Test C: Halfway boundaries (+1.0 and -1.0)
const halfwaySharpDelta = maxSharpHz;
const halfwayFlatDelta = -maxFlatHz;
const devHalfwaySharp = Math.min(
  1.0,
  Math.max(-1.0, halfwaySharpDelta / maxSharpHz),
);
const devHalfwayFlat = Math.min(
  1.0,
  Math.max(-1.0, halfwayFlatDelta / maxFlatHz),
);
assert.strictEqual(
  devHalfwaySharp,
  1.0,
  "Halfway sharp must equal exactly +1.0",
);
assert.strictEqual(
  devHalfwayFlat,
  -1.0,
  "Halfway flat must equal exactly -1.0",
);

// Test D: Clamping beyond halfway boundaries
const overSharpDelta = maxSharpHz * 1.5;
const overFlatDelta = -maxFlatHz * 1.5;
const devOverSharp = Math.min(1.0, Math.max(-1.0, overSharpDelta / maxSharpHz));
const devOverFlat = Math.min(1.0, Math.max(-1.0, overFlatDelta / maxFlatHz));
assert.strictEqual(devOverSharp, 1.0, "Over-sharp must clamp to +1.0");
assert.strictEqual(devOverFlat, -1.0, "Over-flat must clamp to -1.0");

console.log("All DSP and Savitzky-Golay verification tests PASSED!");
