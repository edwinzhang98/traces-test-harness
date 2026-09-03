#!/usr/bin/env bash
# One-shot setup: verify the toolchain, install the pinned pi CLI locally, fetch
# the official practice environments. Safe to re-run.
set -e

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLES_URL="https://github.com/ApodexAI/executable-world-examples"

# --- 1/4  Node ---------------------------------------------------------------
echo "[1/4] Checking Node..."
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found on PATH." >&2
  echo "       Install Node >= 22 from https://nodejs.org (or via nvm: nvm install 22)." >&2
  exit 1
fi
NODE_VERSION="$(node --version)"
NODE_MAJOR="$(echo "${NODE_VERSION#v}" | cut -d. -f1)"
NODE_MINOR="$(echo "${NODE_VERSION#v}" | cut -d. -f2)"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 19 ]; }; then
  echo "ERROR: Node $NODE_VERSION found, but >= 22.19 is required (by the pinned pi 0.84.3)." >&2
  echo "       Upgrade from https://nodejs.org (or via nvm: nvm install 22)." >&2
  exit 1
fi
echo "      OK: node $NODE_VERSION"

# --- 2/4  Python -------------------------------------------------------------
echo "[2/4] Checking Python..."
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 not found on PATH." >&2
  echo "       Install Python >= 3.11 from https://www.python.org/downloads/." >&2
  exit 1
fi
PYTHON_VERSION="$(python3 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])')"
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 11) else 1)'; then
  echo "ERROR: Python $PYTHON_VERSION found, but >= 3.11 is required." >&2
  echo "       Install Python >= 3.11 from https://www.python.org/downloads/." >&2
  exit 1
fi
echo "      OK: python3 $PYTHON_VERSION"

# --- 3/4  pi CLI (pinned, installed into ./node_modules) ---------------------
echo "[3/4] Installing the pinned pi CLI into ./node_modules (npm install)..."
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found on PATH (it ships with Node)." >&2
  exit 1
fi
if ! npm --prefix "$HERE" install; then
  echo "ERROR: npm install failed. Check your network connection and npm registry access." >&2
  exit 1
fi
echo "      OK: $HERE/node_modules/.bin/pi"

# --- 4/4  practice environments ----------------------------------------------
echo "[4/4] Checking practice environments (executable-world-examples)..."
if [ -d "$HERE/vendor/executable-world-examples" ]; then
  echo "      found: $HERE/vendor/executable-world-examples"
elif [ -d "$HERE/../executable-world-examples" ]; then
  echo "      found: $HERE/../executable-world-examples"
elif [ -d "$HERE/executable-world-examples" ]; then
  echo "      found: $HERE/executable-world-examples"
else
  echo "      not found, cloning $EXAMPLES_URL into ./vendor ..."
  mkdir -p "$HERE/vendor"
  if ! git clone "$EXAMPLES_URL" "$HERE/vendor/executable-world-examples"; then
    echo "ERROR: git clone failed. Clone it manually into ./vendor:" >&2
    echo "       git clone $EXAMPLES_URL vendor/executable-world-examples" >&2
    exit 1
  fi
  echo "      OK: cloned into ./vendor/executable-world-examples (gitignored, never modified)"
fi

echo
echo "Setup complete."
echo "Next: choose how the model is reached (README \"Model access\"), then run one episode:"
echo "  python3 run_experiment.py --tasks corpus_dedup --seeds 0"
