const STORAGE_KEYS = [
  "queue",
  "runState",
  "currentItemId",
  "activeTabId",
  "settings",
  "activityLog",
  "lastStatus",
  "pageStatus"
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
  maxRetries: 1,
  autoSaveOutputs: false
};

const DEFAULT_PAGE_STATUS = {
  provider: null,
  connected: false,
  ready: false,
  composerFound: false,
  sendButtonFound: false,
  generating: false,
  draftPresent: false,
  lastCheckedAt: null,
  reason: "Waiting for a supported AI tab."
};

const DEFAULT_STATE = {
  queue: [],
  runState: "idle",
  currentItemId: null,
  activeTabId: null,
  settings: DEFAULT_SETTINGS,
  activityLog: [],
  lastStatus: "Idle",
  pageStatus: DEFAULT_PAGE_STATUS
};

const QUEUE_TICK_ALARM = "queueTick";

chrome.runtime.onInstalled.addListener(async () => {
  await ensureState();
  await appendLog("Extension installed. Open ChatGPT or Gemini in Chrome to start.");
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureState();
});

chrome.action.onClicked.addListener(async (tab) => {
  await ensureState();

  if (tab?.id && isSupportedAssistantUrl(tab.url)) {
    await safeSendToTab(tab.id, {
      type: "OVERLAY/TOGGLE"
    });

    await patchState({
      activeTabId: tab.id
    });

    return;
  }

  const existingTab = await findSupportedAssistantTab();
  if (existingTab?.id) {
    await chrome.tabs.update(existingTab.id, { active: true });

    if (existingTab.windowId) {
      await chrome.windows.update(existingTab.windowId, { focused: true });
    }

    await safeSendToTab(existingTab.id, {
      type: "OVERLAY/SHOW"
    });

    await patchState({
      activeTabId: existingTab.id
    });

    return;
  }

  const createdTab = await chrome.tabs.create({
    url: "https://chatgpt.com/"
  });

  if (createdTab?.id) {
    await patchState({
      activeTabId: createdTab.id
    });
  }
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
    pageStatus: buildDisconnectedPageStatus("Tracked AI tab closed."),
    lastStatus: "Tracked AI tab closed."
  });

  await appendLog("Tracked AI tab closed.", "warn");
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !isSupportedAssistantUrl(tab.url)) {
    return;
  }

  const state = await getState();
  if (state.activeTabId === tabId) {
    await refreshPageStatusForTab(tabId, "AI tab refreshed.");

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
      return handleAddPrompts(message.payload || {});
    case "POPUP/START":
      return handleStart(message.payload || {});
    case "POPUP/PAUSE":
      return handlePause();
    case "POPUP/RESUME":
      return handleResume();
    case "POPUP/STOP":
      return handleStop();
    case "POPUP/SKIP_CURRENT":
      return handleSkipCurrent();
    case "POPUP/RETRY_CURRENT":
      return handleRetryCurrent();
    case "POPUP/REMOVE_ITEM":
      return handleRemoveItem(message.payload?.itemId);
    case "POPUP/MOVE_ITEM":
      return handleMoveItem(message.payload?.itemId, message.payload?.direction);
    case "POPUP/RETRY_ITEM":
      return handleRetryItem(message.payload?.itemId);
    case "POPUP/UPDATE_ITEM":
      return handleUpdateItem(message.payload || {});
    case "POPUP/CLEAR_COMPLETED":
      return handleClearCompleted();
    case "POPUP/CLEAR_ALL":
      return handleClearAll();
    case "POPUP/RERUN_ALL":
      return handleRerunAll();
    case "POPUP/SAVE_SETTINGS":
      return handleSaveSettings(message.payload?.settings ?? {});
    case "POPUP/REFRESH_PAGE_STATUS":
      return handleRefreshPageStatus();
    case "CONTENT/READY":
      return handleContentReady(message.payload, sender);
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

async function handleAddPrompts(payload) {
  const sharedAttachments = normalizeAttachments(payload?.attachments || []);
  const items = buildQueueItemsFromPayload(payload, sharedAttachments);

  if (!items.length) {
    return {
      ok: false,
      error: "No prompts or attachments were provided."
    };
  }

  const state = await getState();
  const newItems = items.map((item) => buildQueueItem(item));

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

async function handleUpdateItem(payload) {
  const state = await getState();
  const itemId = payload?.itemId;

  if (!itemId) {
    return {
      ok: false,
      error: "Missing itemId."
    };
  }

  if (state.currentItemId === itemId) {
    return {
      ok: false,
      error: "The active prompt cannot be edited."
    };
  }

  const existing = state.queue.find((entry) => entry.id === itemId);
  if (!existing) {
    return {
      ok: false,
      error: "Prompt not found."
    };
  }

  const text = String(payload?.text || "").trim();
  const attachments = normalizeAttachments(payload?.attachments || []);

  if (!text && !attachments.length) {
    return {
      ok: false,
      error: "A queue item needs prompt text or at least one attachment."
    };
  }

  const queue = state.queue.map((entry) => {
    if (entry.id !== itemId) {
      return entry;
    }

    return normalizeQueueItem({
      ...entry,
      text,
      attachments,
      status: "queued",
      startedAt: null,
      finishedAt: null,
      retryCount: 0,
      lastError: null,
      savedOutputsAt: null
    });
  });

  await chrome.storage.local.set({
    queue,
    lastStatus: "Prompt updated."
  });

  await appendLog("Prompt updated.");

  const latestState = await getState();
  if (latestState.runState === "running") {
    await scheduleQueueTick(400);
  }

  return {
    ok: true
  };
}

async function handleStart(options = {}) {
  const state = await getState();
  const canRun = state.currentItemId || state.queue.some((item) => item.status === "queued");
  const immediate = Boolean(options?.immediate);

  if (!canRun) {
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
  await scheduleQueueTick(state.currentItemId ? 250 : immediate ? 0 : state.settings.startupDelayMs);

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
    lastStatus: "Queue stopped.",
    pageStatus: {
      ...state.pageStatus,
      generating: false,
      lastCheckedAt: new Date().toISOString(),
      reason: "Queue stopped."
    }
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
    lastStatus: "Current prompt skipped.",
    pageStatus: {
      ...state.pageStatus,
      generating: false,
      lastCheckedAt: new Date().toISOString(),
      reason: "Current prompt skipped."
    }
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

async function handleRetryCurrent() {
  const state = await getState();
  if (!state.currentItemId) {
    return {
      ok: false,
      error: "There is no active prompt to retry."
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
      status: "queued",
      startedAt: null,
      finishedAt: null,
      retryCount: item.retryCount + 1,
      lastError: "Retry requested by user.",
      savedOutputsAt: null
    };
  });

  await chrome.storage.local.set({
    queue,
    currentItemId: null,
    lastStatus: "Current prompt requeued.",
    pageStatus: {
      ...state.pageStatus,
      generating: false,
      lastCheckedAt: new Date().toISOString(),
      reason: "Current prompt requeued."
    }
  });

  await appendLog("Current prompt requeued.", "warn");

  const latestState = await getState();
  if (latestState.runState === "running") {
    await scheduleQueueTick(400);
  }

  return {
    ok: true
  };
}

async function handleRemoveItem(itemId) {
  const state = await getState();

  if (!itemId) {
    return {
      ok: false,
      error: "Missing itemId."
    };
  }

  if (state.currentItemId === itemId) {
    return {
      ok: false,
      error: "Use Skip Current or Retry Current for the active prompt."
    };
  }

  const item = state.queue.find((entry) => entry.id === itemId);
  if (!item) {
    return {
      ok: false,
      error: "Prompt not found."
    };
  }

  const queue = state.queue.filter((entry) => entry.id !== itemId);
  const nextState = {
    queue,
    lastStatus: "Prompt removed from queue."
  };

  if (!queue.length && !state.currentItemId && state.runState === "running") {
    nextState.runState = "idle";
  }

  await chrome.storage.local.set(nextState);
  await appendLog("Prompt removed from queue.");

  return {
    ok: true
  };
}

async function handleMoveItem(itemId, direction) {
  const state = await getState();

  if (!itemId) {
    return {
      ok: false,
      error: "Missing itemId."
    };
  }

  if (state.currentItemId === itemId) {
    return {
      ok: false,
      error: "The active prompt cannot be moved."
    };
  }

  const index = state.queue.findIndex((item) => item.id === itemId);
  if (index === -1) {
    return {
      ok: false,
      error: "Prompt not found."
    };
  }

  const targetIndex = direction === "up" ? index - 1 : direction === "down" ? index + 1 : -1;
  if (targetIndex < 0 || targetIndex >= state.queue.length) {
    return {
      ok: false,
      error: "Prompt cannot be moved in that direction."
    };
  }

  const queue = [...state.queue];
  const [item] = queue.splice(index, 1);
  queue.splice(targetIndex, 0, item);

  await chrome.storage.local.set({
    queue,
    lastStatus: `Prompt moved ${direction}.`
  });

  await appendLog(`Prompt moved ${direction}.`);

  return {
    ok: true
  };
}

async function handleRetryItem(itemId) {
  const state = await getState();

  if (!itemId) {
    return {
      ok: false,
      error: "Missing itemId."
    };
  }

  if (state.currentItemId === itemId) {
    return {
      ok: false,
      error: "Use Retry Current for the active prompt."
    };
  }

  const item = state.queue.find((entry) => entry.id === itemId);
  if (!item) {
    return {
      ok: false,
      error: "Prompt not found."
    };
  }

  if (item.status === "sending" || item.status === "waiting") {
    return {
      ok: false,
      error: "The prompt is already in progress."
    };
  }

  const queue = state.queue.map((entry) => {
    if (entry.id !== itemId) {
      return entry;
    }

    return {
      ...entry,
      status: "queued",
      startedAt: null,
      finishedAt: null,
      lastError: null,
      savedOutputsAt: null
    };
  });

  await chrome.storage.local.set({
    queue,
    lastStatus: "Prompt requeued."
  });

  await appendLog("Prompt requeued.");

  const latestState = await getState();
  if (latestState.runState === "running") {
    await scheduleQueueTick(400);
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
  const state = await getState();

  await chrome.alarms.clear(QUEUE_TICK_ALARM);

  if (state.currentItemId && state.activeTabId) {
    await safeSendToTab(state.activeTabId, {
      type: "CONTENT/ABORT"
    });
  }

  await chrome.storage.local.set({
    queue: [],
    currentItemId: null,
    runState: "idle",
    lastStatus: "Queue cleared.",
    pageStatus: normalizePageStatus({
      ...state.pageStatus,
      generating: false,
      lastCheckedAt: new Date().toISOString(),
      reason: "Queue cleared."
    })
  });

  await appendLog("Queue cleared.");

  return {
    ok: true
  };
}

async function handleRerunAll() {
  const state = await getState();

  if (!state.queue.length) {
    return {
      ok: false,
      error: "Queue is empty."
    };
  }

  await chrome.alarms.clear(QUEUE_TICK_ALARM);

  if (state.currentItemId && state.activeTabId) {
    await safeSendToTab(state.activeTabId, {
      type: "CONTENT/ABORT"
    });
  }

  const queue = state.queue.map((item) => ({
    ...item,
    status: "queued",
    startedAt: null,
    finishedAt: null,
    retryCount: 0,
    lastError: null,
    savedOutputsAt: null
  }));

  await chrome.storage.local.set({
    queue,
    currentItemId: null,
    runState: "running",
    lastStatus: "All prompts requeued. Restarting queue.",
    pageStatus: normalizePageStatus({
      ...state.pageStatus,
      generating: false,
      lastCheckedAt: new Date().toISOString(),
      reason: "All prompts requeued. Restarting queue."
    })
  });

  await appendLog("All prompts requeued. Restarting queue.");
  await scheduleQueueTick(state.settings.startupDelayMs);

  return {
    ok: true
  };
}

async function handleSaveSettings(rawSettings) {
  const state = await getState();
  const settings = sanitizeSettings({
    ...state.settings,
    ...rawSettings
  });

  await patchState({
    settings,
    lastStatus: "Settings saved."
  });

  await appendLog("Settings saved.");

  return {
    ok: true,
    settings
  };
}

async function handleRefreshPageStatus() {
  const state = await getState();
  const tab = await findSupportedAssistantTab(state.activeTabId);

  if (!tab?.id) {
    const pageStatus = buildDisconnectedPageStatus("Open a ChatGPT or Gemini tab to continue.");
    await patchState({
      activeTabId: null,
      pageStatus,
      lastStatus: pageStatus.reason
    });

    return {
      ok: true,
      pageStatus
    };
  }

  await patchState({
    activeTabId: tab.id
  });

  const pageStatus = await refreshPageStatusForTab(tab.id, "Manual page check.");

  return {
    ok: true,
    pageStatus
  };
}

async function handleContentReady(payload, sender) {
  const tabId = sender.tab?.id ?? null;
  const url = sender.tab?.url ?? "";

  if (!tabId || !isSupportedAssistantUrl(url)) {
    return {
      ok: false,
      error: "Content script is not attached to a supported AI tab."
    };
  }

  const pageStatus = normalizePageStatus({
    ...payload?.status,
    connected: true,
    lastCheckedAt: new Date().toISOString(),
    reason: contentReadyReason(payload?.reason, payload?.status?.ready)
  });

  await patchState({
    activeTabId: tabId,
    pageStatus,
    lastStatus: pageStatus.ready ? `${pageStatus.provider || "Assistant"} tab connected.` : pageStatus.reason
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
    lastStatus: "Prompt submitted. Waiting for completion.",
    pageStatus: normalizePageStatus({
      ...state.pageStatus,
      connected: true,
      generating: true,
      lastCheckedAt: new Date().toISOString(),
      reason: "Prompt submitted. Waiting for completion."
    })
  });

  await appendLog("Prompt submitted. Waiting for completion.");

  return {
    ok: true
  };
}

async function handlePromptDone(payload, sender) {
  const itemId = payload?.itemId;
  const senderTabId = sender.tab?.id ?? null;
  const state = await getState();
  const completedItem = state.queue.find((item) => item.id === itemId) || null;

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
    activeTabId: senderTabId ?? state.activeTabId,
    lastStatus: "Prompt completed.",
    pageStatus: normalizePageStatus({
      ...state.pageStatus,
      connected: true,
      generating: false,
      lastCheckedAt: new Date().toISOString(),
      reason: "Prompt completed."
    })
  });

  await appendLog("Prompt completed.");

  if (state.settings.autoSaveOutputs && completedItem) {
    const saveResult = await autoSavePromptOutputs(completedItem, payload?.output);

    if (saveResult.savedAt) {
      const savedQueue = (await getState()).queue.map((item) => {
        if (item.id !== itemId) {
          return item;
        }

        return {
          ...item,
          savedOutputsAt: saveResult.savedAt
        };
      });

      await chrome.storage.local.set({
        queue: savedQueue,
        lastStatus: saveResult.message || "Prompt completed and saved."
      });
    }
  }

  if (senderTabId) {
    await refreshPageStatusForTab(senderTabId, "Prompt completed.");
  }

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
    const tab = await findSupportedAssistantTab(state.activeTabId);
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
      lastStatus: "Queue complete.",
      pageStatus: {
        ...state.pageStatus,
        generating: false,
        lastCheckedAt: new Date().toISOString(),
        reason: "Queue complete."
      }
    });

    await appendLog("Queue complete.");
    return;
  }

  const tab = await findSupportedAssistantTab(state.activeTabId);
  if (!tab?.id) {
    const pageStatus = buildDisconnectedPageStatus("Open a ChatGPT or Gemini tab to continue.");

    await patchState({
      activeTabId: null,
      pageStatus,
      lastStatus: pageStatus.reason
    });

    await appendLog("No supported AI tab available.", "warn");
    return;
  }

  const ping = await safeSendToTab(tab.id, {
    type: "PAGE/PING"
  });

  if (!ping?.ok) {
    const pageStatus = normalizePageStatus({
      connected: true,
      ready: false,
      lastCheckedAt: new Date().toISOString(),
      reason: "Assistant page is not ready yet."
    });

    await patchState({
      activeTabId: tab.id,
      pageStatus,
      lastStatus: pageStatus.reason
    });

    await appendLog("Assistant page is not ready yet.", "warn");
    await scheduleQueueTick(2500);
    return;
  }

  const pageStatus = normalizePageStatus({
    ...ping,
    connected: true,
    lastCheckedAt: new Date().toISOString(),
    reason: ping.ready
      ? "Page ready."
      : !ping.composerFound
        ? "Waiting for composer."
        : ping.generating
          ? "Waiting for the current response to finish."
          : ping.draftPresent
            ? "Composer has an existing draft."
            : "Page not ready yet."
  });

  await patchState({
    activeTabId: tab.id,
    pageStatus,
    lastStatus: pageStatus.reason
  });

  if (!ping.ready) {
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
    lastStatus: `Submitting prompt ${getQueuePosition(state.queue, nextItem.id)}.`,
    pageStatus: normalizePageStatus({
      ...pageStatus,
      generating: true,
      reason: `Submitting prompt ${getQueuePosition(state.queue, nextItem.id)}.`
    })
  });

  await appendLog(`Submitting prompt ${getQueuePosition(state.queue, nextItem.id)} (${source}).`);

  const response = await safeSendToTab(tab.id, {
    type: "PROMPT/SUBMIT",
    payload: {
      itemId: nextItem.id,
      text: nextItem.text,
      attachments: nextItem.attachments,
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
        lastError: reason,
        savedOutputsAt: null
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
    lastStatus: canRetry ? `Retrying prompt after failure: ${reason}` : `Prompt failed: ${reason}`,
    pageStatus: normalizePageStatus({
      ...state.pageStatus,
      connected: Boolean(tabId ?? state.activeTabId),
      generating: false,
      lastCheckedAt: new Date().toISOString(),
      reason: canRetry ? `Retrying prompt after failure: ${reason}` : `Prompt failed: ${reason}`
    })
  });

  await appendLog(
    canRetry ? `Prompt failed and will retry: ${reason}` : `Prompt failed: ${reason}`,
    canRetry ? "warn" : "error"
  );

  if (tabId ?? state.activeTabId) {
    await refreshPageStatusForTab(tabId ?? state.activeTabId, canRetry ? "Retry pending." : "Prompt failed.");
  }

  const latestState = await getState();
  if (latestState.runState === "running") {
    await scheduleQueueTick(canRetry ? latestState.settings.retryDelayMs : latestState.settings.cooldownMs);
  }
}

