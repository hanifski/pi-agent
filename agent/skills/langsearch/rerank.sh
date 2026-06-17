#!/bin/bash
# LangSearch Rerank Helper
# Usage: rerank.sh "query" "doc1" "doc2" "doc3" ...

QUERY="$1"
shift
DOCS=$(printf '"%s",' "$@" | sed 's/,$//')

if [ -z "$LANGSEARCH_API_KEY" ]; then
    echo "Error: LANGSEARCH_API_KEY not set"
    echo "Run: export LANGSEARCH_API_KEY='your-key'"
    exit 1
fi

curl -s "https://api.langsearch.com/v1/rerank" \
  -H "Authorization: Bearer $LANGSEARCH_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"langsearch-reranker-v1\",
    \"query\": \"$QUERY\",
    \"top_n\": $#,
    \"return_documents\": true,
    \"documents\": [$DOCS]
  }"