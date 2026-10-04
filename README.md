# Digital Strobe Tuner

A high-performance digital chromatic strobe tuner with continuous analytical motion blur modeling, built entirely with Vanilla JavaScript and WebGL2. Zero external runtime dependencies or build tools required.

---

## Visual Architecture & UI

- **12-Tone Piano Keyboard Interface**:
  - Natural keys (C, D, E, F, G, A, B) mapped along the bottom tier.
  - Accidental keys (C#, D#, F#, G#, A#) positioned along the top tier.
  - High-contrast electric cyan strobe glow with amber zero-cent center alignment guides.
- **8-Octave Tiered Bands (96 Notes Total)**:
  - Each key is vertically divided into 8 octave tiers (Octaves 0 through 7, spanning C0 to B7).
  - Octave $N$ displays $N + 1$ strobe bars (Octave 0 displays 1 bar; Octave 7 displays 8 bars).
  - Bars remain completely stationary when in tune, drifting right when sharp ($\omega > 0$) and left when flat ($\omega < 0$).

---

## Audio DSP & Mathematical Architecture

1. **Continuous 96-Note DSP Processing (8 Octaves)**:
   - Processes all 96 notes simultaneously within an `AudioWorkletProcessor`.
   - Continuous heterodyning with complex conjugate carrier $e^{-j\omega t}$ using a 2D rotation matrix:
     $$\begin{bmatrix} I_{n+1} \\ Q_{n+1} \end{bmatrix} = \begin{bmatrix} \cos(\Delta\theta) & -\sin(\Delta\theta) \\ \sin(\Delta\theta) & \cos(\Delta\theta) \end{bmatrix} \begin{bmatrix} I_n \\ Q_n \end{bmatrix}$$
   - 2-stage cascaded dynamic-bandwidth IIR low-pass filtering (-12 dB/octave attenuation).
   - 5-block (640-sample window) 2nd-order Savitzky-Golay polynomial derivative filtering to compute $\frac{dI}{dt}$ and $\frac{dQ}{dt}$ with 2-block delay compensation for perfect temporal synchronization.
   - Instantaneous phase $\phi = \operatorname{atan2}(Q, I)$ and angular velocity $\omega = \frac{I \dot{Q} - Q \dot{I}}{I^2 + Q^2}$.

2. **In-Processor Gating, Calibration & Deviation Scaling**:
   - Frequency-dependent baseline noise floors (~$-55$ dB at A4, sloping by $-3$ dB/octave).
   - Dynamic Range and Microphone Sensitivity map input power directly to bar brightness $[0.0, 1.0]$.
   - **Normalized Pitch Deviation**: Pitch error is computed against exact geometric mean boundaries ($\pm 50$ cents / $\sqrt{f_{\text{target}} \cdot f_{\text{neighbor}}}$).
   - **Pitch Bleed Gate**: Signals detuned by more than 50 cents ($|\text{rawDev}| > 1.0$) are gated to zero, eliminating adjacent-semitone harmonic bleed and false rotation artifacts.

3. **Lock-Free Zero-Copy SharedArrayBuffer Transport**:
   - Real-time data transfer from the `AudioWorklet` to the main rendering thread using `SharedArrayBuffer` and `Atomics`.
   - Transmits $[\phi, \omega, \text{brightness}, \text{deviation}]$ across 96 channels into a 128-block circular ring buffer.
   - WebGL2 directly streams the ring buffer into an `RGBA32F` texture via `gl.texSubImage2D()` with zero CPU memory copies or per-frame allocations.

4. **Analytical WebGL2 Motion Blur Shader**:
   - Integrates the 50% duty-cycle square wave of the strobe pattern over each block interval $[t, t + \Delta t]$ using closed-form definite integration:
     $$\int S(\theta)\,d\theta = 0.5\,\theta + \pi \left| \operatorname{fract}\left(\frac{\theta}{2\pi} - 0.25\right) - 0.5 \right|$$
   - Eliminates temporal aliasing, strobing noise, and wagon-wheel artifacts without stochastic multi-sampling or GPU trigonometric overhead.
   - Inactive notes (brightness = 0) are skipped early before evaluating integrals.

---

## Tuner Controls & Flexibility

- **A4 Calibration**: Adjustable reference pitch from 400.0 Hz to 480.0 Hz (default: 440.0 Hz).
- **Stretch Tuning Presets**: Acoustic piano stretch tuning profiles (*Concert Grand, Studio Grand, Average, Small Grand, Upright, Vertical, Console, Spinet*) and standard *Equal Temperament*.
- **Fine Cents Offset**: Global offset from $-50.0$ to $+50.0$ cents.
- **Microphone Sensitivity & Dynamic Range**: Adjustable input gain ($-30$ to $+30$ dB) and visual dynamic range ($6$ to $60$ dB).

---

## How to Run

Modern browsers require Cross-Origin Isolation (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`) to enable `SharedArrayBuffer`.

1. Start the local server:
   ```bash
   make serve
   # or: node server.js
   ```

2. Navigate to [http://localhost:8000](http://localhost:8000) in a supported browser (Chrome, Edge, Firefox).
3. Click **Start Audio** and grant microphone permissions.

---

## Verification & Testing

Run the automated Node.js test suites:

```bash
# Verify heterodyning, low-pass filtering, and Savitzky-Golay numerical derivatives
node test_dsp.js

# Verify stretch tuning curves and pitch calculations
node test_stretch.js
```

*(Linux / PipeWire users)* To route synthetic test frequencies or audio files directly into Chrome's microphone input:
```bash
./play.sh 440        # Generates a 440 Hz sine wave
./play.sh sound.wav  # Streams an audio file
```

---

## Code Formatting

Formatting uses `prettier` and `clang-format` (must be installed on your system):

```bash
make fmt
```
