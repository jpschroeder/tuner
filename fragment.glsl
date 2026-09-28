#version 300 es
// fragment.glsl - WebGL2 Strobe Tuner Fragment Shader with Analytical Motion
// Blur
//
// ==============================================================================
// MATHEMATICAL ARCHITECTURE & THEORY:
// 1. Piano Layout Geometry:
//    The screen is mapped to a standard 12-tone octave layout resembling piano
//    keys:
//    - Bottom half (y < 0.5): 7 natural "white keys" (C, D, E, F, G, A, B).
//    - Top half (y >= 0.5): 5 accidental "black keys" (C#, D#, F#, G#, A#)
//    positioned
//      precisely between their adjacent natural keys.
//    - Each key is vertically split into 8 stacked tiers representing octaves 0
//    to 7.
//    - Octave 0 displays 1 rotating strobe bar, Octave 1 displays 2, ...,
//    Octave 7 displays 8.
//
// 2. Analytical Square Wave Motion Blur Integration:
//    A standard strobe tuner displays alternating bright and dark bars modeled
//    as a 50% duty cycle square wave:
//        S(theta) = 0.5 + 0.5 * sign(cos(theta))
//    When a note is vibrating or detuned, the strobe pattern rotates at angular
//    velocity:
//        omega = dPhi/dt = (I * dQ/dt - Q * dI/dt) / (I^2 + Q^2)
//    Instead of stochastic multi-sampling, the exact motion blur across time
//    delta dt is computed by evaluating the closed-form definite integral of
//    S(theta):
//        integral(S(theta) dtheta) = 0.5 * theta + 0.5 * (2/PI) *
//        arcsin(sin(theta))
//    Evaluating across [theta0, theta1] where dTheta = theta1 - theta0 = -omega
//    * dt:
//        Intensity = 0.5 + 0.5 * (2/PI) * (arcsin(sin(theta1)) -
//        arcsin(sin(theta0))) / dTheta
//    This yields perfectly continuous, anti-aliased motion blur without
//    wagon-wheel strobing artifacts or temporal sampling noise.
//
// 3. Zero-Copy Circular Texture Sampling:
//    Recent audio blocks are fetched from the 96x128 RGBA32F ring texture using
//    circular indexing starting at u_headIndex:
//        row = (u_headIndex - b + RING_BLOCKS) % RING_BLOCKS
//    where b = 0 is the newest block and older blocks extend into the frame
//    shutter window.
// ==============================================================================

precision highp float;

in vec2 v_uv;
out vec4 fragColor;

// --- UNIFORMS ---
// 96x128 RGBA32F texture storing [I, Q, dI/dt, dQ/dt] per channel per block
uniform sampler2D u_historyTex;
uniform int
    u_numBlocks; // Number of audio blocks processed since previous render frame
uniform int
    u_headIndex; // Ring buffer head index pointing to the newest audio block
uniform float
    u_dt; // Sample duration of one block in seconds (128 / sampleRate)
uniform vec2 u_resolution; // Canvas viewport resolution in physical pixels

// --- CONSTANTS ---
const int RING_BLOCKS = 128;
const float PI = 3.14159265358979323846;
const float TWO_PI = 6.28318530717958647692;

// Visual styling palette
const vec3 COLOR_WHITE_KEY_BG =
    vec3(0.12, 0.13, 0.16); // Charcoal natural key background
const vec3 COLOR_BLACK_KEY_BG =
    vec3(0.08, 0.09, 0.11); // Obsidian accidental key background
const vec3 COLOR_CHASSIS =
    vec3(0.03, 0.03, 0.04); // Deep black bezel / gap between accidentals
const vec3 COLOR_STROBE_BAR =
    vec3(0.00, 0.90, 0.70); // High-contrast electric cyan strobe glow
const vec3 COLOR_CENTER_TICK =
    vec3(1.00, 0.60, 0.10); // Amber 0-cent target alignment center guide

