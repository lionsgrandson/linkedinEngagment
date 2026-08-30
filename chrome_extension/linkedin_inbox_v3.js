;(() => {
  if (location.hostname !== 'www.linkedin.com' || !location.pathname.startsWith('/messaging')) return
  if (window.__codeCrafterInboxBridge) return
  window.__codeCrafterInboxBridge = true

  const VERSION = '3.20.17'
  const SCAN_MS = 2000
  const SEND_DELAY_MS = 1800
  const processed = new Set()
  const attempted = new Set()
  let busy = false

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim()
  const visible = (node) => Boolean(node && node.isConnected && node.offsetParent !== null)
  const text = (node) => normalize(node?.innerText || node?.textContent || '')
  const api = (path, method = 'GET', body = null) => {
    if (!chrome.runtime?.id) throw new Error('extension was reloaded; refresh this LinkedIn inbox page')
    return chrome.runtime.sendMessage({type: 'localApi', path, method, body})
  }
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
    if (document.getElementById('cc-linkedin-inbox-v3')) return
    const box = document.createElement('div')
    box.id = 'cc-linkedin-inbox-v3'
    box.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;width:290px;padding:14px;border-radius:12px;background:#111827;color:white;font:14px Arial;box-shadow:0 8px 30px #0006'
    box.innerHTML = `<b>CodeCrafter LinkedIn Inbox v${VERSION}</b><div id="cc-linkedin-inbox-v3-status" style="margin-top:9px">Starting...</div><div id="cc-linkedin-inbox-v3-detail" style="display:none;margin-top:7px;color:#cbd5e1;font-size:11px"></div>`
    document.documentElement.appendChild(box)
    CodeCrafterSettings.load().then(({ui}) => {
      if (!ui.showOverlay) box.style.display = 'none'
      if (ui.compactOverlay) Object.assign(box.style, {width: '220px', padding: '8px', fontSize: '12px'})
    }).catch(() => {})
  }

  function status(message, detail = '') {
    panel()
    const main = document.getElementById('cc-linkedin-inbox-v3-status')
    const extra = document.getElementById('cc-linkedin-inbox-v3-detail')
    if (main) main.textContent = message
    if (extra) {
      extra.textContent = detail
      extra.style.display = detail ? 'block' : 'none'
    }
  }

  function conversationRows() {
    const rows = [
      ...document.querySelectorAll('li.msg-conversation-listitem'),
      ...document.querySelectorAll('.msg-conversations-container__convo-item'),
      ...document.querySelectorAll("[data-view-name='message-list-item']"),
      ...document.querySelectorAll("[data-testid*='conversation-list-item' i]"),
    ]
    const anchored = [...document.querySelectorAll("a[href*='/messaging/thread/']")]
      .map((anchor) => anchor.closest("li,[role='listitem'],[data-view-name='message-list-item'],div"))
    return unique([...rows, ...anchored]).filter((row) => visible(row) && row.querySelector?.("a[href*='/messaging/thread/']"))
  }

  function rowHref(row) {
    return row?.querySelector?.("a[href*='/messaging/thread/']")?.href || ''
  }

  function rowSelected(row) {
    if (!row) return false
    if (row.matches?.("[aria-selected='true'],.msg-conversation-listitem--active")) return true
    if (row.querySelector?.("[aria-current='page'],[aria-selected='true'],.msg-conversation-listitem__link--active,.msg-conversations-container__convo-item-link--active")) return true
    const href = rowHref(row)
    try {
      return href && location.pathname.startsWith(new URL(href).pathname.replace(/\/+$/, ''))
    } catch (_error) { return false }
  }

  function rowUnread(row) {
    const value = `${row.className || ''} ${text(row)} ${row.getAttribute?.('aria-label') || ''}`
    if (/\bunread\b|\bnew message\b|\b[1-9]\d* new messages?\b/i.test(value)) return true
    return Boolean(row.matches?.('.msg-conversation-listitem--unread,[data-unread=true]') || row.querySelector?.(
      "[aria-label*='unread' i],[aria-label*='new message' i],[class*='unread' i],[data-testid*='unread' i],[data-view-name*='unread' i],.notification-badge",
    ))
  }

  function activeRow() {
    return conversationRows().find(rowSelected) || null
  }

  function contactName(row) {
    if (!row) return ''
    const candidates = [
      row.querySelector('.msg-conversation-card__participant-names'),
      row.querySelector('.msg-conversation-listitem__participant-names'),
      row.querySelector("[data-testid*='title' i]"),
      row.querySelector("[class*='participant' i]"),
      row.querySelector('img[alt]'),
      row.querySelector("[dir='auto']"),
    ].filter(Boolean)
    for (const node of candidates) {
      const value = node.tagName === 'IMG' ? normalize(node.alt) : text(node)
      if (value && !/^(?:unread|new message|messages?)$/i.test(value)) return value.slice(0, 250)
    }
    return text(row).split(/\s{2,}/)[0].slice(0, 250)
  }

  function threadRoot() {
    return document.querySelector('.msg-s-message-list-container,.msg-s-message-list,.msg-thread,[data-view-name*=message-thread],main') || document.body
  }

  function messageEvents() {
    const root = threadRoot()
    return unique([
      ...root.querySelectorAll('li.msg-s-message-list__event'),
      ...root.querySelectorAll('.msg-s-event-listitem'),
      ...root.querySelectorAll("[data-view-name='message']"),
      ...root.querySelectorAll("[data-testid*='message-item' i]"),
    ]).filter((event) => visible(event) && text(event))
  }

  function direction(event) {
    const content = text(event)
    const classText = String(event?.className || '')
    const labels = [event?.getAttribute?.('aria-label') || '', ...[...event?.querySelectorAll?.('[aria-label]') || []]
      .slice(0, 10).map((node) => node.getAttribute('aria-label') || '')].join(' ')
    if (/outbound|message-out|from-me/i.test(classText)) return 'OUTBOUND'
    if (/\b(?:you sent|sent by you|your message)\b/i.test(labels)) return 'OUTBOUND'
    if (/\bMoshe Schwartzberg sent the following message\b/i.test(content)) return 'OUTBOUND'
    const sender = text(event?.querySelector?.(
      ".msg-s-message-group__name,.msg-s-message-list__event-actor,.msg-s-event-listitem__name,[data-view-name='message-sender'],a[href*='/in/']",
    ))
    if (/^(?:Moshe Schwartzberg|You)$/i.test(sender)) return 'OUTBOUND'
    return 'INBOUND'
  }

  function body(event) {
    const node = [
      '.msg-s-event-listitem__body',
      '.msg-s-message-list__event-content',
      '.msg-s-message-list__event-content p',
      "[data-view-name='message-body']",
      "[data-testid*='message-text' i]",
    ].map((selector) => event?.querySelector?.(selector)).find(Boolean)
    let value = text(node || event)
      .replace(/^Moshe Schwartzberg sent the following message\s*/i, '')
      .replace(/^You\s*/i, '')
      .replace(/\b(?:Seen|Delivered|Sent)\s*$/i, '')
      .trim()
    if (/^(?:Seen|Delivered|Sent|Today|Yesterday|\d{1,2}:\d{2}(?:\s*[AP]M)?)$/i.test(value)) value = ''
    return value
  }

  function messages() {
    return messageEvents().map((event) => ({direction: direction(event), body: body(event)})).filter((item) => item.body)
  }

  function latestInbound() {
    const latest = messages().at(-1)
    return latest?.direction === 'INBOUND' ? latest.body : ''
  }

  function context() {
    return messages().slice(-30).map((item) => `${item.direction}: ${item.body}`).join('\n').slice(-10000)
  }

  function threadSignature() {
    return fingerprint(messages().slice(-8).map((item) => `${item.direction}:${item.body}`).join('|'))
  }

  function editor() {
    return [...document.querySelectorAll(
      "div.msg-form__contenteditable[contenteditable='true'],div[contenteditable='true'][role='textbox'][aria-label*='message' i],div[contenteditable='true'][role='textbox'],textarea[placeholder*='message' i],textarea",
    )].filter(visible).find((node) => !/search/i.test(`${node.getAttribute('aria-label') || ''} ${node.getAttribute('placeholder') || ''}`)) || null
  }

  function editorValue(input) {
    return normalize(input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement ? input.value : input?.textContent)
  }

  function putDraft(input, value) {
    input.focus()
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value)
      input.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: value}))
      input.dispatchEvent(new Event('change', {bubbles: true}))
      return editorValue(input) === normalize(value)
    }

    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(input)
    selection.removeAllRanges()
    selection.addRange(range)
    document.execCommand('delete', false)
    document.execCommand('insertText', false, value)
    input.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: value}))

    // A native one-character edit helps LinkedIn update the composer state when the text is inserted programmatically.
    const end = document.createRange()
    end.selectNodeContents(input)
    end.collapse(false)
    selection.removeAllRanges()
    selection.addRange(end)
    document.execCommand('insertText', false, ' ')
    input.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: ' '}))
    document.execCommand('delete', false)
    input.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'deleteContentBackward', data: null}))
    return editorValue(input) === normalize(value)
  }

  function exactOutgoing(expected) {
    const wanted = normalize(expected)
    if (!wanted) return false
    return messages().some((item) => item.direction === 'OUTBOUND' && (
      normalize(item.body).includes(wanted) || wanted.includes(normalize(item.body))
    ))
  }

  async function waitForOutgoing(expected, previousSignature, timeout = 12000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (exactOutgoing(expected)) return true
      const latest = messages().at(-1)
      const input = editor()
      if (latest?.direction === 'OUTBOUND' && threadSignature() !== previousSignature && !editorValue(input)) {
        const wanted = normalize(expected).slice(0, 90)
        const actual = normalize(latest.body)
        if (actual.includes(wanted) || wanted.includes(actual.slice(0, 90))) return true
      }
      const feedback = text(document.querySelector("[role='alert'],.artdeco-toast-item"))
      if (/couldn.?t send|failed|try again|something went wrong/i.test(feedback)) return false
      await sleep(200)
    }
    return false
  }

  function sendControl(input) {
    const roots = unique([
      input?.closest?.('form'),
      input?.closest?.('.msg-form'),
      input?.closest?.("[data-view-name*='message' i]"),
      threadRoot(),
      document,
    ])
    const selectors = [
      'button.msg-form__send-button',
      'button.msg-form__send-btn',
      "button[type='submit']",
      "button[aria-label='Send']",
      "button[aria-label*='send message' i]",
      "button[data-control-name*='send' i]",
      "button[data-view-name*='send' i]",
      "[role='button'][aria-label='Send']",
      "[role='button'][aria-label*='send message' i]",
      "[role='button'][data-control-name*='send' i]",
      "[role='button'][data-view-name*='send' i]",
    ]
    for (const root of roots) {
      for (const selector of selectors) {
        const node = root?.querySelector?.(selector)
        if (visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true') return node
      }
      const byLabel = [...root?.querySelectorAll?.("button,[role='button']") || []].filter(visible).find((node) => {
        const label = normalize(`${node.innerText || ''} ${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''} ${node.getAttribute('data-control-name') || ''} ${node.getAttribute('data-view-name') || ''}`)
        return /^(?:Send|Send message)\b/i.test(label) && !node.disabled && node.getAttribute('aria-disabled') !== 'true'
      })
      if (byLabel) return byLabel
    }
    return null
  }

  function composerForm(input) {
    return input?.closest?.('form') || input?.closest?.('.msg-form')?.querySelector?.('form') || null
  }

  async function submitDraft(input, expected) {
    const previousSignature = threadSignature()
    const control = sendControl(input)
    let method = ''

    if (control) {
      method = 'button'
      control.click()
    } else {
      const form = composerForm(input)
      if (form && typeof form.requestSubmit === 'function') {
        method = 'form'
        form.requestSubmit()
      } else {
        method = 'enter'
        input.focus()
        input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true}))
        input.dispatchEvent(new KeyboardEvent('keypress', {key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true}))
        input.dispatchEvent(new KeyboardEvent('keyup', {key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true}))
      }
    }

    const confirmed = await waitForOutgoing(expected, previousSignature)
    return {confirmed, method}
  }

  async function openRow(row) {
    if (!row) return false
    if (rowSelected(row) && editor() && messages().length) return true
    const target = row.querySelector("a[href*='/messaging/thread/']") || row
    const before = threadSignature()
    target.scrollIntoView?.({block: 'center'})
    target.click?.()
    const deadline = Date.now() + 9000
    while (Date.now() < deadline) {
      if (editor() && messages().length && (rowSelected(row) || threadSignature() !== before)) return true
      await sleep(200)
    }
    return false
  }

  function chooseRow() {
    const unread = conversationRows().find((row) => rowUnread(row))
    if (unread) return unread
    const active = activeRow()
    if (active && latestInbound()) return active
    return null
  }

  async function cycle() {
    if (busy) return
    busy = true
    try {
      const settings = await CodeCrafterSettings.load()
      const config = settings.platforms.linkedin
      if (!config?.enabled || !config.messages) {
        status('LinkedIn inbox replies are disabled in Settings.')
        return
      }

      const row = chooseRow()
      if (!row) {
        status('Watching for new LinkedIn messages...')
        return
      }

      const contactBefore = contactName(row)
      if (!rowSelected(row)) {
        status(`Opening ${contactBefore || 'unread conversation'}...`)
        if (!(await openRow(row))) {
          status('Conversation did not finish loading. Retrying automatically.')
          return
        }
      }

      await sleep(300)
      const inbound = latestInbound()
      const active = activeRow() || row
      const contact = contactName(active) || contactBefore
      const href = rowHref(active) || rowHref(row)
      const key = `${href || contact || 'linkedin'}|${fingerprint(inbound)}`

      if (!inbound) {
        status('Latest visible message is not inbound. Watching for the next one...')
        return
      }
      if (processed.has(key)) {
        status('This inbound message was already handled.')
        return
      }
      if (attempted.has(key)) {
        status('A send was already attempted for this message. Not retrying automatically to avoid duplicates.')
        return
      }

      const policy = CodeCrafterSettings.replyDecision(settings, contact, false)
      if (!policy.allowed) {
        processed.add(key)
        status(`Reply blocked by Settings: ${policy.reason}`)
        return
      }

      status(`Drafting a reply to ${contact || 'the newest message'}...`)
      const draft = await api('/draft-inbox-reply', 'POST', {
        site: 'linkedin',
        context: context(),
        writingStyle: settings.writingStyle,
        safeguards: settings.replySafeguards,
        contact,
        isGroup: false,
      })
      if (!draft?.ok || !draft.data?.allowed || !draft.data?.message) {
        status('Could not draft a safe reply. Retrying...', draft?.data?.reason || draft?.error || '')
        return
      }

      if (exactOutgoing(draft.data.message)) {
        processed.add(key)
        status('That reply is already visible. Watching for the next message...')
        return
      }

      const input = editor()
      if (!input) {
        status('Message editor was not found. Retrying...')
        return
      }
      if (!putDraft(input, draft.data.message)) {
        status('LinkedIn did not retain the draft. Retrying...')
        return
      }

      const started = Date.now()
      while (Date.now() - started < SEND_DELAY_MS) {
        const left = Math.max(0, SEND_DELAY_MS - (Date.now() - started))
        status(`Reply ready. Sending in ${(left / 1000).toFixed(1)}s`)
        await sleep(100)
      }

      if (!latestInbound()) {
        status('Conversation changed before send. Rereading first...')
        return
      }

      attempted.add(key)
      const result = await submitDraft(input, draft.data.message)
      if (!result.confirmed) {
        status(`Send attempted using ${result.method}, but LinkedIn did not confirm it. Automatic retry is blocked to avoid a duplicate.`)
        await api('/result', 'POST', {
          ok: false,
          site: 'linkedin',
          actionId: `linkedin:reply-attempt:${href || contact}:${fingerprint(inbound)}`,
          reason: `LinkedIn send attempt via ${result.method} was not confirmed`,
        }).catch(() => {})
        return
      }

      processed.add(key)
      const actionId = `linkedin:reply:${href || contact}:${fingerprint(inbound)}:${fingerprint(draft.data.message)}`
      await api('/result', 'POST', {
        ok: true,
        kind: 'inbox_reply',
        actionId,
        site: 'linkedin',
        reason: `LinkedIn displayed the outgoing reply after ${result.method} submission`,
      })

      if (settings.integrations?.crm?.enabled) {
        const due = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
        const crmResult = await api('/crm-event', 'POST', {
          crm: settings.integrations.crm,
          event: {
            eventType: 'linkedin.reply.sent',
            occurredAt: new Date().toISOString(),
            channel: 'linkedin',
            contact,
            inboundContext: inbound,
            conversationHistory: context(),
            outboundMessage: draft.data.message,
            status: 'sent',
            actionId,
            tasks: [{
              title: `Follow up with ${contact || 'LinkedIn contact'}`,
              dueDate: due,
              priority: 'Medium',
              sourceId: `${actionId}:follow-up`,
              sourceLabel: 'LinkedIn inbox',
            }],
          },
        })
        status(crmResult?.ok && crmResult.data?.delivered ? 'Reply sent and logged in CRM.' : 'Reply sent. CRM logging failed.')
      } else {
        status('Reply sent successfully.')
      }
    } catch (error) {
      status('LinkedIn inbox watcher hit an error and will retry.', String(error).slice(0, 300))
    } finally {
      busy = false
    }
  }

  panel()
  api('/extension-heartbeat', 'POST', {
    site: 'linkedin-inbox', extensionVersion: VERSION, extensionBuild: 'linkedin-inbox-v3', url: location.href,
  }).catch(() => {})
  setInterval(() => api('/extension-heartbeat', 'POST', {
    site: 'linkedin-inbox', extensionVersion: VERSION, extensionBuild: 'linkedin-inbox-v3', url: location.href,
  }).catch(() => {}), 30000)
  setInterval(cycle, SCAN_MS)
  cycle()
})()
