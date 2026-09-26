#!/usr/bin/env bash
# Runs once, right after the Codespace is created.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Downloading Go dependencies"
(cd backend && go mod tidy)

echo "==> Installing Angular dependencies"
(cd frontend && npm install --no-audit --no-fund)

echo
echo "Setup complete. Start the app with two terminals:"
echo "  1) cd backend && go run ."
echo "  2) cd frontend && npm start"