async function refreshPageStatusForTab(tabId, reason) {
  const response = await safeSendToTab(tabId, {
    type: "PAGE/PING"
  });

  const pageStatus = response?.ok
    ? normalizePageStatus({
        ...response,
        connected: true,
        lastCheckedAt: new Date().toISOString(),
        reason
      })
    : normalizePageStatus({
        connected: true,
        ready: false,
        lastCheckedAt: new Date().toISOString(),
        reason
      });

  await chrome.storage.local.set({
    activeTabId: tabId,
    pageStatus
  });

  return pageStatus;
}

async function findSupportedAssistantTab(preferredTabId) {
  if (preferredTabId) {
    try {
      const preferred = await chrome.tabs.get(preferredTabId);
      if (preferred?.id && isSupportedAssistantUrl(preferred.url)) {
        return preferred;
      }
    } catch (error) {
      console.warn("[service-worker] preferred tab lookup failed", error);
    }
  }

  const tabs = await chrome.tabs.query({
    url: [
      "https://chatgpt.com/*",
      "https://chat.openai.com/*",
      "https://gemini.google.com/*"
    ]
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
    },
    pageStatus: normalizePageStatus({
      ...state.pageStatus,
      ...(partialState.pageStatus || {})
    })
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
    queue: Array.isArray(rawState.queue) ? rawState.queue.map((item) => normalizeQueueItem(item)) : [],
    activityLog: Array.isArray(rawState.activityLog) ? rawState.activityLog : [],
    pageStatus: normalizePageStatus(rawState.pageStatus || {})
  };
}

