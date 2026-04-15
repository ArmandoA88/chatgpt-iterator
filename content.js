const COMPOSER_SELECTORS = [
  "form textarea",
  "textarea[data-testid]",
  "textarea[placeholder]",
  "textarea",
  "[contenteditable='true'][data-lexical-editor='true']",
  "[contenteditable='true'][role='textbox']",
  "[contenteditable='true']"
];

const SEND_BUTTON_SELECTORS = [
  "form button[data-testid*='send']",
  "form button[aria-label*='Send']",
  "form button[aria-label*='send']",
  "form button[type='submit']",
  "button[data-testid*='send']",
  "button[aria-label*='Send']",
  "button[aria-label*='send']"
];

const STOP_BUTTON_SELECTORS = [
  "button[aria-label*='Stop']",
  "button[aria-label*='stop']",
  "button[data-testid*='stop']"
];

const OVERLAY_STORAGE_KEYS = [
  "queue",
  "runState",
  "currentItemId",
  "lastStatus",
  "pageStatus"
];

let monitorState = null;
let lastKnownUrl = location.href;
let overlayUi = null;
let overlayDisplayState = {
  collapsed: false
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "PAGE/PING") {
    sendResponse(buildPageStatus());
    return false;
  }

  if (message?.type === "PROMPT/SUBMIT") {
    submitPrompt(message.payload)
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.error("[content] prompt submit failed", error);
        sendResponse({
          ok: false,
          accepted: false,
          error: error.message
        });
      });

    return true;
  }

  if (message?.type === "CONTENT/RESUME_MONITOR") {
    resumeMonitor(message.payload)
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.error("[content] resume failed", error);
        sendResponse({
          ok: false,
          error: error.message
        });
      });

    return true;
  }

  if (message?.type === "CONTENT/ABORT") {
    abortCurrentRun({ stopGeneration: true });
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "OVERLAY/TOGGLE") {
    toggleOverlayVisibility();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "OVERLAY/SHOW") {
    showOverlay();
    sendResponse({ ok: true });
    return false;
  }

  sendResponse({
    ok: false,
    error: `Unknown content message: ${message?.type ?? "undefined"}`
  });
  return false;
});

bootstrap();

function bootstrap() {
  initInPageOverlay().catch((error) => {
    console.error("[content] overlay init failed", error);
  });

  notifyReady("bootstrap");

  const routeObserver = new MutationObserver(() => {
    if (location.href !== lastKnownUrl) {
      lastKnownUrl = location.href;
      notifyReady("route-change");
    }
  });

  routeObserver.observe(document.documentElement, {
    subtree: true,
    childList: true
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      notifyReady("visible");
    }
  });

  window.addEventListener("load", () => notifyReady("load"));
}

async function notifyReady(reason) {
  try {
    await chrome.runtime.sendMessage({
      type: "CONTENT/READY",
      payload: {
        reason,
        status: buildPageStatus()
      }
    });
  } catch (error) {
    console.debug("[content] ready notification skipped", error);
  }
}

function buildPageStatus() {
  const composer = findComposer();
  const sendButton = composer ? findSendButton(composer) : findSendButton();
  const draftPresent = composer ? Boolean(readComposerText(composer).trim()) : false;
  const generating = isGenerating();

  return {
    ok: true,
    ready: Boolean(composer) && !generating && !draftPresent,
    composerFound: Boolean(composer),
    sendButtonFound: Boolean(sendButton),
    generating,
    draftPresent
  };
}

