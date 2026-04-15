const STORAGE_KEYS = [
  "queue",
  "runState",
  "currentItemId",
  "activeTabId",
  "settings",
  "activityLog",
  "lastStatus"
];

const DEFAULT_SETTINGS = {
  startupDelayMs: 1200,
  cooldownMs: 1600,
  retryDelayMs: 5000,
  stableMs: 3500,
  pollIntervalMs: 1200,
  completionTimeoutMs: 180000,
  lookupTimeoutMs: 15000,
  submitConfirmTimeoutMs: 12000,
  maxRetries: 1
};

const DEFAULT_STATE = {
  queue: [],
  runState: "idle",
  currentItemId: null,
  activeTabId: null,
  settings: DEFAULT_SETTINGS,
  activityLog: [],
  lastStatus: "Idle"
};

const QUEUE_TICK_ALARM = "queueTick";

chrome.runtime.onInstalled.addListener(async () => {
  await ensureState();
  await appendLog("Extension installed. Open chatgpt.com to start.");
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureState();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== QUEUE_TICK_ALARM) {
    return;
  }

  await processQueue("alarm");
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state.activeTabId !== tabId) {
    return;
  }

  await patchState({
    activeTabId: null,
    lastStatus: "Tracked ChatGPT tab closed."
  });

  await appendLog("Tracked ChatGPT tab closed.", "warn");
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !isChatGPTUrl(tab.url)) {
    return;
  }

  const state = await getState();
  if (state.activeTabId === tabId) {
    await patchState({
      lastStatus: "ChatGPT tab refreshed. Reconnecting."
    });

    if (state.runState === "running") {
      await scheduleQueueTick(1000);
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch(async (error) => {
      console.error("[service-worker] message error", error);
      await appendLog(`Unexpected error: ${error.message}`, "error");
      sendResponse({
        ok: false,
        error: error.message
      });
    });

  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "POPUP/ADD_PROMPTS":
      return handleAddPrompts(message.payload?.prompts ?? []);
    case "POPUP/START":
      return handleStart();
    case "POPUP/PAUSE":
      return handlePause();
    case "POPUP/RESUME":
      return handleResume();
    case "POPUP/STOP":
      return handleStop();
    case "POPUP/SKIP_CURRENT":
      return handleSkipCurrent();
    case "POPUP/CLEAR_COMPLETED":
      return handleClearCompleted();
    case "POPUP/CLEAR_ALL":
      return handleClearAll();
    case "CONTENT/READY":
      return handleContentReady(sender);
    case "CONTENT/SUBMITTED":
      return handlePromptSubmitted(message.payload, sender);
    case "CONTENT/DONE":
      return handlePromptDone(message.payload, sender);
    case "CONTENT/FAILED":
      return handlePromptFailed(message.payload, sender);
    default:
      return {
        ok: false,
        error: `Unknown message type: ${message?.type ?? "undefined"}`
      };
  }
}

async function handleAddPrompts(rawPrompts) {
  const prompts = rawPrompts
    .map((prompt) => String(prompt || "").trim())
    .filter(Boolean);

  if (!prompts.length) {
    return {
      ok: false,
      error: "No prompts were provided."
    };
  }

  const state = await getState();
  const newItems = prompts.map((text) => ({
    id: crypto.randomUUID(),
    text,
    status: "queued",
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    retryCount: 0,
    lastError: null
  }));

  await chrome.storage.local.set({
    queue: [...state.queue, ...newItems],
    lastStatus: `${newItems.length} prompt${newItems.length === 1 ? "" : "s"} added to the queue.`
  });

  await appendLog(`Added ${newItems.length} prompt${newItems.length === 1 ? "" : "s"} to the queue.`);

  return {
    ok: true,
    added: newItems.length
  };
}

async function handleStart() {
  const state = await getState();
  if (!state.queue.some((item) => item.status === "queued")) {
    await patchState({
      lastStatus: "Queue is empty."
    });

    return {
      ok: false,
      error: "Queue is empty."
    };
  }

  await patchState({
    runState: "running",
    lastStatus: "Queue started."
  });

  await appendLog("Queue started.");
  await scheduleQueueTick(state.settings.startupDelayMs);

  return {
    ok: true
  };
}

