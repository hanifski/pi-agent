#!/bin/bash
# LangSearch Web Search Helper
# Usage: search.sh "query" [count] [freshness]

QUERY="${1:-test}"
COUNT="${2:-5}"
FRESHNESS="${3:-noLimit}"

if [ -z "$LANGSEARCH_API_KEY" ]; then
    echo "Error: LANGSEARCH_API_KEY not set"
    echo "Run: export LANGSEARCH_API_KEY='your-key'"
    exit 1
fi

curl -s "https://api.langsearch.com/v1/web-search" \
  -H "Authorization: Bearer $LANGSEARCH_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"query\": \"$QUERY\",
    \"summary\": true,
    \"count\": $COUNT,
    \"freshness\": \"$FRESHNESS\"
  }"