#!/usr/bin/env bash
# Stops the local test Moodle and deletes everything it stored.
set -euo pipefail
cd "$(dirname "$0")"
docker compose down -v