async function submitPrompt(payload) {
  const itemId = payload?.itemId;
  const text = String(payload?.text || "");
  const settings = buildSettings(payload?.settings);

  if (!itemId || !text.trim()) {
    return {
      ok: false,
      accepted: false,
      error: "Prompt submission is missing an item ID or text."
    };
  }

  if (monitorState) {
    return {
      ok: false,
      accepted: false,
      error: "A prompt is already being monitored on this page."
    };
  }

  const composer = await waitForComposer(settings.lookupTimeoutMs);
  if (!composer) {
    return {
      ok: false,
      accepted: false,
      error: "Could not find the ChatGPT composer."
    };
  }

  const existingText = readComposerText(composer).trim();
  if (existingText && existingText !== text.trim()) {
    return {
      ok: false,
      accepted: false,
      error: "Composer is not empty. Clear manual draft text before starting."
    };
  }

  const inserted = writeComposerText(composer, text);
  if (!inserted) {
    return {
      ok: false,
      accepted: false,
      error: "Failed to insert text into the composer."
    };
  }

  await sleep(180);

  const sendButton = findSendButton(composer);
  if (!sendButton) {
    return {
      ok: false,
      accepted: false,
      error: "Could not find an enabled send button."
    };
  }

  const preSubmitSnapshot = getAssistantSnapshot();
  clickElement(sendButton);

  const started = await waitForGenerationStart(settings.submitConfirmTimeoutMs, preSubmitSnapshot);
  if (!started) {
    return {
      ok: false,
      accepted: false,
      error: "The page did not enter generation mode after send."
    };
  }

  await chrome.runtime.sendMessage({
    type: "CONTENT/SUBMITTED",
    payload: { itemId }
  });

  startMonitor({
    itemId,
    settings,
    lastSnapshot: getAssistantSnapshot()
  });

  return {
    ok: true,
    accepted: true
  };
}

async function resumeMonitor(payload) {
  const itemId = payload?.itemId;
  const settings = buildSettings(payload?.settings);

  if (!itemId) {
    return {
      ok: false,
      error: "Missing itemId for monitor resume."
    };
  }

  if (monitorState?.itemId === itemId) {
    return {
      ok: true,
      resumed: true
    };
  }

  startMonitor({
    itemId,
    settings,
    lastSnapshot: getAssistantSnapshot()
  });

  return {
    ok: true,
    resumed: true
  };
}

function startMonitor({ itemId, settings, lastSnapshot }) {
  abortCurrentRun();

  monitorState = {
    itemId,
    settings,
    startedAt: Date.now(),
    lastSnapshot: lastSnapshot || "",
    lastChangeAt: Date.now(),
    timerId: window.setInterval(() => {
      tickMonitor().catch((error) => {
        console.error("[content] monitor tick failed", error);
      });
    }, settings.pollIntervalMs)
  };
}

async function tickMonitor() {
  if (!monitorState) {
    return;
  }

  const snapshot = getAssistantSnapshot();
  if (snapshot !== monitorState.lastSnapshot) {
    monitorState.lastSnapshot = snapshot;
    monitorState.lastChangeAt = Date.now();
  }

  const elapsedMs = Date.now() - monitorState.startedAt;
  const stableMs = Date.now() - monitorState.lastChangeAt;
  const composer = findComposer();
  const pageBusy = isGenerating();
  const pageIdle = Boolean(composer) && !pageBusy && stableMs >= monitorState.settings.stableMs;

  if (pageIdle) {
    const itemId = monitorState.itemId;
    abortCurrentRun();
    await chrome.runtime.sendMessage({
      type: "CONTENT/DONE",
      payload: { itemId }
    });
    return;
  }

  if (elapsedMs >= monitorState.settings.completionTimeoutMs) {
    const itemId = monitorState.itemId;
    abortCurrentRun();
    await chrome.runtime.sendMessage({
      type: "CONTENT/FAILED",
      payload: {
        itemId,
        reason: "Timed out while waiting for ChatGPT to finish."
      }
    });
  }
}

function abortCurrentRun(options = {}) {
  const stopGeneration = Boolean(options.stopGeneration);

  if (monitorState?.timerId) {
    window.clearInterval(monitorState.timerId);
  }

  monitorState = null;

  if (stopGeneration) {
    const stopButton = findStopButton();
    if (stopButton) {
      clickElement(stopButton);
    }
  }
}

