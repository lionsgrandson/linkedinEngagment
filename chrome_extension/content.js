;(() => {
  if (window.__codeCrafterBridge) return
  window.__codeCrafterBridge = true
  const EXTENSION_VERSION = '3.18.4'
  const EXTENSION_BUILD = '1441821fb223'
  let paused = false
  let busy = false
  const processed = new Set()
  const queuedProfiles = new Set()
  let dailyFollowupCheckedDay = ''
  let priorityRequested = false

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
  const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim()
  const editorText = (editor) => normalizeText(
    editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement
      ? editor.value
      : editor?.textContent,
  )
  const feedbackText = () => normalizeText([
    ...document.querySelectorAll("[role='alert'],.artdeco-toast-item,[role='dialog']"),
  ].filter(visible).map(label).join(' '))
  const blockingFeedback = () => {
    const message = feedbackText()
    return /couldn.?t|unable to|try again|something went wrong|invitation limit|email address|required|not available|failed/i.test(message)
      ? message.slice(0, 400)
      : ''
  }
  async function waitForConnectionConfirmation(dialog, timeout = 12000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const pageText = [
        ...document.querySelectorAll("[role='alert'],.artdeco-toast-item"),
      ].filter(visible).map(label).join(' ')
      if (/invitation (?:was )?sent|request (?:was )?sent/i.test(pageText))
        return { ok: true, reason: 'LinkedIn confirmed invitation sent' }
      if (/couldn.?t send|unable to send|try again|something went wrong|invitation limit|email address|required/i.test(pageText))
        return { ok: false, reason: pageText.slice(0, 300) }
      if (findControl(/^Pending(?:\s|$)|Invitation pending/i))
        return { ok: true, reason: 'LinkedIn shows the invitation as pending' }
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
      editor.textContent = ''
      document.execCommand('insertText', false, text)
      editor.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: text,
      }))
    }
    return editorText(editor) === normalizeText(text)
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
  async function waitForExactOutgoingMessage(expected, timeout = 12000) {
    const wanted = normalizeText(expected)
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const outgoing = [...document.querySelectorAll(
        "li.msg-s-message-list__event,.msg-s-event-listitem,[data-view-name*='message']",
      )].filter(visible).some((item) => {
        const content = normalizeText(item.innerText)
        return content.includes(wanted) && /Moshe Schwartzberg sent the following message|\bYou\b/i.test(content)
      })
      if (outgoing) return true
      if (blockingFeedback()) return false
      await sleep(300)
    }
    return false
  }

  const commentRoots = (root = document) => [...root.querySelectorAll(
    ".comments-comment-item,[data-view-name='comment-item'],[data-urn*='comment']",
  )].filter(visible)
  const hasExactComment = (root, expected) => {
    const wanted = normalizeText(expected)
    const signature = wanted.slice(0, 100)
    return Boolean(wanted) && commentRoots(root).some(
      (comment) => normalizeText(comment.innerText).includes(signature),
    )
  }
  const hasOwnComment = (root) => commentRoots(root).some((comment) => {
    const content = `${label(comment)} ${comment.innerText || ''}`
    return /Moshe Schwartzberg(?:’|'|â€™)?s comment|View Moshe(?: Schwartzberg)?(?:’|'|â€™)?s profile|\bMoshe Schwartzberg\b/i.test(content)
  })
  async function expandComments(root) {
    for (let pass = 0; pass < 3; pass += 1) {
      const control = findControl(/^(Load|Show|View) (more|previous|all|\d+) (comments|replies)/i, root)
      if (!control) return
      control.scrollIntoView({block: 'center'})
      control.click()
      await sleep(1200)
    }
  }
  async function waitForExactComment(root, expected, timeout = 12000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (hasExactComment(root, expected))
        return {ok: true, reason: 'LinkedIn shows the submitted comment signature'}
      const blocked = blockingFeedback()
      if (blocked) return {ok: false, reason: blocked}
      await sleep(300)
    }
    return {ok: false, reason: 'LinkedIn did not display the exact submitted comment'}
  }

  function panel() {
    if (document.getElementById('cc-bot-controls')) return
    const box = document.createElement('div')
    box.id = 'cc-bot-controls'
    box.style.cssText =
      'position:fixed;right:18px;bottom:18px;z-index:2147483647;width:250px;padding:14px;border-radius:12px;background:#111827;color:#fff;font:14px Arial;box-shadow:0 8px 30px #0006'
    box.innerHTML =
      `<style>@keyframes ccPulse{50%{opacity:.35}}#cc-status[data-state="loading"]::after{content:"";display:block;width:72%;height:7px;margin-top:7px;border-radius:5px;background:#94a3b8;animation:ccPulse 1s infinite}#cc-minimize:hover,#cc-pause:hover{filter:brightness(1.12)}</style><div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><b>CodeCrafter Bot v${EXTENSION_VERSION}</b><button id="cc-minimize" aria-label="Minimize bot panel" title="Minimize" style="width:28px;height:28px;border:1px solid #475569;border-radius:7px;background:#1e293b;color:#fff;font-size:18px;line-height:1;cursor:pointer;transition:filter .15s">−</button></div><div id="cc-panel-body"><div id="cc-status" data-state="loading" style="margin:9px 0">Connecting to Python...</div><button id="cc-pause" style="width:100%;padding:10px;border:0;border-radius:8px;background:#f59e0b;font-weight:700;cursor:pointer;transition:filter .15s">Pause bot</button></div>`
    document.documentElement.appendChild(box)
    CodeCrafterSettings.load().then(({ui}) => {
      if (!ui.showOverlay) box.style.display = 'none'
      if (ui.compactOverlay) Object.assign(box.style, {width: '205px', padding: '8px', fontSize: '12px'})
    })
    const button = box.querySelector('#cc-pause')
    button.onmouseenter = () => (button.style.filter = 'brightness(1.12)')
    button.onmouseleave = () => (button.style.filter = 'none')
    button.onclick = () => {
      paused = !paused
      button.textContent = paused ? 'Resume bot' : 'Pause bot'
      button.style.background = paused ? '#22c55e' : '#f59e0b'
      status(paused ? 'Paused — nothing will submit' : 'Running')
    }
    const minimize = box.querySelector('#cc-minimize')
    const body = box.querySelector('#cc-panel-body')
    const applyMinimized = (minimized) => {
      body.style.display = minimized ? 'none' : 'block'
      minimize.textContent = minimized ? '+' : '−'
      minimize.setAttribute('aria-label', minimized ? 'Expand bot panel' : 'Minimize bot panel')
      minimize.title = minimized ? 'Expand' : 'Minimize'
      Object.assign(box.style, minimized
        ? {width: '250px', padding: '9px 11px'}
        : {width: '250px', padding: '14px'})
      sessionStorage.setItem('ccBotPanelMinimized', minimized ? '1' : '0')
    }
    applyMinimized(sessionStorage.getItem('ccBotPanelMinimized') === '1')
    minimize.onclick = () => applyMinimized(body.style.display !== 'none')
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
        alreadyCommented: hasOwnComment(node),
        mediaUrls: [...node.querySelectorAll('img,video')]
          .filter((element) => element.tagName === 'VIDEO' || element.naturalWidth >= 180)
          .map((element) => element.currentSrc || element.src || element.poster || '')
          .filter(Boolean).slice(0, 3),
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
          actionId: `linkedin:like:${action.key}`,
          reason: reacted
            ? 'LinkedIn confirmed like'
            : 'like state did not change',
        })
      }
    }
    if (!action.comment) {
      if (action.connect) await queueProfileConnection(action.authorUrl)
      return
    }
    findControl(/^Comment(?:\s|$)/i, node)?.click()
    await expandComments(node)
    if (hasOwnComment(node)) {
      status('Blank state - an existing comment by this account is already visible', 'blank')
      return api('/result', 'POST', {
        ok: false,
        kind: 'comment',
        reason: 'duplicate prevented: this account already commented on the post',
      })
    }
    if (hasExactComment(node, action.comment)) {
      status('Blank state - this exact comment is already posted', 'blank')
      return api('/result', 'POST', {
        ok: false,
        kind: 'comment',
        reason: 'duplicate prevented: exact comment is already visible',
      })
    }
    const editor = await waitForVisible([
      "div[contenteditable='true'][role='textbox']",
      'textarea.comments-comment-box-comment__text-editor',
    ], 10000, node)
    if (!editor)
      return api('/result', 'POST', {
        ok: false,
        reason: 'comment editor not found',
      })
    if (!setEditorText(editor, action.comment))
      return api('/result', 'POST', {
        ok: false,
        kind: 'comment',
        reason: 'LinkedIn comment editor did not retain the draft text',
      })
    if (!(await countdown('Comment'))) return
    await expandComments(node)
    if (hasExactComment(node, action.comment)) {
      editor.textContent = ''
      editor.dispatchEvent(new Event('input', {bubbles: true}))
      return api('/result', 'POST', {
        ok: false,
        kind: 'comment',
        reason: 'duplicate prevented during final pre-submit check',
      })
    }
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
    const confirmation = await waitForExactComment(node, action.comment)
    status(
      confirmation.ok ? 'Running - exact comment confirmed' : 'Comment submission could not be confirmed',
      confirmation.ok ? 'success' : 'failure',
    )
    await api('/result', 'POST', {
      ok: confirmation.ok,
      kind: 'comment',
      actionId: `linkedin:comment:${action.key}:${normalizeText(action.comment).slice(0, 160)}`,
      reason: confirmation.reason,
    })
    if (confirmation.ok && action.connect) await queueProfileConnection(action.authorUrl)
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
      if (!setEditorText(editor, response.data.message)) {
        const reason = 'Accepted-connection message editor did not retain the draft'
        await api('/result', 'POST', {ok: false, kind: 'message', url: task.url, reason})
        await finishProfileTask(task, 'retry', reason)
        return
      }
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
      const confirmed = await waitForExactOutgoingMessage(response.data.message)
      await api('/result', 'POST', {
        ok: confirmed,
        kind: confirmed ? 'message' : undefined,
        actionId: `linkedin:message:${task.url}:${normalizeText(response.data.message).slice(0, 160)}`,
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
      const deadline = Date.now() + 5000
      while (!connect && Date.now() < deadline) {
        connect = findConnectControl()
        if (!connect) await sleep(250)
      }
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
    let dialog = await waitForVisible(["div[role='dialog']"], 6000)
    if (!dialog) {
      const confirmation = await waitForConnectionConfirmation(null, 4000)
      await api('/result', 'POST', {
        ok: confirmation.ok,
        kind: confirmation.ok ? 'connection' : undefined,
        actionId: `linkedin:connection:${task.url}`,
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
    if (addNote) {
      await sleep(800)
      dialog = [...document.querySelectorAll("div[role='dialog']")].filter(visible).at(-1) || dialog
    }
    const input = await waitForVisible([
      'textarea',
      "div[contenteditable='true'][role='textbox']",
      "input[name='message']",
    ], 5000, dialog)
    if (addNote && !input) {
      dialog = [...document.querySelectorAll("div[role='dialog']")].filter(visible).at(-1) || dialog
      const sendWithoutNote = findControl(/^Send without a note$/i, dialog)
      if (!sendWithoutNote) {
        const reason = `Connection note editor did not appear; controls=${controlDiagnostics(dialog)}`
        await api('/result', 'POST', { ok: false, kind: 'connection', reason })
        await finishProfileTask(task, 'retry', reason)
        return
      }
    }
    if (input) {
      const note = response.data.message.slice(0, 300)
      if (!setEditorText(input, note)) {
        const reason = 'Connection note editor did not retain the draft'
        await api('/result', 'POST', {ok: false, kind: 'connection', reason})
        await finishProfileTask(task, 'retry', reason)
        return
      }
    }
    if (!(await countdown('Connection request'))) return
    status('Connection timer complete - locating the live Send button', 'loading')
    let send = null
    const sendDeadline = Date.now() + 5000
    while (!send && Date.now() < sendDeadline) {
      dialog = [...document.querySelectorAll("div[role='dialog']")].filter(visible).at(-1) || dialog
      send = findControl(/^(Send|Send invitation|Send now|Send without a note)$/i, dialog) ||
        findControl(/^(Send|Send invitation|Send now|Send without a note)$/i)
      if (!send || send.disabled) {
        send = null
        await sleep(200)
      }
    }
    if (!send || send.disabled) {
      status('Failure - LinkedIn did not expose an enabled invitation Send button', 'failure')
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
      actionId: `linkedin:connection:${task.url}`,
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
    const priorityScan = new URLSearchParams(location.search).has('cc_priority')
    status(priorityScan ? 'Priority alert - scanning new notifications' : 'Daily follow-up - scanning notification replies', 'loading')
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
      if (!/(?:(?:replied|responded) to your (?:comment|reply)|mentioned you in a comment|commented on your (?:post|activity)|commented on a post you)/i.test(notificationText)) continue
      const link = [...node.querySelectorAll('a[href]')].find((anchor) =>
        /\/feed\/update\/|\/posts\/|commentUrn=/i.test(anchor.href),
      )
      if (!link) continue
      const id = `${link.href}|${notificationText.slice(0, 600)}`
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
    await chrome.runtime.sendMessage({
      type: priorityScan ? 'finishLinkedInPriorityScan' : 'closeAutomationTab',
    })
  }

  async function checkNotificationPriority() {
    if (priorityRequested || location.pathname.startsWith('/notifications')) return
    const notificationLink = [...document.querySelectorAll("a[href*='/notifications']")]
      .filter(visible)
      .find((link) => {
        const content = `${label(link)} ${link.innerText || ''}`
        const badge = link.querySelector(
          "[data-test-icon*='notification'],.notification-badge,[aria-label*='new notification' i]",
        )
        return Boolean(badge || /\b[1-9]\d*\s+(?:new\s+)?notifications?\b/i.test(content))
      })
    if (!notificationLink) return
    priorityRequested = true
    const response = await chrome.runtime.sendMessage({type: 'triggerLinkedInPriority'})
    if (!response?.ok) priorityRequested = false
  }
  async function handleNotificationReply(task) {
    status('Daily follow-up - opening a reply thread', 'loading')
    await waitForVisible(['main'], 15000)
    await sleep(1800)
    const normalized = (task.notificationText || '').replace(/\s+/g, ' ').trim()
      .replace(/^Unread notification\.\s*/i, '')
    const actor = normalized.match(/^(.{1,100}?)\s+(?:replied|responded|mentioned|commented)/i)?.[1]?.trim()
    if (!commentRoots(document).length) {
      findControl(/^Comment(?:\s|$)|Show comments/i)?.click()
      await waitForVisible([
        '.comments-comment-item',
        "[data-view-name='comment-item']",
        "[data-urn*='comment']",
      ], 12000)
    }
    await expandComments(document)
    const threadComments = commentRoots(document)
    const highlighted = threadComments.find((root) =>
      root.matches(".comments-comment-item--highlighted,[data-highlighted='true']") &&
      findControl(/^Reply$/i, root),
    )
    const target = (actor
      ? [...threadComments].reverse().find((root) =>
          (root.innerText || '').toLowerCase().includes(actor.toLowerCase()) &&
          findControl(/^Reply$/i, root),
        )
      : null) || highlighted || [...threadComments].reverse().find((root) => findControl(/^Reply$/i, root))
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
      context: `${task.notificationText || ''}\n${normalizeText(target.innerText)}`.slice(-10000),
    })
    if (!response?.ok || !response.data.allowed || !response.data.reply) {
      const reason = `Notification reply skipped: ${response?.data?.reason || 'draft failed'}`
      await api('/result', 'POST', { ok: false, reason })
      await finishNotificationTask(task, 'done', reason)
      return
    }
    if (hasExactComment(document, response.data.reply)) {
      await finishNotificationTask(task, 'done', 'duplicate reply already visible')
      return status('Blank state - this reply is already posted', 'blank')
    }
    replyButton.click()
    const replyEditorSelectors = [
      "div[contenteditable='true'][role='textbox'][aria-label*='reply' i]",
      "div[contenteditable='true'][role='textbox'][data-placeholder*='reply' i]",
      "textarea[placeholder*='reply' i]",
      "textarea[aria-label*='reply' i]",
    ]
    const editor = await waitForVisible(replyEditorSelectors, 8000, target) ||
      await waitForVisible(replyEditorSelectors, 4000)
    if (!editor) {
      const reason = 'Notification reply editor did not appear'
      await api('/result', 'POST', { ok: false, reason })
      await finishNotificationTask(task, 'retry', reason)
      return
    }
    if (!setEditorText(editor, response.data.reply)) {
      const reason = 'Notification reply editor did not retain the draft text'
      await api('/result', 'POST', {ok: false, reason})
      await finishNotificationTask(task, 'retry', reason)
      return
    }
    if (!(await countdown('Comment reply'))) return
    await expandComments(document)
    if (hasExactComment(document, response.data.reply)) {
      await finishNotificationTask(task, 'done', 'duplicate reply appeared before submit')
      return status('Blank state - duplicate notification reply prevented', 'blank')
    }
    const replyRoot = editor.closest('form') || target
    const submit = findControl(/^(Reply|Comment|Send)$/i, replyRoot)
    if (!submit || submit.disabled) {
      const reason = `Notification reply submit unavailable; controls=${controlDiagnostics(replyRoot)}`
      await api('/result', 'POST', { ok: false, reason })
      await finishNotificationTask(task, 'retry', reason)
      return
    }
    submit.click()
    const confirmation = await waitForExactComment(document, response.data.reply)
    await api('/result', 'POST', {
      ok: confirmation.ok,
      kind: confirmation.ok ? 'notification_reply' : undefined,
      actionId: `linkedin:notification_reply:${task.id}:${normalizeText(response.data.reply).slice(0, 160)}`,
      notificationId: task.id,
      reason: confirmation.reason,
    })
    status(
      confirmation.ok ? 'Comment reply confirmed' : 'Comment reply was not confirmed',
      confirmation.ok ? 'success' : 'failure',
    )
    await finishNotificationTask(
      task,
      confirmation.ok ? 'done' : 'retry',
      confirmation.ok ? '' : confirmation.reason,
    )
  }

  async function handleIncomingInvitations() {
    status('Loading incoming invitations', 'loading')
    await waitForVisible(['main'], 12000)
    const attempted = new Set()
    const availableAccepts = () => controls(document).filter((control) =>
      visible(control) && /^(Accept(?:\s|$)|Accept .+ invitation)/i.test(label(control)),
    )
    const invitationKey = (control) => normalizeText(
      (control.closest('li,article,[role=listitem]') || control.parentElement)?.innerText,
    ).slice(0, 500) || label(control)
    if (!availableAccepts().length) {
      status('Blank state - no incoming invitations', 'blank')
      if (new URLSearchParams(location.search).has('cc_auto_invites'))
        await chrome.runtime.sendMessage({type: 'closeAutomationTab'})
      return
    }
    while (true) {
      const accept = availableAccepts().find((control) => !attempted.has(invitationKey(control)))
      if (!accept) break
      const card = accept.closest('li,article,[role=listitem]') || accept.parentElement
      const invitationLabel = label(accept)
      attempted.add(invitationKey(accept))
      const acceptsBefore = availableAccepts().length
      const name = invitationLabel
        .replace(/^(?:Accept\s+)+/i, '')
        .replace(/(?:[’']s)?\s+invitation.*$/i, '')
        .trim() || normalizeText(card?.innerText).replace(/\s+wants to connect.*$/i, '')
      card?.scrollIntoView({block: 'center'})
      if (!(await countdown(`Accept ${name || 'invitation'}`))) return
      status(`Accept timer complete - rechecking ${name || 'invitation'}`, 'loading')
      const liveAccept = availableAccepts().find((control) =>
        visible(control) && label(control) === invitationLabel,
      ) || availableAccepts().find((control) =>
        visible(control) && name && label(control).replace(/^(?:Accept\s+)+/i, '')
          .toLocaleLowerCase().startsWith(name.toLocaleLowerCase()),
      )
      if (!liveAccept || liveAccept.disabled) {
        const reason = `LinkedIn replaced the Accept button and no enabled replacement was found for ${name || 'the invitation'}`
        status(`Failure - ${reason}`, 'failure')
        await api('/result', 'POST', {ok: false, kind: 'connection_accept', reason})
        break
      }
      liveAccept.click()
      const deadline = Date.now() + 12000
      let confirmed = false
      let reason = 'LinkedIn did not confirm the invitation acceptance'
      while (Date.now() < deadline) {
        const feedback = feedbackText()
        if (/invitation accepted|you are now connected|connection accepted/i.test(feedback)) {
          confirmed = true
          reason = `LinkedIn confirmed invitation accepted${name ? ` for ${name}` : ''}`
          break
        }
        const sameInvitation = controls(document).some((control) => label(control) === invitationLabel)
        const acceptsAfter = availableAccepts().length
        if (!sameInvitation && acceptsAfter < acceptsBefore) {
          confirmed = true
          reason = `LinkedIn removed the accepted invitation${name ? ` for ${name}` : ''}`
          break
        }
        const blocked = blockingFeedback()
        if (blocked) { reason = blocked; break }
        await sleep(300)
      }
      await api('/result', 'POST', {
        ok: confirmed,
        kind: confirmed ? 'connection_accept' : undefined,
        actionId: `linkedin:connection_accept:${normalizeText(name || invitationLabel)}`,
        reason,
      })
      status(confirmed ? `Success - accepted ${name}` : `Failure - ${reason}`, confirmed ? 'success' : 'failure')
      if (!confirmed) break
      await sleep(1000)
    }
    if (new URLSearchParams(location.search).has('cc_auto_invites'))
      await chrome.runtime.sendMessage({type: 'closeAutomationTab'})
  }
  async function maybeRunDailyFollowups(config) {
    if (!config.notificationReplies && !config.messages && !config.incomingInvites) return
    const now = new Date()
    const localDay = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')].join('-')
    if (dailyFollowupCheckedDay === localDay) return
    const response = await api('/daily-followups', 'POST', {})
    if (!response?.ok) return
    dailyFollowupCheckedDay = localDay
    if (!response.data.due) return
    const pendingConnections = response.data.pendingConnections || []
    if (config.messages && pendingConnections.length) {
      await chrome.runtime.sendMessage({
        type: 'openProfiles',
        mode: 'acceptedCheck',
        urls: pendingConnections,
      })
    }
    if (config.notificationReplies)
      await chrome.runtime.sendMessage({ type: 'openDailyNotifications' })
    if (config.incomingInvites)
      await chrome.runtime.sendMessage({ type: 'openIncomingInvitations' })
    status(
      `Daily follow-up started - ${pendingConnections.length} pending connections to check`,
    )
  }
  async function cycle() {
    panel()
    if (busy || paused || !location.pathname.startsWith('/feed')) return
    busy = true
    try {
      const settings = await CodeCrafterSettings.load()
      const config = settings.platforms.linkedin
      if (!config.enabled) return status('Blank state - LinkedIn automation disabled', 'blank')
      const foundPosts = posts()
      await maybeRunDailyFollowups(config)
      const response = await api('/cycle', 'POST', {
        posts: foundPosts,
        topics: config.topics,
        features: {
          likes: config.likes,
          comments: config.comments,
          connections: config.connections,
          imageRecognition: config.imageRecognition,
        },
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
    if (location.pathname.startsWith('/messaging')) return
    panel()
    const settings = await CodeCrafterSettings.load()
    if (!settings.platforms.linkedin.enabled)
      return status('Blank state - LinkedIn automation disabled', 'blank')
    const notificationTask = await chrome.runtime.sendMessage({ type: 'getNotificationTask' })
    if (notificationTask?.task && settings.platforms.linkedin.notificationReplies)
      return handleNotificationReply(notificationTask.task)
    if (location.pathname.startsWith('/notifications')) {
      if (!settings.platforms.linkedin.notificationReplies)
        return status('Blank state - notification replies disabled', 'blank')
      return handleNotificationsPage()
    }
    if (location.pathname.startsWith('/mynetwork/invitation-manager/received')) {
      if (!settings.platforms.linkedin.incomingInvites)
        return status('Blank state - incoming invitation acceptance disabled', 'blank')
      return handleIncomingInvitations()
    }
    if (location.pathname.startsWith('/in/')) return handleProfileConnection()
    if (location.pathname.startsWith('/feed')) {
      setInterval(cycle, 12000)
      if (settings.platforms.linkedin.notificationInterrupts) {
        setInterval(checkNotificationPriority, 3000)
        checkNotificationPriority()
      }
      cycle()
    }
  }
  start().catch((error) => {
    status(`Automation failed - ${String(error).slice(0, 180)}`, 'failure')
  })
})()
