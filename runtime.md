# Runtime for the first two stages

Use Node.js 26 LTS and the TypeScript SDK's `@modelcontextprotocol/server` package. Import its stdio transport from `@modelcontextprotocol/server/stdio`. For Stage 2, use `Database` from `node:sqlite`. The local Node build already supports FTS5. [Node release](https://nodejs.org/en/blog/release/v26.13.0) · [SDK package at v2.4.0](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.4.0/packages/server/package.json) · [Node SQLite API](https://nodejs.org/api/sqlite.html)

## Local checks

On November 19, 2026, the following checks ran on macOS 26.7.3, Apple silicon.

| Check | Observed result |
| --- | --- |
| Runtime | Node 26.13.0 reported the Lithium LTS release. |
| Search | An in-memory database reported SQLite 3.54.1. An FTS5 table accepted a fixture passage. A parameterized `MATCH` query returned it with a BM25 score. |
| Transport | A test client launched the reference filesystem server 2.4.0 with SDK 2.4.0 over stdio. It negotiated MCP 2025-11-25, listed tools, and read a synthetic note. |
| Codex | Codex CLI 0.167.0 exposed the command-based stdio registration syntax in `codex mcp add --help`. |

The reference server supplied the protocol probe. Margin needs its own read-only tool set. [Reference server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) · [SDK release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.4.0) · [FTS5 queries](https://sqlite.org/fts5.html)

## Step 1 acceptance

Configure Codex with absolute paths to Node, Margin's entry point, and the private registry. Start a fresh session outside the fixture checkout. Read bounded passages from the checkout and a separate notes directory through Margin. Check that the checkout gains zero files and both isolation checks pass. This live Codex check remains open. [Codex MCP setup](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