function findComposer() {
  const candidates = COMPOSER_SELECTORS
    .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
    .filter((element) => isUsableComposer(element));

  return candidates[0] || null;
}

function isUsableComposer(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (!isVisible(element)) {
    return false;
  }

  if (element.getAttribute("aria-hidden") === "true") {
    return false;
  }

  if ("disabled" in element && element.disabled) {
    return false;
  }

  return true;
}

function readComposerText(composer) {
  if ("value" in composer) {
    return composer.value || "";
  }

  return composer.innerText || composer.textContent || "";
}

function writeComposerText(composer, text) {
  composer.focus();

  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    const prototype = Object.getPrototypeOf(composer);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

    if (!descriptor?.set) {
      return false;
    }

    descriptor.set.call(composer, text);
    composer.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: text,
      inputType: "insertText"
    }));
    composer.dispatchEvent(new Event("change", {
      bubbles: true
    }));

    return readComposerText(composer).trim() === text.trim();
  }

  if (composer.isContentEditable) {
    selectElementContents(composer);

    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, text);
    } catch (error) {
      inserted = false;
    }

    if (!inserted) {
      composer.textContent = text;
      composer.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: text,
        inputType: "insertText"
      }));
    }

    return readComposerText(composer).trim() === text.trim();
  }

  return false;
}

function findSendButton(composer = null) {
  const roots = [];
  const form = composer?.closest?.("form");
  if (form) {
    roots.push(form);
  }
  roots.push(document);

  for (const root of roots) {
    for (const selector of SEND_BUTTON_SELECTORS) {
      const button = Array.from(root.querySelectorAll(selector)).find(isUsableSendButton);
      if (button) {
        return button;
      }
    }
  }

  return null;
}

function isUsableSendButton(button) {
  if (!(button instanceof HTMLButtonElement)) {
    return false;
  }

  if (!isVisible(button) || button.disabled) {
    return false;
  }

  const label = button.getAttribute("aria-label") || button.innerText || "";
  if (/stop/i.test(label)) {
    return false;
  }

  return true;
}

function findStopButton() {
  for (const selector of STOP_BUTTON_SELECTORS) {
    const button = Array.from(document.querySelectorAll(selector)).find((entry) => {
      if (!(entry instanceof HTMLButtonElement)) {
        return false;
      }

      if (!isVisible(entry) || entry.disabled) {
        return false;
      }

      const label = entry.getAttribute("aria-label") || entry.innerText || "";
      return /stop/i.test(label);
    });

    if (button) {
      return button;
    }
  }

  return null;
}

function isGenerating() {
  if (findStopButton()) {
    return true;
  }

  const liveRegion = Array.from(document.querySelectorAll("[aria-live='polite'], [aria-live='assertive']")).find((node) => {
    const text = node.textContent || "";
    return /thinking|generating|streaming/i.test(text);
  });

  return Boolean(liveRegion);
}

function getAssistantSnapshot() {
  const candidates = Array.from(
    document.querySelectorAll("[data-message-author-role='assistant'], main article, main [role='article']")
  ).filter((element) => isVisible(element));

  if (!candidates.length) {
    return "";
  }

  const lastCandidate = candidates[candidates.length - 1];
  const text = lastCandidate.innerText || lastCandidate.textContent || "";
  return text.trim().slice(-4000);
}

async function waitForComposer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const composer = findComposer();
    if (composer) {
      return composer;
    }

    await sleep(250);
  }

  return null;
}

async function waitForGenerationStart(timeoutMs, preSubmitSnapshot) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (findStopButton()) {
      return true;
    }

    const latestSnapshot = getAssistantSnapshot();
    if (latestSnapshot && latestSnapshot !== preSubmitSnapshot) {
      return true;
    }

    const composer = findComposer();
    if (composer && !readComposerText(composer).trim()) {
      return true;
    }

    await sleep(250);
  }

  return false;
}

function selectElementContents(element) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

