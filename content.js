const CHATGPT_COMPOSER_SELECTORS = [
  "form textarea",
  "textarea[data-testid]",
  "textarea[placeholder]",
  "textarea",
  "[contenteditable='true'][data-lexical-editor='true']",
  "[contenteditable='true'][role='textbox']"
];

const GEMINI_COMPOSER_SELECTORS = [
  "rich-textarea div[contenteditable='true']",
  "div[contenteditable='true'][aria-label]",
  "div[contenteditable='true'][data-placeholder]",
  "textarea[aria-label]",
  "textarea[data-placeholder]"
];

const GENERIC_COMPOSER_SELECTORS = [
  "[contenteditable='true'][data-lexical-editor='true']",
  "[contenteditable='true'][role='textbox']",
  "[contenteditable='true']"
];

const CHATGPT_SEND_BUTTON_SELECTORS = [
  "form button[data-testid*='send']",
  "form button[aria-label*='Send']",
  "form button[aria-label*='send']",
  "form button[type='submit']",
  "button[data-testid*='send']"
];

const GEMINI_SEND_BUTTON_SELECTORS = [
  "button[aria-label*='Send']",
  "button[aria-label*='send']",
  "button[aria-label*='Submit']",
  "button[aria-label*='submit']",
  "button[mattooltip*='Send']",
  "button[mattooltip*='send']",
  "button[data-test-id*='send']"
];

const GENERIC_SEND_BUTTON_SELECTORS = [
  "button[data-testid*='send']",
  "button[aria-label*='Send']",
  "button[aria-label*='send']"
];

const CHATGPT_STOP_BUTTON_SELECTORS = [
  "button[aria-label*='Stop']",
  "button[aria-label*='stop']",
  "button[data-testid*='stop']"
];

const GEMINI_STOP_BUTTON_SELECTORS = [
  "button[aria-label*='Stop']",
  "button[aria-label*='stop']",
  "button[mattooltip*='Stop']",
  "button[mattooltip*='stop']",
  "button[data-test-id*='stop']"
];

const GENERIC_STOP_BUTTON_SELECTORS = [
  "button[aria-label*='Stop']",
  "button[aria-label*='stop']"
];

const CHATGPT_RESPONSE_SELECTORS = [
  "[data-message-author-role='assistant']",
  "main article",
  "main [role='article']"
];

const GEMINI_RESPONSE_SELECTORS = [
  "model-response",
  "message-content",
  "main .response-content",
  "main [data-test-id*='response']",
  "main [class*='response']"
];

const GENERIC_RESPONSE_SELECTORS = [
  "main article",
  "main [role='article']"
];

const GENERATING_INDICATOR_SELECTORS = [
  "main [role='progressbar']",
  "main mat-progress-spinner",
  "main md-progress-circular",
  "main [data-test-id*='loading']"
];

const OVERLAY_STORAGE_KEYS = [
  "queue",
  "runState",
  "currentItemId",
  "lastStatus",
  "pageStatus",
  "settings"
];

const INVALIDATED_EXTENSION_PATTERN = /Extension context invalidated/i;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_ATTACHMENT_BATCH_BYTES = 45 * 1024 * 1024;
const OVERLAY_POSITION_STORAGE_KEY = "overlayPosition";

let monitorState = null;
let lastKnownUrl = location.href;
let overlayUi = null;
let overlayDisplayState = {
  collapsed: false
};
let extensionContextAlive = true;
let overlayAddAttachments = [];
let overlayEditState = null;
let overlayLastRenderedState = null;
let overlayPosition = null;
let overlayDragState = null;

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
    await sendExtensionMessage({
      type: "CONTENT/READY",
      payload: {
        reason,
        status: buildPageStatus()
      }
    }, { quiet: true });
  } catch (error) {
    console.debug("[content] ready notification skipped", error);
  }
}

function buildPageStatus() {
  const provider = getCurrentProvider();
  const composer = findComposer();
  const sendButton = composer ? findSendButton(composer) : findSendButton();
  const draftPresent = composer ? Boolean(readComposerText(composer).trim()) : false;
  const generating = isGenerating();

  return {
    ok: true,
    provider,
    ready: Boolean(composer) && !generating,
    composerFound: Boolean(composer),
    sendButtonFound: Boolean(sendButton),
    generating,
    draftPresent
  };
}

