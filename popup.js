const STORAGE_KEYS = [
  "queue",
  "runState",
  "currentItemId",
  "activeTabId",
  "activityLog",
  "lastStatus"
];

const elements = {};

document.addEventListener("DOMContentLoaded", async () => {
  bindElements();
  bindEvents();
  await renderFromStorage();

  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    if (!Object.keys(changes).some((key) => STORAGE_KEYS.includes(key))) {
      return;
    }

    await renderFromStorage();
  });
});

function bindElements() {
  elements.promptInput = document.getElementById("prompt-input");
  elements.delimiterMode = document.getElementById("delimiter-mode");
  elements.customTokenWrap = document.getElementById("custom-token-wrap");
  elements.customToken = document.getElementById("custom-token");
  elements.addPrompts = document.getElementById("add-prompts");
  elements.clearInput = document.getElementById("clear-input");
  elements.runState = document.getElementById("run-state");
  elements.chatgptConnection = document.getElementById("chatgpt-connection");
  elements.lastStatus = document.getElementById("last-status");
  elements.totalCount = document.getElementById("total-count");
  elements.remainingCount = document.getElementById("remaining-count");
  elements.completedCount = document.getElementById("completed-count");
  elements.startRun = document.getElementById("start-run");
  elements.pauseRun = document.getElementById("pause-run");
  elements.resumeRun = document.getElementById("resume-run");
  elements.stopRun = document.getElementById("stop-run");
  elements.skipCurrent = document.getElementById("skip-current");
  elements.clearCompleted = document.getElementById("clear-completed");
  elements.clearAll = document.getElementById("clear-all");
  elements.activeLabel = document.getElementById("active-label");
  elements.queueList = document.getElementById("queue-list");
  elements.activityLog = document.getElementById("activity-log");
}

function bindEvents() {
  elements.delimiterMode.addEventListener("change", () => {
    const showCustom = elements.delimiterMode.value === "custom";
    elements.customTokenWrap.hidden = !showCustom;
  });

  elements.addPrompts.addEventListener("click", async () => {
    const prompts = splitPrompts(
      elements.promptInput.value,
      elements.delimiterMode.value,
      elements.customToken.value
    );

    if (!prompts.length) {
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: "POPUP/ADD_PROMPTS",
      payload: { prompts }
    });

    if (response?.ok) {
      elements.promptInput.value = "";
    }
  });

  elements.clearInput.addEventListener("click", () => {
    elements.promptInput.value = "";
  });

  elements.startRun.addEventListener("click", () => sendPopupCommand("POPUP/START"));
  elements.pauseRun.addEventListener("click", () => sendPopupCommand("POPUP/PAUSE"));
  elements.resumeRun.addEventListener("click", () => sendPopupCommand("POPUP/RESUME"));
  elements.stopRun.addEventListener("click", () => sendPopupCommand("POPUP/STOP"));
  elements.skipCurrent.addEventListener("click", () => sendPopupCommand("POPUP/SKIP_CURRENT"));
  elements.clearCompleted.addEventListener("click", () => sendPopupCommand("POPUP/CLEAR_COMPLETED"));
  elements.clearAll.addEventListener("click", () => sendPopupCommand("POPUP/CLEAR_ALL"));
}

async function sendPopupCommand(type) {
  try {
    await chrome.runtime.sendMessage({ type });
  } catch (error) {
    console.error("[popup] command failed", error);
  }
}

