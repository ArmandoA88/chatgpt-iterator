# AI Queue Iterator

Chrome extension scaffold for queueing prompts on supported AI web apps and submitting them one at a time.

## Files

- `manifest.json`: MV3 wiring, permissions, service worker, and content script.
- `service-worker.js`: queue coordinator, storage updates, alarms, and message routing.
- `content.js`: page automation, prompt insertion, completion monitoring, and in-page queue overlay.

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder.
5. Open `https://chatgpt.com/`, `https://chat.openai.com/chat`, or `https://gemini.google.com/`.
6. Pin the extension and click the extension icon on a supported AI tab if you want to toggle the in-page panel.

## Current Scope

- Same-conversation mode only.
- Queue stored in `chrome.storage.local`.
- Start, pause, resume, stop, retry current, skip current, delete everything, and run all again.
- Per-item queue controls for direct text editing, drag reordering, requeue, and remove.
- In-page queue panel on ChatGPT web and Gemini web with quick-add and live queue status.
- Queue items can store prompt text plus attached files/images.
- Quick add submits with `Enter`, uses `Shift+Enter` for a newline, and item editors accept clipboard image/file paste with `Ctrl+V`.
- The first quick-add prompt auto-starts immediately when the queue is idle.
- Optional `Auto Save` toggle downloads detected AI-generated files and images after each completed prompt.
- Page diagnostics for composer, send button, draft state, and generation state.
- Best-effort DOM selectors for ChatGPT and Gemini composer, send, stop, upload, and response controls.

Queued items are rendered in a compact collapsed state by default so long queues take less vertical space. Click the prompt text or `Edit` to expand inline editing.

## Debugging

- Service worker: open the extension card in `chrome://extensions` and inspect the worker.
- Content script: open DevTools on the ChatGPT or Gemini tab.

## Caveat

This relies on the live DOM of the supported AI websites. Selector changes on ChatGPT or Gemini can break automation and may require updates in `content.js`.

Attachments are serialized into extension storage so they can stay with the queue. Large files can make the extension heavier; the current in-page uploader rejects files over about 15 MB each or 45 MB per edit/add batch.

Auto-save is best-effort. It downloads visible file/image outputs from the latest assistant response, but site DOM changes or non-downloadable assets can still prevent some saves.
