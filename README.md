# ChatGPT Queue Iterator

Chrome extension scaffold for queueing prompts on ChatGPT web and submitting them one at a time.

## Files

- `manifest.json`: MV3 wiring, permissions, service worker, and content script.
- `service-worker.js`: queue coordinator, storage updates, alarms, and message routing.
- `content.js`: page automation, prompt insertion, completion monitoring, and in-page queue overlay.

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder.
5. Open `https://chatgpt.com/` or `https://chat.openai.com/chat`.
6. Pin the extension and click the extension icon on a ChatGPT tab if you want to toggle the in-page panel.

## Current Scope

- Same-conversation mode only.
- Queue stored in `chrome.storage.local`.
- Start, pause, resume, stop, retry current, skip current, clear completed, clear all.
- Per-item queue controls for move up, move down, requeue, and remove.
- In-page queue panel on ChatGPT web with quick-add and live queue status.
- Page diagnostics for composer, send button, draft state, and generation state.
- Best-effort DOM selectors for ChatGPT composer, send, and stop controls.

## Debugging

- Service worker: open the extension card in `chrome://extensions` and inspect the worker.
- Content script: open DevTools on the ChatGPT tab.

## Caveat

This relies on ChatGPT's live DOM. Selector changes on the ChatGPT web app can break automation and may require updates in `content.js`.