function normalizePageStatus(rawPageStatus) {
  return {
    ...DEFAULT_PAGE_STATUS,
    ...(rawPageStatus || {})
  };
}

function buildDisconnectedPageStatus(reason) {
  return normalizePageStatus({
    provider: null,
    connected: false,
    ready: false,
    composerFound: false,
    sendButtonFound: false,
    generating: false,
    draftPresent: false,
    lastCheckedAt: new Date().toISOString(),
    reason
  });
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

function sanitizeSettings(rawSettings) {
  return {
    startupDelayMs: clampInt(rawSettings.startupDelayMs, 0, 120000, DEFAULT_SETTINGS.startupDelayMs),
    cooldownMs: clampInt(rawSettings.cooldownMs, 0, 120000, DEFAULT_SETTINGS.cooldownMs),
    retryDelayMs: clampInt(rawSettings.retryDelayMs, 0, 300000, DEFAULT_SETTINGS.retryDelayMs),
    stableMs: clampInt(rawSettings.stableMs, 500, 20000, DEFAULT_SETTINGS.stableMs),
    pollIntervalMs: clampInt(rawSettings.pollIntervalMs, 250, 10000, DEFAULT_SETTINGS.pollIntervalMs),
    completionTimeoutMs: clampInt(rawSettings.completionTimeoutMs, 5000, 600000, DEFAULT_SETTINGS.completionTimeoutMs),
    lookupTimeoutMs: clampInt(rawSettings.lookupTimeoutMs, 1000, 60000, DEFAULT_SETTINGS.lookupTimeoutMs),
    submitConfirmTimeoutMs: clampInt(rawSettings.submitConfirmTimeoutMs, 1000, 60000, DEFAULT_SETTINGS.submitConfirmTimeoutMs),
    maxRetries: clampInt(rawSettings.maxRetries, 0, 10, DEFAULT_SETTINGS.maxRetries),
    autoSaveOutputs: coerceBoolean(rawSettings.autoSaveOutputs, DEFAULT_SETTINGS.autoSaveOutputs)
  };
}

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function contentReadyReason(reason, ready) {
  if (ready) {
    return "Assistant tab connected.";
  }

  switch (reason) {
    case "route-change":
      return "Route changed. Waiting for ready UI.";
    case "visible":
      return "Tab visible. Checking composer.";
    case "load":
      return "Page loaded. Checking composer.";
    default:
      return "Assistant tab connected. Waiting for ready UI.";
  }
}

function getQueuePosition(queue, itemId) {
  const index = queue.findIndex((item) => item.id === itemId);
  return index === -1 ? "?" : index + 1;
}

function buildQueueItemsFromPayload(payload, sharedAttachments) {
  const explicitItems = Array.isArray(payload?.items) ? payload.items : [];
  if (explicitItems.length) {
    return explicitItems
      .map((entry) => ({
        text: String(entry?.text || "").trim(),
        attachments: normalizeAttachments(entry?.attachments || sharedAttachments)
      }))
      .filter((entry) => entry.text || entry.attachments.length);
  }

  const prompts = Array.isArray(payload?.prompts) ? payload.prompts : [];
  const promptItems = prompts
    .map((prompt) => String(prompt || "").trim())
    .filter(Boolean)
    .map((text) => ({
      text,
      attachments: sharedAttachments
    }));

  if (promptItems.length) {
    return promptItems;
  }

  if (sharedAttachments.length) {
    return [{
      text: "",
      attachments: sharedAttachments
    }];
  }

  return [];
}

function buildQueueItem(rawItem) {
  return normalizeQueueItem({
    id: crypto.randomUUID(),
    text: rawItem?.text || "",
    attachments: rawItem?.attachments || [],
    status: "queued",
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    retryCount: 0,
    lastError: null,
    savedOutputsAt: null
  });
}

function normalizeQueueItem(rawItem) {
  return {
    id: rawItem?.id || crypto.randomUUID(),
    text: String(rawItem?.text || "").trim(),
    attachments: normalizeAttachments(rawItem?.attachments || []),
    status: rawItem?.status || "queued",
    createdAt: rawItem?.createdAt || new Date().toISOString(),
    startedAt: rawItem?.startedAt || null,
    finishedAt: rawItem?.finishedAt || null,
    retryCount: Number.isFinite(Number(rawItem?.retryCount)) ? Math.max(0, Number(rawItem.retryCount)) : 0,
    lastError: rawItem?.lastError || null,
    savedOutputsAt: rawItem?.savedOutputsAt || null
  };
}

function normalizeAttachments(rawAttachments) {
  if (!Array.isArray(rawAttachments)) {
    return [];
  }

  return rawAttachments
    .map((attachment) => normalizeAttachment(attachment))
    .filter(Boolean);
}

function normalizeAttachment(rawAttachment) {
  if (!rawAttachment || typeof rawAttachment !== "object") {
    return null;
  }

  const name = String(rawAttachment.name || "").trim();
  const dataUrl = String(rawAttachment.dataUrl || "").trim();

  if (!name || !dataUrl) {
    return null;
  }

  return {
    id: rawAttachment.id || crypto.randomUUID(),
    name,
    type: String(rawAttachment.type || "application/octet-stream"),
    size: Number.isFinite(Number(rawAttachment.size)) ? Math.max(0, Number(rawAttachment.size)) : 0,
    dataUrl,
    lastModified: Number.isFinite(Number(rawAttachment.lastModified))
      ? Number(rawAttachment.lastModified)
      : Date.now()
  };
}

function isSupportedAssistantUrl(url) {
  return (
    typeof url === "string" &&
    (
      url.startsWith("https://chatgpt.com/") ||
      url.startsWith("https://chat.openai.com/") ||
      url.startsWith("https://gemini.google.com/")
    )
  );
}

async function autoSavePromptOutputs(item, rawOutput) {
  if (item.savedOutputsAt) {
    return {
      savedAt: item.savedOutputsAt,
      message: null
    };
  }

  const output = normalizeOutputPayload(rawOutput);
  const assets = output.assets;

  if (!assets.length) {
    await appendLog("Prompt completed but no savable files or images were detected.", "warn");
    return {
      savedAt: null,
      message: null
    };
  }

  const baseName = buildOutputBaseName(item, output);
  let downloadCount = 0;

  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index];
    const url = asset.dataUrl || asset.url;
    if (!url) {
      continue;
    }

    try {
      await chrome.downloads.download({
        url,
        filename: `AI Queue Iterator/${sanitizeFilename(output.provider || "Assistant")}/${inferAssetFilename(asset, index, baseName)}`,
        saveAs: false,
        conflictAction: "uniquify"
      });
      downloadCount += 1;
    } catch (error) {
      console.warn("[service-worker] asset download failed", error);
      await appendLog(`Auto-save skipped one asset: ${error.message}`, "warn");
    }
  }

  if (!downloadCount) {
    await appendLog("Prompt completed but no output files or images could be downloaded.", "warn");
    return {
      savedAt: null,
      message: null
    };
  }

  const savedAt = new Date().toISOString();
  const message = downloadCount
    ? `Saved ${downloadCount} output file${downloadCount === 1 ? "" : "s"} automatically.`
    : null;

  if (message) {
    await appendLog(message);
  }

  return {
    savedAt,
    message
  };
}

