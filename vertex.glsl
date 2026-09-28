#version 300 es
// vertex.glsl - WebGL2 Full-Screen Triangle Vertex Shader
//
// ==============================================================================
// FULL-SCREEN TRIANGLE TECHNIQUE:
// Rather than rendering two triangles (quad) with a diagonal seam, we emit a
// single oversized triangle with coordinates [-1, -1], [3, -1], [-1, 3] in NDC.
// This triangle fully covers the [-1, 1] clip space without generating a
// diagonal primitive edge down the center of the viewport, eliminating
// potential rasterizer seam artifacts and saving vertex overhead.
// ==============================================================================

in vec2 a_position;
out vec2 v_uv;

void main() {
  // Map Normalized Device Coordinates [-1.0, 1.0] to texture UV space
  // [0.0, 1.0]
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
