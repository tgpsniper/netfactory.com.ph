#!/bin/bash
LOG_DIR="/var/log/j2network/audit"
DAYS=30
echo "[AUDIT CLEANUP] $(date) — Scanning $LOG_DIR for files older than $DAYS days"
count=0
for f in "$LOG_DIR"/log*.csv; do
  [ -f "$f" ] || continue
  if [ "$(find "$f" -mtime +$DAYS -print)" ]; then
    echo "[AUDIT CLEANUP] Deleting: $(basename "$f")"
    rm -f "$f"
    count=$((count + 1))
  fi
done
echo "[AUDIT CLEANUP] Done — deleted $count file(s)"
