#!/usr/bin/env bash
set -euo pipefail
exec cargo test --release --locked --workspace --lib "$@"
