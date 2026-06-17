---
name: langsearch
description: Web search and semantic reranking via LangSearch API. Use when you need to search the web for current information, research topics, or rerank documents by relevance. Returns summarized content in markdown format. Keywords - search, web, rerank, research, langsearch.
allowed-tools: Bash
---

# LangSearch

Web search and semantic reranking capabilities via LangSearch API.

## Prerequisites

Set your API key as an environment variable:

```bash
export LANGSEARCH_API_KEY="your-api-key-here"
```

Get a free API key at: https://langsearch.com/api-keys

## Web Search

Search billions of web documents with built-in summarization.

### Quick Search (Recommended)

```bash
# Basic search with 5 results
{baseDir}/search.sh "your search query"

# With count and freshness
{baseDir}/search.sh "latest AI news" 10 oneDay
```

### Direct API Call

```bash
curl -s "https://api.langsearch.com/v1/web-search" \
  -H "Authorization: Bearer $LANGSEARCH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "your search query",
    "summary": true,
    "count": 5
  }' | jq .
```

### Parameters

| Parameter | Description | Values |
|-----------|-------------|--------|
| `query` | Search query (required) | Any string |
| `summary` | Return summarized content | `true` / `false` |
| `count` | Number of results | 1-50 (default: 10) |
| `freshness` | Time filter for results | `noLimit`, `oneDay`, `oneWeek`, `oneMonth` |

### Freshness Filter Examples

```bash
# Recent news (last 24 hours)
curl -s "https://api.langsearch.com/v1/web-search" \
  -H "Authorization: Bearer $LANGSEARCH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "latest AI developments",
    "freshness": "oneDay",
    "summary": true,
    "count": 5
  }' | jq .

# Content from the past week
curl -s "https://api.langsearch.com/v1/web-search" \
  -H "Authorization: Bearer $LANGSEARCH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "React 19 release notes",
    "freshness": "oneWeek",
    "summary": true,
    "count": 5
  }' | jq .
```

### Response Structure

```json
{
  "code": 200,
  "data": {
    "webPages": {
      "value": [
        {
          "id": "...",
          "name": "Page Title",
          "url": "https://example.com",
          "displayUrl": "example.com",
          "snippet": "Short snippet...",
          "summary": "Full markdown summary of the page content..."
        }
      ]
    }
  }
}
```

## Semantic Rerank

Rerank documents by semantic relevance to a query.

### Quick Rerank (Recommended)

```bash
{baseDir}/rerank.sh "your query" "First document text" "Second document text" "Third document text"
```

### Direct API Call

```bash
curl -s "https://api.langsearch.com/v1/rerank" \
  -H "Authorization: Bearer $LANGSEARCH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "langsearch-reranker-v1",
    "query": "your query",
    "top_n": 5,
    "return_documents": true,
    "documents": [
      "First document text...",
      "Second document text...",
      "Third document text..."
    ]
  }' | jq .
```

### Rerank Parameters

| Parameter | Description |
|-----------|-------------|
| `model` | Always `langsearch-reranker-v1` |
| `query` | Query to rank documents against |
| `documents` | Array of document strings to rank |
| `top_n` | Number of top results to return |
| `return_documents` | Include document text in response |

### Rerank Response

```json
{
  "code": 200,
  "model": "langsearch-reranker-v1",
  "results": [
    {
      "index": 2,
      "document": { "text": "Document text..." },
      "relevance_score": 0.85
    }
  ]
}
```

## Workflow

1. **Search**: Use web-search to find relevant pages with summaries
2. **Extract**: Parse the `summary` field for markdown content
3. **Rerank** (optional): If you have multiple sources, use rerank to prioritize

## Use Cases

- Research current events or latest developments
- Find documentation for libraries/frameworks
- Get summarized content without visiting pages
- Rerank search results from multiple sources
- Time-filtered searches for recent content

## Tips

- Always set `summary: true` to get markdown-formatted content
- Use `freshness: "oneDay"` for breaking news or time-sensitive queries
- The `summary` field contains the useful content - prefer it over `snippet`
- Results are already ranked by relevance; use rerank for custom prioritization
- Combine with other tools (read, bash) for deeper investigation