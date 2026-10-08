#!/usr/bin/env bash
# reset-redis.sh
# Wipes ONLY the current Redis database (SELECT 0) so each example starts clean.
#
# Usage: npm run redis:reset
set -euo pipefail

REDIS_URL="${REDIS_URL:-redis://localhost:6379}"

echo "Before: $(redis-cli -u "$REDIS_URL" dbsize) keys"
redis-cli -u "$REDIS_URL" FLUSHDB
echo "After:  $(redis-cli -u "$REDIS_URL" dbsize) keys"
echo "Redis database reset."
