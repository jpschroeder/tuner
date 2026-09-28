# Digital Strobe Tuner

A high-performance digital chromatic strobe tuner with continuous analytical motion blur modeling, built entirely with Vanilla JavaScript and WebGL2.

## Key Architecture & Features

1. **Continuous 96-Note DSP Processing (8 Octaves)**:
   - Processes all 96 notes simultaneously in an `AudioWorkletProcessor`.
   - Continuous heterodyning with 2-stage cascaded dynamic-bandwidth IIR low-pass filtering.
   - 5-block (640-sample window) 2nd-order Savitzky-Golay polynomial derivative filtering to compute $\frac{dI}{dt}$ and $\frac{dQ}{dt}$.
   - Direct $I$ and $Q$ output is delayed by 2 blocks (256 samples, ~5.3 ms) to synchronize with the Savitzky-Golay center derivative.

2. **In-Processor Noise & Dynamic Range Scaling**:
   - Noise handling is executed completely within the audio processor rather than the shader.
   - Frequency-dependent baseline noise floors (calibrated around $-55$ dB for A4, sloping by $-3$ dB per octave).
   - Global Microphone Sensitivity and Dynamic Range controls scale the $(I, Q)$ phasor magnitude directly to the target bar brightness. Below the noise floor, the magnitude is cleanly gated to 0.

3. **Zero-Copy SharedArrayBuffer Ring Buffer**:
   - Real-time lock-free audio data transfer from the `AudioWorklet` to the main rendering thread using `SharedArrayBuffer` and `Atomics`.

4. **Analytical WebGL2 Motion Blur Shader**:
   - Reads the newest batch of blocks written since the previous animation frame from a floating-point texture (`RGBA32F`).
   - Calculates exact instantaneous angular velocity $\omega = \frac{I \dot{Q} - Q \dot{I}}{I^2 + Q^2}$.
   - Analytically integrates the 50% duty-cycle square wave of the strobe pattern over each block interval, rendering motion blur with zero aliasing or wagon-wheel artifacts.

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
