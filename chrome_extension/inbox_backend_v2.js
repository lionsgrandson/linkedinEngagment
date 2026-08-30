;(() => {
  const base = globalThis.CodeCrafterNativeBackend
  if (!base?.handle || globalThis.__codeCrafterInboxBackendV2) return
  globalThis.__codeCrafterInboxBackendV2 = true

  const originalHandle = base.handle.bind(base)
  const clean = (value, limit = 10000) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
  const dayKey = (date = new Date()) => [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')

  const automatedDisclosure = (context) => {
    const value = String(context || '')
    const hebrew = (value.match(/[\u0590-\u05ff]/g) || []).length
    const latin = (value.match(/[A-Za-z]/g) || []).length
    return hebrew > latin
      ? 'זו הודעה אוטומטית. משה יחזור אליך אישית בהקדם.'
      : 'This is an automated reply. Moshe will get back to you personally soon.'
  }

  const latestInbound = (context) => {
    const lines = String(context || '').split('\n')
    const inbound = lines.filter((line) => line.trim().toUpperCase().startsWith('INBOUND:'))
    return clean(inbound.at(-1)?.split(':').slice(1).join(':') || '', 4000)
  }

  const needsBusinessFacts = (message) => /\b(?:price|pricing|cost|rate|rates|hours|open|available|availability|service|services|offer|website|site|phone|email|contact|package|packages|maintenance|crm|automation|landing page|web development)\b|(?:מחיר|מחירים|עלות|שעות|פתוח|זמינות|שירות|שירותים|אתר|טלפון|אימייל|חבילה|תחזוקה)/iu.test(String(message || ''))

  const badChatDraft = (value) => {
    const text = String(value || '').trim()
    if (!text) return 'blank reply'
    if (/^(?:here(?:'s| is)|below is|draft|response draft|professional response|suggested response|suggested reply|proposed response|proposed reply)\b/i.test(text))
      return 'meta draft wrapper'
    if (/\b(?:professional response draft|tailored to your business|business values|subject:)\b/i.test(text))
      return 'email or assistant style draft'
    if (/^\s*subject\s*:/im.test(text)) return 'email subject line'
    if (/^\s*(?:\d+[.)]|[-*•])\s+/m.test(text)) return 'list formatting'
    if (/\n\s*(?:\d+[.)]|[-*•])\s+/m.test(text)) return 'list formatting'
    return ''
  }

  const sentenceCount = (value) => (String(value || '').match(/[.!?]+(?:\s|$)/g) || []).length

  async function ollamaText(prompt, numPredict = 500) {
    const settings = await CodeCrafterSettings.load()
    const url = clean(settings.browserRuntime?.ollamaUrl, 1000)
    const model = clean(settings.browserRuntime?.ollamaModel, 200)
    if (!url || !model) throw new Error('Ollama URL and model are required in browser settings.')
    const response = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        think: false,
        options: {temperature: 0.28, num_predict: numPredict},
      }),
    })
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`)
    const data = await response.json()
    return String(data?.response || '').trim()
  }

  async function draftInboxReply(body) {
    const settings = await CodeCrafterSettings.load()
    const site = clean(body?.site || 'social', 40).toLowerCase()
    const decision = CodeCrafterSettings.replyDecision(settings, body?.contact, body?.isGroup)
    if (!decision.allowed) return {allowed: false, reason: decision.reason}

    const context = String(body?.context || '').slice(-12000)
    const latest = latestInbound(context) || clean(body?.context, 4000)
    if (!latest) return {allowed: false, reason: 'No inbound message could be identified.'}

    const hasOutbound = context.split('\n').some((line) => line.trim().toUpperCase().startsWith('OUTBOUND:'))
    const isWhatsApp = site === 'whatsapp'
    const isLinkedIn = site === 'linkedin'
    const maxChars = isLinkedIn ? 520 : 700
    const writing = base.writingGuidance(body?.writingStyle || settings.writingStyle)
    const business = needsBusinessFacts(latest)
      ? base.businessGuidance(body?.safeguards || settings.replySafeguards)
      : 'Do not mention services, packages, pricing, company philosophy, capabilities, maintenance plans, or business facts unless the newest message directly asks about them.'

    const prompt = `Write the exact ${site} chat reply to the newest inbound message.
Return ONLY the final message that should be sent.
This is a chat message, NOT an email, proposal, sales response, partnership memo, or polished business letter.
Do not return JSON. Do not write Subject:. Do not use headings, numbered lists, bullet lists, labels, analysis, quotation marks, or explanations.
Never write phrases such as "here is a response", "professional response draft", "tailored to your business values", "suggested reply", "proposed reply", "as Moshe", "Moshe can reply", or "you can answer".
Keep it short enough that a normal person would actually send it in a DM. Maximum ${maxChars} characters. Prefer 1 to 3 short sentences.
Answer only what the newest message actually needs. Do not summarize their entire company or repeat their pitch back to them.
Do not upsell. Do not list CodeCrafter services. Do not explain CodeCrafter's philosophy. Do not create collaboration ideas unless they explicitly ask for specific collaboration ideas.
If this is a generic sales, agency, outsourcing, partnership, or networking pitch, acknowledge it briefly and ask one simple question if useful. Do not counter-pitch.
Use first person naturally. Sound casual, direct, warm, and human rather than corporate.
${hasOutbound ? 'This is an ongoing conversation. Do not restart it with an introduction or greeting unless the newest message naturally calls for one.' : 'A short greeting is allowed if it sounds natural.'}
Match the newest inbound message language.
${isWhatsApp ? 'Do not write the automation disclosure. The extension appends it after the reply.' : ''}
${writing}
${business}
VISIBLE CONVERSATION:
${context}
NEWEST INBOUND MESSAGE:
${latest}`

    let lastReason = 'The model returned a blank reply.'
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const raw = await ollamaText(`${prompt}\n${attempt ? `Previous draft was rejected because: ${lastReason}. Make the new reply shorter and more natural. Return only the message.` : ''}`, isLinkedIn ? 180 : 240)
      const rawText = String(raw || '').trim()
      if (!rawText) {
        lastReason = 'blank reply'
        continue
      }
      if ([...rawText].length > maxChars) {
        lastReason = `reply was too long at ${[...rawText].length} characters; maximum is ${maxChars}`
        continue
      }
      const structureViolation = badChatDraft(rawText)
      if (structureViolation) {
        lastReason = structureViolation
        continue
      }
      if (sentenceCount(rawText) > 4) {
        lastReason = 'too many sentences for a chat reply'
        continue
      }
      let message = base.sendable(rawText, maxChars)
      if (!message || message !== rawText.replace(/\s+/g, ' ').trim()) {
        if (!message) {
          lastReason = 'blank reply or meta narration'
          continue
        }
      }
      const finalViolation = badChatDraft(message)
      if (finalViolation) {
        lastReason = finalViolation
        continue
      }
      if (!base.languageCompatible(latest, message)) {
        lastReason = 'reply language did not match the inbound message'
        continue
      }
      if (isWhatsApp) message = `${message}\n\n${automatedDisclosure(latest)}`
      return {allowed: true, message, reply: message, reason: 'short human chat reply approved'}
    }

    if (isWhatsApp) {
      const disclosure = automatedDisclosure(latest)
      return {allowed: true, message: disclosure, reply: disclosure,
        reason: 'transparent fallback while waiting for Moshe'}
    }
    return {allowed: false, reason: lastReason}
  }

  async function draftNotificationReply(body) {
    const settings = await CodeCrafterSettings.load()
    const latest = clean(body?.latestReply || body?.notificationText, 4000)
    const context = String(body?.context || body?.notificationText || '').slice(-12000)
    if (!latest) return {allowed: false, reason: 'The newest LinkedIn comment could not be read.'}

    const writing = base.writingGuidance(body?.writingStyle || settings.writingStyle)
    const business = needsBusinessFacts(latest)
      ? base.businessGuidance(body?.safeguards || settings.replySafeguards)
      : 'Do not mention CodeCrafter services, pricing, packages, business philosophy, or capabilities unless the newest comment directly asks about them.'
    const prompt = `Write the exact LinkedIn comment reply to the newest comment below.
Return ONLY the final sendable reply text.
Do not return JSON. Do not return analysis, a label, quotation marks, markdown, a proposed reply wrapper, headings, numbered lists, or bullet lists.
Never say "as Moshe", "Moshe can reply", "you can answer", "here is a reply", or anything describing the reply.
Respond specifically to the newest commenter and continue the visible conversation naturally.
Maximum 420 characters. Prefer one or two short sentences.
Do not invent clients, results, experience, facts, or familiarity.
Do not pitch services unless the person explicitly asks for relevant help.
Match the newest comment language and the saved writing style.
${writing}
${business}
VISIBLE THREAD:
${context}
NEWEST COMMENT TO ANSWER:
${latest}`

    let lastReason = 'The model returned a blank comment reply.'
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const raw = await ollamaText(`${prompt}\n${attempt ? `Previous draft was rejected because: ${lastReason}. Return a shorter natural reply only.` : ''}`, 150)
      const rawText = String(raw || '').trim()
      if (!rawText) { lastReason = 'blank reply'; continue }
      if ([...rawText].length > 420) { lastReason = 'reply was too long'; continue }
      const violation = badChatDraft(rawText)
      if (violation) { lastReason = violation; continue }
      const reply = base.sendable(rawText, 420)
      if (!reply) { lastReason = 'blank reply or meta narration'; continue }
      if (badChatDraft(reply)) { lastReason = badChatDraft(reply); continue }
      if (!base.languageCompatible(latest, reply)) {
        lastReason = 'reply language did not match the newest comment'
        continue
      }
      return {allowed: true, reply, message: reply, reason: 'short human comment reply approved'}
    }
    return {allowed: false, reason: lastReason}
  }

  async function recordRealActivity(body) {
    const now = Date.now()
    const stored = await chrome.storage.local.get([
      'ccRealActivityLog', 'ccLifetimeMetrics', 'ccRealActivityIds', 'ccRealMetricsStartedAt',
    ])
    const log = Array.isArray(stored.ccRealActivityLog) ? stored.ccRealActivityLog : []
    const lifetime = stored.ccLifetimeMetrics && typeof stored.ccLifetimeMetrics === 'object'
      ? stored.ccLifetimeMetrics : {}
    const ids = stored.ccRealActivityIds && typeof stored.ccRealActivityIds === 'object'
      ? stored.ccRealActivityIds : {}
    const startedAt = Number(stored.ccRealMetricsStartedAt || now)

    const actionId = clean(body?.actionId, 1000)
    const success = Boolean(body?.ok && body?.kind)
    const duplicate = success && actionId && ids[actionId]
    if (success && !duplicate) {
      const kind = clean(body.kind, 120)
      lifetime[kind] = Number(lifetime[kind] || 0) + 1
      if (actionId) ids[actionId] = now
    }

    const entry = {
      at: new Date(now).toISOString(),
      day: dayKey(new Date(now)),
      ok: Boolean(body?.ok),
      kind: clean(body?.kind || (body?.ok ? 'confirmed_action' : 'failure'), 120),
      site: clean(body?.site, 80),
      actionId,
      reason: clean(body?.reason, 600),
      duplicate: Boolean(duplicate),
    }
    log.push(entry)

    const prunedIds = Object.fromEntries(Object.entries(ids)
      .sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 5000))
    await chrome.storage.local.set({
      ccRealActivityLog: log.slice(-1500),
      ccLifetimeMetrics: lifetime,
      ccRealActivityIds: prunedIds,
      ccRealMetricsStartedAt: startedAt,
    })
  }

  async function handle(path, method = 'GET', body = {}) {
    if (path === '/draft-inbox-reply' && String(method).toUpperCase() === 'POST')
      return draftInboxReply(body)
    if (path === '/draft-notification-reply' && String(method).toUpperCase() === 'POST')
      return draftNotificationReply(body)

    const result = await originalHandle(path, method, body)
    if (path === '/result' && String(method).toUpperCase() === 'POST') {
      try { await recordRealActivity(body) } catch (error) {
        console.warn('CodeCrafter real activity logging failed', error)
      }
    }
    return result
  }

  globalThis.CodeCrafterNativeBackend.handle = handle
})()
