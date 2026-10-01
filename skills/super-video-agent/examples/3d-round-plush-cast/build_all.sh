#!/bin/sh
# EXAMPLE: rebuild every cast GLB (and preview stills with --previews). Four Blender jobs at a time.
# Usage: sh build_all.sh [--out <dir>] [--previews] [targets...]
# Blender: set BLENDER to the binary; defaults to the macOS app bundle path.
B=${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}
HERE=$(dirname "$0")
GEN="$HERE/make_cast.py"
OUT="$HERE/out"
if [ "$1" = "--out" ]; then OUT="$2"; shift 2; fi
LOG="$OUT/logs"
mkdir -p "$LOG"
FLAG=""
if [ "$1" = "--previews" ]; then FLAG="--previews"; shift; fi
TARGETS=${*:-"bear cat rabbit puppy pancake props-small props-set props-town"}
"$B" --background --python "$GEN" -- tex --out "$OUT" > "$LOG/tex.log" 2>&1 || { echo "tex FAILED"; exit 1; }
n=0
for t in $TARGETS; do
  ( "$B" --background --python "$GEN" -- "$t" $FLAG --out "$OUT" > "$LOG/$t.log" 2>&1; echo "$t exit $?" >> "$LOG/done.txt" ) &
  n=$((n + 1))
  if [ $((n % 4)) -eq 0 ]; then wait; fi
done
wait
echo "ALL DONE" >> "$LOG/done.txt"
