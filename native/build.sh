#!/bin/bash
# Compile the native macOS bridge. Runs on build and (via main.cjs) on first launch
# if the binary is missing. Requires the Xcode command-line tools (swiftc).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found — install Xcode command-line tools (xcode-select --install)" >&2
  exit 1
fi
swiftc -O -o "$DIR/mac-bridge" "$DIR/mac-bridge.swift" \
  -framework Cocoa -framework ApplicationServices
echo "built $DIR/mac-bridge"