async function handlePause() {
  await patchState({
    runState: "paused",
    lastStatus: "Queue paused. Current prompt will finish monitoring."
  });

  await chrome.alarms.clear(QUEUE_TICK_ALARM);
  await appendLog("Queue paused.");

  return {
    ok: true
  };
}

async function handleResume() {
  await patchState({
    runState: "running",
    lastStatus: "Queue resumed."
  });

  await appendLog("Queue resumed.");
  await scheduleQueueTick(250);

  return {
    ok: true
  };
}

async function handleStop() {
  const state = await getState();

  await patchState({
    runState: "stopped",
    lastStatus: "Queue stopped."
  });

  await chrome.alarms.clear(QUEUE_TICK_ALARM);

  if (state.activeTabId) {
    await safeSendToTab(state.activeTabId, {
      type: "CONTENT/ABORT"
    });
  }

  if (state.currentItemId) {
    const queue = state.queue.map((item) => {
      if (item.id !== state.currentItemId) {
        return item;
      }

      return {
        ...item,
        status: "cancelled",
        finishedAt: new Date().toISOString(),
        lastError: "Stopped by user."
      };
    });

    await chrome.storage.local.set({
      queue,
      currentItemId: null
    });
  }

  await appendLog("Queue stopped by user.", "warn");

  return {
    ok: true
  };
}

async function handleSkipCurrent() {
  const state = await getState();
  if (!state.currentItemId) {
    return {
      ok: false,
      error: "There is no active prompt to skip."
    };
  }

  if (state.activeTabId) {
    await safeSendToTab(state.activeTabId, {
      type: "CONTENT/ABORT"
    });
  }

  const queue = state.queue.map((item) => {
    if (item.id !== state.currentItemId) {
      return item;
    }

    return {
      ...item,
      status: "skipped",
      finishedAt: new Date().toISOString(),
      lastError: "Skipped by user."
    };
  });

  await chrome.storage.local.set({
    queue,
    currentItemId: null,
    lastStatus: "Current prompt skipped."
  });

  await appendLog("Current prompt skipped.", "warn");

  const latestState = await getState();
  if (latestState.runState === "running") {
    await scheduleQueueTick(latestState.settings.cooldownMs);
  }

  return {
    ok: true
  };
}

async function handleClearCompleted() {
  const state = await getState();
  const queue = state.queue.filter((item) => item.status !== "completed");

  await chrome.storage.local.set({
    queue,
    lastStatus: "Completed prompts cleared."
  });

  await appendLog("Completed prompts cleared.");

  return {
    ok: true
  };
}

async function handleClearAll() {
  await chrome.alarms.clear(QUEUE_TICK_ALARM);
  await chrome.storage.local.set({
    queue: [],
    currentItemId: null,
    runState: "idle",
    lastStatus: "Queue cleared."
  });

  await appendLog("Queue cleared.");

  return {
    ok: true
  };
}

async function handleContentReady(sender) {
  const tabId = sender.tab?.id ?? null;
  const url = sender.tab?.url ?? "";

  if (!tabId || !isChatGPTUrl(url)) {
    return {
      ok: false,
      error: "Content script is not attached to a chatgpt.com tab."
    };
  }

  await patchState({
    activeTabId: tabId,
    lastStatus: "ChatGPT tab connected."
  });

  const state = await getState();
  if (state.runState === "running") {
    if (state.currentItemId) {
      await safeSendToTab(tabId, {
        type: "CONTENT/RESUME_MONITOR",
        payload: {
          itemId: state.currentItemId,
          settings: buildPageSettings(state.settings)
        }
      });
    } else {
      await scheduleQueueTick(500);
    }
  }

  return {
    ok: true
  };
}

