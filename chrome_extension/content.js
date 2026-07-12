(() => {
  if (window.__codeCrafterBridge) return;
  window.__codeCrafterBridge = true;
  let paused = false;
  let busy = false;
  const processed = new Set();
  const connectionBatch = [];
  let dailyPostChecked = false;
  let lastAcceptedCheck = 0;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const api = (path, method = "GET", body = null) =>
    chrome.runtime.sendMessage({type: "localApi", path, method, body});

  function panel() {
    if (document.getElementById("cc-bot-controls")) return;
    const box = document.createElement("div");
    box.id = "cc-bot-controls";
    box.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;width:250px;padding:14px;border-radius:12px;background:#111827;color:#fff;font:14px Arial;box-shadow:0 8px 30px #0006";
    box.innerHTML = '<b>CodeCrafter Bot v3.2.0</b><div id="cc-status" style="margin:9px 0">Connecting to Python...</div><button id="cc-pause" style="width:100%;padding:10px;border:0;border-radius:8px;background:#f59e0b;font-weight:700;cursor:pointer">Pause bot</button>';
    document.documentElement.appendChild(box);
    const button = box.querySelector("#cc-pause");
    button.onmouseenter = () => button.style.filter = "brightness(1.12)";
    button.onmouseleave = () => button.style.filter = "none";
    button.onclick = () => {
      paused = !paused;
      button.textContent = paused ? "Resume bot" : "Pause bot";
      button.style.background = paused ? "#22c55e" : "#f59e0b";
      status(paused ? "Paused — nothing will submit" : "Running");
    };
  }
  function status(text) { panel(); document.getElementById("cc-status").textContent = text; }
  async function waitActive() { while (paused) await sleep(200); }
  async function delay() {
    let remaining = 5000 + Math.random() * 5000;
    while (remaining > 0) {
      await waitActive();
      const started = Date.now();
      await sleep(Math.min(200, remaining));
      remaining -= Date.now() - started;
    }
  }
  async function countdown(label) {
    let remaining = 10000;
    while (remaining > 0) {
      await waitActive();
      status(`${label} submits in ${(remaining / 1000).toFixed(1)}s — Pause to hold`);
      const started = Date.now();
      await sleep(Math.min(100, remaining));
      remaining -= Date.now() - started;
    }
    return !paused;
  }
  function postNodes() {
    const legacy = [...document.querySelectorAll("div.feed-shared-update-v2")];
    if (legacy.length) return legacy;
    return [...document.querySelectorAll("h2")]
      .filter(heading => heading.textContent.trim() === "Feed post")
      .map(heading => heading.closest("[role='listitem']"))
      .filter((node, index, all) => node && all.indexOf(node) === index);
  }
  function posts() {
    return postNodes().map((node, index) => ({
      index,
      text: (node.innerText || "").replace(/^Feed post\s*/i, "").trim().slice(0, 5000),
      liked: node.querySelector("button[aria-pressed='true'],button[aria-label*='unreact'],button[aria-label='Reaction button state: Like']") !== null,
      alreadyCommented: node.querySelector("button[aria-label*='Moshe Schwartzberg’s comment'],button[aria-label*=\"Moshe Schwartzberg's comment\"]") !== null
    })).map(item => {
      const node = postNodes()[item.index];
      const control = node?.querySelector("button[aria-label^='Open control menu for post by ']");
      const author = control?.getAttribute("aria-label")?.replace("Open control menu for post by ", "") || "";
      const links = [...(node?.querySelectorAll("a[href*='/in/']") || [])];
      const authorUrl = links.find(link => link.textContent.includes(author))?.href || links[0]?.href || "";
      return {...item, authorUrl, key: item.text.slice(0, 300)};
    })
      .filter(item => item.text.length > 30 && !/\bPromoted\b/i.test(item.text) && !processed.has(item.key))
      .slice(0, 8);
  }
  async function moveToNext() {
    const next = posts()[0];
    if (next) postNodes()[next.index]?.scrollIntoView({behavior: "smooth", block: "center"});
    else {
      postNodes().at(-1)?.scrollIntoView({behavior: "smooth", block: "end"});
      window.scrollBy({top: 700, behavior: "smooth"});
    }
    await delay();
  }
  async function execute(action) {
    const node = postNodes()[action.index];
    if (!node) return api("/result", "POST", {ok: false, reason: "post container disappeared"});
    node.scrollIntoView({behavior: "smooth", block: "center"}); await delay();
    if (action.like) {
      const like = node.querySelector("button[aria-label='Reaction button state: no reaction'],button[aria-label*='React Like'],button[aria-label*='Like']");
      if (!like) await api("/result", "POST", {ok: false, kind: "like", reason: "reaction button not found"});
      else {
        like.click(); await sleep(500);
        const reacted = like.getAttribute("aria-label") !== "Reaction button state: no reaction" || like.getAttribute("aria-pressed") === "true";
        await api("/result", "POST", {ok: reacted, kind: "like", reason: reacted ? "LinkedIn confirmed like" : "like state did not change"});
      }
    }
    if (!action.comment) { queueProfileConnection(action.authorUrl); return; }
    node.querySelector("button[aria-label*='Comment']")?.click(); await delay();
    const editor = node.querySelector("div[contenteditable='true'][role='textbox']");
    if (!editor) return api("/result", "POST", {ok: false, reason: "comment editor not found"});
    editor.focus(); document.execCommand("insertText", false, action.comment);
    const before = node.querySelectorAll("button[aria-label*='Moshe Schwartzberg’s comment'],button[aria-label*=\"Moshe Schwartzberg's comment\"]").length;
    if (!(await countdown("Comment"))) return;
    const submit = node.querySelector("button.comments-comment-box__submit-button") ||
      [...node.querySelectorAll("button")].find(button => button.textContent.trim() === "Comment");
    if (!submit || submit.disabled) return api("/result", "POST", {ok: false, reason: "submit button unavailable"});
    submit.click();
    for (let n = 0; n < 20; n++) {
      await sleep(250);
      const after = node.querySelectorAll("button[aria-label*='Moshe Schwartzberg’s comment'],button[aria-label*=\"Moshe Schwartzberg's comment\"]").length;
      if (after > before || !node.contains(editor)) {
        status("Running — comment submitted successfully");
        await api("/result", "POST", {ok: true, kind: "comment", reason: "LinkedIn confirmed comment"});
        queueProfileConnection(action.authorUrl);
        return;
      }
    }
    status("Comment submission could not be confirmed");
    return api("/result", "POST", {ok: false, kind: "comment", reason: "LinkedIn did not confirm comment"});
  }
  async function queueProfileConnection(url) {
    if (!url || connectionBatch.includes(url)) return;
    connectionBatch.push(url);
    status(`Connection profiles collected: ${connectionBatch.length}/15`);
    if (connectionBatch.length < 15) return;
    const batch = connectionBatch.splice(0, 15);
    status("Opening 15 profile tabs for connection requests");
    await chrome.runtime.sendMessage({type: "openProfiles", urls: batch});
    window.focus();
  }
  async function handleProfileConnection() {
    const stored = await chrome.runtime.sendMessage({type: "getProfileTask", url: location.href});
    const raw = localStorage.getItem("ccPendingConnection");
    const task = stored?.task || (raw ? JSON.parse(raw) : null);
    if (!task) return;
    if (!location.href.startsWith(task.url.split("?")[0])) return;
    localStorage.removeItem("ccPendingConnection");
    await delay();
    const messageButton = [...document.querySelectorAll("button,a")].find(e => e.offsetParent !== null && e.textContent.trim() === "Message");
    if (messageButton) {
      if (task.mode !== "acceptedCheck") { status("Already connected — no request sent"); return; }
      const response = await api("/draft-message", "POST", {stage: "accepted", context: (document.querySelector("main")?.innerText || "").slice(0, 5000)});
      if (!response?.ok || !response.data.allowed || !response.data.message) return status(`Opener skipped — ${response?.data?.reason || "draft failed"}`);
      messageButton.click(); await delay();
      const editor = [...document.querySelectorAll("div[contenteditable='true'][role='textbox']")].find(e => e.offsetParent !== null);
      if (!editor) return api("/result", "POST", {ok: false, kind: "message", url: task.url, reason: "message editor not found"});
      editor.focus(); document.execCommand("insertText", false, response.data.message);
      if (!(await countdown("Non-pitch opener"))) return;
      const sendMessage = [...document.querySelectorAll("button")].find(e => e.offsetParent !== null && /^Send$/i.test(e.textContent.trim()));
      if (!sendMessage || sendMessage.disabled) return api("/result", "POST", {ok: false, kind: "message", url: task.url, reason: "message Send button unavailable"});
      sendMessage.click(); status("Non-pitch opener submitted");
      await api("/result", "POST", {ok: true, kind: "message", url: task.url, reason: "accepted-connection opener submitted"});
      setTimeout(() => window.close(), 1200); return;
    }
    if (task.mode === "acceptedCheck") {
      status("Connection still pending — will check later");
      setTimeout(() => window.close(), 1200); return;
    }
    const response = await api("/draft-connection", "POST", {url: location.href, profile: (document.querySelector("main")?.innerText || "").slice(0, 5000)});
    if (!response?.ok || !response.data.allowed || !response.data.message) {
      status(`Connection skipped — ${response?.data?.reason || "draft failed"}`);
      setTimeout(() => window.close(), 1200); return;
    }
    let connect = [...document.querySelectorAll("button")].find(e => e.offsetParent !== null && e.textContent.trim() === "Connect");
    if (!connect) {
      const more = [...document.querySelectorAll("button")].find(e => e.offsetParent !== null && e.textContent.trim() === "More");
      more?.click(); await sleep(500);
      connect = [...document.querySelectorAll("div[role='button'],button")].find(e => e.offsetParent !== null && e.textContent.trim() === "Connect");
    }
    if (!connect) return api("/result", "POST", {ok: false, kind: "connection", reason: "Connect control not found"});
    connect.click(); await sleep(500);
    const addNote = [...document.querySelectorAll("button")].find(e => e.offsetParent !== null && e.textContent.trim() === "Add a note");
    addNote?.click(); await sleep(300);
    const input = [...document.querySelectorAll("textarea")].find(e => e.offsetParent !== null);
    if (input) { input.value = response.data.message.slice(0, 300); input.dispatchEvent(new Event("input", {bubbles: true})); }
    if (!(await countdown("Connection request"))) return;
    const send = [...document.querySelectorAll("button")].find(e => e.offsetParent !== null && /^(Send|Send invitation)$/.test(e.textContent.trim()));
    if (!send || send.disabled) return api("/result", "POST", {ok: false, kind: "connection", reason: "Send invitation unavailable"});
    send.click(); status("Connection request submitted");
    await api("/result", "POST", {ok: true, kind: "connection", url: task.url, reason: "connection request submitted"});
    setTimeout(() => window.close(), 1200);
  }
  async function maybeCheckAcceptedConnection() {
    if (Date.now() - lastAcceptedCheck < 15 * 60 * 1000) return;
    lastAcceptedCheck = Date.now();
    const response = await api("/next-pending-connection", "POST", {});
    const url = response?.data?.url;
    if (!url) return;
    localStorage.setItem("ccPendingConnection", JSON.stringify({url, mode: "acceptedCheck", created: Date.now()}));
    window.open(url, "_blank", "noopener");
  }
  async function maybeDailyPost(samples) {
    if (dailyPostChecked || [0, 6].includes(new Date().getDay())) return;
    dailyPostChecked = true;
    const response = await api("/daily-post", "POST", {samples: samples.map(item => item.text)});
    const draft = response?.data?.draft;
    if (!response?.ok || !response.data.allowed || !draft) return;
    const start = [...document.querySelectorAll("a,button")].find(element => element.textContent.trim() === "Start a post");
    if (!start) return api("/result", "POST", {ok: false, kind: "post", reason: "Start a post control not found"});
    start.click(); await delay();
    const editor = [...document.querySelectorAll("div[contenteditable='true'][role='textbox']")].find(element => element.offsetParent !== null);
    if (!editor) return api("/result", "POST", {ok: false, kind: "post", reason: "post editor not found"});
    editor.focus(); document.execCommand("insertText", false, draft);
    if (!(await countdown("Daily post"))) return;
    const submit = [...document.querySelectorAll("button")].find(button => button.offsetParent !== null && button.textContent.trim() === "Post");
    if (!submit || submit.disabled) return api("/result", "POST", {ok: false, kind: "post", reason: "Post button unavailable"});
    submit.click(); await sleep(1000);
    return api("/result", "POST", {ok: true, kind: "post", reason: "daily post submitted"});
  }
  async function cycle() {
    panel(); if (busy || paused || !location.pathname.startsWith("/feed")) return;
    busy = true;
    try {
      const foundPosts = posts();
      await maybeCheckAcceptedConnection();
      await maybeDailyPost(foundPosts);
      const response = await api("/cycle", "POST", {
        posts: foundPosts,
        diagnostics: {
          extensionVersion: "3.2.0",
          url: location.href,
          feedHeadings: [...document.querySelectorAll("h2")].filter(h => h.textContent.trim() === "Feed post").length,
          listItems: document.querySelectorAll("[role='listitem']").length,
          scrollTop: Math.round(document.scrollingElement?.scrollTop || window.scrollY)
        }
      });
      if (!response?.ok) { status("Start Python: python linkedin_bot.py"); return; }
      const info = response.data;
      foundPosts.slice(0, info.checked || 0).forEach(item => processed.add(item.key));
      status(info.action ? `Ollama selected post ${info.action.index + 1} of ${info.received}` :
        `Scanned ${info.received} posts — ${info.last_reason || "none relevant yet"}`);
      if (info.action) await execute(info.action);
      status(`Processed ${processed.size} posts — moving down`);
      await moveToNext();
    } catch (error) { status("Python bridge unavailable"); }
    finally { busy = false; }
  }
  panel();
  if (location.pathname.startsWith("/in/")) handleProfileConnection();
  else { setInterval(cycle, 12000); cycle(); }
})();
