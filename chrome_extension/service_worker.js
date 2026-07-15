importScripts("settings.js");

const INBOX_URLS = {
  linkedin: "https://www.linkedin.com/messaging/?cc_auto_messages=1",
  instagram: "https://www.instagram.com/direct/inbox/?cc_auto_messages=1",
  facebook: "https://www.facebook.com/messages/?cc_auto_messages=1",
};
const WHATSAPP_URL = "https://web.whatsapp.com/?cc_auto_messages=1";
const LINKEDIN_INVITATIONS_URL =
  "https://www.linkedin.com/mynetwork/invitation-manager/received/?cc_auto_invites=1";
const LINKEDIN_TASK_CONCURRENCY = 3;

const ensureWhatsAppTab = async (activate = false) => {
  const settings = await CodeCrafterSettings.load();
  if (!settings.platforms.whatsapp?.enabled || !settings.platforms.whatsapp.messages ||
      !settings.platforms.whatsapp.optedIn || settings.platforms.whatsapp.consentRevision !== 2)
    return {ok: true, opened: 0};
  const stored = await chrome.storage.local.get("ccWhatsAppAutomationTabId");
  if (stored.ccWhatsAppAutomationTabId) {
    try {
      await chrome.tabs.get(stored.ccWhatsAppAutomationTabId);
      return {ok: true, opened: 0, tabId: stored.ccWhatsAppAutomationTabId};
    } catch (_error) {
      await chrome.storage.local.remove("ccWhatsAppAutomationTabId");
    }
  }
  const tab = await chrome.tabs.create({url: WHATSAPP_URL, active: false});
  await chrome.storage.local.set({ccWhatsAppAutomationTabId: tab.id});
  return {ok: true, opened: 1, tabId: tab.id};
};

const openEnabledMessageTabs = async (force = false) => {
  const settings = await CodeCrafterSettings.load();
  const stored = await chrome.storage.local.get("ccMessageAutomationTabs");
  const tracked = stored.ccMessageAutomationTabs || {};
  let opened = 0;
  for (const [platform, url] of Object.entries(INBOX_URLS)) {
    const config = settings.platforms[platform];
    if (!config?.enabled || !config.messages) continue;
    if (tracked[platform]) {
      try {
        await chrome.tabs.get(tracked[platform]);
        continue;
      } catch (_error) {
        delete tracked[platform];
      }
    }
    const tab = await chrome.tabs.create({url, active: false});
    tracked[platform] = tab.id;
    opened += 1;
  }
  await chrome.storage.local.set({ccMessageAutomationTabs: tracked});
  return {ok: true, opened};
};

const ensureLinkedInFollowupTabs = async () => {
  const settings = await CodeCrafterSettings.load();
  const config = settings.platforms.linkedin;
  if (!config?.enabled) return {ok: true, opened: 0};
  const stored = await chrome.storage.local.get("ccLinkedInFollowupTabs");
  const tracked = stored.ccLinkedInFollowupTabs || {};
  const targets = {
    notifications: config.notificationReplies
      ? "https://www.linkedin.com/notifications/?filter=all&cc_followups=1" : "",
    invitations: config.incomingInvites ? LINKEDIN_INVITATIONS_URL : "",
  };
  let opened = 0;
  for (const [kind, url] of Object.entries(targets)) {
    if (!url) continue;
    if (tracked[kind]) {
      try { await chrome.tabs.get(tracked[kind]); continue; }
      catch (_error) { delete tracked[kind]; }
    }
    const tab = await chrome.tabs.create({url, active: false});
    tracked[kind] = tab.id;
    opened += 1;
  }
  await chrome.storage.local.set({ccLinkedInFollowupTabs: tracked});
  return {ok: true, opened, tabs: tracked};
};

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("ccDailyMessages", {periodInMinutes: 5});
  chrome.alarms.create("ccWhatsAppMonitor", {periodInMinutes: 1});
  chrome.alarms.create("ccLinkedInFollowups", {periodInMinutes: 5});
  openEnabledMessageTabs(false).catch(() => {});
  ensureWhatsAppTab(false).catch(() => {});
  clearStaleNotificationAutomation().catch(() => {});
  ensureLinkedInFollowupTabs().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("ccDailyMessages", {periodInMinutes: 5});
  chrome.alarms.create("ccWhatsAppMonitor", {periodInMinutes: 1});
  chrome.alarms.create("ccLinkedInFollowups", {periodInMinutes: 5});
  openEnabledMessageTabs(false).catch(() => {});
  ensureWhatsAppTab(false).catch(() => {});
  clearStaleNotificationAutomation().catch(() => {});
  ensureLinkedInFollowupTabs().catch(() => {});
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "ccDailyMessages") openEnabledMessageTabs(false).catch(() => {});
  if (alarm.name === "ccWhatsAppMonitor") ensureWhatsAppTab(false).catch(() => {});
  if (alarm.name === "ccLinkedInFollowups") ensureLinkedInFollowupTabs().catch(() => {});
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
    } catch (_error) {
      const {key, ...value} = task;
      await chrome.storage.local.set({
        [key]: {...value, status: "queued", tabId: null}
      });
    }
  }
  const refreshed = await queuedProfileTasks();
  const capacity = Math.max(0, LINKEDIN_TASK_CONCURRENCY -
    refreshed.filter(task => task.status === "processing").length);
  for (const next of refreshed.filter(task => task.status !== "processing").slice(0, capacity)) {
    const tab = await chrome.tabs.create({url: next.url, active: false});
    const {key, ...value} = next;
    await chrome.storage.local.set({[key]: {...value, status: "processing", tabId: tab.id}});
  }
};