function clickElement(element) {
  element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  element.click();
}

function isVisible(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);

  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.visibility !== "hidden" &&
    style.display !== "none"
  );
}

function buildSettings(settings) {
  return {
    stableMs: Number(settings?.stableMs) || 3500,
    pollIntervalMs: Number(settings?.pollIntervalMs) || 1200,
    completionTimeoutMs: Number(settings?.completionTimeoutMs) || 180000,
    lookupTimeoutMs: Number(settings?.lookupTimeoutMs) || 15000,
    submitConfirmTimeoutMs: Number(settings?.submitConfirmTimeoutMs) || 12000
  };
}

async function initInPageOverlay() {
  if (overlayUi) {
    return overlayUi;
  }

  const host = document.createElement("div");
  host.id = "cgqi-overlay-host";

  (document.body || document.documentElement).appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
      }

      .cgqi-root {
        position: fixed;
        right: 18px;
        top: 88px;
        z-index: 2147483647;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #ececec;
      }

      .cgqi-panel {
        width: 332px;
        max-height: calc(100vh - 120px);
        display: grid;
        gap: 12px;
        padding: 14px;
        border-radius: 18px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background:
          linear-gradient(180deg, rgba(28, 28, 30, 0.96), rgba(20, 20, 22, 0.96));
        box-shadow: 0 16px 46px rgba(0, 0, 0, 0.36);
        backdrop-filter: blur(16px);
      }

      .cgqi-panel.is-hidden {
        display: none;
      }

      .cgqi-launcher {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 42px;
        padding: 0 14px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 999px;
        background: rgba(18, 18, 19, 0.96);
        color: #f3f3f3;
        cursor: pointer;
        font: inherit;
        font-size: 13px;
        font-weight: 700;
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.3);
      }

      .cgqi-launcher.is-hidden {
        display: none;
      }

      .cgqi-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }

      .cgqi-eyebrow {
        margin: 0 0 6px;
        color: #9ca0aa;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .cgqi-summary {
        margin: 0;
        color: #f5f5f6;
        font-size: 15px;
        font-weight: 700;
        line-height: 1.35;
      }

      .cgqi-icon,
      .cgqi-button,
      .cgqi-mini {
        border: 0;
        border-radius: 999px;
        font: inherit;
        cursor: pointer;
      }

      .cgqi-icon {
        min-height: 30px;
        padding: 0 12px;
        background: rgba(255, 255, 255, 0.06);
        color: #d4d4d8;
        font-size: 12px;
        font-weight: 700;
      }

      .cgqi-progress {
        height: 7px;
        overflow: hidden;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.06);
      }

      .cgqi-progress-fill {
        height: 100%;
        width: 0;
        border-radius: inherit;
        background: linear-gradient(90deg, #8ab4ff, #c0ffd1);
        transition: width 180ms ease;
      }

      .cgqi-chips,
      .cgqi-controls,
      .cgqi-item-actions,
      .cgqi-footer-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .cgqi-chip {
        display: inline-flex;
        align-items: center;
        min-height: 24px;
        padding: 0 10px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.06);
        color: #dadce3;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      .cgqi-chip.is-good {
        background: rgba(61, 155, 113, 0.18);
        color: #91e6bc;
      }

      .cgqi-chip.is-busy {
        background: rgba(114, 137, 255, 0.18);
        color: #b9c7ff;
      }

      .cgqi-chip.is-warn {
        background: rgba(199, 150, 65, 0.18);
        color: #f0d58e;
      }

      .cgqi-chip.is-bad {
        background: rgba(196, 83, 83, 0.18);
        color: #ffb0b0;
      }

      .cgqi-status {
        color: #a5a8b2;
        font-size: 12px;
        line-height: 1.45;
      }

      .cgqi-button {
        min-height: 34px;
        padding: 0 12px;
        background: rgba(255, 255, 255, 0.08);
        color: #f2f2f3;
        font-size: 12px;
        font-weight: 700;
      }

      .cgqi-button.is-primary {
        background: linear-gradient(135deg, #2f63ff, #4d8cff);
        color: #ffffff;
      }

      .cgqi-button.is-danger {
        background: linear-gradient(135deg, #9f4040, #c45858);
        color: #ffffff;
      }

      .cgqi-button:disabled,
      .cgqi-mini:disabled,
      .cgqi-icon:disabled {
        opacity: 0.42;
        cursor: not-allowed;
      }

      .cgqi-list {
        display: grid;
        gap: 8px;
        max-height: 320px;
        overflow: auto;
        padding-right: 4px;
      }

      .cgqi-list::-webkit-scrollbar {
        width: 8px;
      }

      .cgqi-list::-webkit-scrollbar-thumb {
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.12);
      }

      .cgqi-empty,
      .cgqi-item {
        border-radius: 14px;
        border: 1px solid rgba(255, 255, 255, 0.06);
        background: rgba(255, 255, 255, 0.03);
      }

      .cgqi-empty {
        padding: 14px;
        color: #9ca0aa;
        font-size: 12px;
        line-height: 1.5;
      }

      .cgqi-item {
        padding: 12px;
      }

      .cgqi-item.is-active {
        border-color: rgba(114, 137, 255, 0.45);
        box-shadow: inset 0 0 0 1px rgba(114, 137, 255, 0.2);
      }

      .cgqi-item.is-failed {
        border-color: rgba(196, 83, 83, 0.32);
      }

      .cgqi-item-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }

      .cgqi-item-index {
        color: #8e929d;
        font-size: 12px;
        font-weight: 700;
      }

      .cgqi-item-text {
        margin: 8px 0 6px;
        color: #f3f3f4;
        font-size: 13px;
        line-height: 1.45;
      }

      .cgqi-item-meta {
        color: #8f93a0;
        font-size: 11px;
        line-height: 1.45;
      }

      .cgqi-item-actions {
        margin-top: 10px;
      }

      .cgqi-mini {
        min-height: 26px;
        padding: 0 9px;
        background: rgba(255, 255, 255, 0.06);
        color: #d7d9df;
        font-size: 11px;
        font-weight: 700;
      }

      .cgqi-mini.is-danger {
        background: rgba(196, 83, 83, 0.16);
        color: #ffb0b0;
      }

      .cgqi-add {
        display: grid;
        gap: 8px;
        padding-top: 4px;
        border-top: 1px solid rgba(255, 255, 255, 0.06);
      }

      .cgqi-add-label {
        color: #9ca0aa;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }

      .cgqi-input {
        min-height: 82px;
        resize: vertical;
        padding: 10px 12px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.04);
        color: #f5f5f6;
        font: inherit;
        font-size: 12px;
        line-height: 1.45;
      }

      .cgqi-input:focus {
        outline: 1px solid rgba(138, 180, 255, 0.55);
      }

      .cgqi-button:hover:not(:disabled),
      .cgqi-icon:hover:not(:disabled),
      .cgqi-mini:hover:not(:disabled),
      .cgqi-launcher:hover {
        filter: brightness(1.08);
      }
    </style>
    <div class="cgqi-root">
      <button class="cgqi-launcher is-hidden" type="button" data-overlay-action="toggle">Queue</button>
      <aside class="cgqi-panel">
        <div class="cgqi-header">
          <div>
            <p class="cgqi-eyebrow">Queue</p>
            <p class="cgqi-summary" data-role="summary">Queue is loading.</p>
          </div>
          <button class="cgqi-icon" type="button" data-overlay-action="toggle">Hide</button>
        </div>
        <div class="cgqi-progress">
          <div class="cgqi-progress-fill" data-role="progress-fill"></div>
        </div>
        <div class="cgqi-chips" data-role="chips"></div>
        <div class="cgqi-status" data-role="status"></div>
        <div class="cgqi-controls" data-role="controls"></div>
        <div class="cgqi-list" data-role="queue-list"></div>
        <div class="cgqi-add">
          <label class="cgqi-add-label" for="cgqi-quick-add">Quick Add</label>
          <textarea
            id="cgqi-quick-add"
            class="cgqi-input"
            data-role="quick-add-input"
            placeholder="Separate prompts with blank lines. Press Ctrl+Enter to add."
          ></textarea>
          <div class="cgqi-footer-actions">
            <button class="cgqi-button is-primary" type="button" data-overlay-action="add-prompts">Add prompts</button>
            <button class="cgqi-button" type="button" data-overlay-action="refresh-page">Refresh page</button>
          </div>
        </div>
      </aside>
    </div>
  `;

  overlayUi = {
    host,
    shadow,
    launcher: shadow.querySelector(".cgqi-launcher"),
    panel: shadow.querySelector(".cgqi-panel"),
    summary: shadow.querySelector("[data-role='summary']"),
    progressFill: shadow.querySelector("[data-role='progress-fill']"),
    chips: shadow.querySelector("[data-role='chips']"),
    status: shadow.querySelector("[data-role='status']"),
    controls: shadow.querySelector("[data-role='controls']"),
    queueList: shadow.querySelector("[data-role='queue-list']"),
    quickAddInput: shadow.querySelector("[data-role='quick-add-input']")
  };

  shadow.addEventListener("click", handleOverlayClick);
  shadow.addEventListener("keydown", handleOverlayKeydown);
  chrome.storage.onChanged.addListener(handleOverlayStorageChange);

  syncOverlayVisibility();
  await renderOverlayFromStorage();
  await requestOverlayCommand("POPUP/REFRESH_PAGE_STATUS");

  return overlayUi;
}

function handleOverlayStorageChange(changes, areaName) {
  if (areaName !== "local") {
    return;
  }

  if (!Object.keys(changes).some((key) => OVERLAY_STORAGE_KEYS.includes(key))) {
    return;
  }

  renderOverlayFromStorage().catch((error) => {
    console.error("[content] overlay render failed", error);
  });
}

async function handleOverlayClick(event) {
  const button = event.target.closest("[data-overlay-action]");
  if (!button || button.disabled) {
    return;
  }

  const action = button.dataset.overlayAction;
  const itemId = button.dataset.itemId;

  if (action === "toggle") {
    overlayDisplayState.collapsed = !overlayDisplayState.collapsed;
    syncOverlayVisibility();

    if (!overlayDisplayState.collapsed) {
      await requestOverlayCommand("POPUP/REFRESH_PAGE_STATUS");
      await renderOverlayFromStorage();
    }

    return;
  }

  if (action === "add-prompts") {
    await handleOverlayAddPrompts();
    return;
  }

  if (action === "move-up") {
    await requestOverlayCommand("POPUP/MOVE_ITEM", { itemId, direction: "up" });
    return;
  }

  if (action === "move-down") {
    await requestOverlayCommand("POPUP/MOVE_ITEM", { itemId, direction: "down" });
    return;
  }

  if (action === "requeue") {
    await requestOverlayCommand("POPUP/RETRY_ITEM", { itemId });
    return;
  }

  if (action === "remove") {
    await requestOverlayCommand("POPUP/REMOVE_ITEM", { itemId });
    return;
  }

  const actionMap = {
    start: "POPUP/START",
    pause: "POPUP/PAUSE",
    resume: "POPUP/RESUME",
    stop: "POPUP/STOP",
    "retry-current": "POPUP/RETRY_CURRENT",
    "skip-current": "POPUP/SKIP_CURRENT",
    "refresh-page": "POPUP/REFRESH_PAGE_STATUS"
  };

  const messageType = actionMap[action];
  if (messageType) {
    await requestOverlayCommand(messageType);
  }
}

async function handleOverlayKeydown(event) {
  if (!overlayUi || event.target !== overlayUi.quickAddInput) {
    return;
  }

  if (event.key === "Enter" && event.ctrlKey) {
    event.preventDefault();
    await handleOverlayAddPrompts();
  }
}

async function handleOverlayAddPrompts() {
  if (!overlayUi) {
    return;
  }

  const prompts = splitPromptBatch(overlayUi.quickAddInput.value);
  if (!prompts.length) {
    return;
  }

  const response = await requestOverlayCommand("POPUP/ADD_PROMPTS", { prompts });
  if (response?.ok) {
    overlayUi.quickAddInput.value = "";
  }
}

async function requestOverlayCommand(type, payload = undefined) {
  try {
    return await chrome.runtime.sendMessage(payload ? { type, payload } : { type });
  } catch (error) {
    console.error("[content] overlay command failed", error);
    return {
      ok: false,
      error: error.message
    };
  }
}

async function renderOverlayFromStorage() {
  if (!overlayUi) {
    return;
  }

  const rawState = await chrome.storage.local.get(OVERLAY_STORAGE_KEYS);
  renderOverlay({
    queue: Array.isArray(rawState.queue) ? rawState.queue : [],
    runState: rawState.runState || "idle",
    currentItemId: rawState.currentItemId || null,
    lastStatus: rawState.lastStatus || "Idle",
    pageStatus: rawState.pageStatus || {}
  });
}

function renderOverlay(state) {
  if (!overlayUi) {
    return;
  }

  const queue = state.queue;
  const total = queue.length;
  const completed = queue.filter((item) => item.status === "completed").length;
  const activeItem = queue.find((item) => item.id === state.currentItemId) || null;
  const activeIndex = activeItem ? queue.findIndex((item) => item.id === state.currentItemId) + 1 : null;
  const remaining = queue.filter((item) => ["queued", "sending", "waiting"].includes(item.status)).length;
  const progress = total ? Math.round((completed / total) * 100) : 0;
  const launcherCount = remaining || total;

  overlayUi.launcher.textContent = launcherCount ? `Queue ${launcherCount}` : "Queue";
  overlayUi.summary.textContent = total
    ? `${completed} out of ${total} prompts complete.`
    : "Queue is empty.";
  overlayUi.progressFill.style.width = `${progress}%`;
  overlayUi.chips.innerHTML = buildOverlayChips(state.runState, state.pageStatus, activeIndex);
  overlayUi.status.textContent = activeItem
    ? `Active #${activeIndex}: ${truncate(activeItem.text, 96)}`
    : state.lastStatus;
  overlayUi.controls.innerHTML = buildOverlayControls(state.runState, queue, Boolean(activeItem));
  overlayUi.queueList.innerHTML = buildOverlayQueue(queue, state.currentItemId);

  syncOverlayVisibility();
}

