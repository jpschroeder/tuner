// test_stretch.js - Automated Verification of Stretch Tuning calculation
import assert from "node:assert";
import { STRETCH_TUNINGS } from "./stretch_tunings.js";

console.log("Starting Stretch Tuning Verification...");

const TOTAL_CHANNELS = 96;
const basePitch = 440.0;
const centsOffset = 0.0;

function computePitches(basePitch, centsOffset, stretchOffsets) {
  const targetHzs = new Float32Array(TOTAL_CHANNELS);
  for (let k = 0; k < TOTAL_CHANNELS; k++) {
    const noteIdx = k % 12;
    const oct = Math.floor(k / 12);
    const baseHz = basePitch * Math.pow(2.0, oct - 4 + (noteIdx - 9) / 12.0);
    const hz =
      baseHz * Math.pow(2.0, (centsOffset + stretchOffsets[k]) / 1200.0);
    targetHzs[k] = hz;
  }
  return targetHzs;
}

// Verify that omitting stretchOffsets throws an exception
assert.throws(() => {
  computePitches(basePitch, centsOffset, undefined);
}, TypeError);

// 1. Equal temperament verification (all offsets 0.0)
const equalPitches = computePitches(
  basePitch,
  centsOffset,
  STRETCH_TUNINGS.equal,
);
// A4 is channel index: 4 * 12 + 9 = 57
assert.strictEqual(
  equalPitches[57],
  440.0,
  "A4 in equal temperament must be exactly 440.0 Hz",
);

// 2. Concert Grand verification
const concertPitches = computePitches(
  basePitch,
  centsOffset,
  STRETCH_TUNINGS.concertGrand,
);
// A4 has stretch 0.0 in concertGrand
assert.strictEqual(
  concertPitches[57],
  440.0,
  "A4 in concertGrand should be 440.0 Hz",
);

// C0 (channel index 0) has -12.8 cents offset in concertGrand
const expectedC0Base = basePitch * Math.pow(2.0, 0 - 4 + (0 - 9) / 12.0);
const expectedC0Stretched = expectedC0Base * Math.pow(2.0, -12.8 / 1200.0);
assert(
  Math.abs(concertPitches[0] - expectedC0Stretched) < 1e-4,
  `C0 concert grand pitch should be ${expectedC0Stretched}, got ${concertPitches[0]}`,
);
assert(
  concertPitches[0] < equalPitches[0],
  "C0 in stretch tuning should be lower in frequency than equal temperament",
);

// B7 (channel index 95) has +10.9 cents offset in concertGrand
const expectedB7Base = basePitch * Math.pow(2.0, 7 - 4 + (11 - 9) / 12.0);
const expectedB7Stretched = expectedB7Base * Math.pow(2.0, 10.9 / 1200.0);
assert(
  Math.abs(concertPitches[95] - expectedB7Stretched) < 1e-3,
  `B7 concert grand pitch should be ${expectedB7Stretched}, got ${concertPitches[95]}`,
);
assert(
  concertPitches[95] > equalPitches[95],
  "B7 in stretch tuning should be higher in frequency than equal temperament",
);

// 3. Verify all presets exist and have 96 entries
const expectedPresets = [
  "equal",
  "concertGrand",
  "studioGrand",
  "average",
  "smallGrand",
  "upright",
  "vertical",
  "console",
  "spinet",
];

for (const preset of expectedPresets) {
  assert(
    STRETCH_TUNINGS[preset],
    `Preset ${preset} must exist in STRETCH_TUNINGS`,
  );
  assert.strictEqual(
    STRETCH_TUNINGS[preset].length,
    96,
    `Preset ${preset} must have exactly 96 values`,
  );
  const pitches = computePitches(
    basePitch,
    centsOffset,
    STRETCH_TUNINGS[preset],
  );
  assert.strictEqual(pitches.length, 96);
  // Verify all pitches are strictly increasing
  for (let k = 1; k < 96; k++) {
    assert(
      pitches[k] > pitches[k - 1],
      `Pitches in ${preset} should be strictly monotonically increasing (channel ${k} vs ${k - 1})`,
    );
  }
}

console.log("All Stretch Tuning verification tests PASSED!");
