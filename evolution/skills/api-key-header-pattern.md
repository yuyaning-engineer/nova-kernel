# Skill: API Key Header Pattern
Status: promoted
Confidence: 0.95
Source: council-review-round-5

## Rule
Always pass API keys via HTTP headers (e.g., x-goog-api-key), never in URL query parameters.

## Evidence
T-001, A-004: API keys in URLs leak to logs, proxy caches, Referer headers.

## Application
When making any HTTP request to an AI API (Gemini, OpenAI, etc.), place the key in a request header, not the URL.
