// main.js - Strobe Tuner Main Controller & WebGL2 Motion Blur Renderer
//
// ==============================================================================
// ARCHITECTURE OVERVIEW:
// 1. Lock-Free Zero-Copy Audio Pipeline:
//    - The browser's AudioWorklet thread runs StrobeAudioProcessor, processing
//      continuous blocks of 128 audio samples across 96 channels.
//    - Each block writes [I, Q, dI/dt, dQ/dt] for all 96 notes directly into a
//      SharedArrayBuffer acting as a 128-block circular ring buffer.
//    - The audio thread updates an atomic write counter via Atomics.store().
//
// 2. High-Performance Zero-Copy WebGL Uploads:
//    - In the requestAnimationFrame render loop, the main thread reads the atomic
//      counter using Atomics.load() to determine newly arrived blocks.
//    - A single pre-cached TypedArray view (historyDataView) points directly to
//      the SharedArrayBuffer ring buffer.
//    - gl.texSubImage2D() transmits the entire ring directly from shared memory
//      into an RGBA32F GPU texture (96 columns x 128 rows) with ZERO JavaScript
//      array allocations and ZERO CPU memory copies.
//
// 3. Analytical GPU Strobe Simulation:
//    - fragment.glsl indexes backwards circularly from u_headIndex to integrate
//      the moving 50% duty-cycle strobe square wave over all blocks received
//      since the previous animation frame.
// ==============================================================================

const TOTAL_CHANNELS = 96; // 8 octaves * 12 notes per octave
const RING_BLOCKS = 128; // Circular ring buffer depth in 128-sample blocks
const HEADER_SIZE = 16; // 16 slots (64 bytes) for atomic metadata at buffer start
const MAX_BATCH_BLOCKS = 16; // Maximum blocks to integrate in one visual frame (~42ms)

// Total SharedArrayBuffer footprint:
// 16 Int32 slots + (128 blocks * 96 channels * 4 floats/channel * 4 bytes/float) = 196,672 bytes (~192 KB)
const SAB_BYTE_LENGTH = HEADER_SIZE * 4 + RING_BLOCKS * TOTAL_CHANNELS * 4 * 4;

// Audio state
let audioCtx = null;
let strobeNode = null;
let sab = null;
let int32View = null;
let float32View = null;
let historyDataView = null; // Pre-cached view over the 128-block ring buffer
let isAudioRunning = false;
let lastReadIndex = 0; // Tracks the last processed write count from the audio thread

// WebGL state
let gl = null;
let shaderProgram = null;
let historyTexture = null;

// Uniform locations
let uHistoryTexLoc = null;
let uNumBlocksLoc = null;
let uHeadIndexLoc = null;
let uDtLoc = null;
let uResolutionLoc = null;

/**
 * Asynchronously loads a shader source text file over HTTP.
 */
