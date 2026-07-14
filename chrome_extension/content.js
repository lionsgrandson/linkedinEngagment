;(() => {
  if (window.__codeCrafterBridge) return
  window.__codeCrafterBridge = true
  const EXTENSION_VERSION = '3.7.0'
  const EXTENSION_BUILD = 'fd2bf36f0dac'
  let paused = false
  let busy = false
  const processed = new Set()
  const queuedProfiles = new Set()
  let dailyFollowupCheckedDay = ''

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const api = (path, method = 'GET', body = null) =>
    chrome.runtime.sendMessage({ type: 'localApi', path, method, body })

  const visible = (element) => element && element.offsetParent !== null
  const labels = (element) => [
    element?.textContent,
    element?.getAttribute?.('aria-label'),
    element?.getAttribute?.('title'),
  ].filter(Boolean).map((value) => value.replace(/\s+/g, ' ').trim())
  const label = (element) => labels(element).join(' ')
  const controls = (root = document) =>
    [...root.querySelectorAll("button,a,div[role='button']")].filter(visible)
  const findControl = (pattern, root = document) =>
    controls(root).find((element) =>
      labels(element).some((value) => pattern.test(value)) || pattern.test(label(element)),
    )
  async function waitForVisible(selectors, timeout = 10000, root = document) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const found = selectors
        .flatMap((selector) => [...root.querySelectorAll(selector)])
        .find(visible)
      if (found) return found
      await sleep(200)
    }
    return null
  }
  const controlDiagnostics = (root = document) =>
    controls(root).map(label).filter(Boolean).slice(0, 12).join(' / ').slice(0, 700)
  const findConnectControl = (root = document) =>
    controls(root).find((element) =>
      labels(element).some((value) =>
        /^(Connect(?: with .+)?|Invite .+ to connect)$/i.test(value),
      ),
    )
  async function waitForConnectionConfirmation(dialog, timeout = 12000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const pageText = [
        ...document.querySelectorAll("[role='alert'],.artdeco-toast-item"),
      ].filter(visible).map(label).join(' ')
      if (/invitation (?:was )?sent|request (?:was )?sent/i.test(pageText))
        return { ok: true, reason: 'LinkedIn confirmed invitation sent' }
      if (/couldn.?t send|unable to send|try again|something went wrong/i.test(pageText))
        return { ok: false, reason: pageText.slice(0, 300) }
      if (findControl(/^Pending(?:\s|$)|Invitation pending/i))
        return { ok: true, reason: 'LinkedIn shows the invitation as pending' }
      if (dialog && !visible(dialog))
        return { ok: true, reason: 'LinkedIn closed the invitation dialog after Send' }
      await sleep(250)
    }
    return { ok: false, reason: 'LinkedIn did not confirm the connection request' }
  }
  function setEditorText(editor, text) {
    editor.focus()
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      const prototype = editor instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(editor, text)
      editor.dispatchEvent(new Event('input', { bubbles: true }))
      editor.dispatchEvent(new Event('change', { bubbles: true }))
    } else {
      document.execCommand('insertText', false, text)
      editor.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: text,
      }))
    }
  }
  async function waitForEditorClear(editor, timeout = 10000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const value = editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement
        ? editor.value
        : editor.textContent
      if (!visible(editor) || !value?.trim()) return true
      await sleep(250)
    }
    return false
  }

  function panel() {
    if (document.getElementById('cc-bot-controls')) return
    const box = document.createElement('div')
    box.id = 'cc-bot-controls'
    box.style.cssText =
      'position:fixed;right:18px;bottom:18px;z-index:2147483647;width:250px;padding:14px;border-radius:12px;background:#111827;color:#fff;font:14px Arial;box-shadow:0 8px 30px #0006'
    box.innerHTML =
      `<style>@keyframes ccPulse{50%{opacity:.35}}#cc-status[data-state="loading"]::after{content:"";display:block;width:72%;height:7px;margin-top:7px;border-radius:5px;background:#94a3b8;animation:ccPulse 1s infinite}</style><b>CodeCrafter Bot v${EXTENSION_VERSION}</b><div id="cc-status" data-state="loading" style="margin:9px 0">Connecting to Python...</div><button id="cc-pause" style="width:100%;padding:10px;border:0;border-radius:8px;background:#f59e0b;font-weight:700;cursor:pointer;transition:filter .15s">Pause bot</button>`
    document.documentElement.appendChild(box)
    const button = box.querySelector('#cc-pause')
    button.onmouseenter = () => (button.style.filter = 'brightness(1.12)')
    button.onmouseleave = () => (button.style.filter = 'none')
    button.onclick = () => {
      paused = !paused
      button.textContent = paused ? 'Resume bot' : 'Pause bot'
      button.style.background = paused ? '#22c55e' : '#f59e0b'
      status(paused ? 'Paused — nothing will submit' : 'Running')
    }
  }
  function status(text, state = 'filled') {
    panel()
    const element = document.getElementById('cc-status')
    element.textContent = text
    element.dataset.state = state
  }
  async function waitActive() {
    while (paused) await sleep(200)
  }
  async function delay() {
    let remaining = 5000 + Math.random() * 5000
    while (remaining > 0) {
      await waitActive()
      const started = Date.now()
      await sleep(Math.min(200, remaining))
      remaining -= Date.now() - started
    }
  }
  async function countdown(label) {
    let remaining = 10000
    while (remaining > 0) {
      await waitActive()
      status(
        `${label} submits in ${(remaining / 1000).toFixed(1)}s — Pause to hold`,
      )
      const started = Date.now()
      await sleep(Math.min(100, remaining))
      remaining -= Date.now() - started
    }
    return !paused
  }
  function postNodes() {
    const legacy = [...document.querySelectorAll('div.feed-shared-update-v2')]
    if (legacy.length) return legacy
    return [...document.querySelectorAll('h2')]
      .filter((heading) => heading.textContent.trim() === 'Feed post')
      .map((heading) => heading.closest("[role='listitem']"))
      .filter((node, index, all) => node && all.indexOf(node) === index)
  }
  function posts() {
    return postNodes()
      .map((node, index) => ({
        index,
        text: (node.innerText || '')
          .replace(/^Feed post\s*/i, '')
          .trim()
          .slice(0, 5000),
        liked:
          node.querySelector(
            "button[aria-pressed='true'],button[aria-label*='unreact'],button[aria-label='Reaction button state: Like']",
          ) !== null,
        alreadyCommented:
          node.querySelector(
            "button[aria-label*='Moshe Schwartzberg’s comment'],button[aria-label*=\"Moshe Schwartzberg's comment\"]",
          ) !== null,
      }))
      .map((item) => {
        const node = postNodes()[item.index]
        const control = node?.querySelector(
          "button[aria-label^='Open control menu for post by ']",
        )
        const author =
          control
            ?.getAttribute('aria-label')
            ?.replace('Open control menu for post by ', '') || ''
        const links = [...(node?.querySelectorAll("a[href*='/in/']") || [])]
        const authorUrl =
          links.find((link) => link.textContent.includes(author))?.href ||
          links[0]?.href ||
          ''
        return { ...item, authorUrl, key: item.text.slice(0, 300) }
      })
      .filter(
        (item) =>
          item.text.length > 30 &&
          !/\bPromoted\b/i.test(item.text) &&
          !processed.has(item.key),
      )
      .slice(0, 8)
  }
  async function moveToNext() {
    const next = posts()[0]
    if (next)
      postNodes()[next.index]?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
    else {
      postNodes().at(-1)?.scrollIntoView({ behavior: 'smooth', block: 'end' })
      window.scrollBy({ top: 700, behavior: 'smooth' })
    }
    await delay()
  }
  async function execute(action) {
    const node = postNodes()[action.index]
    if (!node)
      return api('/result', 'POST', {
        ok: false,
        reason: 'post container disappeared',
      })
    node.scrollIntoView({ behavior: 'smooth', block: 'center' })
    await delay()
    if (action.like) {
      const like = node.querySelector(
        "button[aria-label='Reaction button state: no reaction'],button[aria-label*='React Like'],button[aria-label*='Like']",
      )
      if (!like)
        await api('/result', 'POST', {
          ok: false,
          kind: 'like',
          reason: 'reaction button not found',
        })
      else {
        like.click()
        await sleep(500)
        const reacted =
          like.getAttribute('aria-label') !==
            'Reaction button state: no reaction' ||
          like.getAttribute('aria-pressed') === 'true'
        await api('/result', 'POST', {
          ok: reacted,
          kind: 'like',
          reason: reacted
            ? 'LinkedIn confirmed like'
            : 'like state did not change',
        })
      }
    }
    if (!action.comment) {
      queueProfileConnection(action.authorUrl)
      return
    }
    node.querySelector("button[aria-label*='Comment']")?.click()
    await delay()
    const editor = node.querySelector(
      "div[contenteditable='true'][role='textbox']",
    )
    if (!editor)
      return api('/result', 'POST', {
        ok: false,
        reason: 'comment editor not found',
      })
    editor.focus()
    document.execCommand('insertText', false, action.comment)
    const before = node.querySelectorAll(
      "button[aria-label*='Moshe Schwartzberg’s comment'],button[aria-label*=\"Moshe Schwartzberg's comment\"]",
    ).length
    if (!(await countdown('Comment'))) return
    const submit =
      node.querySelector('button.comments-comment-box__submit-button') ||
      [...node.querySelectorAll('button')].find(
        (button) => button.textContent.trim() === 'Comment',
      )
    if (!submit || submit.disabled)
      return api('/result', 'POST', {
        ok: false,
        reason: 'submit button unavailable',
      })
    submit.click()
    for (let n = 0; n < 20; n++) {
      await sleep(250)
      const after = node.querySelectorAll(
        "button[aria-label*='Moshe Schwartzberg’s comment'],button[aria-label*=\"Moshe Schwartzberg's comment\"]",
      ).length
      if (after > before || !node.contains(editor)) {
        status('Running — comment submitted successfully')
        await api('/result', 'POST', {
          ok: true,
          kind: 'comment',
          reason: 'LinkedIn confirmed comment',
        })
        queueProfileConnection(action.authorUrl)
        return
      }
    }
    status('Comment submission could not be confirmed')
    return api('/result', 'POST', {
      ok: false,
      kind: 'comment',
      reason: 'LinkedIn did not confirm comment',
    })
  }
  async function queueProfileConnection(url) {
    if (!url || queuedProfiles.has(url)) return
    queuedProfiles.add(url)
    status('Opening author profile for a connection request')
    const result = await chrome.runtime.sendMessage({ type: 'openProfiles', urls: [url] })
    await api('/result', 'POST', {
      ok: Boolean(result?.ok),
      reason: result?.ok ? `Connection profile queued: ${url}` : `Could not queue connection profile: ${url}`,
    })
    window.focus()
  }
  async function finishProfileTask(task, outcome = 'done', reason = '') {
    await chrome.runtime.sendMessage({
      type: 'clearProfileTask',
      url: task.url,
      outcome,
      reason,
    })
    localStorage.removeItem('ccPendingConnection')
  }
  async function handleProfileConnection() {
    const stored = await chrome.runtime.sendMessage({ type: 'getProfileTask', url: location.href })
    const raw = localStorage.getItem('ccPendingConnection')
    const task = stored?.task || (raw ? JSON.parse(raw) : null)
    if (!task) return
    status('Connection task loaded - inspecting profile')
    await delay()
    const profileRoot = document.querySelector('main .artdeco-card,main section,main') || document
    const messageButton = findControl(/^Message$|Message .* profile/i, profileRoot)
    if (task.mode === 'acceptedCheck') {
      if (findControl(/^Pending(?:\s|$)|Invitation pending/i, profileRoot) ||
          findConnectControl(profileRoot)) {
        status('Connection still pending - will check tomorrow')
        await finishProfileTask(task)
        return
      }
      if (!messageButton) {
        status('Acceptance could not be confirmed - will check tomorrow')
        await finishProfileTask(task)
        return
      }
      const response = await api('/draft-message', 'POST', {
        stage: 'accepted',
        context: (document.querySelector('main')?.innerText || '').slice(0, 5000),
      })
      if (!response?.ok || !response.data.allowed || !response.data.message) {
        status(`Opener skipped - ${response?.data?.reason || 'draft failed'}`)
        await finishProfileTask(task)
        return
      }
      messageButton.click()
      await delay()
      const editor = await waitForVisible([
        "div[contenteditable='true'][role='textbox']",
        "textarea[placeholder*='message' i]",
      ], 10000)
      if (!editor) {
        const reason = 'Accepted-connection message editor not found'
        await api('/result', 'POST', { ok: false, kind: 'message', url: task.url, reason })
        await finishProfileTask(task, 'retry', reason)
        return
      }
      setEditorText(editor, response.data.message)
      if (!(await countdown('Non-pitch opener'))) return
      const messageRoot = editor.closest("[role='dialog'],form,.msg-form") || document
      const sendMessage = findControl(/^Send$/i, messageRoot)
      if (!sendMessage || sendMessage.disabled) {
        const reason = 'Accepted-connection message Send button unavailable'
        await api('/result', 'POST', { ok: false, kind: 'message', url: task.url, reason })
        await finishProfileTask(task, 'retry', reason)
        return
      }
      sendMessage.click()
      const confirmed = await waitForEditorClear(editor)
      await api('/result', 'POST', {
        ok: confirmed,
        kind: confirmed ? 'message' : undefined,
        url: task.url,
        reason: confirmed
          ? 'LinkedIn confirmed accepted-connection opener'
          : 'LinkedIn did not confirm accepted-connection opener',
      })
      status(confirmed ? 'Accepted-connection opener confirmed' : 'Opener was not confirmed')
      await finishProfileTask(
        task,
        confirmed ? 'done' : 'retry',
        confirmed ? '' : 'message submission was not confirmed',
      )
      return
    }
    if (findControl(/^Pending(?:\s|$)|Invitation pending/i, profileRoot)) {
      status('Connection request is already pending')
      await finishProfileTask(task)
      return
    }
    if (messageButton && !findConnectControl(profileRoot)) {
      status('Already connected - no request needed')
      await finishProfileTask(task)
      return
    }
    const response = await api('/draft-connection', 'POST', {
      url: location.href,
      profile: (document.querySelector('main')?.innerText || '').slice(0, 5000),
    })
    if (!response?.ok || !response.data.allowed || !response.data.message) {
      status(`Connection skipped — ${response?.data?.reason || 'draft failed'}`)
      await api('/result', 'POST', {
        ok: false,
        kind: 'connection',
        reason: `Connection draft failed: ${response?.data?.reason || 'unknown'}`,
      })
      await finishProfileTask(task, 'done', 'draft rejected')
      return
    }
    let connect = findConnectControl(profileRoot)
    if (!connect) {
      const more = findControl(/^More$|More actions/i, profileRoot)
      more?.click()
      await sleep(800)
      connect = findConnectControl()
    }
    if (!connect) {
      await api('/result', 'POST', {
        ok: false,
        kind: 'connection',
        reason: `Connect control not found; controls=${controlDiagnostics()}`,
      })
      await finishProfileTask(task, 'retry', 'Connect control not found')
      return
    }
    connect.click()
    const dialog = await waitForVisible(["div[role='dialog']"], 6000)
    if (!dialog) {
      const confirmation = await waitForConnectionConfirmation(null, 4000)
      await api('/result', 'POST', {
        ok: confirmation.ok,
        kind: confirmation.ok ? 'connection' : undefined,
        url: task.url,
        reason: confirmation.reason,
      })
      await finishProfileTask(
        task,
        confirmation.ok ? 'done' : 'retry',
        confirmation.reason,
      )
      return
    }
    const addNote = findControl(/^Add a note$|Personalize invitation/i, dialog)
    addNote?.click()
    if (addNote) await sleep(500)
    const input = await waitForVisible([
      'textarea',
      "div[contenteditable='true'][role='textbox']",
      "input[name='message']",
    ], 5000, dialog)
    if (addNote && !input) {
      const reason = 'Connection note editor did not appear'
      await api('/result', 'POST', { ok: false, kind: 'connection', reason })
      await finishProfileTask(task, 'retry', reason)
      return
    }
    if (input) {
      const note = response.data.message.slice(0, 300)
      setEditorText(input, note)
    }
    if (!(await countdown('Connection request'))) return
    const send = findControl(/^(Send|Send invitation|Send now|Send without a note)$/i, dialog)
    if (!send || send.disabled) {
      await api('/result', 'POST', {
        ok: false,
        kind: 'connection',
        reason: `Send invitation unavailable; controls=${controlDiagnostics(dialog)}`,
      })
      await finishProfileTask(task, 'retry', 'Send invitation unavailable')
      return
    }
    send.click()
    status('Waiting for LinkedIn to confirm the connection request')
    const confirmation = await waitForConnectionConfirmation(dialog)
    await api('/result', 'POST', {
      ok: confirmation.ok,
      kind: confirmation.ok ? 'connection' : undefined,
      url: task.url,
      reason: confirmation.reason,
    })
    status(confirmation.ok ? 'Connection request confirmed' : 'Connection request not confirmed')
    await finishProfileTask(
      task,
      confirmation.ok ? 'done' : 'retry',
      confirmation.reason,
    )
  }
  async function finishNotificationTask(task, outcome = 'done', reason = '') {
    await chrome.runtime.sendMessage({
      type: 'clearNotificationTask',
      id: task.id,
      outcome,
      reason,
    })
  }
  async function handleNotificationsPage() {
    status('Daily follow-up - scanning notification replies', 'loading')
    await sleep(2500)
    const candidates = []
    const seen = new Set()
    const nodes = [
      ...document.querySelectorAll(
        "[data-view-name='notification-card'],.nt-card,article,li,[role='listitem']",
      ),
    ].filter(visible)
    for (const node of nodes) {
      const notificationText = (node.innerText || '').replace(/\s+/g, ' ').trim()
      if (!/(?:replied|responded) to your comment/i.test(notificationText)) continue
      const link = [...node.querySelectorAll('a[href]')].find((anchor) =>
        /\/feed\/update\/|\/posts\/|commentUrn=/i.test(anchor.href),
      )
      if (!link) continue
      const id = node.getAttribute('data-urn') || `${link.href}|${notificationText.slice(0, 300)}`
      if (seen.has(id)) continue
      seen.add(id)
      candidates.push({ id, url: link.href, notificationText: notificationText.slice(0, 1200) })
    }
    const response = await api('/notification-replies', 'POST', { candidates })
    const unseen = response?.data?.candidates || []
    if (unseen.length) {
      await chrome.runtime.sendMessage({ type: 'queueNotificationReplies', candidates: unseen })
      status(`Daily follow-up - queued ${unseen.length} notification replies`, 'success')
    } else {
      status('Daily follow-up - no new comment replies', 'blank')
    }
    await sleep(800)
    await chrome.runtime.sendMessage({ type: 'closeAutomationTab' })
  }
  async function handleNotificationReply(task) {
    status('Daily follow-up - opening a reply thread', 'loading')
    await delay()
    const normalized = (task.notificationText || '').replace(/\s+/g, ' ').trim()
    const actor = normalized.match(/^(.{1,100}?)\s+(?:replied|responded) to/i)?.[1]?.trim()
    const commentRoots = [
      ...document.querySelectorAll(
        ".comments-comment-item,[data-view-name='comment-item'],[data-urn*='comment']",
      ),
    ].filter(visible)
    const highlighted = commentRoots.find((root) =>
      root.matches(".comments-comment-item--highlighted,[data-highlighted='true']") &&
      findControl(/^Reply$/i, root),
    )
    const target = highlighted || (actor
      ? commentRoots.find((root) =>
          (root.innerText || '').toLowerCase().includes(actor.toLowerCase()) &&
          findControl(/^Reply$/i, root),
        )
      : null)
    const replyButton = target ? findControl(/^Reply$/i, target) : null
    if (!target || !replyButton) {
      const reason = `Could not safely identify the replied-to comment; actor=${actor || 'unknown'}`
      await api('/result', 'POST', { ok: false, reason })
      await finishNotificationTask(task, 'retry', reason)
      return
    }
    const response = await api('/draft-notification-reply', 'POST', {
      notificationId: task.id,
      notificationText: task.notificationText,
      context: (document.querySelector('main')?.innerText || '').slice(0, 5000),
    })
    if (!response?.ok || !response.data.allowed || !response.data.reply) {
      const reason = `Notification reply skipped: ${response?.data?.reason || 'draft failed'}`
      await api('/result', 'POST', { ok: false, reason })
      await finishNotificationTask(task, 'done', reason)
      return
    }
    replyButton.click()
    const editor = await waitForVisible([
      "div[contenteditable='true'][role='textbox']",
      'textarea',
    ], 8000, target) || await waitForVisible([
      "div[contenteditable='true'][role='textbox']",
      'textarea',
    ], 4000)
    if (!editor) {
      const reason = 'Notification reply editor did not appear'
      await api('/result', 'POST', { ok: false, reason })
      await finishNotificationTask(task, 'retry', reason)
      return
    }
    setEditorText(editor, response.data.reply)
    if (!(await countdown('Comment reply'))) return
    const replyRoot = editor.closest('form') || target
    const submit = findControl(/^(Reply|Comment|Send)$/i, replyRoot)
    if (!submit || submit.disabled) {
      const reason = `Notification reply submit unavailable; controls=${controlDiagnostics(replyRoot)}`
      await api('/result', 'POST', { ok: false, reason })
      await finishNotificationTask(task, 'retry', reason)
      return
    }
    submit.click()
    const confirmed = await waitForEditorClear(editor)
    await api('/result', 'POST', {
      ok: confirmed,
      kind: confirmed ? 'notification_reply' : undefined,
      notificationId: task.id,
      reason: confirmed
        ? 'LinkedIn confirmed notification comment reply'
        : 'LinkedIn did not confirm notification comment reply',
    })
    status(
      confirmed ? 'Comment reply confirmed' : 'Comment reply was not confirmed',
      confirmed ? 'success' : 'failure',
    )
    await finishNotificationTask(
      task,
      confirmed ? 'done' : 'retry',
      confirmed ? '' : 'reply submission was not confirmed',
    )
  }
  async function maybeRunDailyFollowups() {
    const now = new Date()
    const localDay = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')].join('-')
    if (dailyFollowupCheckedDay === localDay) return
    const response = await api('/daily-followups', 'POST', {})
    if (!response?.ok) return
    dailyFollowupCheckedDay = localDay
    if (!response.data.due) return
    const pendingConnections = response.data.pendingConnections || []
    if (pendingConnections.length) {
      await chrome.runtime.sendMessage({
        type: 'openProfiles',
        mode: 'acceptedCheck',
        urls: pendingConnections,
      })
    }
    await chrome.runtime.sendMessage({ type: 'openDailyNotifications' })
    status(
      `Daily follow-up started - ${pendingConnections.length} pending connections to check`,
    )
  }
  async function cycle() {
    panel()
    if (busy || paused || !location.pathname.startsWith('/feed')) return
    busy = true
    try {
      const foundPosts = posts()
      await maybeRunDailyFollowups()
      const response = await api('/cycle', 'POST', {
        posts: foundPosts,
        diagnostics: {
          extensionVersion: EXTENSION_VERSION,
          extensionBuild: EXTENSION_BUILD,
          url: location.href,
          feedHeadings: [...document.querySelectorAll('h2')].filter(
            (h) => h.textContent.trim() === 'Feed post',
          ).length,
          listItems: document.querySelectorAll("[role='listitem']").length,
          scrollTop: Math.round(
            document.scrollingElement?.scrollTop || window.scrollY,
          ),
        },
      })
      if (!response?.ok) {
        status('Start Python: python linkedin_bot.py')
        return
      }
      const info = response.data
      foundPosts
        .slice(0, info.checked || 0)
        .forEach((item) => processed.add(item.key))
      status(
        info.action
          ? `Ollama selected post ${info.action.index + 1} of ${info.received}`
          : `Scanned ${info.received} posts — ${info.last_reason || 'none relevant yet'}`,
      )
      if (info.action) await execute(info.action)
      status(`Processed ${processed.size} posts — moving down`)
      await moveToNext()
    } catch (error) {
      status('Python bridge unavailable')
    } finally {
      busy = false
    }
  }
  async function start() {
    panel()
    const notificationTask = await chrome.runtime.sendMessage({ type: 'getNotificationTask' })
    if (notificationTask?.task) return handleNotificationReply(notificationTask.task)
    if (location.pathname.startsWith('/notifications')) return handleNotificationsPage()
    if (location.pathname.startsWith('/in/')) return handleProfileConnection()
    if (location.pathname.startsWith('/feed')) {
      setInterval(cycle, 12000)
      cycle()
    }
  }
  start().catch((error) => {
    status(`Automation failed - ${String(error).slice(0, 180)}`, 'failure')
  })
})()
