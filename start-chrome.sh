#!/bin/bash
# start-chrome.sh — Launch Chrome with remote debugging enabled
# Uses a temporary profile at /tmp/chrome-debug so Chrome starts
# a fresh instance that respects the debugging port flag on macOS.
#
# Usage: ./start-chrome.sh
# Then run: node scraper.js

# Kill any existing Chrome first
pkill -f "Google Chrome" 2>/dev/null
sleep 2

echo "Launching Chrome with remote debugging on port 9222..."
echo ""

open -a "Google Chrome" --args \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug

# Wait for Chrome to start and port to bind
echo "Waiting for Chrome to start..."
for i in $(seq 1 15); do
  sleep 1
  if curl -s http://127.0.0.1:9222/json/version > /dev/null 2>&1; then
    echo ""
    echo "Chrome is running with remote debugging on port 9222!"
    echo ""
    echo "Next steps:"
    echo "  1. Log in to AliExpress in the Chrome window"
    echo "  2. Run: node scraper.js"
    exit 0
  fi
done

echo ""
echo "WARNING: Port 9222 not responding after 15 seconds."
echo "Try closing ALL Chrome windows (Cmd+Q) and running this script again."
exit 1
