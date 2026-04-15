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

let monitorState = null;
let lastKnownUrl = location.href;

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
    abortCurrentRun();
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
      payload: { reason }
    });
  } catch (error) {
    console.debug("[content] ready notification skipped", error);
  }
}

function buildPageStatus() {
  const composer = findComposer();
  const sendButton = composer ? findSendButton(composer) : findSendButton();

  return {
    ok: true,
    ready: Boolean(composer && sendButton),
    composerFound: Boolean(composer),
    sendButtonFound: Boolean(sendButton),
    generating: isGenerating()
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

function abortCurrentRun() {
  if (monitorState?.timerId) {
    window.clearInterval(monitorState.timerId);
  }

  monitorState = null;
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

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
