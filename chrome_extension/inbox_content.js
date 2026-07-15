;(() => {
  const host = location.hostname
  const platform = host.includes('linkedin') ? 'linkedin' : host.includes('instagram') ? 'instagram' : host.includes('facebook') ? 'facebook' : ''
  const onInbox = (platform === 'linkedin' && location.pathname.startsWith('/messaging')) ||
    (platform === 'instagram' && location.pathname.startsWith('/direct')) ||
    (platform === 'facebook' && location.pathname.startsWith('/messages'))
  if (!platform || !onInbox || window.__codeCrafterInboxBridge) return
  window.__codeCrafterInboxBridge = true
  const EXTENSION_VERSION = '3.15.3'
  const EXTENSION_BUILD = '55292288fa00'
  const processed = new Set()
  let busy = false
  let emptyScans = 0
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const api = (path, method = 'GET', body = null) => chrome.runtime.sendMessage({type: 'localApi', path, method, body})
  const visible = (element) => element && element.offsetParent !== null
  const text = (element) => (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim()
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim()
  const editorText = (input) => normalize(
    input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement
      ? input.value : input?.textContent,
  )

  function panel() {
    if (document.getElementById('cc-inbox-controls')) return
    const box = document.createElement('div'); box.id = 'cc-inbox-controls'
    box.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;width:270px;padding:14px;border-radius:12px;background:#111827;color:white;font:14px Arial;box-shadow:0 8px 30px #0006'
    box.innerHTML = `<style>@keyframes ccInboxPulse{50%{opacity:.35}}</style><b>CodeCrafter Inbox v${EXTENSION_VERSION}</b><div id="cc-inbox-status" style="margin:9px 0">Loading inbox…</div><div id="cc-inbox-skeleton" style="height:8px;width:72%;border-radius:8px;background:#475569;animation:ccInboxPulse 1s infinite"></div>`
    document.documentElement.appendChild(box)
    CodeCrafterSettings.load().then(({ui}) => {
      if (!ui.showOverlay) box.style.display = 'none'
      if (ui.compactOverlay) Object.assign(box.style, {width: '205px', padding: '8px', fontSize: '12px'})
    })
  }
  function status(message, phase = 'filled') {
    panel()
    const node = document.getElementById('cc-inbox-status')
    node.textContent = message
    node.dataset.phase = phase
    document.getElementById('cc-inbox-skeleton').style.display = phase === 'loading' ? 'block' : 'none'
  }
  function conversationRows() {
    if (platform === 'linkedin')
      return [...document.querySelectorAll('li.msg-conversation-listitem')].filter(visible)
    return [...document.querySelectorAll("[role='row'],[role='listitem'],li")].filter(visible)
  }
  function conversationKey(row) {
    const anchor = row.querySelector('a[href]')
    return `${anchor?.href || row.id || ''}|${text(row).slice(0, 500)}`
  }
  function isUnreadConversation(row) {
    const content = `${row.className || ''} ${text(row)} ${row.getAttribute('aria-label') || ''}`
    return /unread|\b[1-9]\d* new notifications?\b/i.test(content) || Boolean(row.querySelector(
      "[aria-label*='unread' i],[aria-label*='new notification' i],[class*='unread'],[data-testid*='unread' i]",
    ))
  }
  function unreadConversation() {
    return conversationRows().find((row) => isUnreadConversation(row) && !processed.has(conversationKey(row)))
  }
  function conversationContact(conversation) {
    const labelled = conversation.querySelector("[data-testid*='title' i],[class*='title' i],img[alt],[dir='auto']")
    const labelledText = labelled?.tagName === 'IMG' ? String(labelled.alt || '').trim() : text(labelled)
    if (labelledText && !/^(unread|new message)$/i.test(labelledText)) return labelledText
    const ignored = /^(unread|new message|today|yesterday|\d{1,2}:\d{2}(?:\s*[ap]m)?)$/i
    return String(conversation.innerText || '').split(/\r?\n/).map((line) => line.trim())
      .find((line) => line && !ignored.test(line)) || ''
  }
  function conversationIsGroup() {
    if (platform === 'linkedin') {
      const title = text(document.querySelector('.msg-thread__link-to-profile,[class*=conversation-title]'))
      return /,| and /i.test(title)
    }
    const header = [...document.querySelectorAll('header,[role=banner]')].filter(visible).at(-1)
    return Boolean(header?.querySelector("[data-icon*='group' i],[data-testid*='group' i],[aria-label*='group' i]"))
  }
  function editor() {
    return [...document.querySelectorAll("textarea,[contenteditable='true'][role='textbox']")]
      .filter(visible).find((node) => !/search/i.test(node.getAttribute('aria-label') || node.getAttribute('placeholder') || ''))
  }
  function linkedInEvents() {
    return [...document.querySelectorAll('li.msg-s-message-list__event')].filter(visible)
  }
  function conversationContext() {
    if (platform !== 'linkedin') return text(document.querySelector('main') || document.body).slice(-6000)
    return linkedInEvents().slice(-20).map((event) => text(event)).join('\n').slice(-9000)
  }
  function latestIsInbound() {
    if (platform !== 'linkedin') return true
    const content = text(linkedInEvents().at(-1))
    return Boolean(content) && !/^Moshe Schwartzberg sent the following message/i.test(content) &&
      !/^Moshe Schwartzberg\s+\d{1,2}:\d{2}/i.test(content)
  }
  async function openConversation(row) {
    const target = row.querySelector(
      ".msg-conversation-listitem__link,[href*='/messaging/thread/'],[tabindex='0']",
    ) || row
    const beforeActive = document.querySelector('.msg-conversation-listitem__link--active')
    const beforeEvents = linkedInEvents().map((event) => text(event)).join('|')
    if (beforeActive === target && beforeEvents && editor()) return true
    target.scrollIntoView({block: 'center'})
    target.focus()
    target.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, pointerType: 'mouse'}))
    target.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, buttons: 1}))
    target.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, buttons: 0}))
    target.click()
    const deadline = Date.now() + 12000
    while (Date.now() < deadline) {
      const currentActive = document.querySelector('.msg-conversation-listitem__link--active')
      const active = target.classList.contains('msg-conversations-container__convo-item-link--active') ||
        currentActive === target || /active conversation/i.test(text(row))
      const currentEvents = linkedInEvents().map((event) => text(event)).join('|')
      if (active && currentActive !== beforeActive && currentEvents && currentEvents !== beforeEvents && editor())
        return true
      await sleep(250)
    }
    target.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true}))
    target.dispatchEvent(new KeyboardEvent('keyup', {key: 'Enter', code: 'Enter', bubbles: true}))
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(250)
      const currentEvents = linkedInEvents().map((event) => text(event)).join('|')
      if (currentEvents && currentEvents !== beforeEvents && editor()) return true
    }
    return false
  }
  function setEditorText(input, value) {
    input.focus()
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value)
    } else {
      input.textContent = ''
      document.execCommand('insertText', false, value)
    }
    input.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: value}))
    input.dispatchEvent(new Event('change', {bubbles: true}))
    return editorText(input) === normalize(value)
  }
  function exactOutgoingMessage(value) {
    const wanted = normalize(value)
    if (!wanted) return false
    if (platform === 'linkedin') return linkedInEvents().some((event) => {
      const content = text(event)
      return /Moshe Schwartzberg sent the following message/i.test(content) && content.includes(wanted)
    })
    return [...document.querySelectorAll("[class*='message-out'],[data-testid*='outgoing']")]
      .filter(visible).some((message) => text(message).includes(wanted))
  }
  async function waitForExactOutgoing(value, timeout = 12000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (exactOutgoingMessage(value)) return true
      const feedback = text(document.querySelector("[role='alert'],.artdeco-toast-item"))
      if (/couldn.?t send|failed|try again|something went wrong/i.test(feedback)) return false
      await sleep(250)
    }
    return false
  }
  async function countdown() {
    for (let left = 10000; left > 0; left -= 100) {
      status(`Inbox reply sends in ${(left / 1000).toFixed(1)}s`)
      await sleep(100)
    }
  }
  async function cycle() {
    if (busy) return
    busy = true
    try {
      const settings = await CodeCrafterSettings.load()
      const config = settings.platforms[platform]
      if (!config.enabled || !config.messages) {
        status('Blank state - inbox replies disabled', 'blank')
        return
      }
      const conversation = unreadConversation()
      if (!conversation) {
        emptyScans += 1
        status('Blank state - no unread conversations', 'blank')
        if (emptyScans >= 3 && new URLSearchParams(location.search).has('cc_auto_messages'))
          await chrome.runtime.sendMessage({type: 'closeAutomationTab'})
        return
      }
      emptyScans = 0
      const key = conversationKey(conversation)
      const contact = conversationContact(conversation)
      status(`Opening unread conversation with ${contact || 'contact'}…`, 'loading')
      if (!(await openConversation(conversation))) {
        processed.add(key)
        status('Failure - conversation did not open or finish loading', 'failure')
        return
      }
      const isGroup = conversationIsGroup()
      const policy = CodeCrafterSettings.replyDecision(settings, contact, isGroup)
      if (!policy.allowed) {
        processed.add(key)
        status(`Blank state - ${policy.reason}`, 'blank')
        return
      }
      if (!latestIsInbound()) {
        processed.add(key)
        status('Blank state - latest message is not inbound', 'blank')
        return
      }
      const draft = await api('/draft-inbox-reply', 'POST', {
        site: platform,
        context: conversationContext(),
        writingStyle: settings.writingStyle,
        safeguards: settings.replySafeguards,
        contact,
        isGroup,
      })
      if (!draft?.ok || !draft.data.allowed || !draft.data.message) {
        processed.add(key)
        status(`Blank state - ${draft?.data?.reason || 'no safe reply'}`, 'blank')
        return
      }
      if (exactOutgoingMessage(draft.data.message)) {
        processed.add(key)
        status('Blank state - exact reply already exists', 'blank')
        return
      }
      const input = editor()
      if (!input) return status('Failure - message editor not found', 'failure')
      if (!setEditorText(input, draft.data.message))
        return status('Failure - message editor did not retain the draft', 'failure')
      await countdown()
      if (exactOutgoingMessage(draft.data.message)) {
        processed.add(key)
        status('Blank state - duplicate reply prevented', 'blank')
        return
      }
      const root = input.closest('form,[role=dialog]') || document
      const send = [...root.querySelectorAll("button,[role='button']")].filter(visible)
        .find((node) => /^(Send|Send message)$/i.test(text(node)) || /^Send/i.test(node.getAttribute('aria-label') || ''))
      if (!send || send.disabled) return status('Failure - enabled Send button not found', 'failure')
      send.click()
      const confirmed = await waitForExactOutgoing(draft.data.message)
      if (confirmed) processed.add(key)
      await api('/result', 'POST', {
        ok: confirmed,
        kind: confirmed ? 'inbox_reply' : undefined,
        site: platform,
        reason: confirmed ? `${platform} displayed the exact outgoing reply` : `${platform} did not display the exact outgoing reply`,
      })
      status(confirmed ? 'Success - inbox reply sent' : 'Failure - reply not confirmed', confirmed ? 'success' : 'failure')
    } catch (error) {
      status(`Failure - ${String(error).slice(0, 150)}`, 'failure')
    } finally {
      busy = false
    }
  }
  panel()
  setInterval(cycle, 5000)
  cycle()
})()