function syncOverlayVisibility() {
  if (!overlayUi) {
    return;
  }

  overlayUi.panel.classList.toggle("is-hidden", overlayDisplayState.collapsed);
  overlayUi.launcher.classList.toggle("is-hidden", !overlayDisplayState.collapsed);
}

function toggleOverlayVisibility() {
  overlayDisplayState.collapsed = !overlayDisplayState.collapsed;
  syncOverlayVisibility();
}

function showOverlay() {
  if (overlayDisplayState.collapsed) {
    overlayDisplayState.collapsed = false;
    syncOverlayVisibility();
  }
}

function buildOverlayChips(runState, pageStatus, activeIndex) {
  const chips = [];
  chips.push(`<span class="cgqi-chip">${escapeHtml(runState)}</span>`);

  if (pageStatus.connected) {
    chips.push(`<span class="cgqi-chip is-good">connected</span>`);
  } else {
    chips.push(`<span class="cgqi-chip is-bad">disconnected</span>`);
  }

  if (pageStatus.ready) {
    chips.push(`<span class="cgqi-chip is-good">ready</span>`);
  } else if (pageStatus.generating) {
    chips.push(`<span class="cgqi-chip is-busy">busy</span>`);
  } else if (pageStatus.draftPresent) {
    chips.push(`<span class="cgqi-chip is-warn">draft</span>`);
  } else {
    chips.push(`<span class="cgqi-chip">waiting</span>`);
  }

  if (activeIndex) {
    chips.push(`<span class="cgqi-chip is-busy">active #${activeIndex}</span>`);
  }

  return chips.join("");
}

