;(() => {
  if (location.hostname !== 'web.whatsapp.com' || window.__codeCrafterWhatsAppBridge) return
  window.__codeCrafterWhatsAppBridge = true

  const EXTENSION_VERSION = '3.15.3'
  const EXTENSION_BUILD = '55292288fa00'
  const processed = new Set()
  let busy = false
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const api = (path, method = 'GET', body = null) =>
    chrome.runtime.sendMessage({ type: 'localApi', path, method, body })
  const visible = (node) => node && node.offsetParent !== null
  const text = (node) => (node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim()

  function panel() {
    if (document.getElementById('cc-whatsapp-controls')) return
    const box = document.createElement('div')
    box.id = 'cc-whatsapp-controls'
    box.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;width:285px;padding:14px;border-radius:12px;background:#111827;color:white;font:14px Arial;box-shadow:0 8px 30px #0006'
    box.innerHTML = `<style>@keyframes ccWaPulse{50%{opacity:.35}}</style><b>CodeCrafter WhatsApp v${EXTENSION_VERSION}</b><div id="cc-wa-status" data-phase="loading" style="margin:9px 0">Loading WhatsApp Web...</div><div id="cc-wa-skeleton" aria-label="Loading" style="height:8px;width:72%;border-radius:8px;background:#475569;animation:ccWaPulse 1s infinite"></div>`
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
  }

  async function priorityActive() {
    return Boolean((await chrome.storage.local.get('ccLinkedInPriorityActive')).ccLinkedInPriorityActive)
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
    return chatRows.slice(0, 12).find((row) => {
      const preview = text(row.querySelector("[data-testid='last-msg-status'],[data-testid='cell-frame-secondary']"))
      return preview && !row.querySelector("[aria-label='You:']") && !processed.has(text(row).slice(0, 500))
    })
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
    input.focus()
    document.execCommand('selectAll', false, null)
    document.execCommand('insertText', false, message)
    input.dispatchEvent(new InputEvent('input', {
      bubbles: true, inputType: 'insertText', data: message,
    }))
    return text(input) === String(message || '').replace(/\s+/g, ' ').trim()
  }

  function exactOutgoingMessage(message) {
    const wanted = String(message || '').replace(/\s+/g, ' ').trim()
    return Boolean(wanted) && [...document.querySelectorAll("[data-testid='msg-container']")]
      .filter(visible)
      .some((row) => row.querySelector("[aria-label='You:']") && text(row).includes(wanted))
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
      if (await priorityActive()) return false
      status(`Reply sends in ${(left / 1000).toFixed(1)}s - LinkedIn alerts have priority`)
      await sleep(100)
    }
    return true
  }

  async function cycle() {
    if (busy) return
    busy = true
    let key = ''
    try {
      const settings = await CodeCrafterSettings.load()
      const config = settings.platforms.whatsapp
      if (!config?.enabled || !config.messages || !config.optedIn || config.consentRevision !== 2) {
        status('Blank state - WhatsApp replies disabled', 'blank')
        return
      }
      if (await priorityActive()) {
        status('Filled state - paused for a LinkedIn notification', 'filled')
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
        processed.add(key)
        status(`Blank state - ${response?.data?.reason || 'no safe reply'}`, 'blank')
        return
      }
      const input = editor()
      if (!input) throw new Error('WhatsApp message editor not found')
      if (!setEditorText(input, response.data.message))
        throw new Error('WhatsApp editor did not retain the drafted reply')
      if (!(await countdown(automaticClient))) {
        setEditorText(input, '')
        processed.delete(key)
        status('Filled state - interrupted for LinkedIn notification', 'filled')
        return
      }
      const send = [...document.querySelectorAll(
        "footer button,footer [role='button'],[role='contentinfo'] button,[role='contentinfo'] [role='button'],[data-testid='compose-btn-send']",
      )].filter(visible).find((node) => /send/i.test(
        `${node.getAttribute('aria-label') || ''} ${node.getAttribute('data-testid') || ''} ${text(node)}`,
      ))
      if (send) send.click()
      else input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', bubbles: true,
      }))
      const confirmed = await waitForExactOutgoingMessage(response.data.message)
      await api('/result', 'POST', {
        ok: confirmed,
        kind: confirmed ? 'inbox_reply' : undefined,
        site: 'whatsapp',
        reason: confirmed ? 'WhatsApp Web confirmed reply' : 'WhatsApp Web did not confirm reply',
      })
      status(confirmed ? 'Success - reply sent; leaving chat' : 'Failure - reply not confirmed', confirmed ? 'success' : 'failure')
      if (confirmed) {
        processed.add(key)
      }
    } catch (error) {
      if (key) processed.delete(key)
      status(`Failure - ${String(error).slice(0, 160)}`, 'failure')
    } finally {
      busy = false
    }
  }

  panel()
  setInterval(cycle, 3000)
  cycle()
})()