async function handlePromptSubmitted(payload, sender) {
  const itemId = payload?.itemId;
  const senderTabId = sender.tab?.id ?? null;
  const state = await getState();

  if (!itemId) {
    return {
      ok: false,
      error: "Missing itemId."
    };
  }

  const queue = state.queue.map((item) => {
    if (item.id !== itemId) {
      return item;
    }

    return {
      ...item,
      status: "waiting"
    };
  });

  await chrome.storage.local.set({
    queue,
    activeTabId: senderTabId ?? state.activeTabId,
    lastStatus: "Prompt submitted. Waiting for completion."
  });

  await appendLog("Prompt submitted. Waiting for completion.");

  return {
    ok: true
  };
}

async function handlePromptDone(payload, sender) {
  const itemId = payload?.itemId;
  const state = await getState();

  if (!itemId) {
    return {
      ok: false,
      error: "Missing itemId."
    };
  }

  const queue = state.queue.map((item) => {
    if (item.id !== itemId) {
      return item;
    }

    return {
      ...item,
      status: "completed",
      finishedAt: new Date().toISOString(),
      lastError: null
    };
  });

  await chrome.storage.local.set({
    queue,
    currentItemId: null,
    activeTabId: sender.tab?.id ?? state.activeTabId,
    lastStatus: "Prompt completed."
  });

  await appendLog("Prompt completed.");

  const latestState = await getState();
  if (latestState.runState === "running") {
    await scheduleQueueTick(latestState.settings.cooldownMs);
  }

  return {
    ok: true
  };
}

async function handlePromptFailed(payload, sender) {
  const itemId = payload?.itemId;
  const reason = payload?.reason || "Unknown page automation error.";

  if (!itemId) {
    return {
      ok: false,
      error: "Missing itemId."
    };
  }

  await failOrRetryItem(itemId, reason, sender.tab?.id ?? null);

  return {
    ok: true
  };
}

async function processQueue(source) {
  const state = await getState();

  if (state.runState !== "running") {
    return;
  }

  if (state.currentItemId) {
    const tab = await findChatGPTTab(state.activeTabId);
    if (tab?.id) {
      await safeSendToTab(tab.id, {
        type: "CONTENT/RESUME_MONITOR",
        payload: {
          itemId: state.currentItemId,
          settings: buildPageSettings(state.settings)
        }
      });
    }

    return;
  }

  const nextItem = state.queue.find((item) => item.status === "queued");
  if (!nextItem) {
    await patchState({
      runState: "idle",
      lastStatus: "Queue complete."
    });

    await appendLog("Queue complete.");
    return;
  }

  const tab = await findChatGPTTab(state.activeTabId);
  if (!tab?.id) {
    await patchState({
      activeTabId: null,
      lastStatus: "Open a chatgpt.com tab to continue."
    });

    await appendLog("No chatgpt.com tab available.", "warn");
    return;
  }

  const ping = await safeSendToTab(tab.id, {
    type: "PAGE/PING"
  });

  if (!ping?.ok) {
    await patchState({
      activeTabId: tab.id,
      lastStatus: "ChatGPT page is not ready yet."
    });

    await appendLog("ChatGPT page is not ready yet.", "warn");
    await scheduleQueueTick(2500);
    return;
  }

  if (!ping.ready) {
    await patchState({
      activeTabId: tab.id,
      lastStatus: "Waiting for composer and send controls."
    });

    await scheduleQueueTick(2000);
    return;
  }

  const queue = state.queue.map((item) => {
    if (item.id !== nextItem.id) {
      return item;
    }

    return {
      ...item,
      status: "sending",
      startedAt: item.startedAt || new Date().toISOString(),
      lastError: null
    };
  });

  await chrome.storage.local.set({
    queue,
    currentItemId: nextItem.id,
    activeTabId: tab.id,
    lastStatus: `Submitting prompt ${getQueuePosition(state.queue, nextItem.id)}.`
  });

  await appendLog(`Submitting prompt ${getQueuePosition(state.queue, nextItem.id)} (${source}).`);

  const response = await safeSendToTab(tab.id, {
    type: "PROMPT/SUBMIT",
    payload: {
      itemId: nextItem.id,
      text: nextItem.text,
      settings: buildPageSettings(state.settings)
    }
  });

  if (!response?.ok || response.accepted === false) {
    await failOrRetryItem(
      nextItem.id,
      response?.error || "Prompt submission command was rejected.",
      tab.id
    );
  }
}

