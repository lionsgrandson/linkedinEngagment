;(() => {
  if (location.hostname !== 'web.whatsapp.com' || window.__codeCrafterWhatsAppBridge) return
  window.__codeCrafterWhatsAppBridge = true

  const EXTENSION_VERSION = '3.18.1'
  const EXTENSION_BUILD = '5cf01b8aac28'
  const processed = new Set()
  let busy = false
  let activeTransaction = ''
  let sendStarted = false
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const api = (path, method = 'GET', body = null) => {
    if (!chrome.runtime?.id) throw new Error('extension was reloaded; refresh this WhatsApp page')
    return chrome.runtime.sendMessage({ type: 'localApi', path, method, body })
  }
  const visible = (node) => node && node.offsetParent !== null
  const text = (node) => (node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim()

  const fingerprint = (value) => {
    let hash = 2166136261
    for (const character of String(value || '').normalize('NFKC')) {
      hash ^= character.charCodeAt(0)
      hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
  }

  async function claimTransaction(contact, context) {
    const latestInbound = context.trim().split('\n').filter((line) => line.startsWith('INBOUND:')).at(-1) || ''
    const transactionId = `wa:${fingerprint(`${contact}\n${latestInbound}`)}`
    const stored = await chrome.storage.local.get('ccWhatsAppSendTransactions')
    const now = Date.now()
    const transactions = stored.ccWhatsAppSendTransactions || {}
    for (const [id, transaction] of Object.entries(transactions)) {
      if (!transaction?.updatedAt || now - transaction.updatedAt > 7 * 24 * 60 * 60 * 1000) delete transactions[id]
    }
    let existing = transactions[transactionId]
    if (existing?.state === 'drafting' && now - existing.updatedAt > 5 * 60 * 1000) {
      delete transactions[transactionId]
      existing = null
    }
    if (existing?.state === 'sending' && now - existing.updatedAt > 10 * 60 * 1000) {
      existing = {...existing, state: 'uncertain', updatedAt: now}
      transactions[transactionId] = existing
    }
    if (existing && ['drafting', 'sending', 'confirmed', 'uncertain', 'rejected'].includes(existing.state)) {
      return {claimed: false, transactionId, state: existing.state}
    }
    if (existing?.retryAfter && existing.retryAfter > now) {
      return {claimed: false, transactionId, state: 'cooldown'}
    }
    transactions[transactionId] = {state: 'drafting', contact, updatedAt: now}
    await chrome.storage.local.set({ccWhatsAppSendTransactions: transactions})
    return {claimed: true, transactionId}
  }

  async function updateTransaction(transactionId, patch) {
    if (!transactionId) return
    const stored = await chrome.storage.local.get('ccWhatsAppSendTransactions')
    const transactions = stored.ccWhatsAppSendTransactions || {}
    transactions[transactionId] = {
      ...(transactions[transactionId] || {}), ...patch, updatedAt: Date.now(),
    }
    await chrome.storage.local.set({ccWhatsAppSendTransactions: transactions})
  }

  async function clearFailedTransaction(transactionId) {
    const stored = await chrome.storage.local.get('ccWhatsAppSendTransactions')
    const transactions = stored.ccWhatsAppSendTransactions || {}
    if (transactions[transactionId]?.state !== 'failed') return false
    delete transactions[transactionId]
    await chrome.storage.local.set({ccWhatsAppSendTransactions: transactions})
    return true
  }

  function panel() {
    if (document.getElementById('cc-whatsapp-controls')) return
    const box = document.createElement('div')
    box.id = 'cc-whatsapp-controls'
    box.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;width:285px;padding:14px;border-radius:12px;background:#111827;color:white;font:14px Arial;box-shadow:0 8px 30px #0006'
    box.innerHTML = `<style>@keyframes ccWaPulse{50%{opacity:.35}}#cc-wa-retry:hover{filter:brightness(1.18);transform:translateY(-1px)}</style><b>CodeCrafter WhatsApp v${EXTENSION_VERSION}</b><div id="cc-wa-status" data-phase="loading" style="margin:9px 0">Loading WhatsApp Web...</div><div id="cc-wa-skeleton" aria-label="Loading" style="height:8px;width:72%;border-radius:8px;background:#475569;animation:ccWaPulse 1s infinite"></div><button id="cc-wa-retry" type="button" style="display:none;width:100%;margin-top:9px;padding:9px;border:0;border-radius:8px;background:#2563eb;color:white;font-weight:700;cursor:pointer;transition:.15s">Retry this message once</button>`
    document.documentElement.appendChild(box)
    CodeCrafterSettings.load().then(({ui}) => {
      if (!ui.showOverlay) box.style.display = 'none'
      if (ui.compactOverlay) Object.assign(box.style, {width: '205px', padding: '8px', fontSize: '12px'})
    })
  }

  function status(message, phase = 'filled') {
    panel()
    const node = document.getElementById('cc-wa-status')
    node.textContent = message
    node.dataset.phase = phase
    document.getElementById('cc-wa-skeleton').style.display = phase === 'loading' ? 'block' : 'none'
    document.getElementById('cc-wa-retry').style.display = 'none'
  }

  function offerFailedRetry(transactionId, key) {
    const button = document.getElementById('cc-wa-retry')
    button.style.display = 'block'
    button.onclick = async () => {
      button.disabled = true
      if (await clearFailedTransaction(transactionId)) {
        processed.delete(key)
        status('Success - failed attempt cleared; retrying now', 'success')
        setTimeout(cycle, 250)
      } else {
        status('Blank state - this message is no longer safe to retry', 'blank')
      }
      button.disabled = false
    }
  }

  function unreadConversation() {
    const chatRows = [...document.querySelectorAll(
      "[role='grid'][aria-label='Chat list'] [role='row'],[aria-label='Chat list'] [role='row']",
    )]
      .filter(visible)
    const unread = chatRows.find((row) => {
      const marker = row.querySelector(
        "[aria-label*='unread' i],[data-testid*='unread' i],[data-icon*='unread' i]",
      )
      const label = row.getAttribute('aria-label') || ''
      return Boolean(marker || /unread|new message/i.test(label))
    }) || [...document.querySelectorAll(
      "[data-testid='icon-unread-count'],[aria-label*='unread message' i]",
    )].filter(visible).map((node) => node.closest("[role='listitem'],[role='row']"))[0]
    if (unread) return unread
    const recent = chatRows[0]
    if (!recent) return null
    const preview = text(recent.querySelector(
      "[data-testid='last-msg-status'],[data-testid='cell-frame-secondary']",
    ))
    const title = text(recent.querySelector("[data-testid='cell-frame-title']"))
    const systemChat = /^(WhatsApp Business|Facebook(?: Business)?|Pelephone)$/i.test(title) ||
      /passcode|confirmation code|one-time code/i.test(preview)
    return preview && !systemChat && !recent.querySelector("[aria-label='You:']") &&
      !processed.has(text(recent).slice(0, 500)) ? recent : null
  }

  function activeConversation() {
    const selected = document.querySelector(
      "[aria-label='Chat list'] [aria-selected='true'],[role='grid'][aria-label='Chat list'] [aria-selected='true'],[aria-selected='true'] [data-testid='cell-frame-container']",
    )
    return selected?.closest("[role='row'],[role='listitem'],[aria-selected='true']") || selected
  }

  function conversationContext() {
    const rows = [...document.querySelectorAll("[data-testid='msg-container']")]
      .filter((row) => !row.closest("[aria-label='Chat list']"))
      .filter(visible)
      .slice(-30)
      .map((row) => {
        const senderLabels = [...row.querySelectorAll('[aria-label]')]
          .map((node) => node.getAttribute('aria-label') || '')
          .filter((value) => value.endsWith(':'))
        const direction = senderLabels.includes('You:')
          ? 'OUTBOUND'
          : senderLabels.length
            ? 'INBOUND'
            : ''
        return direction ? `${direction}: ${text(row)}` : ''
      })
      .filter((line) => line.length > 10 && !/^(?:INBOUND|OUTBOUND):\s*\d{1,2}:\d{2}$/.test(line))
    if (rows.length) return rows.join('\n').slice(-10000)
    return [...document.querySelectorAll('.message-in,.message-out')]
      .filter(visible)
      .slice(-30)
      .map((node) => {
        return `${node.classList.contains('message-in') ? 'INBOUND' : 'OUTBOUND'}: ${text(node)}`
      })
      .filter((line) => line.length > 10 && !/^(?:INBOUND|OUTBOUND):\s*\d{1,2}:\d{2}$/.test(line))
      .join('\n')
      .slice(-10000)
  }

  function editor() {
    return [...document.querySelectorAll(
      "footer [contenteditable='true'][role='textbox'],footer div[contenteditable='true'],[role='contentinfo'] [contenteditable='true'][role='textbox'],[role='contentinfo'] div[contenteditable='true']",
    )].filter(visible).find((node) => !/search/i.test(node.getAttribute('aria-label') || ''))
  }

  async function waitForConversationOpen(timeout = 6000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (editor() || document.querySelector("[role='row'] [data-testid^='conv-msg-']")) return true
      await sleep(200)
    }
    return false
  }

  async function openConversation(conversation) {
    const targets = [
      conversation.querySelector("[data-testid='cell-frame-container']"),
      conversation.querySelector("[role='gridcell'][tabindex='0']"),
      conversation,
    ].filter(Boolean)
    conversation.scrollIntoView({block: 'center'})
    for (const target of targets) {
      target.focus()
      target.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, pointerType: 'mouse'}))
      target.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, buttons: 1}))
      target.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, buttons: 0}))
      target.click()
      if (await waitForConversationOpen(2500)) return true
    }
    const focusTarget = conversation.querySelector("[role='gridcell'][tabindex='0']")
    if (focusTarget) {
      focusTarget.focus()
      focusTarget.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', bubbles: true,
      }))
      focusTarget.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Enter', code: 'Enter', bubbles: true,
      }))
    }
    return waitForConversationOpen(3000)
  }

  function clientName(conversation) {
    const title = text(conversation.querySelector("[data-testid='cell-frame-title']"))
    return title.replace(/^\d+\s+unread messages?/i, '').trim()
  }

  function conversationIdentity(fallbackName) {
    const header = [...document.querySelectorAll('header')].filter(visible).at(-1)
    const title = text(header?.querySelector(
      "[data-testid='conversation-info-header-chat-title']",
    )) || fallbackName
    const isGroup = Boolean(header?.querySelector(
      "[data-icon*='group' i],[data-testid*='group' i],[aria-label*='group' i]",
    ))
    return {contact: title, isGroup}
  }

  function setEditorText(input, message) {
    const value = String(message || '')
    input.focus()
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(input)
    selection.removeAllRanges()
    selection.addRange(range)
    document.execCommand('delete', false, null)
    input.textContent = ''
    input.dispatchEvent(new InputEvent('input', {
      bubbles: true, inputType: 'deleteContentBackward', data: null,
    }))
    if (value) {
      input.focus()
      document.execCommand('insertText', false, value)
      if (text(input) !== value.replace(/\s+/g, ' ').trim()) input.textContent = value
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText', data: value,
      }))
    }
    return text(input) === value.replace(/\s+/g, ' ').trim()
  }

  function exactOutgoingMessage(message) {
    const wanted = String(message || '').replace(/\s+/g, ' ').trim()
    return Boolean(wanted) && [...document.querySelectorAll("[data-testid='msg-container']")]
      .filter(visible)
      .some((row) => {
        const outgoing = row.querySelector("[aria-label='You:'],[data-icon='msg-check'],[data-icon='msg-dblcheck']") ||
          row.closest('.message-out') || row.classList.contains('message-out')
        return Boolean(outgoing) && text(row).includes(wanted)
      })
  }

  async function waitForExactOutgoingMessage(message, timeout = 12000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (exactOutgoingMessage(message)) return true
      await sleep(250)
    }
    return false
  }

  async function countdown(automaticClient) {
    if (automaticClient) {
      status('Filled state - automatic client approved; sending now', 'filled')
      return true
    }
    for (let left = 10000; left > 0; left -= 100) {
      status(`Reply sends in ${(left / 1000).toFixed(1)}s`)
      await sleep(100)
    }
    return true
  }

  function sendButton() {
    const exact = [...document.querySelectorAll(
      "[aria-label='Send'],button[aria-label*='Send' i],[role='button'][aria-label*='Send' i],[data-testid='compose-btn-send'],[data-testid='send'],[data-icon='send']",
    )].filter(visible)
    for (const node of exact) {
      const target = node.closest("button,[role='button']") || node
      if (visible(target) && target.getAttribute('aria-disabled') !== 'true') return target
    }
    return [...document.querySelectorAll("footer button,footer [role='button'],[role='contentinfo'] button,[role='contentinfo'] [role='button']")]
      .filter(visible)
      .find((node) => /send/i.test(`${node.getAttribute('aria-label') || ''} ${node.getAttribute('data-testid') || ''}`)) || null
  }

  async function cycle() {
    if (busy) return
    busy = true
    let key = ''
    activeTransaction = ''
    sendStarted = false
    try {
      const settings = await CodeCrafterSettings.load()
      const config = settings.platforms.whatsapp
      if (!config?.enabled || !config.messages || !config.optedIn || config.consentRevision !== 2) {
        status('Blank state - WhatsApp replies disabled', 'blank')
        return
      }
      let conversation = unreadConversation()
      if (!conversation) {
        const context = conversationContext()
        if (context.trim().split('\n').at(-1)?.startsWith('INBOUND:'))
          conversation = activeConversation()
      }
      if (!conversation) {
        status('Blank state - no unread client messages', 'blank')
        return
      }
      key = text(conversation).slice(0, 500)
      if (!key || processed.has(key)) return
      const client = clientName(conversation)
      const automaticClient = config.topics.some(
        (name) => name.localeCompare(client, undefined, {sensitivity: 'accent'}) === 0,
      )
      status('Loading unread client conversation...', 'loading')
      const selected = conversation.matches?.("[aria-selected='true']") ||
        Boolean(conversation.querySelector?.("[aria-selected='true']"))
      if (!selected && !(await openConversation(conversation))) {
        processed.delete(key)
        throw new Error('WhatsApp chat did not open')
      }
      const identity = conversationIdentity(client)
      const policy = CodeCrafterSettings.replyDecision(settings, identity.contact, identity.isGroup)
      if (!policy.allowed) {
        processed.add(key)
        status(`Blank state - ${policy.reason}`, 'blank')
        return
      }
      const context = conversationContext()
      if (!context) throw new Error('conversation could not be read')
      if (!context.trim().split('\n').at(-1).startsWith('INBOUND:')) {
        processed.add(key)
        status('Blank state - latest message is not inbound', 'blank')
        return
      }
      const claim = await claimTransaction(identity.contact, context)
      activeTransaction = claim.transactionId
      if (!claim.claimed) {
        processed.add(key)
        if (claim.state === 'cooldown') {
          status('Failure - the previous attempt failed and is waiting before retry', 'failure')
          offerFailedRetry(claim.transactionId, key)
        } else {
          status(`Blank state - this inbound message already has a ${claim.state} send transaction`, 'blank')
        }
        return
      }
      processed.add(key)
      const response = await api('/draft-inbox-reply', 'POST', {
        site: 'whatsapp',
        context,
        writingStyle: settings.writingStyle,
        safeguards: settings.replySafeguards,
        contact: identity.contact,
        isGroup: identity.isGroup,
        client,
      })
      if (!response?.ok || !response.data.allowed || !response.data.message) {
        await updateTransaction(activeTransaction, {
          state: 'rejected', reason: response?.data?.reason || 'no safe reply',
        })
        processed.add(key)
        status(`Blank state - ${response?.data?.reason || 'no safe reply'}`, 'blank')
        return
      }
      const input = editor()
      if (!input) throw new Error('WhatsApp message editor not found')
      if (!setEditorText(input, response.data.message))
        throw new Error('WhatsApp editor did not retain the drafted reply')
      await countdown(automaticClient)
      let send = null
      const sendDeadline = Date.now() + 5000
      while (Date.now() < sendDeadline && !send) {
        send = sendButton()
        if (!send || send.getAttribute('aria-disabled') === 'true') {
          send = null
          await sleep(200)
        }
      }
      if (!send) throw new Error(`WhatsApp Send button not found; editor="${text(input).slice(0, 120)}"`)
      sendStarted = true
      await updateTransaction(activeTransaction, {state: 'sending', message: response.data.message})
      send.scrollIntoView({block: 'nearest', inline: 'nearest'})
      send.focus()
      send.click()
      let confirmed = await waitForExactOutgoingMessage(response.data.message, 20000)
      if (!confirmed && !text(input)) confirmed = await waitForExactOutgoingMessage(response.data.message, 15000)
      await updateTransaction(activeTransaction, {
        state: confirmed ? 'confirmed' : 'uncertain',
        confirmedAt: confirmed ? new Date().toISOString() : '',
      })
      await api('/result', 'POST', {
        ok: confirmed,
        kind: confirmed ? 'inbox_reply' : undefined,
        actionId: `whatsapp:reply:${identity.contact}:${String(response.data.message).replace(/\s+/g, ' ').slice(0, 180)}`,
        site: 'whatsapp',
        reason: confirmed ? 'WhatsApp Web confirmed reply' : 'WhatsApp Web did not confirm reply',
      })
      if (confirmed && settings.integrations?.crm?.enabled) {
        const crmResult = await api('/crm-event', 'POST', {
          crm: settings.integrations.crm,
          event: {
            eventType: 'whatsapp.reply.sent',
            occurredAt: new Date().toISOString(),
            channel: 'whatsapp',
            contact: identity.contact,
            phone: /^\+?[\d\s().-]{7,}$/.test(identity.contact) ? identity.contact : '',
            inboundContext: context,
            outboundMessage: response.data.message,
            status: 'sent',
            actionId: activeTransaction,
            tasks: [{title: `Follow up with ${identity.contact || 'WhatsApp contact'}`, dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10), priority: 'Medium', sourceId: `${activeTransaction}:follow-up`, sourceLabel: 'WhatsApp inbox'}],
          },
        })
        status(crmResult?.ok && crmResult.data?.delivered
          ? 'Success - reply sent and logged in CRM'
          : 'Success - reply sent; CRM logging failed', crmResult?.ok && crmResult.data?.delivered ? 'success' : 'failure')
      } else {
        status(confirmed ? 'Success - reply sent' : 'Failure - send not confirmed; duplicate retry blocked', confirmed ? 'success' : 'failure')
      }
      if (confirmed) {
        processed.add(key)
      }
    } catch (error) {
      if (activeTransaction) {
        await updateTransaction(activeTransaction, sendStarted
          ? {state: 'uncertain', error: String(error).slice(0, 300)}
          : {state: 'failed', error: String(error).slice(0, 300), retryAfter: Date.now() + 5 * 60 * 1000})
      }
      if (key && !activeTransaction) processed.delete(key)
      status(`Failure - ${String(error).slice(0, 160)}`, 'failure')
    } finally {
      busy = false
    }
  }

  panel()
  api('/extension-heartbeat', 'POST', {
    site: 'whatsapp', extensionVersion: EXTENSION_VERSION,
    extensionBuild: EXTENSION_BUILD, url: location.href,
  }).catch(() => {})
  setInterval(() => api('/extension-heartbeat', 'POST', {
    site: 'whatsapp', extensionVersion: EXTENSION_VERSION,
    extensionBuild: EXTENSION_BUILD, url: location.href,
  }).catch(() => {}), 30000)
  setInterval(cycle, 3000)
  cycle()
})()