function buildOverlayControls(runState, queue, hasActiveItem) {
  const hasQueued = queue.some((item) => item.status === "queued");
  const hasRunnable = hasQueued || hasActiveItem;

  return [
    overlayButton("start", "Start", !hasQueued || runState === "running", true),
    overlayButton("pause", "Pause", runState !== "running"),
    overlayButton("resume", "Resume", (runState !== "paused" && runState !== "stopped") || !hasRunnable),
    overlayButton("stop", "Stop", runState !== "running" && runState !== "paused", false, true),
    overlayButton("retry-current", "Retry Current", !hasActiveItem),
    overlayButton("skip-current", "Skip Current", !hasActiveItem)
  ].join("");
}

function buildOverlayQueue(queue, currentItemId) {
  if (!queue.length) {
    return `<div class="cgqi-empty">Add prompts here or from the popup, then start the queue.</div>`;
  }

  return queue.map((item, index) => {
    const isActive = item.id === currentItemId;
    const isFailed = ["failed", "cancelled", "skipped"].includes(item.status);
    const showRequeue = !isActive && !["queued", "sending", "waiting"].includes(item.status);
    const metaParts = [`Retries: ${item.retryCount || 0}`];

    if (item.lastError) {
      metaParts.push(truncate(item.lastError, 82));
    }

    return `
      <article class="cgqi-item${isActive ? " is-active" : ""}${isFailed ? " is-failed" : ""}">
        <div class="cgqi-item-head">
          <span class="cgqi-item-index">#${index + 1}</span>
          <span class="cgqi-chip ${overlayToneClass(item.status, isActive)}">${escapeHtml(item.status)}</span>
        </div>
        <p class="cgqi-item-text">${escapeHtml(truncate(item.text, 150))}</p>
        <div class="cgqi-item-meta">${escapeHtml(metaParts.join(" | "))}</div>
        <div class="cgqi-item-actions">
          <button class="cgqi-mini" type="button" data-overlay-action="move-up" data-item-id="${item.id}" ${isActive || index === 0 ? "disabled" : ""}>Up</button>
          <button class="cgqi-mini" type="button" data-overlay-action="move-down" data-item-id="${item.id}" ${isActive || index === queue.length - 1 ? "disabled" : ""}>Dn</button>
          ${showRequeue ? `<button class="cgqi-mini" type="button" data-overlay-action="requeue" data-item-id="${item.id}">Re</button>` : ""}
          <button class="cgqi-mini is-danger" type="button" data-overlay-action="remove" data-item-id="${item.id}" ${isActive ? "disabled" : ""}>X</button>
        </div>
      </article>
    `;
  }).join("");
}

function overlayButton(action, label, disabled, primary = false, danger = false) {
  const classes = ["cgqi-button"];
  if (primary) {
    classes.push("is-primary");
  }
  if (danger) {
    classes.push("is-danger");
  }

  return `<button class="${classes.join(" ")}" type="button" data-overlay-action="${action}" ${disabled ? "disabled" : ""}>${label}</button>`;
}

function overlayToneClass(status, isActive) {
  if (isActive || status === "sending" || status === "waiting") {
    return "is-busy";
  }

  if (status === "completed") {
    return "is-good";
  }

  if (status === "failed" || status === "cancelled") {
    return "is-bad";
  }

  if (status === "skipped") {
    return "is-warn";
  }

  return "";
}

function splitPromptBatch(text) {
  return String(text || "")
    .trim()
    .split(/\n\s*\n/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function truncate(text, limit) {
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