async function submitPrompt(payload) {
  const itemId = payload?.itemId;
  const text = String(payload?.text || "");
  const attachments = normalizeSerializedAttachments(payload?.attachments || []);
  const settings = buildSettings(payload?.settings);
  const provider = getCurrentProvider();

  if (!itemId || (!text.trim() && !attachments.length)) {
    return {
      ok: false,
      accepted: false,
      error: "Prompt submission is missing an item ID, text, or attachments."
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
      error: `Could not find the ${provider} composer.`
    };
  }

  const desiredText = text.trim();
  const existingText = readComposerText(composer).trim();
  if (existingText && existingText !== desiredText) {
    return {
      ok: false,
      accepted: false,
      error: "Composer is not empty. Clear manual draft text before starting."
    };
  }

  if (desiredText && existingText !== desiredText) {
    const inserted = writeComposerText(composer, desiredText);
    if (!inserted) {
      return {
        ok: false,
        accepted: false,
        error: "Failed to insert text into the composer."
      };
    }
  }

  if (attachments.length) {
    const uploadResult = await uploadAttachments(composer, attachments, settings.lookupTimeoutMs);
    if (!uploadResult.ok) {
      return {
        ok: false,
        accepted: false,
        error: uploadResult.error
      };
    }
  }

  await sleep(attachments.length ? 700 : 180);

  const preSubmitSnapshot = getAssistantSnapshot();
  const started = await triggerPromptSubmission(composer, preSubmitSnapshot, settings.submitConfirmTimeoutMs);
  if (!started) {
    return {
      ok: false,
      accepted: false,
      error: "Could not trigger prompt submission."
    };
  }

  await sendExtensionMessage({
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
    const output = captureLatestOutput();
    abortCurrentRun();
    await sendExtensionMessage({
      type: "CONTENT/DONE",
      payload: {
        itemId,
        output
      }
    });
    return;
  }

  if (elapsedMs >= monitorState.settings.completionTimeoutMs) {
    const itemId = monitorState.itemId;
    const provider = getCurrentProvider();
    abortCurrentRun();
    await sendExtensionMessage({
      type: "CONTENT/FAILED",
      payload: {
        itemId,
        reason: `Timed out while waiting for ${provider} to finish.`
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
  const candidates = getComposerSelectors()
    .flatMap((selector) => queryAllDeep(selector))
    .filter((element, index, array) => array.indexOf(element) === index)
    .filter((element) => isUsableComposer(element))
    .map((element) => ({
      element,
      score: scoreComposer(element)
    }))
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.element || null;
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
    dispatchSyntheticInputEvents(composer, text);

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
      composer.replaceChildren(document.createTextNode(text));
    }

    dispatchSyntheticInputEvents(composer, text);
    moveCaretToEnd(composer);

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
  if (composer?.parentElement) {
    roots.push(composer.parentElement);
  }
  const nearbyContainer = composer?.closest?.("form, footer, main, rich-textarea");
  if (nearbyContainer) {
    roots.push(nearbyContainer);
  }
  roots.push(document);

  for (const root of roots) {
    for (const selector of getSendButtonSelectors()) {
      const button = queryAllDeep(selector, root).find(isUsableSendButton);
      if (button) {
        return button;
      }
    }

    const heuristicButton = findHeuristicSendButton(root);
    if (heuristicButton) {
      return heuristicButton;
    }
  }

  return null;
}

function isUsableSendButton(button) {
  if (!(button instanceof HTMLElement)) {
    return false;
  }

  if (!isVisible(button) || isDisabledElement(button)) {
    return false;
  }

  const label = getElementDescriptor(button);
  if (/stop/i.test(label)) {
    return false;
  }

  return true;
}

function findHeuristicSendButton(root) {
  const candidates = queryAllDeep("button, [role='button']", root)
    .filter((button) => isUsableSendButton(button))
    .map((button) => ({
      button,
      score: scoreSendButton(button)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.button || null;
}

function scoreSendButton(button) {
  const label = getElementDescriptor(button);

  if (/stop|voice|microphone|record|attach|upload|plus|tool|search|canvas|reason|deep research|read aloud/.test(label)) {
    return -1;
  }

  let score = 0;

  if ("type" in button && button.type === "submit") {
    score += 120;
  }

  if (/send|submit/.test(label)) {
    score += 90;
  }

  if (/run|generate/.test(label)) {
    score += 40;
  }

  if (!label.trim()) {
    score += 12;
  }

  if (button.querySelector("svg")) {
    score += 10;
  }

  const rect = button.getBoundingClientRect();
  score += rect.right / 100;

  return score;
}

function findStopButton() {
  for (const selector of getStopButtonSelectors()) {
    const button = queryAllDeep(selector).find((entry) => {
      if (!(entry instanceof HTMLElement)) {
        return false;
      }

      if (!isVisible(entry) || isDisabledElement(entry)) {
        return false;
      }

      const label = getElementDescriptor(entry);
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

  const progressIndicator = GENERATING_INDICATOR_SELECTORS
    .flatMap((selector) => queryAllDeep(selector))
    .find((element) => isVisible(element));

  if (progressIndicator) {
    return true;
  }

  const liveRegion = queryAllDeep("[aria-live='polite'], [aria-live='assertive']").find((node) => {
    const text = node.textContent || "";
    return /thinking|generating|streaming/i.test(text);
  });

  return Boolean(liveRegion);
}

function getAssistantSnapshot() {
  const lastCandidate = getLatestAssistantResponseElement();
  if (!lastCandidate) {
    return "";
  }

  const text = lastCandidate.innerText || lastCandidate.textContent || "";
  return text.trim().slice(-4000);
}

function getAssistantResponseElements() {
  return getResponseSelectors()
    .flatMap((selector) => queryAllDeep(selector))
    .filter((element, index, array) => array.indexOf(element) === index)
    .filter((element) => isVisible(element));
}

function getLatestAssistantResponseElement() {
  const candidates = getAssistantResponseElements();
  return candidates.length ? candidates[candidates.length - 1] : null;
}

function captureLatestOutput() {
  const provider = getCurrentProvider();
  const responseElement = getLatestAssistantResponseElement();

  if (!responseElement) {
    return {
      provider,
      text: "",
      assets: []
    };
  }

  const text = (responseElement.innerText || responseElement.textContent || "").trim().slice(0, 200000);
  const assets = collectOutputAssets(responseElement);

  return {
    provider,
    text,
    assets
  };
}

function collectOutputAssets(responseElement) {
  const assets = [];
  const seen = new Set();

  for (const anchor of Array.from(responseElement.querySelectorAll("a[href]"))) {
    const href = normalizeOutputUrl(anchor.href);
    if (!href || seen.has(href) || !isSavableAnchor(anchor, href)) {
      continue;
    }

    seen.add(href);
    assets.push({
      kind: "file",
      url: href,
      filename: inferOutputFilename(anchor, href, assets.length)
    });
  }

  for (const image of Array.from(responseElement.querySelectorAll("img"))) {
    const source = normalizeOutputUrl(image.currentSrc || image.src);
    if (!source || seen.has(source) || !isSavableImage(image)) {
      continue;
    }

    seen.add(source);
    assets.push({
      kind: "image",
      url: source,
      filename: inferOutputFilename(image, source, assets.length)
    });
  }

  return assets;
}

function isSavableAnchor(anchor, href) {
  const descriptor = getElementDescriptor(anchor);

  if (anchor.hasAttribute("download")) {
    return true;
  }

  if (/\.(png|jpe?g|webp|gif|pdf|txt|csv|zip|docx?|xlsx?|pptx?|json|svg)(?:$|[?#])/i.test(href)) {
    return true;
  }

  return /download|export|attachment|file|image/.test(descriptor);
}

function isSavableImage(image) {
  const width = image.naturalWidth || image.width || 0;
  const height = image.naturalHeight || image.height || 0;
  const descriptor = getElementDescriptor(image);

  if (/avatar|icon|profile|logo/.test(descriptor)) {
    return false;
  }

  return width >= 96 || height >= 96 || Boolean(image.closest("a[href]"));
}

function inferOutputFilename(element, url, index) {
  const rawName = [
    element.getAttribute("download"),
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.getAttribute("alt"),
    extractFilenameFromPath(url)
  ]
    .filter(Boolean)
    .find(Boolean);

  const clean = sanitizeInlineFilename(rawName || `${getCurrentProvider().toLowerCase()}-asset-${index + 1}`);
  if (/\.[a-z0-9]{2,8}$/i.test(clean)) {
    return clean;
  }

  const extension = inferUrlExtension(url);
  return `${clean}${extension ? `.${extension}` : ""}`;
}

function normalizeOutputUrl(url) {
  if (typeof url !== "string") {
    return "";
  }

  const trimmed = url.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("blob:") || trimmed.startsWith("data:")) {
    return trimmed;
  }

  try {
    return new URL(trimmed, location.href).toString();
  } catch (error) {
    return "";
  }
}

function extractFilenameFromPath(url) {
  if (!url || url.startsWith("data:") || url.startsWith("blob:")) {
    return "";
  }

  try {
    const parsed = new URL(url, location.href);
    const lastPart = parsed.pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(lastPart);
  } catch (error) {
    return "";
  }
}

function sanitizeInlineFilename(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "")
    .slice(0, 96) || "file";
}

function inferUrlExtension(url) {
  const source = String(url || "").toLowerCase();

  if (/\.png\b|data:image\/png/.test(source)) {
    return "png";
  }

  if (/\.jpe?g\b|data:image\/jpeg/.test(source)) {
    return "jpg";
  }

  if (/\.webp\b|data:image\/webp/.test(source)) {
    return "webp";
  }

  if (/\.gif\b|data:image\/gif/.test(source)) {
    return "gif";
  }

  if (/\.pdf\b|data:application\/pdf/.test(source)) {
    return "pdf";
  }

  if (/\.txt\b|data:text\/plain/.test(source)) {
    return "txt";
  }

  return "";
}

function getCurrentProvider(url = location.href) {
  if (typeof url !== "string") {
    return "Assistant";
  }

  if (url.startsWith("https://gemini.google.com/")) {
    return "Gemini";
  }

  if (url.startsWith("https://chatgpt.com/") || url.startsWith("https://chat.openai.com/")) {
    return "ChatGPT";
  }

  return "Assistant";
}

function getComposerSelectors() {
  const provider = getCurrentProvider();

  if (provider === "Gemini") {
    return [...GEMINI_COMPOSER_SELECTORS, ...GENERIC_COMPOSER_SELECTORS];
  }

  return [...CHATGPT_COMPOSER_SELECTORS, ...GENERIC_COMPOSER_SELECTORS];
}

function getSendButtonSelectors() {
  const provider = getCurrentProvider();

  if (provider === "Gemini") {
    return [...GEMINI_SEND_BUTTON_SELECTORS, ...GENERIC_SEND_BUTTON_SELECTORS];
  }

  return [...CHATGPT_SEND_BUTTON_SELECTORS, ...GENERIC_SEND_BUTTON_SELECTORS];
}

function getStopButtonSelectors() {
  const provider = getCurrentProvider();

  if (provider === "Gemini") {
    return [...GEMINI_STOP_BUTTON_SELECTORS, ...GENERIC_STOP_BUTTON_SELECTORS];
  }

  return [...CHATGPT_STOP_BUTTON_SELECTORS, ...GENERIC_STOP_BUTTON_SELECTORS];
}

function getResponseSelectors() {
  const provider = getCurrentProvider();

  if (provider === "Gemini") {
    return [...GEMINI_RESPONSE_SELECTORS, ...GENERIC_RESPONSE_SELECTORS];
  }

  return [...CHATGPT_RESPONSE_SELECTORS, ...GENERIC_RESPONSE_SELECTORS];
}

function scoreComposer(element) {
  const label = [
    element.getAttribute("aria-label"),
    element.getAttribute("placeholder"),
    element.getAttribute("data-placeholder"),
    element.textContent
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  let score = 0;

  if (element instanceof HTMLTextAreaElement) {
    score += 25;
  }

  if (element.isContentEditable) {
    score += 20;
  }

  if (element.closest("form")) {
    score += 30;
  }

  if (element.closest("footer")) {
    score += 15;
  }

  if (getCurrentProvider() === "Gemini" && element.closest("rich-textarea")) {
    score += 60;
  }

  if (/prompt|message|ask|type|write|enter/.test(label)) {
    score += 80;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width > 120) {
    score += 5;
  }
  score += rect.bottom / 200;

  return score;
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

async function uploadAttachments(composer, attachments, timeoutMs) {
  const provider = getCurrentProvider();

  for (const attachment of attachments) {
    const input = await waitForAttachmentInput(composer, Math.min(timeoutMs, 6000));
    if (!input) {
      return {
        ok: false,
        error: `Could not find a file upload control on ${provider}.`
      };
    }

    const file = deserializeAttachment(attachment);
    if (!file) {
      return {
        ok: false,
        error: `Could not prepare ${attachment.name || "attachment"} for upload.`
      };
    }

    const assigned = assignFilesToInput(input, [file]);
    if (!assigned) {
      return {
        ok: false,
        error: `Could not assign ${attachment.name} to the upload control.`
      };
    }

    await sleep(900);
  }

  return {
    ok: true
  };
}

async function waitForAttachmentInput(composer, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let triggerClicked = false;

  while (Date.now() < deadline) {
    const input = findAttachmentInput(composer);
    if (input) {
      return input;
    }

    if (!triggerClicked) {
      const trigger = findAttachmentTrigger(composer);
      if (trigger) {
        clickElement(trigger);
        triggerClicked = true;
      }
    }

    await sleep(250);
  }

  return null;
}

function findAttachmentInput(composer = null) {
  const roots = [];
  const form = composer?.closest?.("form");
  if (form) {
    roots.push(form);
  }
  if (composer?.parentElement) {
    roots.push(composer.parentElement);
  }
  const nearbyContainer = composer?.closest?.("form, footer, main, rich-textarea");
  if (nearbyContainer) {
    roots.push(nearbyContainer);
  }
  roots.push(document);

  for (const root of roots) {
    const input = queryAllDeep("input[type='file']", root).find((entry) => {
      return entry instanceof HTMLInputElement && !isDisabledElement(entry);
    });

    if (input) {
      return input;
    }
  }

  return null;
}

function findAttachmentTrigger(composer = null) {
  const roots = [];
  const form = composer?.closest?.("form");
  if (form) {
    roots.push(form);
  }
  if (composer?.parentElement) {
    roots.push(composer.parentElement);
  }
  const nearbyContainer = composer?.closest?.("form, footer, main, rich-textarea");
  if (nearbyContainer) {
    roots.push(nearbyContainer);
  }
  roots.push(document);

  for (const root of roots) {
    const trigger = queryAllDeep("button, [role='button'], label", root)
      .filter((entry) => entry instanceof HTMLElement)
      .filter((entry) => isVisible(entry) && !isDisabledElement(entry))
      .map((entry) => ({
        entry,
        score: scoreAttachmentTrigger(entry)
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)[0]?.entry;

    if (trigger) {
      return trigger;
    }
  }

  return null;
}

function scoreAttachmentTrigger(element) {
  const label = getElementDescriptor(element);

  if (/send|submit|stop|voice|microphone|record|search|reason|canvas|deep research|read aloud/.test(label)) {
    return -1;
  }

  let score = 0;

  if (/attach|upload|file|image|photo|picture/.test(label)) {
    score += 120;
  }

  if (/add/.test(label) && /file|image|photo/.test(label)) {
    score += 60;
  }

  if (element.tagName === "LABEL") {
    score += 10;
  }

  if (element.querySelector("input[type='file']")) {
    score += 200;
  }

  return score;
}

function assignFilesToInput(input, files) {
  try {
    const dataTransfer = new DataTransfer();
    for (const file of files) {
      dataTransfer.items.add(file);
    }

    input.files = dataTransfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    return input.files?.length > 0;
  } catch (error) {
    console.warn("[content] assign files failed", error);
    return false;
  }
}

function deserializeAttachment(attachment) {
  if (!attachment?.dataUrl || !attachment?.name) {
    return null;
  }

  const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/i.exec(attachment.dataUrl);
  if (!match) {
    return null;
  }

  const mimeType = attachment.type || match[1] || "application/octet-stream";
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new File([bytes], attachment.name, {
    type: mimeType,
    lastModified: attachment.lastModified || Date.now()
  });
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

async function triggerPromptSubmission(composer, preSubmitSnapshot, timeoutMs) {
  const startTime = Date.now();
  const form = composer?.closest?.("form") || null;

  const attempts = [
    async () => {
      const sendButton = findSendButton(composer);
      if (!sendButton) {
        return false;
      }

      clickElement(sendButton);
      return waitForGenerationStart(remainingAttemptMs(startTime, timeoutMs), preSubmitSnapshot);
    },
    async () => {
      if (!form) {
        return false;
      }

      try {
        if (typeof form.requestSubmit === "function") {
          form.requestSubmit();
        } else {
          form.dispatchEvent(new Event("submit", {
            bubbles: true,
            cancelable: true
          }));
        }
      } catch (error) {
        return false;
      }

      return waitForGenerationStart(remainingAttemptMs(startTime, timeoutMs), preSubmitSnapshot);
    },
    async () => {
      dispatchEnterSubmit(composer);
      return waitForGenerationStart(remainingAttemptMs(startTime, timeoutMs), preSubmitSnapshot);
    },
    async () => {
      dispatchEnterSubmit(composer, { ctrlKey: true, metaKey: false });
      return waitForGenerationStart(remainingAttemptMs(startTime, timeoutMs), preSubmitSnapshot);
    },
    async () => {
      dispatchEnterSubmit(composer, { ctrlKey: false, metaKey: true });
      return waitForGenerationStart(remainingAttemptMs(startTime, timeoutMs), preSubmitSnapshot);
    }
  ];

  for (const attempt of attempts) {
    if (remainingAttemptMs(startTime, timeoutMs) <= 0) {
      return false;
    }

    const started = await attempt();
    if (started) {
      return true;
    }
  }

  return false;
}

function remainingAttemptMs(startTime, totalTimeoutMs) {
  return Math.max(800, totalTimeoutMs - (Date.now() - startTime));
}

function dispatchEnterSubmit(composer, modifiers = {}) {
  composer.focus();

  const keyboardEventInit = {
    bubbles: true,
    cancelable: true,
    key: "Enter",
    code: "Enter",
    which: 13,
    keyCode: 13,
    ctrlKey: Boolean(modifiers.ctrlKey),
    metaKey: Boolean(modifiers.metaKey)
  };

  composer.dispatchEvent(new KeyboardEvent("keydown", keyboardEventInit));
  composer.dispatchEvent(new KeyboardEvent("keypress", keyboardEventInit));
  composer.dispatchEvent(new KeyboardEvent("keyup", keyboardEventInit));
}

function selectElementContents(element) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

function clickElement(element) {
  element.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
  element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  element.click();
}

function dispatchSyntheticInputEvents(element, text) {
  try {
    element.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      data: text,
      inputType: "insertText"
    }));
  } catch (error) {
    // Some sites reject constructing beforeinput; continue with input/change.
  }

  element.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    data: text,
    inputType: "insertText"
  }));
  element.dispatchEvent(new Event("change", {
    bubbles: true
  }));
}

function moveCaretToEnd(element) {
  if (!element?.isContentEditable) {
    return;
  }

  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function isDisabledElement(element) {
  return (
    element.hasAttribute("disabled") ||
    element.getAttribute("aria-disabled") === "true" ||
    ("disabled" in element && element.disabled === true)
  );
}

function getElementDescriptor(element) {
  return [
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.getAttribute("data-testid"),
    element.getAttribute("data-test-id"),
    element.getAttribute("mattooltip"),
    element.getAttribute("aria-description"),
    element.innerText,
    element.textContent
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function queryAllDeep(selector, startRoot = document) {
  const results = [];
  const seen = new Set();

  for (const root of getSearchRoots(startRoot)) {
    let matches = [];

    try {
      matches = Array.from(root.querySelectorAll(selector));
    } catch (error) {
      matches = [];
    }

    for (const match of matches) {
      if (seen.has(match)) {
        continue;
      }

      seen.add(match);
      results.push(match);
    }
  }

  return results;
}

function getSearchRoots(startRoot = document) {
  const queue = [startRoot];
  const roots = [];
  const seen = new Set();

  while (queue.length) {
    const root = queue.shift();
    if (!root || seen.has(root) || root === overlayUi?.shadow) {
      continue;
    }

    seen.add(root);
    roots.push(root);

    let elements = [];
    try {
      elements = Array.from(root.querySelectorAll("*"));
    } catch (error) {
      elements = [];
    }

    for (const element of elements) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }

      if (element.id === "cgqi-overlay-host") {
        continue;
      }

      if (element.shadowRoot) {
        queue.push(element.shadowRoot);
      }
    }
  }

  return roots;
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
        right: 12px;
        top: 76px;
        z-index: 2147483647;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #ececec;
      }

      .cgqi-root.is-dragging {
        user-select: none;
      }

      .cgqi-panel {
        width: 286px;
        max-height: calc(100vh - 96px);
        display: grid;
        gap: 9px;
        padding: 11px;
        border-radius: 16px;
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
        gap: 6px;
        min-height: 36px;
        padding: 0 12px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 999px;
        background: rgba(18, 18, 19, 0.96);
        color: #f3f3f3;
        cursor: pointer;
        font: inherit;
        font-size: 12px;
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
        gap: 10px;
        cursor: grab;
        user-select: none;
        touch-action: none;
      }

      .cgqi-root.is-dragging .cgqi-header {
        cursor: grabbing;
      }

      .cgqi-eyebrow {
        margin: 0 0 4px;
        color: #9ca0aa;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .cgqi-summary {
        margin: 0;
        color: #f5f5f6;
        font-size: 13px;
        font-weight: 700;
        line-height: 1.3;
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
        min-height: 28px;
        padding: 0 10px;
        background: rgba(255, 255, 255, 0.06);
        color: #d4d4d8;
        font-size: 11px;
        font-weight: 700;
      }

      .cgqi-progress {
        height: 6px;
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
        gap: 6px;
      }

      .cgqi-chip {
        display: inline-flex;
        align-items: center;
        min-height: 21px;
        padding: 0 8px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.06);
        color: #dadce3;
        font-size: 10px;
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
        font-size: 11px;
        line-height: 1.35;
      }

      .cgqi-button {
        min-height: 30px;
        padding: 0 10px;
        background: rgba(255, 255, 255, 0.08);
        color: #f2f2f3;
        font-size: 11px;
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
        gap: 7px;
        max-height: 260px;
        overflow: auto;
        padding-right: 2px;
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
        padding: 12px;
        color: #9ca0aa;
        font-size: 11px;
        line-height: 1.45;
      }

      .cgqi-item {
        padding: 10px;
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
        gap: 8px;
      }

      .cgqi-item-index {
        color: #8e929d;
        font-size: 11px;
        font-weight: 700;
      }

      .cgqi-item-text {
        margin: 6px 0 5px;
        color: #f3f3f4;
        font-size: 12px;
        line-height: 1.38;
      }

      .cgqi-item-meta {
        color: #8f93a0;
        font-size: 10px;
        line-height: 1.35;
      }

      .cgqi-item-actions {
        margin-top: 8px;
      }

      .cgqi-mini {
        min-height: 24px;
        padding: 0 8px;
        background: rgba(255, 255, 255, 0.06);
        color: #d7d9df;
        font-size: 10px;
        font-weight: 700;
      }

      .cgqi-mini.is-danger {
        background: rgba(196, 83, 83, 0.16);
        color: #ffb0b0;
      }

      .cgqi-add {
        display: grid;
        gap: 7px;
        padding-top: 2px;
        border-top: 1px solid rgba(255, 255, 255, 0.06);
      }

      .cgqi-add-label {
        color: #9ca0aa;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }

      .cgqi-file-input {
        width: 100%;
        color: #cfd2da;
        font: inherit;
        font-size: 10px;
      }

      .cgqi-attachment-list {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .cgqi-attachment-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 22px;
        padding: 0 8px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.06);
        color: #d7d9df;
        font-size: 10px;
        line-height: 1.2;
      }

      .cgqi-attachment-chip button {
        border: 0;
        padding: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
      }

      .cgqi-editor {
        display: grid;
        gap: 8px;
        margin-top: 8px;
      }

      .cgqi-editor-text {
        min-height: 74px;
        resize: vertical;
        padding: 8px 10px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.04);
        color: #f5f5f6;
        font: inherit;
        font-size: 11px;
        line-height: 1.4;
      }

      .cgqi-editor-text:focus {
        outline: 1px solid rgba(138, 180, 255, 0.55);
      }

      .cgqi-editor-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .cgqi-file-note,
      .cgqi-item-placeholder {
        color: #8f93a0;
        font-size: 10px;
        line-height: 1.35;
      }

      .cgqi-input {
        min-height: 64px;
        resize: vertical;
        padding: 9px 10px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.04);
        color: #f5f5f6;
        font: inherit;
        font-size: 11px;
        line-height: 1.4;
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
            placeholder="Press Enter to add. Use Shift+Enter for a new line."
          ></textarea>
          <input
            id="cgqi-quick-files"
            class="cgqi-file-input"
            data-role="quick-add-files"
            type="file"
            multiple
          />
          <div class="cgqi-attachment-list" data-role="quick-add-attachments"></div>
          <div class="cgqi-file-note">Files selected here are attached to each newly added prompt in this batch.</div>
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
    root: shadow.querySelector(".cgqi-root"),
    header: shadow.querySelector(".cgqi-header"),
    launcher: shadow.querySelector(".cgqi-launcher"),
    panel: shadow.querySelector(".cgqi-panel"),
    summary: shadow.querySelector("[data-role='summary']"),
    progressFill: shadow.querySelector("[data-role='progress-fill']"),
    chips: shadow.querySelector("[data-role='chips']"),
    status: shadow.querySelector("[data-role='status']"),
    controls: shadow.querySelector("[data-role='controls']"),
    queueList: shadow.querySelector("[data-role='queue-list']"),
    quickAddInput: shadow.querySelector("[data-role='quick-add-input']"),
    quickAddFiles: shadow.querySelector("[data-role='quick-add-files']"),
    quickAddAttachments: shadow.querySelector("[data-role='quick-add-attachments']")
  };

  shadow.addEventListener("click", handleOverlayClick);
  shadow.addEventListener("keydown", handleOverlayKeydown);
  shadow.addEventListener("input", handleOverlayInput);
  shadow.addEventListener("change", handleOverlayChange);
  shadow.addEventListener("paste", handleOverlayPaste);
  overlayUi.header.addEventListener("pointerdown", handleOverlayPointerDown);
  window.addEventListener("pointermove", handleOverlayPointerMove, true);
  window.addEventListener("pointerup", handleOverlayPointerUp, true);
  window.addEventListener("pointercancel", handleOverlayPointerUp, true);
  window.addEventListener("resize", handleOverlayResize);
  try {
    chrome.storage.onChanged.addListener(handleOverlayStorageChange);
  } catch (error) {
    handleInvalidatedExtensionContext(error);
  }

  await loadOverlayPosition();
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
  const attachmentId = button.dataset.attachmentId;

  if (action === "refresh-page" && !extensionContextAlive) {
    location.reload();
    return;
  }

  if (!extensionContextAlive && action !== "toggle") {
    renderOverlayInvalidatedState("Extension reloaded. Refresh this tab.");
    return;
  }

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

  if (action === "edit") {
    const item = overlayLastRenderedState?.queue?.find((entry) => entry.id === itemId);
    if (!item) {
      return;
    }

    overlayEditState = {
      itemId,
      text: item.text || "",
      attachments: cloneAttachments(item.attachments || [])
    };
    await renderOverlayFromStorage();
    return;
  }

  if (action === "edit-cancel") {
    overlayEditState = null;
    await renderOverlayFromStorage();
    return;
  }

  if (action === "edit-save") {
    if (!overlayEditState || overlayEditState.itemId !== itemId) {
      return;
    }

    const response = await requestOverlayCommand("POPUP/UPDATE_ITEM", {
      itemId,
      text: overlayEditState.text,
      attachments: overlayEditState.attachments
    });

    if (response?.ok) {
      overlayEditState = null;
    }

    await renderOverlayFromStorage();
    return;
  }

  if (action === "edit-remove-attachment") {
    if (!overlayEditState || overlayEditState.itemId !== itemId) {
      return;
    }

    overlayEditState.attachments = overlayEditState.attachments.filter((entry) => entry.id !== attachmentId);
    await renderOverlayFromStorage();
    return;
  }

  if (action === "remove") {
    await requestOverlayCommand("POPUP/REMOVE_ITEM", { itemId });
    return;
  }

  if (action === "toggle-auto-save") {
    const autoSaveOutputs = !Boolean(overlayLastRenderedState?.settings?.autoSaveOutputs);
    await requestOverlayCommand("POPUP/SAVE_SETTINGS", {
      settings: {
        autoSaveOutputs
      }
    });
    await renderOverlayFromStorage();
    return;
  }

  if (action === "remove-quick-attachment") {
    overlayAddAttachments = overlayAddAttachments.filter((entry) => entry.id !== attachmentId);
    renderQuickAddAttachments();
    return;
  }

  if (action === "clear-quick-attachments") {
    overlayAddAttachments = [];
    if (overlayUi?.quickAddFiles) {
      overlayUi.quickAddFiles.value = "";
    }
    renderQuickAddAttachments();
    return;
  }

  const actionMap = {
    start: "POPUP/START",
    pause: "POPUP/PAUSE",
    resume: "POPUP/RESUME",
    stop: "POPUP/STOP",
    "retry-current": "POPUP/RETRY_CURRENT",
    "skip-current": "POPUP/SKIP_CURRENT",
    "clear-all": "POPUP/CLEAR_ALL",
    "rerun-all": "POPUP/RERUN_ALL",
    "refresh-page": "POPUP/REFRESH_PAGE_STATUS"
  };

  const messageType = actionMap[action];
  if (messageType) {
    await requestOverlayCommand(messageType);
  }
}

function handleOverlayInput(event) {
  if (!overlayEditState) {
    return;
  }

  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement)) {
    return;
  }

  if (target.dataset.role === "edit-text" && target.dataset.itemId === overlayEditState.itemId) {
    overlayEditState.text = target.value || "";
  }
}

async function handleOverlayChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.type !== "file") {
    return;
  }

  const files = Array.from(target.files || []);
  if (!files.length) {
    return;
  }

  try {
    const attachments = await serializeFiles(files);

    if (target.dataset.role === "quick-add-files") {
      overlayAddAttachments = mergeAttachments(overlayAddAttachments, attachments);
      target.value = "";
      renderQuickAddAttachments();
      return;
    }

    if (target.dataset.role === "edit-files" && overlayEditState && target.dataset.itemId === overlayEditState.itemId) {
      overlayEditState.attachments = mergeAttachments(overlayEditState.attachments, attachments);
      target.value = "";
      await renderOverlayFromStorage();
    }
  } catch (error) {
    console.warn("[content] file serialization failed", error);
    window.alert(error.message);
    target.value = "";
  }
}

async function handleOverlayPaste(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const files = extractClipboardFiles(event.clipboardData);
  if (!files.length) {
    return;
  }

  event.preventDefault();

  try {
    const attachments = await serializeFiles(files);

    if (target.dataset.role === "quick-add-input") {
      overlayAddAttachments = mergeAttachments(overlayAddAttachments, attachments);
      renderQuickAddAttachments();
      return;
    }

    if (target.dataset.role === "edit-text" && overlayEditState && target.dataset.itemId === overlayEditState.itemId) {
      overlayEditState.attachments = mergeAttachments(overlayEditState.attachments, attachments);
      await renderOverlayFromStorage();
    }
  } catch (error) {
    console.warn("[content] clipboard attachment failed", error);
    window.alert(error.message);
  }
}

async function handleOverlayKeydown(event) {
  if (!overlayUi || event.target !== overlayUi.quickAddInput) {
    return;
  }

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    await handleOverlayAddPrompts();
  }
}

async function handleOverlayAddPrompts() {
  if (!overlayUi) {
    return;
  }

  const prompts = splitPromptBatch(overlayUi.quickAddInput.value);
  if (!prompts.length && !overlayAddAttachments.length) {
    return;
  }

  const response = await requestOverlayCommand("POPUP/ADD_PROMPTS", {
    prompts,
    attachments: cloneAttachments(overlayAddAttachments)
  });
  if (response?.ok) {
    overlayUi.quickAddInput.value = "";
    overlayUi.quickAddFiles.value = "";
    overlayAddAttachments = [];
    renderQuickAddAttachments();
  }
}

async function requestOverlayCommand(type, payload = undefined) {
  try {
    return await sendExtensionMessage(payload ? { type, payload } : { type });
  } catch (error) {
    if (!isInvalidatedExtensionError(error)) {
      console.error("[content] overlay command failed", error);
    }
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

  let rawState;
  try {
    rawState = await chrome.storage.local.get(OVERLAY_STORAGE_KEYS);
  } catch (error) {
    if (isInvalidatedExtensionError(error)) {
      handleInvalidatedExtensionContext(error);
      return;
    }

    throw error;
  }

  renderOverlay({
    queue: Array.isArray(rawState.queue) ? rawState.queue : [],
    runState: rawState.runState || "idle",
    currentItemId: rawState.currentItemId || null,
    lastStatus: rawState.lastStatus || "Idle",
    pageStatus: rawState.pageStatus || {},
    settings: rawState.settings || {}
  });
}

function renderOverlay(state) {
  if (!overlayUi) {
    return;
  }

  if (!extensionContextAlive) {
    renderOverlayInvalidatedState("Extension reloaded. Refresh this tab.");
    return;
  }

  overlayLastRenderedState = state;
  if (overlayEditState && !state.queue.some((item) => item.id === overlayEditState.itemId)) {
    overlayEditState = null;
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
    ? `Active #${activeIndex}: ${truncate(activeItem.text || attachmentOnlyLabel(activeItem.attachments), 96)}`
    : state.lastStatus;
  overlayUi.controls.innerHTML = buildOverlayControls(state.runState, queue, Boolean(activeItem), state.settings || {});
  overlayUi.queueList.innerHTML = buildOverlayQueue(queue, state.currentItemId);
  renderQuickAddAttachments();

  syncOverlayVisibility();
}

function syncOverlayVisibility() {
  if (!overlayUi) {
    return;
  }

  overlayUi.panel.classList.toggle("is-hidden", overlayDisplayState.collapsed);
  overlayUi.launcher.classList.toggle("is-hidden", !overlayDisplayState.collapsed);
  applyOverlayPosition(overlayPosition);
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

function handleOverlayPointerDown(event) {
  if (!overlayUi || overlayDisplayState.collapsed) {
    return;
  }

  if (!event.isPrimary || event.button !== 0) {
    return;
  }

  if (event.target instanceof Element && event.target.closest("button, input, textarea, select, label, a")) {
    return;
  }

  const rect = overlayUi.root.getBoundingClientRect();
  overlayDragState = {
    pointerId: event.pointerId,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top
  };

  overlayPosition = {
    left: rect.left,
    top: rect.top
  };

  overlayUi.root.classList.add("is-dragging");
  applyOverlayPosition(overlayPosition);

  try {
    overlayUi.header.setPointerCapture(event.pointerId);
  } catch (error) {
    // Pointer capture is optional here.
  }

  event.preventDefault();
}

function handleOverlayPointerMove(event) {
  if (!overlayUi || !overlayDragState || event.pointerId !== overlayDragState.pointerId) {
    return;
  }

  overlayPosition = clampOverlayPosition({
    left: event.clientX - overlayDragState.offsetX,
    top: event.clientY - overlayDragState.offsetY
  });

  applyOverlayPosition(overlayPosition);
}

function handleOverlayPointerUp(event) {
  if (!overlayUi || !overlayDragState || event.pointerId !== overlayDragState.pointerId) {
    return;
  }

  try {
    overlayUi.header.releasePointerCapture(event.pointerId);
  } catch (error) {
    // Pointer capture release is optional here.
  }

  overlayUi.root.classList.remove("is-dragging");
  overlayDragState = null;
  persistOverlayPosition();
}

function handleOverlayResize() {
  if (!overlayUi || !overlayPosition) {
    return;
  }

  overlayPosition = clampOverlayPosition(overlayPosition);
  applyOverlayPosition(overlayPosition);
  persistOverlayPosition();
}

async function loadOverlayPosition() {
  if (!overlayUi) {
    return;
  }

  try {
    const rawState = await chrome.storage.local.get([OVERLAY_POSITION_STORAGE_KEY]);
    if (!rawState?.[OVERLAY_POSITION_STORAGE_KEY]) {
      return;
    }

    overlayPosition = clampOverlayPosition(rawState[OVERLAY_POSITION_STORAGE_KEY]);
    applyOverlayPosition(overlayPosition);
  } catch (error) {
    if (isInvalidatedExtensionError(error)) {
      handleInvalidatedExtensionContext(error);
      return;
    }

    console.warn("[content] overlay position load failed", error);
  }
}

function applyOverlayPosition(position) {
  if (!overlayUi || !position) {
    return;
  }

  const next = clampOverlayPosition(position);
  overlayUi.root.style.left = `${next.left}px`;
  overlayUi.root.style.top = `${next.top}px`;
  overlayUi.root.style.right = "auto";
  overlayPosition = next;
}

function clampOverlayPosition(position) {
  const margin = 8;
  const width = overlayUi?.root?.offsetWidth || overlayUi?.panel?.offsetWidth || 286;
  const height = overlayUi?.root?.offsetHeight || overlayUi?.panel?.offsetHeight || 120;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - height - margin);

  return {
    left: clampNumber(position?.left, margin, maxLeft, maxLeft),
    top: clampNumber(position?.top, margin, maxTop, 76)
  };
}

async function persistOverlayPosition() {
  if (!overlayUi || !overlayPosition || !extensionContextAlive) {
    return;
  }

  try {
    await chrome.storage.local.set({
      [OVERLAY_POSITION_STORAGE_KEY]: overlayPosition
    });
  } catch (error) {
    if (isInvalidatedExtensionError(error)) {
      handleInvalidatedExtensionContext(error);
      return;
    }

    console.warn("[content] overlay position save failed", error);
  }
}

function renderOverlayInvalidatedState(message) {
  if (!overlayUi) {
    return;
  }

  overlayUi.summary.textContent = "Extension reloaded.";
  overlayUi.progressFill.style.width = "0%";
  overlayUi.chips.innerHTML = `
    <span class="cgqi-chip is-bad">reload required</span>
  `;
  overlayUi.status.textContent = message;
  overlayUi.controls.innerHTML = overlayButton("refresh-page", "Reload Tab", false, true);
  overlayUi.queueList.innerHTML = `
    <div class="cgqi-empty">This page still has the old content script. Refresh the tab to reconnect the extension.</div>
  `;
  overlayUi.quickAddAttachments.innerHTML = "";
}

function buildOverlayChips(runState, pageStatus, activeIndex) {
  const chips = [];
  chips.push(`<span class="cgqi-chip">${escapeHtml(runState)}</span>`);

  if (pageStatus.provider) {
    chips.push(`<span class="cgqi-chip">${escapeHtml(pageStatus.provider)}</span>`);
  }

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

function buildOverlayControls(runState, queue, hasActiveItem, settings) {
  const hasQueued = queue.some((item) => item.status === "queued");
  const hasRunnable = hasQueued || hasActiveItem;
  const hasAny = queue.length > 0;
  const autoSaveOutputs = Boolean(settings?.autoSaveOutputs);

  return [
    overlayButton("start", "Start", !hasQueued || runState === "running", true),
    overlayButton("pause", "Pause", runState !== "running"),
    overlayButton("resume", "Resume", (runState !== "paused" && runState !== "stopped") || !hasRunnable),
    overlayButton("stop", "Stop", runState !== "running" && runState !== "paused", false, true),
    overlayButton("retry-current", "Retry Current", !hasActiveItem),
    overlayButton("skip-current", "Skip Current", !hasActiveItem),
    overlayButton("toggle-auto-save", autoSaveOutputs ? "Auto Save: On" : "Auto Save: Off", false, autoSaveOutputs),
    overlayButton("rerun-all", "Run All Again", !hasAny),
    overlayButton("clear-all", "Delete Everything", !hasAny, false, true)
  ].join("");
}

function buildOverlayQueue(queue, currentItemId) {
  if (!queue.length) {
    return `<div class="cgqi-empty">Add prompts here, then start the queue.</div>`;
  }

  return queue.map((item, index) => {
    const isActive = item.id === currentItemId;
    const isFailed = ["failed", "cancelled", "skipped"].includes(item.status);
    const showRequeue = !isActive && !["queued", "sending", "waiting"].includes(item.status);
    const metaParts = [`Retries: ${item.retryCount || 0}`];
    const attachmentCount = Array.isArray(item.attachments) ? item.attachments.length : 0;
    const isEditing = overlayEditState?.itemId === item.id;

    if (item.lastError) {
      metaParts.push(truncate(item.lastError, 82));
    }

    if (attachmentCount) {
      metaParts.push(`${attachmentCount} file${attachmentCount === 1 ? "" : "s"}`);
    }

    return `
      <article class="cgqi-item${isActive ? " is-active" : ""}${isFailed ? " is-failed" : ""}">
        <div class="cgqi-item-head">
          <span class="cgqi-item-index">#${index + 1}</span>
          <span class="cgqi-chip ${overlayToneClass(item.status, isActive)}">${escapeHtml(item.status)}</span>
        </div>
        <p class="cgqi-item-text">${item.text ? escapeHtml(truncate(item.text, 150)) : `<span class="cgqi-item-placeholder">${escapeHtml(attachmentOnlyLabel(item.attachments))}</span>`}</p>
        <div class="cgqi-item-meta">${escapeHtml(metaParts.join(" | "))}</div>
        ${attachmentCount ? `<div class="cgqi-attachment-list">${buildAttachmentChips(item.attachments)}</div>` : ""}
        ${isEditing ? buildItemEditor(item.id) : ""}
        <div class="cgqi-item-actions">
          <button class="cgqi-mini" type="button" data-overlay-action="move-up" data-item-id="${item.id}" ${isActive || index === 0 ? "disabled" : ""}>Up</button>
          <button class="cgqi-mini" type="button" data-overlay-action="move-down" data-item-id="${item.id}" ${isActive || index === queue.length - 1 ? "disabled" : ""}>Dn</button>
          <button class="cgqi-mini" type="button" data-overlay-action="edit" data-item-id="${item.id}" ${isActive ? "disabled" : ""}>Edit</button>
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

function buildItemEditor(itemId) {
  if (!overlayEditState || overlayEditState.itemId !== itemId) {
    return "";
  }

  return `
    <div class="cgqi-editor">
      <textarea
        class="cgqi-editor-text"
        data-role="edit-text"
        data-item-id="${itemId}"
        placeholder="Edit prompt text"
      >${escapeHtml(overlayEditState.text || "")}</textarea>
      <input
        class="cgqi-file-input"
        data-role="edit-files"
        data-item-id="${itemId}"
        type="file"
        multiple
      />
      ${overlayEditState.attachments.length ? `<div class="cgqi-attachment-list">${buildAttachmentChips(overlayEditState.attachments, { removable: true, itemId })}</div>` : `<div class="cgqi-file-note">No files attached.</div>`}
      <div class="cgqi-editor-actions">
        <button class="cgqi-mini" type="button" data-overlay-action="edit-save" data-item-id="${itemId}">Save</button>
        <button class="cgqi-mini" type="button" data-overlay-action="edit-cancel" data-item-id="${itemId}">Cancel</button>
      </div>
    </div>
  `;
}

function buildAttachmentChips(attachments, options = {}) {
  if (!Array.isArray(attachments) || !attachments.length) {
    return "";
  }

  const removable = Boolean(options.removable);
  const itemId = options.itemId || "";

  return attachments.map((attachment) => {
    const label = `${attachment.name}${attachment.size ? ` (${formatBytes(attachment.size)})` : ""}`;
    return `
      <span class="cgqi-attachment-chip">
        <span>${escapeHtml(truncate(label, 34))}</span>
        ${removable ? `<button type="button" data-overlay-action="edit-remove-attachment" data-item-id="${itemId}" data-attachment-id="${attachment.id}">x</button>` : ""}
      </span>
    `;
  }).join("");
}

function renderQuickAddAttachments() {
  if (!overlayUi) {
    return;
  }

  if (!overlayAddAttachments.length) {
    overlayUi.quickAddAttachments.innerHTML = "";
    return;
  }

  overlayUi.quickAddAttachments.innerHTML = `
    ${overlayAddAttachments.map((attachment) => `
      <span class="cgqi-attachment-chip">
        <span>${escapeHtml(truncate(`${attachment.name}${attachment.size ? ` (${formatBytes(attachment.size)})` : ""}`, 34))}</span>
        <button type="button" data-overlay-action="remove-quick-attachment" data-attachment-id="${attachment.id}">x</button>
      </span>
    `).join("")}
    <span class="cgqi-attachment-chip">
      <button type="button" data-overlay-action="clear-quick-attachments">clear all</button>
    </span>
  `;
}

function splitPromptBatch(text) {
  return String(text || "")
    .trim()
    .split(/\n\s*\n/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeSerializedAttachments(rawAttachments) {
  if (!Array.isArray(rawAttachments)) {
    return [];
  }

  return rawAttachments
    .map((attachment) => {
      if (!attachment || typeof attachment !== "object") {
        return null;
      }

      const name = String(attachment.name || "").trim();
      const dataUrl = String(attachment.dataUrl || "").trim();

      if (!name || !dataUrl) {
        return null;
      }

      return {
        id: attachment.id || crypto.randomUUID(),
        name,
        type: String(attachment.type || "application/octet-stream"),
        size: Number.isFinite(Number(attachment.size)) ? Math.max(0, Number(attachment.size)) : 0,
        dataUrl,
        lastModified: Number.isFinite(Number(attachment.lastModified))
          ? Number(attachment.lastModified)
          : Date.now()
      };
    })
    .filter(Boolean);
}

function cloneAttachments(attachments) {
  return normalizeSerializedAttachments(attachments).map((attachment) => ({ ...attachment }));
}

function mergeAttachments(existing, incoming) {
  const seen = new Set();
  const merged = [];

  for (const attachment of [...normalizeSerializedAttachments(existing), ...normalizeSerializedAttachments(incoming)]) {
    const key = `${attachment.name}:${attachment.size}:${attachment.lastModified}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(attachment);
  }

  return merged;
}

async function serializeFiles(files) {
  const totalBytes = files.reduce((sum, file) => sum + (file.size || 0), 0);
  if (totalBytes > MAX_ATTACHMENT_BATCH_BYTES) {
    throw new Error(`Attachments exceed ${formatBytes(MAX_ATTACHMENT_BATCH_BYTES)} for one queue edit.`);
  }

  const serialized = [];
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`${file.name} exceeds ${formatBytes(MAX_ATTACHMENT_BYTES)}.`);
    }

    serialized.push(await serializeFile(file));
  }

  return serialized;
}

function serializeFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      resolve({
        id: crypto.randomUUID(),
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size || 0,
        dataUrl: String(reader.result || ""),
        lastModified: file.lastModified || Date.now()
      });
    };

    reader.onerror = () => {
      reject(new Error(`Could not read ${file.name}.`));
    };

    reader.readAsDataURL(file);
  });
}

