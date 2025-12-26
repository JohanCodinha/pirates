#!/bin/bash
# Simple local server for the hex grid game
# Uses Python's built-in HTTP server

PORT=${1:-8080}
echo "Starting server at http://localhost:$PORT"
echo "Press Ctrl+C to stop"
python3 -m http.server $PORT
