# Source locators and media results

Use PDF pages, Word headings, and video timestamps for citations. Return images and selected frames as MCP image blocks, alongside a text citation.

## What Docling preserves

| Source | Evidence | Recommended locator |
| --- | --- | --- |
| PDF | Docling’s five-page fixture records the page, bounding box, coordinate origin, and character span for a passage. [PDF fixture](https://github.com/docling-project/docling/blob/de09f2a81460fb8439fc228d09d0faeeec48d301/tests/data/pdf/groundtruth/multi_page.json) | Cite the file and physical page. Keep the item’s box and origin when a reader needs to highlight it. |
| Word | The DOCX fixture records heading levels, parent links, and item references. Its page map and passage provenance are empty. [Word fixture](https://github.com/docling-project/docling/blob/de09f2a81460fb8439fc228d09d0faeeec48d301/tests/data/docx/groundtruth/unit_test_headers.docx.json) | Cite the heading path and paragraph position. For duplicate or absent headings, retain the item reference within that extraction. |
| Image | Docling treats each image frame as a bitmap page. Reading text from the pixels requires OCR. [Image backend](https://github.com/docling-project/docling/blob/de09f2a81460fb8439fc228d09d0faeeec48d301/docling/backend/image_backend.py#L81-L145) | Cite the original image. Index available OCR or captions as derived text. A failed extraction should still allow image reads. |

Tie derived locators to the source hash. After a change, refresh before presenting a saved location as current.

## What MCP and Codex can carry

MCP permits text and image blocks in one result. An image block carries base64 data and a MIME type. Use a text block for a transcript excerpt, its start and end times, and its source. Pair a selected frame with its actual timestamp. The protocol defines no dedicated video block. [MCP tool results](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#tool-result)

Codex CLI 0.167.0 has tests for both model configurations. It preserves MCP image blocks for image-capable models and substitutes a text notice for text-only models. [Codex model tests](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/core/src/mcp_tool_call_tests.rs#L1056-L1139)

## Local evidence and Stage 3 checks

On November 19, 2026, local commands reported Codex CLI 0.167.0 and FFmpeg 9.0.2. The active Python environment lacked Docling and docling-core. Local conversion and Codex display remain unverified.

1. Extract a two-page PDF and a DOCX with repeated headings. Search for a known sentence in each. Reopen each citation against the original and check the exact passage.
2. In the intended Codex client, open a PNG with a distinctive shape. Ask the model to identify the shape without naming it in text. Check whether the human can see the image.
3. Open one transcript range and its selected frame. Verify the quoted words and timestamp against the clip. Check the visible frame and ask about a detail absent from the transcript.

Record the client version and model. Score model access and human display separately.
