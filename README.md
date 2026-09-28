# Digital Strobe Tuner

A high-performance digital chromatic strobe tuner with continuous analytical motion blur modeling, built entirely with Vanilla JavaScript and WebGL2.

## Key Architecture & Features

1. **Continuous 96-Note DSP Processing (8 Octaves)**:
   - Processes all 96 notes simultaneously in an `AudioWorkletProcessor`.
   - Continuous heterodyning with complex conjugate carrier $e^{-j\omega t}$ and 2-stage cascaded dynamic-bandwidth IIR low-pass filtering.
   - 5-block (640-sample window) 2nd-order Savitzky-Golay polynomial derivative filtering to compute $\frac{dI}{dt}$ and $\frac{dQ}{dt}$.
   - Instantaneous phase $\phi = \operatorname{atan2}(Q, I)$ and angular velocity $\omega = \frac{I \dot{Q} - Q \dot{I}}{I^2 + Q^2}$ are computed directly in the worklet with perfect temporal synchronization.
   - $\omega > 0$ for sharp notes (strobe bars drift right) and $\omega < 0$ for flat notes (strobe bars drift left).

2. **In-Processor Noise, Pitch Bleed Gating & Deviation Scaling**:
   - Noise handling and visual parameter extraction are executed completely within the audio processor rather than the shader.
   - Frequency-dependent baseline noise floors (calibrated around $-55$ dB for A4, sloping by $-3$ dB per octave).
   - Global Microphone Sensitivity and Dynamic Range controls map signal power directly to the target bar brightness $[0.0, 1.0]$. Below the noise floor, values are cleanly gated to 0.
   - **Normalized Pitch Deviation**: Normalized pitch error $[-1.0, 1.0]$ is computed against exact logarithmic geometric mean boundaries ($\pm 50$ cents / $\sqrt{f_{\text{target}} \cdot f_{\text{neighbor}}}$).
   - **Pitch Bleed Gate**: Signals detuned by more than 50 cents ($|\text{rawDev}| > 1.0$) mathematically belong to neighboring notes and are gated out to 0, preventing false-positive rapid rotations on adjacent semitones.

3. **Zero-Copy SharedArrayBuffer Ring Buffer**:
   - Real-time lock-free audio data transfer from the `AudioWorklet` to the main rendering thread using `SharedArrayBuffer` and `Atomics`.
   - Transmits $[\phi, \omega, \text{brightness}, \text{deviation}]$ per channel for 128 continuous blocks.

4. **Analytical WebGL2 Motion Blur Shader**:
   - Reads the newest batch of blocks written since the previous animation frame from a floating-point texture (`RGBA32F`), sampling $[\phi, \omega, \text{brightness}, \text{deviation}]$ directly.
   - Analytically integrates the 50% duty-cycle square wave of the strobe pattern over each block interval, rendering motion blur with zero aliasing or wagon-wheel artifacts.
   - Bypasses transcendental and derivative computations on the GPU, early-out skipping inactive notes where brightness is zero.

## How to Run

Because `SharedArrayBuffer` requires Cross-Origin Isolation in modern web browsers, the application must be served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers.

Run the Node.js server via `make`:

```bash
make serve
# or: node server.js
```

Then open your browser to:
[http://localhost:8000](http://localhost:8000)

Click **Start Audio** to begin tuning.

## Code Formatting

To format JavaScript, HTML, CSS, and GLSL files:

```bash
make fmt
```
