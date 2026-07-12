chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "openProfiles") {
    (async () => {
      for (const url of message.urls || []) {
        const key = `profileTask:${url.split("?")[0]}`;
        await chrome.storage.local.set({[key]: {url, mode: "connect", created: Date.now()}});
        await chrome.tabs.create({url, active: false});
      }
      sendResponse({ok: true});
    })();
    return true;
  }
  if (message?.type === "getProfileTask") {
    const key = `profileTask:${message.url.split("?")[0]}`;
    chrome.storage.local.get(key).then(result => {
      if (result[key]) chrome.storage.local.remove(key);
      sendResponse({task: result[key] || null});
    });
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