const notificationTaskKey = (id) => `notificationTask:${id}`;

const queuedNotificationTasks = async () => {
  const stored = await chrome.storage.local.get(null);
  return Object.entries(stored)
    .filter(([key]) => key.startsWith("notificationTask:"))
    .map(([key, task]) => ({key, ...task}))
    .sort((left, right) => (left.created || 0) - (right.created || 0));
};

const clearStaleNotificationAutomation = async () => {
  const stored = await chrome.storage.local.get(null);
  const keys = Object.keys(stored).filter(key => key.startsWith("notificationTask:"));
  keys.push("ccLinkedInPriorityActive", "ccLinkedInPriorityScanTabId");
  await chrome.storage.local.remove(keys);
};

const openNextNotificationReply = async () => {
  const tasks = await queuedNotificationTasks();
  for (const task of tasks.filter(task => task.status === "processing")) {
    try {
      await chrome.tabs.get(task.tabId);
    } catch (_error) {
      const {key, ...value} = task;
      await chrome.storage.local.set({[key]: {...value, status: "queued", tabId: null}});
    }
  }
  const refreshed = await queuedNotificationTasks();
  const capacity = Math.max(0, LINKEDIN_TASK_CONCURRENCY -
    refreshed.filter(task => task.status === "processing").length);
  const pending = refreshed.filter(task => task.status !== "processing").slice(0, capacity);
  if (!pending.length && !refreshed.some(task => task.status === "processing")) {
    await chrome.storage.local.set({ccLinkedInPriorityActive: false});
    return;
  }
  await chrome.storage.local.set({ccLinkedInPriorityActive: true});
  for (const next of pending) {
    const tab = await chrome.tabs.create({url: next.url, active: false});
    const {key, ...value} = next;
    await chrome.storage.local.set({[key]: {...value, status: "processing", tabId: tab.id}});
  }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "runMessageRepliesNow") {
    Promise.all([openEnabledMessageTabs(true), ensureWhatsAppTab(false)])
      .then(([social, whatsapp]) => sendResponse({
        ok: true, opened: social.opened + whatsapp.opened,
      }))
      .catch(error => sendResponse({ok: false, error: String(error)}));
    return true;
  }
  if (message?.type === "triggerLinkedInPriority") {
    (async () => {
      const stored = await chrome.storage.local.get([
        "ccLinkedInPriorityScanTabId", "ccLastLinkedInPriorityAt"
      ]);
      if (Date.now() - Number(stored.ccLastLinkedInPriorityAt || 0) < 5 * 60 * 1000)
        return sendResponse({ok: true, cooldown: true});
      if (stored.ccLinkedInPriorityScanTabId) {
        try {
          await chrome.tabs.get(stored.ccLinkedInPriorityScanTabId);
          return sendResponse({ok: true, existing: true});
        } catch (_error) {
          await chrome.storage.local.remove("ccLinkedInPriorityScanTabId");
        }
      }
      await chrome.storage.local.set({ccLinkedInPriorityActive: true});
      const tab = await chrome.tabs.create({
        url: "https://www.linkedin.com/notifications/?filter=all&cc_priority=1",
        active: false,
      });
      await chrome.storage.local.set({ccLinkedInPriorityScanTabId: tab.id});
      sendResponse({ok: true, tabId: tab.id});
    })().catch(error => sendResponse({ok: false, error: String(error)}));
    return true;
  }
  if (message?.type === "finishLinkedInPriorityScan") {
    (async () => {
      await chrome.storage.local.remove("ccLinkedInPriorityScanTabId");
      await chrome.storage.local.set({ccLastLinkedInPriorityAt: Date.now()});
      if (!(await queuedNotificationTasks()).length)
        await chrome.storage.local.set({ccLinkedInPriorityActive: false});
      if (_sender.tab?.id) await chrome.tabs.remove(_sender.tab.id).catch(() => {});
      sendResponse({ok: true});
    })();
    return true;
  }
  if (message?.type === "leaveWhatsAppChat") {
    (async () => {
      const stored = await chrome.storage.local.get("ccWhatsAppAutomationTabId");
      if (_sender.tab?.id && stored.ccWhatsAppAutomationTabId === _sender.tab.id) {
        await chrome.tabs.remove(_sender.tab.id).catch(() => {});
        await chrome.storage.local.remove("ccWhatsAppAutomationTabId");
      }
      sendResponse({ok: true});
    })();
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
    ensureLinkedInFollowupTabs()
      .then(result => sendResponse({ok: true, tabId: result.tabs?.notifications}))
      .catch(error => sendResponse({ok: false, error: String(error)}));
    return true;
  }
  if (message?.type === "openIncomingInvitations") {
    ensureLinkedInFollowupTabs()
      .then(result => sendResponse({ok: true, tabId: result.tabs?.invitations}))
      .catch(error => sendResponse({ok: false, error: String(error)}));
    return true;
  }
  if (message?.type === "queueNotificationReplies") {
    (async () => {
      await chrome.storage.local.set({ccLinkedInPriorityActive: true});
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
      if (message.outcome === "retry" && (task?.attempts || 0) < 2) {
        await chrome.storage.local.set({
          [key]: {...task, status: "processing", tabId: _sender.tab?.id || task.tabId,
            attempts: (task.attempts || 0) + 1,
            lastError: message.reason || "notification reply was not confirmed"}
        });
        sendResponse({ok: true, retrying: true});
        if (_sender.tab?.id)
          setTimeout(() => chrome.tabs.reload(_sender.tab.id).catch(() => {}), 2500);
        return;
      }
      await chrome.storage.local.remove(key);
      if (_sender.tab?.id) await chrome.tabs.remove(_sender.tab.id).catch(() => {});
      await openNextNotificationReply();
      sendResponse({ok: true});
    })();
    return true;
  }
  if (message?.type === "closeAutomationTab") {
    (async () => {
      if (_sender.tab?.id) {
        const stored = await chrome.storage.local.get("ccMessageAutomationTabs");
        const tracked = stored.ccMessageAutomationTabs || {};
        for (const [platform, tabId] of Object.entries(tracked))
          if (tabId === _sender.tab.id) delete tracked[platform];
        await chrome.storage.local.set({ccMessageAutomationTabs: tracked});
        const followupStored = await chrome.storage.local.get("ccLinkedInFollowupTabs");
        const followups = followupStored.ccLinkedInFollowupTabs || {};
        for (const [kind, tabId] of Object.entries(followups))
          if (tabId === _sender.tab.id) delete followups[kind];
        await chrome.storage.local.set({ccLinkedInFollowupTabs: followups});
        await chrome.tabs.remove(_sender.tab.id).catch(() => {});
      }
      sendResponse({ok: true});
    })();
    return true;
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
