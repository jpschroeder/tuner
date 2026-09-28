#!/usr/bin/env bash

FREQ="${1:-440}"

# Start SoX generating a continuous sine wave
play -q -n synth sine "$FREQ" &
SOX_PID=$!

# Ensure SoX terminates on exit or interrupt
trap 'kill $SOX_PID 2>/dev/null' EXIT INT TERM

# Brief delay for PipeWire nodes to register
sleep 0.3

# Route SoX directly into Chrome's microphone input
pw-link "SoX:output_FL" "Google Chrome input:input_FL"
pw-link "SoX:output_FR" "Google Chrome input:input_FR"

echo "Routing ${FREQ} Hz sine wave to Chrome. Press Enter or Ctrl+C to stop..."
read -r