async function renderFromStorage() {
  const state = await chrome.storage.local.get(STORAGE_KEYS);
  const queue = Array.isArray(state.queue) ? state.queue : [];
  const activityLog = Array.isArray(state.activityLog) ? state.activityLog : [];
  const runState = state.runState || "idle";
  const currentItemId = state.currentItemId || null;

  const remaining = queue.filter((item) => ["queued", "sending", "waiting"].includes(item.status)).length;
  const completed = queue.filter((item) => item.status === "completed").length;
  const activeItem = queue.find((item) => item.id === currentItemId) || null;

  elements.runState.textContent = capitalize(runState);
  elements.lastStatus.textContent = state.lastStatus || "No activity yet.";
  elements.totalCount.textContent = String(queue.length);
  elements.remainingCount.textContent = String(remaining);
  elements.completedCount.textContent = String(completed);
  elements.activeLabel.textContent = activeItem
    ? `Active: ${truncate(activeItem.text, 64)}`
    : "No active prompt";

  renderConnection(Boolean(state.activeTabId));
  renderQueue(queue, currentItemId);
  renderLog(activityLog);
  syncButtonStates(runState, queue, activeItem);
}

function renderConnection(isConnected) {
  elements.chatgptConnection.textContent = isConnected ? "Connected" : "Disconnected";
  elements.chatgptConnection.className = `badge ${isConnected ? "connected" : "neutral"}`;
}

function renderQueue(queue, currentItemId) {
  if (!queue.length) {
    elements.queueList.className = "list empty";
    elements.queueList.textContent = "Queue is empty.";
    return;
  }

  elements.queueList.className = "list";
  elements.queueList.innerHTML = queue
    .map((item, index) => {
      const activeClass = item.id === currentItemId ? " active" : "";
      return `
        <article class="queue-item${activeClass}">
          <div class="queue-item-head">
            <span class="queue-index">#${index + 1}</span>
            <span class="badge ${badgeClass(item.status)}">${escapeHtml(item.status)}</span>
          </div>
          <p class="queue-text">${escapeHtml(truncate(item.text, 180))}</p>
          <p class="queue-meta">Retries: ${item.retryCount || 0}${item.lastError ? ` | ${escapeHtml(truncate(item.lastError, 72))}` : ""}</p>
        </article>
      `;
    })
    .join("");
}

function renderLog(activityLog) {
  if (!activityLog.length) {
    elements.activityLog.className = "list empty";
    elements.activityLog.textContent = "No log entries yet.";
    return;
  }

  elements.activityLog.className = "list";
  elements.activityLog.innerHTML = activityLog
    .map((entry) => {
      return `
        <article class="log-item">
          <div class="log-head">
            <span class="badge ${badgeClass(entry.level)}">${escapeHtml(entry.level)}</span>
            <time>${escapeHtml(formatTime(entry.timestamp))}</time>
          </div>
          <p>${escapeHtml(entry.message)}</p>
        </article>
      `;
    })
    .join("");
}

function syncButtonStates(runState, queue, activeItem) {
  const hasQueued = queue.some((item) => item.status === "queued");
  const hasCompleted = queue.some((item) => item.status === "completed");
  const hasAny = queue.length > 0;

  elements.startRun.disabled = !hasQueued || runState === "running";
  elements.pauseRun.disabled = runState !== "running";
  elements.resumeRun.disabled = runState !== "paused" && runState !== "stopped";
  elements.stopRun.disabled = runState !== "running" && runState !== "paused";
  elements.skipCurrent.disabled = !activeItem;
  elements.clearCompleted.disabled = !hasCompleted;
  elements.clearAll.disabled = !hasAny;
}

function splitPrompts(input, mode, customToken) {
  const text = String(input || "").trim();
  if (!text) {
    return [];
  }

  if (mode === "tripleDash") {
    return text
      .split(/\n\s*---\s*\n/g)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  if (mode === "custom") {
    const token = String(customToken || "").trim();
    if (!token) {
      return [];
    }

    return text
      .split(token)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return text
    .split(/\n\s*\n/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function badgeClass(status) {
  switch (status) {
    case "completed":
    case "connected":
    case "info":
      return "connected";
    case "waiting":
    case "sending":
      return "running";
    case "failed":
    case "error":
    case "cancelled":
      return "danger";
    case "skipped":
    case "warn":
      return "warning";
    default:
      return "neutral";
  }
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function truncate(text, limit) {
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
}

function formatTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch (error) {
    return "";
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