function extractClipboardFiles(clipboardData) {
  if (!clipboardData) {
    return [];
  }

  const files = [];
  const items = Array.from(clipboardData.items || []);

  for (const [index, item] of items.entries()) {
    if (item.kind !== "file") {
      continue;
    }

    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    files.push(ensureNamedFile(file, index));
  }

  if (files.length) {
    return files;
  }

  return Array.from(clipboardData.files || []).map((file, index) => ensureNamedFile(file, index));
}

function ensureNamedFile(file, index) {
  if (file.name) {
    return file;
  }

  const extension = mimeTypeToExtension(file.type);
  const suffix = extension ? `.${extension}` : "";
  return new File([file], `clipboard-${Date.now()}-${index + 1}${suffix}`, {
    type: file.type || "application/octet-stream",
    lastModified: Date.now()
  });
}

function mimeTypeToExtension(mimeType) {
  const normalized = String(mimeType || "").toLowerCase();

  if (normalized === "image/png") {
    return "png";
  }

  if (normalized === "image/jpeg") {
    return "jpg";
  }

  if (normalized === "image/webp") {
    return "webp";
  }

  if (normalized === "image/gif") {
    return "gif";
  }

  if (normalized === "application/pdf") {
    return "pdf";
  }

  return "";
}

function attachmentOnlyLabel(attachments) {
  const count = Array.isArray(attachments) ? attachments.length : 0;
  return count ? `${count} attachment${count === 1 ? "" : "s"} only` : "No prompt text";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, numeric));
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

async function sendExtensionMessage(message, options = {}) {
  if (!extensionContextAlive) {
    return null;
  }

  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (isInvalidatedExtensionError(error)) {
      handleInvalidatedExtensionContext(error);
      return null;
    }

    if (!options.quiet) {
      throw error;
    }

    return null;
  }
}

function isInvalidatedExtensionError(error) {
  return INVALIDATED_EXTENSION_PATTERN.test(String(error?.message || error || ""));
}

function handleInvalidatedExtensionContext(error) {
  extensionContextAlive = false;
  renderOverlayInvalidatedState(error?.message || "Extension reloaded. Refresh this tab.");
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
