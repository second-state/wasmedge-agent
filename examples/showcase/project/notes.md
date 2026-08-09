# Ops handoff

You are inheriting two files from the ops team:

- `logs/access.log` — one morning of API traffic from 2026-08-05. The
  `/api` service has been flaky since Tuesday; nobody has quantified it.
  The log format is `ip - - [DD/Mon/YYYY:HH:MM:SS +0000] "METHOD path HTTP/1.1" status bytes latency`;
  the bracketed timestamp contains a space, so it spans two whitespace-separated
  fields. `status` and `bytes` are bare integers and `latency` carries an `ms`
  suffix (e.g. `24ms`). The collector was glitching, so expect some corrupted
  lines.
- `data/inventory.csv` — the current warehouse inventory snapshot
  (`sku,name,warehouse,qty,unit_price`).

Questions the team wants answered: how bad is the flakiness and where, which
stock is about to run out, and where the inventory value sits.
