;(() => {
  const host = location.hostname
  const platform = host.includes('linkedin') ? 'linkedin' : host.includes('instagram') ? 'instagram' : host.includes('facebook') ? 'facebook' : ''
  const onInbox = (platform === 'linkedin' && location.pathname.startsWith('/messaging')) ||
    (platform === 'instagram' && location.pathname.startsWith('/direct')) ||
    (platform === 'facebook' && location.pathname.startsWith('/messages'))
  if (!platform || !onInbox || window.__codeCrafterInboxBridge) return
  window.__codeCrafterInboxBridge = true

  const EXTENSION_VERSION = '3.20.14'
  const EXTENSION_BUILD = 'inbox-reliable-20260830'
  const SCAN_INTERVAL_MS = 2000
  const SEND_COUNTDOWN_MS = 2500
  const processed = new Set()
  let busy = false
  let lastFailure = ''

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const api = (path, method = 'GET', body = null) => {
    if (!chrome.runtime?.id) throw new Error('extension was reloaded; refresh this inbox page')
    return chrome.runtime.sendMessage({type: 'localApi', path, method, body})
  }
  const visible = (element) => Boolean(element && element.isConnected && element.offsetParent !== null)
  const text = (element) => (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim()
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim()
  const unique = (items) => [...new Set(items.filter(Boolean))]
  const fingerprint = (value) => {
    let hash = 2166136261
    for (const character of String(value || '').normalize('NFKC')) {
      hash ^= character.charCodeAt(0)
      hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
  }

  function panel() {
    if (document.getElementById('cc-inbox-controls')) return
    const box = document.createElement('div')
    box.id = 'cc-inbox-controls'
    box.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;width:285px;padding:14px;border-radius:12px;background:#111827;color:white;font:14px Arial;box-shadow:0 8px 30px #0006'
    box.innerHTML = `<style>@keyframes ccInboxPulse{50%{opacity:.35}}</style><b>CodeCrafter Inbox v${EXTENSION_VERSION}</b><div id="cc-inbox-status" style="margin:9px 0">Starting persistent inbox watcher...</div><div id="cc-inbox-skeleton" style="height:8px;width:72%;border-radius:8px;background:#475569;animation:ccInboxPulse 1s infinite"></div><div id="cc-inbox-debug" style="display:none;margin-top:8px;color:#cbd5e1;font-size:11px"></div>`
    document.documentElement.appendChild(box)
    CodeCrafterSettings.load().then(({ui}) => {
      if (!ui.showOverlay) box.style.display = 'none'
      if (ui.compactOverlay) Object.assign(box.style, {width: '215px', padding: '8px', fontSize: '12px'})
    }).catch(() => {})
  }

  function status(message, phase = 'filled', debug = '') {
    panel()
    const node = document.getElementById('cc-inbox-status')
    if (node) {
      node.textContent = message
      node.dataset.phase = phase
    }
    const skeleton = document.getElementById('cc-inbox-skeleton')
    if (skeleton) skeleton.style.display = phase === 'loading' ? 'block' : 'none'
    const debugNode = document.getElementById('cc-inbox-debug')
    if (debugNode) {
      debugNode.textContent = debug || lastFailure
      debugNode.style.display = debugNode.textContent ? 'block' : 'none'
    }
  }

  function linkedInConversationRows() {
    const directRows = [
      ...document.querySelectorAll('li.msg-conversation-listitem'),
      ...document.querySelectorAll('.msg-conversations-container__convo-item'),
      ...document.querySelectorAll("[data-view-name='message-list-item']"),
      ...document.querySelectorAll("[data-testid*='conversation-list-item' i]"),
    ]
    const anchorRows = [...document.querySelectorAll("a[href*='/messaging/thread/']")]
      .map((anchor) => anchor.closest("li,[role='listitem'],[data-view-name='message-list-item'],div"))
    return unique([...directRows, ...anchorRows]).filter((row) =>
      visible(row) && (row.querySelector("a[href*='/messaging/thread/']") || /msg-conversation/i.test(String(row.className || ''))),
    )
  }

  function conversationRows() {
    if (platform === 'linkedin') return linkedInConversationRows()
    return [...document.querySelectorAll("[role='row'],[role='listitem'],li")].filter(visible)
  }

  function conversationHref(row) {
    const anchor = row?.querySelector?.("a[href*='/messaging/thread/'],a[href]")
    return anchor?.href || ''
  }

  function rowIsSelected(row) {
    if (!row) return false
    const selected = row.matches?.("[aria-selected='true'],.msg-conversation-listitem--active") ||
      row.querySelector?.("[aria-current='page'],[aria-selected='true'],.msg-conversation-listitem__link--active,.msg-conversations-container__convo-item-link--active")
    if (selected) return true
    const href = conversationHref(row)
    if (!href) return false
    try {
      const url = new URL(href)
      return location.pathname.startsWith(url.pathname.replace(/\/+$/, ''))
    } catch (_error) {
      return false
    }
  }

  function isUnreadConversation(row) {
    const content = `${row.className || ''} ${text(row)} ${row.getAttribute?.('aria-label') || ''}`
    if (/\bunread\b|\bnew message\b|\b[1-9]\d* new messages?\b/i.test(content)) return true
    if (row.matches?.('.msg-conversation-listitem--unread,[data-unread=true]')) return true
    return Boolean(row.querySelector?.(
      "[aria-label*='unread' i],[aria-label*='new message' i],[class*='unread' i],[data-testid*='unread' i],[data-view-name*='unread' i],.notification-badge",
    ))
  }

  function activeConversation() {
    if (platform !== 'linkedin') return null
    return conversationRows().find(rowIsSelected) || null
  }

  function conversationContact(conversation) {
    if (!conversation) return ''
    const candidates = [
      conversation.querySelector("[data-testid*='title' i]"),
      conversation.querySelector('.msg-conversation-card__participant-names'),
      conversation.querySelector('.msg-conversation-listitem__participant-names'),
      conversation.querySelector("[class*='participant' i]"),
      conversation.querySelector("img[alt]"),
      conversation.querySelector("[dir='auto']"),
    ].filter(Boolean)
    for (const candidate of candidates) {
      const value = candidate.tagName === 'IMG' ? String(candidate.alt || '').trim() : text(candidate)
      if (value && !/^(unread|new message|messages?)$/i.test(value)) return value.slice(0, 300)
    }
    const ignored = /^(unread|new message|today|yesterday|active now|\d{1,2}:\d{2}(?:\s*[ap]m)?)$/i
    return String(conversation.innerText || '').split(/\r?\n/).map((line) => line.trim())
      .find((line) => line && !ignored.test(line))?.slice(0, 300) || ''
  }

  function conversationIsGroup() {
    if (platform === 'linkedin') {
      const title = text(document.querySelector(
        '.msg-thread__link-to-profile,[class*=conversation-title],[data-view-name*=conversation-title],.msg-thread__participants',
      ))
      return /,| and |\b\d+ participants?\b/i.test(title)
    }
    const header = [...document.querySelectorAll('header,[role=banner]')].filter(visible).at(-1)
    return Boolean(header?.querySelector("[data-icon*='group' i],[data-testid*='group' i],[aria-label*='group' i]"))
  }

  function editor() {
    const selectors = platform === 'linkedin'
      ? "div.msg-form__contenteditable[contenteditable='true'],div[contenteditable='true'][role='textbox'][aria-label*='message' i],div[contenteditable='true'][role='textbox'],textarea[placeholder*='message' i],textarea"
      : "textarea,[contenteditable='true'][role='textbox']"
    return [...document.querySelectorAll(selectors)]
      .filter(visible)
      .find((node) => !/search/i.test(node.getAttribute('aria-label') || node.getAttribute('placeholder') || '')) || null
  }

  function threadRoot() {
    if (platform !== 'linkedin') return document.querySelector('main') || document.body
    return document.querySelector(
      '.msg-s-message-list-container,.msg-s-message-list,.msg-thread,[data-view-name*=message-thread],main',
    ) || document.body
  }

  function linkedInEvents() {
    const root = threadRoot()
    const events = [
      ...root.querySelectorAll('li.msg-s-message-list__event'),
      ...root.querySelectorAll('.msg-s-event-listitem'),
      ...root.querySelectorAll("[data-view-name='message']"),
      ...root.querySelectorAll("[data-testid*='message-item' i]"),
    ]
    return unique(events).filter((event) => visible(event) && text(event))
  }

  function eventDirection(event) {
    if (!event) return ''
    const content = text(event)
    const labels = [event.getAttribute?.('aria-label') || '', ...[...event.querySelectorAll?.('[aria-label]') || []]
      .slice(0, 8).map((node) => node.getAttribute('aria-label') || '')].join(' ')
    const classText = `${event.className || ''}`
    if (/outbound|message-out|from-me/i.test(classText) || /\b(?:you sent|sent by you|your message)\b/i.test(labels)) return 'OUTBOUND'
    if (/\bMoshe Schwartzberg sent the following message\b/i.test(content) || /^You\b/i.test(content)) return 'OUTBOUND'
    const sender = text(event.querySelector?.(
      ".msg-s-message-group__name,.msg-s-message-list__event-actor,.msg-s-event-listitem__name,[data-view-name='message-sender'],a[href*='/in/']",
    ))
    if (/^(?:Moshe Schwartzberg|You)$/i.test(sender)) return 'OUTBOUND'
    if (/inbound|message-in|from-them/i.test(classText)) return 'INBOUND'
    return 'INBOUND'
  }

  function eventBody(event) {
    if (!event) return ''
    const bodyNode = [
      '.msg-s-event-listitem__body',
      '.msg-s-message-list__event-content',
      '.msg-s-message-list__event-content p',
      "[data-view-name='message-body']",
      "[data-testid*='message-text' i]",
    ].map((selector) => event.querySelector?.(selector)).find(Boolean)
    let value = text(bodyNode || event)
    value = value
      .replace(/^Moshe Schwartzberg sent the following message\s*/i, '')
      .replace(/^You\s*/i, '')
      .replace(/\b(?:Seen|Delivered|Sent)\s*$/i, '')
      .trim()
    if (/^(?:Seen|Delivered|Sent|Today|Yesterday|\d{1,2}:\d{2}(?:\s*[AP]M)?)$/i.test(value)) return ''
    return value
  }

  function linkedInMessages() {
    return linkedInEvents().map((event) => ({
      event,
      direction: eventDirection(event),
      body: eventBody(event),
    })).filter((item) => item.body && item.body.length > 0)
  }

  function conversationContext() {
    if (platform !== 'linkedin') return text(document.querySelector('main') || document.body).slice(-8000)
    return linkedInMessages().slice(-30)
      .map((item) => `${item.direction}: ${item.body}`)
      .join('\n')
      .slice(-10000)
  }

  function latestIsInbound() {
    if (platform !== 'linkedin') return true
    return linkedInMessages().at(-1)?.direction === 'INBOUND'
  }

  function latestInboundBody() {
    if (platform !== 'linkedin') return text(document.querySelector('main') || document.body).slice(-1500)
    const latest = linkedInMessages().at(-1)
    return latest?.direction === 'INBOUND' ? latest.body : ''
  }

  function threadSignature() {
    if (platform !== 'linkedin') return fingerprint(text(document.querySelector('main') || document.body).slice(-3000))
    return fingerprint(linkedInMessages().slice(-8).map((item) => `${item.direction}:${item.body}`).join('|'))
  }

  function conversationKey(row, latestInbound = '') {
    const href = conversationHref(row)
    return `${href || conversationContact(row) || row?.id || 'conversation'}|${fingerprint(latestInbound || text(row).slice(0, 700))}`
  }

  function unreadConversation() {
    return conversationRows().find((row) => isUnreadConversation(row) && !processed.has(conversationKey(row))) || null
  }

  async function openConversation(row) {
    if (!row) return false
    if (rowIsSelected(row) && editor() && linkedInMessages().length) return true
    const target = row.querySelector?.("a[href*='/messaging/thread/'],.msg-conversation-listitem__link,[tabindex='0']") || row
    const beforeUrl = location.href
    const beforeSignature = threadSignature()
    target.scrollIntoView?.({block: 'center'})
    target.focus?.()
    target.dispatchEvent?.(new PointerEvent('pointerdown', {bubbles: true, pointerType: 'mouse'}))
    target.dispatchEvent?.(new MouseEvent('mousedown', {bubbles: true, buttons: 1}))
    target.dispatchEvent?.(new MouseEvent('mouseup', {bubbles: true, buttons: 0}))
    target.click?.()
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const currentSignature = threadSignature()
      if (editor() && linkedInMessages().length && (
        rowIsSelected(row) || location.href !== beforeUrl || currentSignature !== beforeSignature
      )) return true
      await sleep(200)
    }
    target.dispatchEvent?.(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true}))
    target.dispatchEvent?.(new KeyboardEvent('keyup', {key: 'Enter', code: 'Enter', bubbles: true}))
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await sleep(200)
      if (editor() && linkedInMessages().length && threadSignature() !== beforeSignature) return true
    }
    return false
  }

  function editorText(input) {
    return normalize(input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement ? input.value : input?.textContent)
  }

  function setEditorText(input, value) {
    input.focus()
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value)
      input.dispatchEvent(new Event('input', {bubbles: true}))
      input.dispatchEvent(new Event('change', {bubbles: true}))
    } else {
      input.textContent = ''
      document.execCommand('insertText', false, value)
      input.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: value}))
    }
    return editorText(input) === normalize(value)
  }

  function exactOutgoingMessage(value) {
    const wanted = normalize(value)
    if (!wanted) return false
    if (platform === 'linkedin') return linkedInMessages().some((item) =>
      item.direction === 'OUTBOUND' && (normalize(item.body).includes(wanted) || wanted.includes(normalize(item.body))),
    )
    return [...document.querySelectorAll("[class*='message-out'],[data-testid*='outgoing']")]
      .filter(visible).some((message) => text(message).includes(wanted))
  }

  async function waitForExactOutgoing(value, previousSignature, timeout = 10000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (exactOutgoingMessage(value)) return true
      const input = editor()
      const newest = platform === 'linkedin' ? linkedInMessages().at(-1) : null
      if (platform === 'linkedin' && newest?.direction === 'OUTBOUND' && threadSignature() !== previousSignature && !editorText(input)) {
        const wanted = normalize(value).slice(0, 80)
        if (normalize(newest.body).includes(wanted) || wanted.includes(normalize(newest.body).slice(0, 80))) return true
      }
      const feedback = text(document.querySelector("[role='alert'],.artdeco-toast-item"))
      if (/couldn.?t send|failed|try again|something went wrong/i.test(feedback)) return false
      await sleep(200)
    }
    return false
  }

  async function countdown() {
    const started = Date.now()
    while (Date.now() - started < SEND_COUNTDOWN_MS) {
      const left = Math.max(0, SEND_COUNTDOWN_MS - (Date.now() - started))
      status(`Reply ready. Sending in ${(left / 1000).toFixed(1)}s`, 'filled')
      await sleep(100)
    }
  }

  function sendButton(input) {
    const roots = unique([
      input?.closest?.('form'),
      input?.closest?.("[role='dialog']"),
      input?.closest?.('.msg-form'),
      document,
    ])
    for (const root of roots) {
      const direct = root.querySelector?.("button.msg-form__send-button,button[type='submit'][aria-label*='send' i],button[aria-label='Send'],button[aria-label*='send message' i]")
      if (visible(direct) && !direct.disabled && direct.getAttribute('aria-disabled') !== 'true') return direct
      const candidate = [...root.querySelectorAll?.("button,[role='button']") || []]
        .filter(visible)
        .find((node) => /^(Send|Send message)$/i.test(text(node)) || /^Send\b/i.test(node.getAttribute('aria-label') || ''))
      if (candidate && !candidate.disabled && candidate.getAttribute('aria-disabled') !== 'true') return candidate
    }
    return null
  }

  async function chooseConversation() {
    const unread = unreadConversation()
    if (unread) return {conversation: unread, alreadyOpen: rowIsSelected(unread)}
    if (platform === 'linkedin' && latestIsInbound() && editor()) {
      const active = activeConversation()
      if (active) return {conversation: active, alreadyOpen: true}
    }
    return {conversation: null, alreadyOpen: false}
  }

  async function cycle() {
    if (busy) return
    busy = true
    try {
      const settings = await CodeCrafterSettings.load()
      const config = settings.platforms[platform]
      if (!config?.enabled || !config.messages) {
        status('Inbox watcher is running, but replies are disabled in Settings.', 'blank')
        return
      }

      const {conversation, alreadyOpen} = await chooseConversation()
      if (!conversation) {
        lastFailure = ''
        status('Watching for new messages...', 'blank')
        return
      }

      const contactBeforeOpen = conversationContact(conversation)
      status(`${alreadyOpen ? 'Reading' : 'Opening'} ${contactBeforeOpen || platform} conversation...`, 'loading')
      if (!alreadyOpen && !(await openConversation(conversation))) {
        lastFailure = 'LinkedIn did not finish opening the selected conversation. It will retry automatically.'
        status('Conversation did not finish loading. Retrying...', 'failure', lastFailure)
        return
      }

      await sleep(350)
      const context = conversationContext()
      const latestInbound = latestInboundBody()
      const contact = conversationContact(activeConversation() || conversation) || contactBeforeOpen
      const key = conversationKey(activeConversation() || conversation, latestInbound)

      if (!context || !latestInbound || !latestIsInbound()) {
        processed.add(key)
        status('Latest visible message is not inbound. Watching for the next one...', 'blank')
        return
      }
      if (processed.has(key)) {
        status('This inbound message was already handled. Watching for the next one...', 'blank')
        return
      }

      const isGroup = conversationIsGroup()
      const policy = CodeCrafterSettings.replyDecision(settings, contact, isGroup)
      if (!policy.allowed) {
        processed.add(key)
        status(`Reply blocked by Settings: ${policy.reason}`, 'blank')
        return
      }

      status(`Drafting a reply to ${contact || 'the newest message'}...`, 'loading')
      const draft = await api('/draft-inbox-reply', 'POST', {
        site: platform,
        context,
        writingStyle: settings.writingStyle,
        safeguards: settings.replySafeguards,
        contact,
        isGroup,
      })
      if (!draft?.ok || !draft.data?.allowed || !draft.data?.message) {
        lastFailure = draft?.data?.reason || draft?.error || 'reply generation failed'
        status('Could not draft a safe reply. Retrying this message...', 'failure', lastFailure)
        return
      }

      if (exactOutgoingMessage(draft.data.message)) {
        processed.add(key)
        status('That exact reply is already visible. Watching for the next message...', 'blank')
        return
      }

      const input = editor()
      if (!input) {
        lastFailure = 'The message editor was not found. The watcher will retry instead of abandoning the message.'
        status('Message editor not found. Retrying...', 'failure', lastFailure)
        return
      }
      if (!setEditorText(input, draft.data.message)) {
        lastFailure = 'LinkedIn did not retain the drafted text in the message editor.'
        status('Draft did not stay in the editor. Retrying...', 'failure', lastFailure)
        return
      }

      await countdown()
      if (!latestIsInbound()) {
        input.textContent = ''
        input.dispatchEvent(new Event('input', {bubbles: true}))
        status('Conversation changed before send. Rereading it first...', 'blank')
        return
      }
      if (exactOutgoingMessage(draft.data.message)) {
        processed.add(key)
        status('Duplicate reply prevented.', 'blank')
        return
      }

      let send = sendButton(input)
      const sendDeadline = Date.now() + 4000
      while (!send && Date.now() < sendDeadline) {
        await sleep(150)
        send = sendButton(input)
      }
      if (!send) {
        lastFailure = 'An enabled Send button was not found. The watcher will retry this inbound message.'
        status('Send button not ready. Retrying...', 'failure', lastFailure)
        return
      }

      const previousSignature = threadSignature()
      send.click()
      const confirmed = await waitForExactOutgoing(draft.data.message, previousSignature)
      if (!confirmed) {
        lastFailure = 'LinkedIn did not confirm the outgoing message. It will be rechecked before any retry.'
        status('Send was not confirmed. Rechecking conversation...', 'failure', lastFailure)
        return
      }

      processed.add(key)
      lastFailure = ''
      const actionId = `${platform}:reply:${conversationHref(activeConversation() || conversation) || contact}:${fingerprint(latestInbound)}:${fingerprint(draft.data.message)}`
      await api('/result', 'POST', {
        ok: true,
        kind: 'inbox_reply',
        actionId,
        site: platform,
        reason: `${platform} displayed the outgoing reply`,
      })

      if (settings.integrations?.crm?.enabled) {
        const due = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
        const crmResult = await api('/crm-event', 'POST', {
          crm: settings.integrations.crm,
          event: {
            eventType: `${platform}.reply.sent`,
            occurredAt: new Date().toISOString(),
            channel: platform,
            contact,
            inboundContext: latestInbound,
            conversationHistory: context,
            outboundMessage: draft.data.message,
            status: 'sent',
            actionId,
            tasks: [{
              title: `Follow up with ${contact || `${platform} contact`}`,
              dueDate: due,
              priority: 'Medium',
              sourceId: `${actionId}:follow-up`,
              sourceLabel: `${platform} inbox`,
            }],
          },
        })
        status(crmResult?.ok && crmResult.data?.delivered
          ? 'Reply sent and logged in CRM.'
          : 'Reply sent. CRM logging failed.', crmResult?.ok && crmResult.data?.delivered ? 'success' : 'failure')
      } else {
        status('Reply sent successfully.', 'success')
      }
    } catch (error) {
      lastFailure = String(error).slice(0, 300)
      status('Inbox watcher hit an error and will retry.', 'failure', lastFailure)
    } finally {
      busy = false
    }
  }

  panel()
  api('/extension-heartbeat', 'POST', {
    site: `${platform}-inbox`, extensionVersion: EXTENSION_VERSION,
    extensionBuild: EXTENSION_BUILD, url: location.href,
  }).catch(() => {})
  setInterval(() => api('/extension-heartbeat', 'POST', {
    site: `${platform}-inbox`, extensionVersion: EXTENSION_VERSION,
    extensionBuild: EXTENSION_BUILD, url: location.href,
  }).catch(() => {}), 30000)
  setInterval(cycle, SCAN_INTERVAL_MS)
  cycle()
})()