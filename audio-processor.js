// audio-processor.js - 96-Channel Strobe Tuner AudioWorkletProcessor
//
// ==============================================================================
// ARCHITECTURE OVERVIEW:
// 1. Continuous 96-channel Heterodyning:
//    Incoming audio is mixed down to mono and multiplied simultaneously by 96
//    quadrature carrier oscillators (cosine & sine) at target note frequencies
//    spanning 8 octaves (C0 through B7). This translates the target frequency band
//    down to 0 Hz (Baseband DC).
//
// 2. Cascaded 2-Stage Dynamic Lowpass Filtering:
//    Each channel applies two cascaded 1st-order IIR filters to both I and Q
//    streams. Dynamic cutoff bandwidths are calculated from adjacent semitone
//    spacings using a 15 dB rejection factor, giving a steep 2nd-order (12 dB/oct)
//    rolloff that isolates closely spaced low-frequency notes.
//
// 3. Savitzky-Golay 2nd-Order Derivative Filtering:
//    A 5-block window (640 audio samples total) is tracked for each channel.
//    A 2nd-order polynomial least-squares fit calculates the smoothed 1st derivatives
//    (dI/dt, dQ/dt) at the center block. The direct I and Q signals are delayed by
//    2 blocks (256 samples, ~5.3 ms) to achieve perfect temporal synchronization.
//
// 4. In-Worklet Noise Gating, Phase, Velocity & Pitch Deviation Extraction:
//    Noise floor evaluation, dynamic range brightness scaling, instantaneous phase
//    (phi), angular velocity (omega), and normalized pitch deviation ([-1.0, 1.0])
//    are computed directly inside the audio processor rather than deferred to GPU shaders.
//    - omega > 0 (sharp) / omega < 0 (flat) sets the drift direction.
//    - Pitch Bleed Gate: Signals detuned by more than 50 cents (past halfway to adjacent
//      notes, |rawDev| > 1.0) are gated out to 0.0 to prevent adjacent-note strobe artifacts.
//    - Visual brightness [0.0, 1.0] gates quiet channels to zero so inactive notes can be
//      early-out skipped in WebGL.
//
// 5. Lock-Free Zero-Copy SharedArrayBuffer Transport:
//    Outputs [phi, omega, brightness, deviation] are published into a 128-block circular
//    ring buffer in SharedArrayBuffer memory using Atomics.store(), allowing the
//    main thread and WebGL to read the newest frames without CPU memory copies.
// ==============================================================================

const TOTAL_CHANNELS = 96; // 8 octaves * 12 semitones
const SG_BLOCKS = 5; // 5-block window for 2nd-order Savitzky-Golay filter
const RING_BLOCKS = 128; // Circular ring buffer capacity in audio blocks
const HEADER_SIZE = 16; // 16 Int32/Float32 slots reserved for atomic metadata

class StrobeAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const opts = options.processorOptions;
    this.numChannels = TOTAL_CHANNELS;
    this.sampleRate = opts.sampleRate;

    // Tuner parameters (initialized from processorOptions, updated via setParams)
    this.basePitch = opts.a4; // Reference pitch for A4 in Hz
    this.centsOffset = opts.cents; // Global tuning offset in cents
    this.sensitivityDb = opts.sensitivity; // Mic sensitivity offset (lowers effective noise floor)
    this.dynamicRangeDb = opts.dynamicRange; // Dynamic range span for mapping dB to brightness
    this.peakDecay = 0.95;

    // --- OSCILLATOR STATES (COMPLEX LOCAL CARRIERS) ---
    // Complex oscillator states: oscI + j*oscQ (initialized to unit vector 1 + 0j)
    this.oscI = new Float32Array(this.numChannels);
    this.oscQ = new Float32Array(this.numChannels);
    // Pre-calculated rotation step constants: cos(phaseStep) and sin(phaseStep)
    this.cosStep = new Float32Array(this.numChannels);
    this.sinStep = new Float32Array(this.numChannels);
    for (let k = 0; k < this.numChannels; k++) {
      this.oscI[k] = 1.0;
      this.oscQ[k] = 0.0;
    }

    // --- 2-STAGE CASCADED LOWPASS FILTER ACCUMULATORS ---
    // Cascading two 1st-order IIR filters yields a 2nd-order filter with
    // -12 dB/octave attenuation, suppressing the upper heterodyne sidebands (2*fc)
    // and neighboring semitones.
    this.iAcc1 = new Float32Array(this.numChannels);
    this.qAcc1 = new Float32Array(this.numChannels);
    this.iAcc2 = new Float32Array(this.numChannels);
    this.qAcc2 = new Float32Array(this.numChannels);
    this.alpha = new Float32Array(this.numChannels);
    this.oneMinusAlpha = new Float32Array(this.numChannels);

    // --- FREQUENCY & NOISE FLOOR CONFIGURATION ---
    this.targetHzs = new Float32Array(this.numChannels);
    this.maxSharpHz = new Float32Array(this.numChannels);
    this.maxFlatHz = new Float32Array(this.numChannels);
    this.baseNoiseFloors = new Float32Array(this.numChannels);
    // Pre-calculated linear power thresholds (P = I^2 + Q^2) and log constants
    // for early-out noise gating without Math.sqrt or Math.log in the audio loop
    this.powerFloor = new Float32Array(this.numChannels);
    this.logPowerFloor = new Float32Array(this.numChannels);
    this.invLogRange = 0.0;

    // Running envelope tracking for auto-scaling
    this.channelPeaks = new Float32Array(this.numChannels);

    // --- SAVITZKY-GOLAY HISTORY BUFFERS ---
    // Tracks the last 5 block values of I and Q for each channel (5 * 96 elements).
    // Index 0: 4 blocks ago (t = -2)
    // Index 1: 3 blocks ago (t = -1)
    // Index 2: 2 blocks ago (t =  0, center / delayed output point)
    // Index 3: 1 block ago  (t = +1)
    // Index 4: Current block(t = +2)
    this.historyI = new Float32Array(this.numChannels * SG_BLOCKS);
    this.historyQ = new Float32Array(this.numChannels * SG_BLOCKS);

    // Preallocated buffer for mono downmixing to prevent GC pauses on audio thread
    this.currentBlockLen = 0;
    this.monoBuffer = new Float32Array(0);

    // SharedArrayBuffer lock-free synchronization initialized synchronously via processorOptions
    this.sab = opts.sab;
    this.int32View = new Int32Array(this.sab);
    this.float32View = new Float32Array(this.sab);
    this.blockCounter = 0;

    // Populate header fields in the SharedArrayBuffer
    Atomics.store(this.int32View, 1, this.sampleRate);
    Atomics.store(this.int32View, 3, this.numChannels);
    Atomics.store(this.int32View, 4, RING_BLOCKS);

    // Initialize pitch frequencies, filter coefficients, and thresholds immediately
    this.updatePitches(this.basePitch, this.centsOffset);

    // Listen for runtime parameter updates from UI sliders
    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;

      if (data.type === "setParams") {
        let needPitchUpdate = false;
        let needThresholdUpdate = false;
        if (data.a4 !== this.basePitch) {
          this.basePitch = data.a4;
          needPitchUpdate = true;
        }
        if (data.cents !== this.centsOffset) {
          this.centsOffset = data.cents;
          needPitchUpdate = true;
        }
        if (data.sensitivity !== this.sensitivityDb) {
          this.sensitivityDb = data.sensitivity;
          needThresholdUpdate = true;
        }
        if (data.dynamicRange !== this.dynamicRangeDb) {
          this.dynamicRangeDb = data.dynamicRange;
          needThresholdUpdate = true;
        }
        if (needPitchUpdate) {
          this.updatePitches(this.basePitch, this.centsOffset);
        } else if (needThresholdUpdate) {
          this.updateThresholds();
        }
      }
    };
  }

  /**
   * Pre-calculates linear power floors (P = 10^(dB/10)) and logarithmic scaling
   * factors. This allows the audio processing loop to gate inactive channels using
   * a single compare against P = I^2 + Q^2, bypassing transcendental functions.
   */
  updateThresholds() {
    this.invLogRange = 10.0 / (Math.max(1.0, this.dynamicRangeDb) * Math.LN10);
    for (let k = 0; k < this.numChannels; k++) {
      const floorDb = this.baseNoiseFloors[k] - this.sensitivityDb;
      this.powerFloor[k] = Math.pow(10.0, floorDb / 10.0);
      this.logPowerFloor[k] = Math.log(this.powerFloor[k]);
    }
  }

  /**
   * Recalculates all 96 target frequencies, oscillator phase steps, dynamic
   * filter cutoffs, and default per-note noise floors.
   */
  updatePitches(basePitch, centsOffset) {
    // Bandwidth ratio for a 1st-order RC filter to achieve 15 dB attenuation at neighbor note:
    // Attenuation factor: sqrt(10^(15/10) - 1) = sqrt(31.62 - 1) = ~2.1502
    const REJECTION_FACTOR = Math.sqrt(Math.pow(10.0, 15.0 / 20.0) - 1.0);

    // 1. Calculate precise target frequencies across 8 octaves (C0 to B7)
    for (let k = 0; k < this.numChannels; k++) {
      const noteIdx = k % 12; // 0: C, 1: C#, ..., 9: A, 11: B
      const oct = Math.floor(k / 12); // Octave index (0 to 7)

      // Equal temperament frequency relative to A4 (octave 4, note 9):
      // f = basePitch * 2^((oct - 4) + (noteIdx - 9) / 12)
      const baseHz = basePitch * Math.pow(2.0, oct - 4 + (noteIdx - 9) / 12.0);

      // Apply cents offset: f_tuned = baseHz * 2^(cents / 1200)
      const hz = baseHz * Math.pow(2.0, centsOffset / 1200.0);
      this.targetHzs[k] = hz;
    }

    // 2. Set dynamic lowpass filter bandwidths and oscillator phase steps
    for (let k = 0; k < this.numChannels; k++) {
      const hz = this.targetHzs[k];
      const prevHz = k > 0 ? this.targetHzs[k - 1] : 0;
      const nextHz = k < this.numChannels - 1 ? this.targetHzs[k + 1] : 0;

      // Pitch deviation halfway boundaries to adjacent semitones:
      // Halfway pitch boundary is the logarithmic midpoint:
      // Flat midpoint = sqrt(targetHz * prevHz), Sharp midpoint = sqrt(targetHz * nextHz)
      // Edge cases (C0 and B7) fall back to 12-TET 2^(1/24) 50-cent ratio
      if (prevHz) {
        this.maxFlatHz[k] = hz - Math.sqrt(hz * prevHz);
      } else {
        this.maxFlatHz[k] = hz * (1.0 - Math.pow(2.0, -1.0 / 24.0));
      }

      if (nextHz) {
        this.maxSharpHz[k] = Math.sqrt(hz * nextHz) - hz;
      } else {
        this.maxSharpHz[k] = hz * (Math.pow(2.0, 1.0 / 24.0) - 1.0);
      }

      // Determine frequency distance to adjacent semitones. Lower bass notes
      // have much narrower Hz intervals, requiring proportionately tighter filters.
      let minDist;
      if (prevHz && nextHz) {
        minDist = Math.min(hz - prevHz, nextHz - hz);
      } else if (prevHz) {
        minDist = hz - prevHz;
      } else if (nextHz) {
        minDist = nextHz - hz;
      } else {
        // Fallback approximation: 1 semitone down = hz * (1 - 2^(-1/12))
        minDist = hz * (1.0 - Math.pow(2.0, -1.0 / 12.0));
      }

      // Dynamic cutoff frequency: clamp between 0.5 Hz (prevents stalling) and 25 Hz
      const cutoffHz = Math.min(
        25.0,
        Math.max(0.5, minDist / REJECTION_FACTOR),
      );

      // Oscillator phase increment per sample in radians: omega * dt = 2*PI*f / fs
      const phaseStep = (2.0 * Math.PI * hz) / this.sampleRate;
      this.cosStep[k] = Math.cos(phaseStep);
      this.sinStep[k] = Math.sin(phaseStep);

      // Standard 1st-order IIR lowpass smoothing factor: alpha = exp(-2*PI*fc / fs)
      // y[n] = alpha * y[n-1] + (1 - alpha) * x[n]
      this.alpha[k] = Math.exp((-2.0 * Math.PI * cutoffHz) / this.sampleRate);
      this.oneMinusAlpha[k] = 1.0 - this.alpha[k];

      // Physical room & mic noise curves follow 1/f spectral density (pink noise).
      // Base floor is -55 dB for A4, sloping by -3 dB per octave higher:
      const octavesFromA4 = Math.log2(hz / basePitch);
      this.baseNoiseFloors[k] = -55.0 - 3.0 * octavesFromA4;
    }

    // Update power thresholds and log scaling constants
    this.updateThresholds();
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;
    if (!this.float32View) return true; // SAB not yet attached

    const left = input[0];
    const right = input[1] || left;
    const blockLen = left.length;

    // Dynamically update SharedArrayBuffer header if render quantum / block length changes
    if (this.currentBlockLen !== blockLen) {
      this.currentBlockLen = blockLen;
      Atomics.store(this.int32View, 2, blockLen);
    }

    // Downmix stereo input to mono. Reusing monoBuffer avoids heap allocations in the audio thread.
    if (this.monoBuffer.length < blockLen) {
      this.monoBuffer = new Float32Array(blockLen);
    }
    for (let i = 0; i < blockLen; i++) {
      this.monoBuffer[i] = (left[i] + right[i]) * 0.5;
    }

    // Time interval represented by one audio block: dt = blockLen / fs
    const dt = blockLen / this.sampleRate;
    // Pre-factor for Savitzky-Golay 1st derivative: 1 / (10 * dt)
    const inv10dt = 1.0 / (10.0 * dt);

    // Compute circular slot offset in SharedArrayBuffer for this block
    const ringSlot =
      (this.blockCounter % RING_BLOCKS) * (this.numChannels * 4) + HEADER_SIZE;

    // Process all 96 notes concurrently
    for (let k = 0; k < this.numChannels; k++) {
      const cS = this.cosStep[k];
      const sS = this.sinStep[k];
      const a = this.alpha[k];
      const oma = this.oneMinusAlpha[k];

      let oI = this.oscI[k];
      let oQ = this.oscQ[k];
      let iA1 = this.iAcc1[k];
      let qA1 = this.qAcc1[k];
      let iA2 = this.iAcc2[k];
      let qA2 = this.qAcc2[k];

      // ----------------------------------------------------------------------
      // STEP 1: HETERODYNING & 2-STAGE CASCADED IIR LOWPASS FILTERING
      // ----------------------------------------------------------------------
      for (let i = 0; i < blockLen; i++) {
        const s = this.monoBuffer[i];

        // Advance complex oscillator using 2D rotation matrix:
        // [cos -sin] [oI]
        // [sin  cos] [oQ]
        // This avoids calling expensive Math.sin() and Math.cos() per audio sample.
        const nextI = oI * cS - oQ * sS;
        const nextQ = oI * sS + oQ * cS;
        oI = nextI;
        oQ = nextQ;

        // Multiply input audio by complex conjugate carrier e^(-jwt).
        // This shifts audio frequencies by -f_target, moving the target note to 0 Hz DC
        // and producing positive angular velocity (omega > 0) when input is sharp.
        const iSample = s * oI;
        const qSample = -s * oQ;

        // Stage 1 Lowpass Filter: removes high audio frequencies and upper carrier sideband
        iA1 = a * iA1 + oma * iSample;
        qA1 = a * qA1 + oma * qSample;

        // Stage 2 Lowpass Filter: cascaded for steeper 2nd-order rolloff (-12 dB/octave)
        iA2 = a * iA2 + oma * iA1;
        qA2 = a * qA2 + oma * qA1;
      }

      // Re-normalize oscillator to prevent cumulative floating-point magnitude drift
      const magOsc = Math.sqrt(oI * oI + oQ * oQ);
      if (magOsc > 1e-6) {
        const invMag = 1.0 / magOsc;
        oI *= invMag;
        oQ *= invMag;
      } else {
        oI = 1.0;
        oQ = 0.0;
      }
      this.oscI[k] = oI;
      this.oscQ[k] = oQ;
      this.iAcc1[k] = iA1;
      this.qAcc1[k] = qA1;
      this.iAcc2[k] = iA2;
      this.qAcc2[k] = qA2;

      // ----------------------------------------------------------------------
      // STEP 2: SAVITZKY-GOLAY 5-BLOCK HISTORY SHIFT
      // ----------------------------------------------------------------------
      // Shift older block samples back by 1 slot and place current block at index 4
      const hOffset = k * SG_BLOCKS;
      this.historyI[hOffset + 0] = this.historyI[hOffset + 1];
      this.historyI[hOffset + 1] = this.historyI[hOffset + 2];
      this.historyI[hOffset + 2] = this.historyI[hOffset + 3];
      this.historyI[hOffset + 3] = this.historyI[hOffset + 4];
      this.historyI[hOffset + 4] = iA2;

      this.historyQ[hOffset + 0] = this.historyQ[hOffset + 1];
      this.historyQ[hOffset + 1] = this.historyQ[hOffset + 2];
      this.historyQ[hOffset + 2] = this.historyQ[hOffset + 3];
      this.historyQ[hOffset + 3] = this.historyQ[hOffset + 4];
      this.historyQ[hOffset + 4] = qA2;

      // ----------------------------------------------------------------------
      // STEP 3: DERIVATIVE & DELAY MATCHING
      // ----------------------------------------------------------------------
      // Delayed direct I and Q: Taken at center index 2 (delayed by 2 blocks = 256 samples).
      const delayedI = this.historyI[hOffset + 2];
      const delayedQ = this.historyQ[hOffset + 2];

      // Savitzky-Golay 1st derivative coefficients for 5 points, 2nd-order polynomial:
      // c = [-2, -1, 0, 1, 2] / (10 * dt)
      // Evaluating at the center point (t = 0) gives the smoothed derivative dy/dt:
      const dI =
        (-2.0 * this.historyI[hOffset + 0] -
          this.historyI[hOffset + 1] +
          this.historyI[hOffset + 3] +
          2.0 * this.historyI[hOffset + 4]) *
        inv10dt;
      const dQ =
        (-2.0 * this.historyQ[hOffset + 0] -
          this.historyQ[hOffset + 1] +
          this.historyQ[hOffset + 3] +
          2.0 * this.historyQ[hOffset + 4]) *
        inv10dt;

      // ----------------------------------------------------------------------
      // STEP 4: IN-PROCESSOR NOISE GATING, BRIGHTNESS & PHASE/VELOCITY EXTRACTION
      // ----------------------------------------------------------------------
      // Calculate instantaneous power P = I^2 + Q^2
      // const power = delayedI * delayedI + delayedQ * delayedQ;

      // Calculate smoothed power P = I^2 + Q^2 over the same 5 points as the Savitzky-Golay filter
      let sumPower = 0.0;
      for (let j = 0; j < SG_BLOCKS; j++) {
        const hI = this.historyI[hOffset + j];
        const hQ = this.historyQ[hOffset + j];
        sumPower += hI * hI + hQ * hQ;
      }
      const smoothPower = sumPower * 0.2; // Divide by 5

      const outIdx = ringSlot + k * 4;

      // Early-out for channels below noise floor:
      // Inactive notes skip Math.sqrt, Math.log, and division entirely
      if (smoothPower <= this.powerFloor[k]) {
        this.float32View[outIdx + 0] = 0.0;
        this.float32View[outIdx + 1] = 0.0;
        this.float32View[outIdx + 2] = 0.0;
        this.float32View[outIdx + 3] = 0.0;
        continue;
      }

      // Logarithmic dynamic range mapping for active notes:
      // (dB - floorDb) / dynamicRange = (ln(P) - ln(P_floor)) * invLogRange
      const brightness = Math.min(
        1.0,
        Math.max(
          0.0,
          (Math.log(smoothPower) - this.logPowerFloor[k]) * this.invLogRange,
        ),
      );

      // Calculate instantaneous phase (phi) and angular velocity (omega)
      const phi = Math.atan2(delayedQ, delayedI);
      const omega = (delayedI * dQ - delayedQ * dI) / smoothPower;

      // Calculate normalized pitch deviation:
      // deltaHz = f_input - f_target = omega / (2 * PI)
      // Deviation scale: 0.0 = in-tune, +1.0 = halfway to next sharp, -1.0 = halfway to prev flat
      const deltaHz = omega / (2.0 * Math.PI);
      let rawDev = 0.0;
      if (deltaHz > 0.0 && this.maxSharpHz[k] > 0.0) {
        rawDev = deltaHz / this.maxSharpHz[k];
      } else if (deltaHz < 0.0 && this.maxFlatHz[k] > 0.0) {
        rawDev = deltaHz / this.maxFlatHz[k];
      }

      // Pitch Bleed Gate: If the measured frequency is more than halfway to an adjacent note,
      // it belongs to that note's channel instead. Gate it out as noise.
      if (rawDev > 1.0 || rawDev < -1.0) {
        this.float32View[outIdx + 0] = 0.0;
        this.float32View[outIdx + 1] = 0.0;
        this.float32View[outIdx + 2] = 0.0;
        this.float32View[outIdx + 3] = 0.0;
        continue;
      }

      const clampedDev = Math.min(1.0, Math.max(-1.0, rawDev));

      this.float32View[outIdx + 0] = phi;
      this.float32View[outIdx + 1] = omega;
      this.float32View[outIdx + 2] = brightness;
      this.float32View[outIdx + 3] = clampedDev;
    }

    // Atomically publish updated write index to notify main thread and WebGL renderer
    this.blockCounter++;
    Atomics.store(this.int32View, 0, this.blockCounter);

    return true;
  }
}

registerProcessor("strobe-audio-processor", StrobeAudioProcessor);