async function failOrRetryItem(itemId, reason, tabId = null) {
  const state = await getState();
  const item = state.queue.find((entry) => entry.id === itemId);

  if (!item) {
    return;
  }

  const canRetry =
    state.runState === "running" &&
    item.retryCount < state.settings.maxRetries;

  const queue = state.queue.map((entry) => {
    if (entry.id !== itemId) {
      return entry;
    }

    if (canRetry) {
      return {
        ...entry,
        status: "queued",
        retryCount: entry.retryCount + 1,
        lastError: reason
      };
    }

    return {
      ...entry,
      status: "failed",
      finishedAt: new Date().toISOString(),
      lastError: reason
    };
  });

  await chrome.storage.local.set({
    queue,
    currentItemId: null,
    activeTabId: tabId ?? state.activeTabId,
    lastStatus: canRetry ? `Retrying prompt after failure: ${reason}` : `Prompt failed: ${reason}`
  });

  await appendLog(
    canRetry ? `Prompt failed and will retry: ${reason}` : `Prompt failed: ${reason}`,
    canRetry ? "warn" : "error"
  );

  const latestState = await getState();
  if (latestState.runState === "running") {
    await scheduleQueueTick(canRetry ? latestState.settings.retryDelayMs : latestState.settings.cooldownMs);
  }
}

async function findChatGPTTab(preferredTabId) {
  if (preferredTabId) {
    try {
      const preferred = await chrome.tabs.get(preferredTabId);
      if (preferred?.id && isChatGPTUrl(preferred.url)) {
        return preferred;
      }
    } catch (error) {
      console.warn("[service-worker] preferred tab lookup failed", error);
    }
  }

  const tabs = await chrome.tabs.query({
    url: ["https://chatgpt.com/*"]
  });

  if (!tabs.length) {
    return null;
  }

  return tabs.find((tab) => tab.active) || tabs[0];
}

async function scheduleQueueTick(delayMs) {
  const when = Date.now() + Math.max(0, delayMs);
  await chrome.alarms.create(QUEUE_TICK_ALARM, { when });
}

async function safeSendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  }
}

async function ensureState() {
  const rawState = await chrome.storage.local.get(STORAGE_KEYS);
  const nextState = normalizeState(rawState);
  await chrome.storage.local.set(nextState);
  return nextState;
}

async function getState() {
  const rawState = await chrome.storage.local.get(STORAGE_KEYS);
  return normalizeState(rawState);
}

async function patchState(partialState) {
  const state = await getState();
  const nextState = {
    ...state,
    ...partialState,
    settings: {
      ...state.settings,
      ...(partialState.settings || {})
    }
  };

  await chrome.storage.local.set(nextState);
  return nextState;
}

function normalizeState(rawState) {
  return {
    ...DEFAULT_STATE,
    ...rawState,
    settings: {
      ...DEFAULT_SETTINGS,
      ...(rawState.settings || {})
    },
    queue: Array.isArray(rawState.queue) ? rawState.queue : [],
    activityLog: Array.isArray(rawState.activityLog) ? rawState.activityLog : []
  };
}

async function appendLog(message, level = "info") {
  const state = await getState();
  const entry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    level,
    message
  };

  const activityLog = [entry, ...state.activityLog].slice(0, 75);

  await chrome.storage.local.set({
    activityLog,
    lastStatus: message
  });
}

function buildPageSettings(settings) {
  return {
    stableMs: settings.stableMs,
    pollIntervalMs: settings.pollIntervalMs,
    completionTimeoutMs: settings.completionTimeoutMs,
    lookupTimeoutMs: settings.lookupTimeoutMs,
    submitConfirmTimeoutMs: settings.submitConfirmTimeoutMs
  };
}

function getQueuePosition(queue, itemId) {
  const index = queue.findIndex((item) => item.id === itemId);
  return index === -1 ? "?" : index + 1;
}

function isChatGPTUrl(url) {
  return typeof url === "string" && url.startsWith("https://chatgpt.com/");
}