function normalizeOutputPayload(rawOutput) {
  const provider = String(rawOutput?.provider || "Assistant");
  const text = String(rawOutput?.text || "");
  const assets = Array.isArray(rawOutput?.assets)
    ? rawOutput.assets
      .map((asset) => normalizeOutputAsset(asset))
      .filter(Boolean)
    : [];

  return {
    provider,
    text,
    assets
  };
}

function normalizeOutputAsset(rawAsset) {
  if (!rawAsset || typeof rawAsset !== "object") {
    return null;
  }

  const url = String(rawAsset.url || "").trim();
  const dataUrl = String(rawAsset.dataUrl || "").trim();
  const filename = String(rawAsset.filename || "").trim();

  if (!url && !dataUrl) {
    return null;
  }

  return {
    url,
    dataUrl,
    filename,
    kind: String(rawAsset.kind || "file")
  };
}

function buildOutputBaseName(item, output) {
  const timestamp = compactTimestamp(item.finishedAt || new Date().toISOString());
  const source = item.text || output.text || "response";
  const snippet = sanitizeFilename(source).slice(0, 56) || "response";
  return `${timestamp}-${snippet}`;
}

function inferAssetFilename(asset, index, baseName) {
  const source = asset.filename || extractFilenameFromUrl(asset.url || asset.dataUrl || "");
  const clean = sanitizeFilename(source || `asset-${index + 1}`);
  const hasExtension = /\.[a-z0-9]{2,8}$/i.test(clean);

  if (hasExtension) {
    return `${baseName}-${clean}`;
  }

  const extension = inferAssetExtension(asset);
  return `${baseName}-${clean}${extension ? `.${extension}` : ""}`;
}

function extractFilenameFromUrl(url) {
  if (!url) {
    return "";
  }

  if (url.startsWith("data:")) {
    return "";
  }

  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(pathname);
  } catch (error) {
    return "";
  }
}

function inferAssetExtension(asset) {
  const source = `${asset.filename || ""} ${asset.url || ""} ${asset.dataUrl || ""}`.toLowerCase();

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

function sanitizeFilename(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "")
    .slice(0, 96) || "file";
}

function compactTimestamp(value) {
  return String(value || new Date().toISOString())
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "")
    .replace("T", "-");
}

function coerceBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    if (value.toLowerCase() === "true") {
      return true;
    }

    if (value.toLowerCase() === "false") {
      return false;
    }
  }

  return fallback;
}