async function loadShader(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to load shader: ${url} (status: ${response.status})`,
    );
  }
  return await response.text();
}

/**
 * Initializes the WebGL2 rendering context, compiles shaders, configures the
 * full-screen triangle geometry, and allocates the RGBA32F history ring texture.
 */
async function initWebGL() {
  const canvas = document.getElementById("strobe-canvas");
  gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    powerPreference: "high-performance",
  });
  if (!gl) {
    alert("WebGL 2.0 is required for this strobe tuner.");
    return false;
  }

  // Load external shader source files concurrently
  let vsSource, fsSource;
  try {
    [vsSource, fsSource] = await Promise.all([
      loadShader("vertex.glsl"),
      loadShader("fragment.glsl"),
    ]);
  } catch (err) {
    console.error("Shader loading failed:", err);
    return false;
  }

  // Compile Vertex Shader
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, vsSource);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    console.error("Vertex Shader Error:", gl.getShaderInfoLog(vs));
    return false;
  }

  // Compile Fragment Shader
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, fsSource);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    console.error("Fragment Shader Error:", gl.getShaderInfoLog(fs));
    return false;
  }

  // Link Shader Program
  shaderProgram = gl.createProgram();
  gl.attachShader(shaderProgram, vs);
  gl.attachShader(shaderProgram, fs);
  gl.linkProgram(shaderProgram);
  if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
    console.error("Program Link Error:", gl.getProgramInfoLog(shaderProgram));
    return false;
  }

  gl.useProgram(shaderProgram);

  // Full-screen triangle geometry:
  // [-1, -1], [3, -1], [-1, 3] covers the entire clip space without a diagonal seam
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1.0, -1.0, 3.0, -1.0, -1.0, 3.0]),
    gl.STATIC_DRAW,
  );

  const aPos = gl.getAttribLocation(shaderProgram, "a_position");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  // Allocate 96x128 RGBA32F texture for the block history ring buffer
  // Width: 96 channels (one column per note)
  // Height: 128 rows (one row per audio block)
  // Channels: R = I, G = Q, B = dI/dt, A = dQ/dt
  historyTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, historyTexture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA32F,
    TOTAL_CHANNELS,
    RING_BLOCKS,
    0,
    gl.RGBA,
    gl.FLOAT,
    null,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Cache uniform locations
  uHistoryTexLoc = gl.getUniformLocation(shaderProgram, "u_historyTex");
  uNumBlocksLoc = gl.getUniformLocation(shaderProgram, "u_numBlocks");
  uHeadIndexLoc = gl.getUniformLocation(shaderProgram, "u_headIndex");
  uDtLoc = gl.getUniformLocation(shaderProgram, "u_dt");
  uResolutionLoc = gl.getUniformLocation(shaderProgram, "u_resolution");

  gl.uniform1i(uHistoryTexLoc, 0);

  // Set up window resize listener and perform initial sizing
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  return true;
}

/**
 * Handles canvas resizing and retina display pixel density scaling.
 */
function resizeCanvas() {
  if (!gl || !gl.canvas) return;
  const canvas = gl.canvas;
  const dpr = window.devicePixelRatio || 1;
  const displayWidth = Math.round(canvas.clientWidth * dpr);
  const displayHeight = Math.round(canvas.clientHeight * dpr);

  if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
    canvas.width = displayWidth;
    canvas.height = displayHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
}

/**
 * Main animation frame render loop.
 * Transmits newly arrived audio blocks to the GPU via zero-copy upload and
 * draws the motion-blurred strobe canvas.
 */
function render() {
  let numBlocksToRender = 0;
  let headIndex = 0;
  let dt = 128.0 / 48000.0;

  if (int32View && historyDataView) {
    // Atomically read the block write counter published by the audio processor
    const currentWrite = Atomics.load(int32View, 0);
    const sampleRate = Atomics.load(int32View, 1) || 48000;
    dt = 128.0 / sampleRate;

    const available = currentWrite - lastReadIndex;
    if (available > 0) {
      // Clamp to MAX_BATCH_BLOCKS to bound shader loop execution on inactive tab resume
      numBlocksToRender = Math.min(available, MAX_BATCH_BLOCKS);
      // Index of the newest audio block written into the ring
      headIndex = (currentWrite - 1) % RING_BLOCKS;

      // TRUE ZERO-COPY GPU UPLOAD:
      // Direct driver transfer from the SharedArrayBuffer memory view into VRAM.
      // Zero allocations and zero CPU memcpy loops in JavaScript.
      gl.bindTexture(gl.TEXTURE_2D, historyTexture);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        TOTAL_CHANNELS,
        RING_BLOCKS,
        gl.RGBA,
        gl.FLOAT,
        historyDataView,
        0,
      );

      lastReadIndex = currentWrite;
    }
  }

  // Update uniforms and draw full-screen quad
  gl.useProgram(shaderProgram);
  gl.uniform2f(uResolutionLoc, gl.canvas.width, gl.canvas.height);
  gl.uniform1i(uNumBlocksLoc, numBlocksToRender);
  gl.uniform1i(uHeadIndexLoc, headIndex);
  gl.uniform1f(uDtLoc, dt);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, historyTexture);

  gl.drawArrays(gl.TRIANGLES, 0, 3);

  requestAnimationFrame(render);
}

// Cached DOM references for UI controls
const ui = {};

/**
 * Requests microphone permission, instantiates the AudioContext and
 * AudioWorkletNode, allocates the SharedArrayBuffer, and begins processing.
 */
async function startAudio() {
  if (!window.crossOriginIsolated) {
    console.warn(
      "SharedArrayBuffer requires crossOriginIsolated. Ensure server is running with COOP/COEP.",
    );
  }

  try {
    ui.startBtn.disabled = true;
    ui.startBtn.textContent = "Starting...";

    audioCtx = new AudioContext({
      latencyHint: "interactive",
    });

    // Load and register the AudioWorklet processor module
    await audioCtx.audioWorklet.addModule("audio-processor.js");

    // Allocate the lock-free SharedArrayBuffer ring buffer
    sab = new SharedArrayBuffer(SAB_BYTE_LENGTH);
    int32View = new Int32Array(sab);
    float32View = new Float32Array(sab);

    // Pre-cache view of the ring buffer once (zero allocations per frame)
    historyDataView = float32View.subarray(
      HEADER_SIZE,
      HEADER_SIZE + TOTAL_CHANNELS * 4 * RING_BLOCKS,
    );

    // Initial parameters from UI controls
    const a4 = ui.a4.valueAsNumber || 440.0;
    const cents = ui.cents.valueAsNumber || 0.0;
    const sensitivity = ui.sens.valueAsNumber || 0.0;
    const dynamicRange = ui.dyn.valueAsNumber || 30.0;

    // Instantiate AudioWorkletNode, passing SharedArrayBuffer and parameters directly via processorOptions
    strobeNode = new AudioWorkletNode(audioCtx, "strobe-audio-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: {
        sab,
        sampleRate: audioCtx.sampleRate,
        a4,
        cents,
        sensitivity,
        dynamicRange,
      },
    });

    // Acquire raw microphone audio stream with DSP preprocessing disabled
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    const micSource = audioCtx.createMediaStreamSource(stream);
    micSource.connect(strobeNode);

    // Synchronize initial UI control values
    syncParams();

    isAudioRunning = true;
    ui.startBtn.textContent = "Audio Active";
  } catch (err) {
    console.error("Audio initialization failed:", err);
    alert("Could not start audio: " + err.message);
    ui.startBtn.disabled = false;
    ui.startBtn.textContent = "Start Audio";
  }
}

/**
 * Transmits current tuning, sensitivity, and dynamic range parameters
 * from the HTML sliders to the AudioWorkletProcessor.
 */
function syncParams() {
  const a4 = ui.a4.valueAsNumber || 440.0;
  const cents = ui.cents.valueAsNumber || 0.0;
  const sensitivity = ui.sens.valueAsNumber || 0.0;
  const dynamicRange = ui.dyn.valueAsNumber || 30.0;

  ui.centsVal.textContent =
    cents > 0 ? `+${cents.toFixed(1)}` : cents.toFixed(1);
  ui.sensVal.textContent =
    sensitivity > 0 ? `+${sensitivity.toFixed(1)}` : sensitivity.toFixed(1);
  ui.dynVal.textContent = dynamicRange.toFixed(0);

  if (!strobeNode) return;

  strobeNode.port.postMessage({
    type: "setParams",
    a4,
    cents,
    sensitivity,
    dynamicRange,
  });
}

/**
 * Binds UI event listeners for sliders and start button.
 */
function setupUI() {
  ui.startBtn = document.getElementById("start-btn");
  ui.a4 = document.getElementById("a4-freq");
  ui.cents = document.getElementById("cents-offset");
  ui.sens = document.getElementById("mic-sensitivity");
  ui.dyn = document.getElementById("dynamic-range");
  ui.centsVal = document.getElementById("cents-val");
  ui.sensVal = document.getElementById("sens-val");
  ui.dynVal = document.getElementById("dyn-val");

  ui.startBtn.addEventListener("click", () => {
    if (!isAudioRunning) {
      startAudio();
    }
  });

  [ui.a4, ui.cents, ui.sens, ui.dyn].forEach((el) => {
    el.addEventListener("input", syncParams);
  });
}

// Bootstrap application on page load
if (typeof window !== "undefined" && window.addEventListener) {
  window.addEventListener("DOMContentLoaded", async () => {
    setupUI();
    const ok = await initWebGL();
    if (ok) {
      requestAnimationFrame(render);
    }
  });
}

/**
 * Sets WebGL context for testing purposes.
 */
function setGL(context) {
  gl = context;
}

export { resizeCanvas, setGL };