// --- DATA STRUCTURES ---
struct LayoutInfo {
  bool isKey;  // True if pixel falls inside an active key (not gutter/chassis)
  int noteIdx; // Semitone pitch index (0 to 11, where 0=C, 9=A)
  int octIdx;  // Octave tier (0 to 7)
  int channelIdx;  // 1D channel index in [0, 95] = octIdx * 12 + noteIdx
  float localX;    // Normalized horizontal coordinate within key [0.0, 1.0]
  float localY;    // Normalized vertical coordinate within key [0.0, 1.0]
  float numBars;   // Number of strobe bands displayed (octIdx + 1)
  bool isBlackKey; // True if key is accidental (top half)
};

/**
 * Maps screen UV coordinates [0.0, 1.0] to piano keyboard geometry.
 */
LayoutInfo getLayout(vec2 uv) {
  LayoutInfo info;
  info.isKey = false;
  info.isBlackKey = false;

  float xCol = uv.x * 7.0;
  bool isTopHalf = (uv.y >= 0.5);

  float xMin = 0.0, xMax = 0.0;
  float yMin = isTopHalf ? 0.5 : 0.0;
  float yMax = isTopHalf ? 1.0 : 0.5;

  if (isTopHalf) {
    // Top half: Accidental black keys positioned between natural columns
    if (xCol >= 0.5 && xCol < 1.5) {
      info.noteIdx = 1; // C#
      xMin = 0.5 / 7.0;
      xMax = 1.5 / 7.0;
      info.isBlackKey = true;
    } else if (xCol >= 1.5 && xCol < 2.5) {
      info.noteIdx = 3; // D#
      xMin = 1.5 / 7.0;
      xMax = 2.5 / 7.0;
      info.isBlackKey = true;
    } else if (xCol >= 3.5 && xCol < 4.5) {
      info.noteIdx = 6; // F#
      xMin = 3.5 / 7.0;
      xMax = 4.5 / 7.0;
      info.isBlackKey = true;
    } else if (xCol >= 4.5 && xCol < 5.5) {
      info.noteIdx = 8; // G#
      xMin = 4.5 / 7.0;
      xMax = 5.5 / 7.0;
      info.isBlackKey = true;
    } else if (xCol >= 5.5 && xCol < 6.5) {
      info.noteIdx = 10; // A#
      xMin = 5.5 / 7.0;
      xMax = 6.5 / 7.0;
      info.isBlackKey = true;
    } else {
      // Natural keyboard gaps (between E-F and B-C): render chassis background
      return info;
    }
  } else {
    // Bottom half: 7 natural white keys (C, D, E, F, G, A, B)
    int col = clamp(int(floor(xCol)), 0, 6);
    int naturalNotes[7] = int[7](0, 2, 4, 5, 7, 9, 11);
    info.noteIdx = naturalNotes[col];
    xMin = float(col) / 7.0;
    xMax = float(col + 1) / 7.0;
  }

  // Calculate proportional key margins (gutters)
  float keyW = xMax - xMin;
  float keyH = yMax - yMin;
  vec2 gutter = vec2(keyW * 0.04, keyH * 0.03);

  vec2 keyMin = vec2(xMin, yMin) + gutter;
  vec2 keyMax = vec2(xMax, yMax) - gutter;

  // Mask out pixels inside gutter separators
  if (uv.x < keyMin.x || uv.x >= keyMax.x || uv.y < keyMin.y ||
      uv.y >= keyMax.y) {
    return info;
  }

  info.isKey = true;
  info.localX = (uv.x - keyMin.x) / (keyMax.x - keyMin.x);
  info.localY = (uv.y - keyMin.y) / (keyMax.y - keyMin.y);

  // Divide the key's height into 8 equal octave rows
  float octFloat = clamp(info.localY * 8.0, 0.0, 7.999);
  info.octIdx = int(floor(octFloat));
  info.channelIdx = info.octIdx * 12 + info.noteIdx;
  info.numBars = float(info.octIdx + 1);

  return info;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  LayoutInfo layoutInfo = getLayout(uv);

  if (!layoutInfo.isKey) {
    // Render chassis border/gap
    fragColor = vec4(COLOR_CHASSIS, 1.0);
    return;
  }

  // Choose key base color
  vec3 baseColor =
      layoutInfo.isBlackKey ? COLOR_BLACK_KEY_BG : COLOR_WHITE_KEY_BG;

  // Sub-pixel octave horizontal dividing line
  float octFrac = fract(layoutInfo.localY * 8.0);
  float octLine =
      smoothstep(0.0, 0.02, octFrac) * (1.0 - smoothstep(0.98, 1.0, octFrac));

  // Center 0-cent target alignment guide line (localX = 0.5)
  float centerDist = abs(layoutInfo.localX - 0.5);
  float centerTick = 1.0 - smoothstep(0.005, 0.015, centerDist);

  // --------------------------------------------------------------------------
  // CONTINUOUS ANALYTICAL MOTION BLUR OVER RECENT AUDIO BLOCKS
  // --------------------------------------------------------------------------
  float totalStrobe = 0.0;
  float totalBrightness = 0.0;

  if (u_numBlocks > 0) {
    // Integrate motion blur over audio blocks received since previous frame
    for (int b = 0; b < 16; b++) {
      if (b >= u_numBlocks)
        break;

      // Circular buffer lookup going backwards from newest (b = 0) to oldest
      int row = (u_headIndex - b + RING_BLOCKS) % RING_BLOCKS;

      // Fetch pre-scaled [I, Q, dI/dt, dQ/dt] for this channel at circular row
      vec4 data =
          texelFetch(u_historyTex, ivec2(layoutInfo.channelIdx, row), 0);
      float I = data.r;
      float Q = data.g;
      float dI = data.b;
      float dQ = data.a;

      float power = I * I + Q * Q;
      if (power < 1e-7)
        continue; // Signal below noise floor (pre-gated by worklet)

      // Phasor magnitude was pre-scaled by audio processor to equal bar
      // brightness [0.0, 1.0]
      float brightness = sqrt(power);
      // Instantaneous phase angle theta = atan2(Q, I)
      float phi = atan(Q, I);

      // Exact instantaneous angular velocity dPhi/dt from Savitzky-Golay
      // derivatives: d/dt atan2(Q, I) = (I * dQ/dt - Q * dI/dt) / (I^2 + Q^2)
      float omega = (I * dQ - Q * dI) / power;

      // Spatial phase of rotating strobe pattern at local position X:
      // theta(x) = numBars * 2*PI * localX - phi(t)
      float theta0 = layoutInfo.numBars * TWO_PI * layoutInfo.localX - phi;
      // Pattern phase displacement over block duration dt:
      float dTheta = -omega * u_dt;
      float theta1 = theta0 + dTheta;

      // Analytically integrate 50% duty cycle square wave over interval
      // [theta0, theta1]. The indefinite integral of sign(cos(x)) is (2/PI) *
      // arcsin(sin(x)).
      float barIntensity;
      if (abs(dTheta) < 1e-4) {
        // Stationary limit: perfectly in-tune or stationary pattern
        barIntensity = 0.5 + 0.5 * sign(cos(theta0));
      } else {
        // Continuous temporal average across the motion interval
        float t0 = asin(clamp(sin(theta0), -1.0, 1.0));
        float t1 = asin(clamp(sin(theta1), -1.0, 1.0));
        barIntensity = 0.5 + 0.5 * (2.0 / PI) * (t1 - t0) / dTheta;
      }

      totalStrobe += barIntensity * brightness;
      totalBrightness += brightness;
    }
  }

  // Normalized temporal average across the rendered shutter window
  float avgStrobe = totalStrobe / float(max(u_numBlocks, 1));

  // Composite final fragment color:
  // Base key background + glowing moving strobe bars + subtle amber center
  // reference line
  vec3 color = baseColor * octLine;
  color += COLOR_STROBE_BAR * avgStrobe * octLine;
  color = mix(color, COLOR_CENTER_TICK, centerTick * 0.35);

  fragColor = vec4(color, 1.0);
}
