chrome.action.onClicked.addListener(async (tab) => {
  await chrome.action.setBadgeBackgroundColor({color: "#16a34a", tabId: tab.id});
  await chrome.action.setBadgeText({text: "OCR", tabId: tab.id});
});

const profileKey = (rawUrl) => {
  const url = new URL(rawUrl);
  const path = url.pathname.replace(/\/+$/, "");
  return `profileTask:${url.origin}${path}`;
};

const queuedProfileTasks = async () => {
  const stored = await chrome.storage.local.get(null);
  return Object.entries(stored)
    .filter(([key]) => key.startsWith("profileTask:"))
    .map(([key, task]) => ({key, ...task}))
    .sort((left, right) => (left.created || 0) - (right.created || 0));
};

const openNextProfile = async () => {
  const tasks = await queuedProfileTasks();
  for (const task of tasks.filter(task => task.status === "processing")) {
    try {
      await chrome.tabs.get(task.tabId);
      return;
    } catch (_error) {
      const {key, ...value} = task;
      await chrome.storage.local.set({
        [key]: {...value, status: "queued", tabId: null}
      });
    }
  }
  const next = (await queuedProfileTasks()).find(task => task.status !== "processing");
  if (!next) return;
  const tab = await chrome.tabs.create({url: next.url, active: false});
  const {key, ...value} = next;
  await chrome.storage.local.set({[key]: {...value, status: "processing", tabId: tab.id}});
};

const notificationTaskKey = (id) => `notificationTask:${id}`;

const queuedNotificationTasks = async () => {
  const stored = await chrome.storage.local.get(null);
  return Object.entries(stored)
    .filter(([key]) => key.startsWith("notificationTask:"))
    .map(([key, task]) => ({key, ...task}))
    .sort((left, right) => (left.created || 0) - (right.created || 0));
};

const openNextNotificationReply = async () => {
  const tasks = await queuedNotificationTasks();
  for (const task of tasks.filter(task => task.status === "processing")) {
    try {
      await chrome.tabs.get(task.tabId);
      return;
    } catch (_error) {
      const {key, ...value} = task;
      await chrome.storage.local.set({[key]: {...value, status: "queued", tabId: null}});
    }
  }
  const next = (await queuedNotificationTasks()).find(task => task.status !== "processing");
  if (!next) return;
  const tab = await chrome.tabs.create({url: next.url, active: false});
  const {key, ...value} = next;
  await chrome.storage.local.set({[key]: {...value, status: "processing", tabId: tab.id}});
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "captureVisible") {
    if (!_sender.tab?.active) {
      sendResponse({ok: false, error: "Instagram tab must be active for screenshot OCR"});
      return;
    }
    chrome.tabs.captureVisibleTab(_sender.tab?.windowId, {format: "jpeg", quality: 75})
      .then(screenshot => sendResponse({ok: true, screenshot}))
      .catch(error => sendResponse({ok: false, error: String(error)}));
    return true;
  }
  if (message?.type === "openProfiles") {
    (async () => {
      let queued = 0;
      for (const url of message.urls || []) {
        const key = profileKey(url);
        const existing = await chrome.storage.local.get(key);
        if (existing[key]) continue;
        await chrome.storage.local.set({
          [key]: {url, mode: message.mode || "connect", created: Date.now(),
            status: "queued", attempts: 0}
        });
        queued += 1;
      }
      await openNextProfile();
      sendResponse({ok: true, queued});
    })();
    return true;
  }
  if (message?.type === "getProfileTask") {
    (async () => {
      const key = profileKey(message.url);
      const result = await chrome.storage.local.get(key);
      if (result[key]) return sendResponse({task: result[key]});
      const redirectedTask = (await queuedProfileTasks()).find(
        task => task.tabId === _sender.tab?.id
      );
      sendResponse({task: redirectedTask || null});
    })();
    return true;
  }
  if (message?.type === "clearProfileTask") {
    (async () => {
      const key = profileKey(message.url);
      const stored = await chrome.storage.local.get(key);
      const task = stored[key];
      if (message.outcome === "retry" && (task?.attempts || 0) < 2) {
        await chrome.storage.local.set({
          [key]: {...task, status: "queued", tabId: null, attempts: (task.attempts || 0) + 1,
            lastError: message.reason || "connection attempt was not confirmed"}
        });
      } else {
        await chrome.storage.local.remove(key);
      }
      if (_sender.tab?.id) await chrome.tabs.remove(_sender.tab.id).catch(() => {});
      await openNextProfile();
      sendResponse({ok: true});
    })();
    return true;
  }
  if (message?.type === "openDailyNotifications") {
    chrome.tabs.create({url: "https://www.linkedin.com/notifications/?filter=all", active: false})
      .then(tab => sendResponse({ok: true, tabId: tab.id}))
      .catch(error => sendResponse({ok: false, error: String(error)}));
    return true;
  }
  if (message?.type === "queueNotificationReplies") {
    (async () => {
      let queued = 0;
      for (const candidate of message.candidates || []) {
        const key = notificationTaskKey(candidate.id);
        const existing = await chrome.storage.local.get(key);
        if (existing[key]) continue;
        await chrome.storage.local.set({
          [key]: {...candidate, created: Date.now(), status: "queued", attempts: 0}
        });
        queued += 1;
      }
      await openNextNotificationReply();
      sendResponse({ok: true, queued});
    })();
    return true;
  }
  if (message?.type === "getNotificationTask") {
    queuedNotificationTasks().then(tasks => {
      sendResponse({task: tasks.find(task => task.tabId === _sender.tab?.id) || null});
    });
    return true;
  }
  if (message?.type === "clearNotificationTask") {
    (async () => {
      const key = notificationTaskKey(message.id);
      const stored = await chrome.storage.local.get(key);
      const task = stored[key];
      if (message.outcome === "retry" && (task?.attempts || 0) < 1) {
        await chrome.storage.local.set({
          [key]: {...task, status: "queued", tabId: null, attempts: (task.attempts || 0) + 1,
            lastError: message.reason || "notification reply was not confirmed"}
        });
      } else {
        await chrome.storage.local.remove(key);
      }
      if (_sender.tab?.id) await chrome.tabs.remove(_sender.tab.id).catch(() => {});
      await openNextNotificationReply();
      sendResponse({ok: true});
    })();
    return true;
  }
  if (message?.type === "closeAutomationTab") {
    if (_sender.tab?.id) chrome.tabs.remove(_sender.tab.id).catch(() => {});
    sendResponse({ok: true});
    return;
  }
  if (message?.type !== "localApi") return;
  fetch(`http://127.0.0.1:8765${message.path}`, {
    method: message.method || "GET",
    headers: {"Content-Type": "application/json"},
    body: message.body ? JSON.stringify(message.body) : undefined
  }).then(async response => sendResponse({ok: response.ok, data: await response.json()}))
    .catch(error => sendResponse({ok: false, error: String(error)}));
  return true;
});
