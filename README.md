# ChatGPT Queue Iterator

Chrome extension scaffold for queueing prompts on `chatgpt.com` and submitting them one at a time.

## Files

- `manifest.json`: MV3 wiring, permissions, popup, service worker, content script.
- `service-worker.js`: queue coordinator, storage updates, alarms, and message routing.
- `content.js`: page automation, prompt insertion, send action, and completion monitoring.
- `popup.html`, `popup.js`, `styles.css`: popup UI and queue controls.

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder.
5. Open `https://chatgpt.com/`.
6. Pin the extension and open the popup.

## Current Scope

- Same-conversation mode only.
- Queue stored in `chrome.storage.local`.
- Start, pause, resume, stop, skip, clear completed, clear all.
- Best-effort DOM selectors for ChatGPT composer, send, and stop controls.

## Debugging

- Popup: right-click the popup and inspect it.
- Service worker: open the extension card in `chrome://extensions` and inspect the worker.
- Content script: open DevTools on the ChatGPT tab.

## Caveat

This relies on ChatGPT's live DOM. Selector changes on `chatgpt.com` can break automation and may require updates in `content.js`.
