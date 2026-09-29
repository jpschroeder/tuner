#!/usr/bin/env bash

INPUT="${1:-440}"
CHROME_IN_L="Google Chrome input:input_FL"
CHROME_IN_R="Google Chrome input:input_FR"

# 1. Fail early if Chrome's microphone input isn't running
if ! pw-link -i | grep -q "$CHROME_IN_L"; then
    echo "Error: Google Chrome microphone input not found."
    echo "Make sure a Chrome tab is actively requesting microphone access."
    exit 1
fi

# 2. Check if input is an existing file, otherwise assume it's a frequency
if [[ -f "$INPUT" ]]; then
    echo "Playing audio file: $INPUT"
    play -q "$INPUT" &
    SOX_PID=$!
else
    echo "Generating ${INPUT} Hz sine wave"
    play -q -n synth sine "$INPUT" &
    SOX_PID=$!
fi

trap 'kill $SOX_PID 2>/dev/null; exit' INT TERM
trap 'kill $SOX_PID 2>/dev/null' EXIT

# Brief delay for PipeWire nodes to register
sleep 0.3

# Route SoX directly into Chrome's microphone input
pw-link "SoX:output_FL" "$CHROME_IN_L"
pw-link "SoX:output_FR" "$CHROME_IN_R"

echo "Routing audio to Chrome."
echo "Press Ctrl+C to stop, or close the Chrome mic to auto-stop..."

# 3. Auto-stop when Chrome stops OR the audio file finishes
# 'kill -0' checks if the SoX process is still running
while pw-link -i | grep -q "$CHROME_IN_L" && kill -0 $SOX_PID 2>/dev/null; do
    sleep 1
done

echo "Finished. Exiting..."