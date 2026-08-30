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
        options: {temperature: 0.36, num_predict: numPredict},
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
    const writing = base.writingGuidance(body?.writingStyle || settings.writingStyle)
    const business = base.businessGuidance(body?.safeguards || settings.replySafeguards)

    const prompt = `Write the exact ${site} reply that should be sent to the newest inbound message.
Return ONLY the final sendable message text.
Do not return JSON. Do not return a label, analysis, explanation, quotation marks, markdown, or a proposed reply wrapper.
Never say "as Moshe", "Moshe can reply", "you can answer", "proposed reply", or anything that describes what someone could send.
Answer the newest inbound message directly.
Use VERIFIED BUSINESS INFORMATION whenever it contains the answer, especially for hours, services, website, contact details, or prices.
If the required fact is not verified, do not invent it. Say briefly that Moshe will follow up, or ask one useful clarification.
${hasOutbound ? 'This is an ongoing conversation. Do not restart it with an introduction or generic greeting.' : 'A short greeting is allowed only when it sounds natural.'}
Match the newest inbound message language.
Be concise, warm, practical, and human.
${isWhatsApp ? 'Do not write the automation disclosure. The extension appends it after the reply.' : ''}
${writing}
${business}
VISIBLE CONVERSATION:
${context}
NEWEST INBOUND MESSAGE:
${latest}`

    let lastReason = 'The model returned a blank reply.'
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const raw = await ollamaText(`${prompt}\n${attempt ? `Previous draft was rejected because: ${lastReason}. Rewrite only the final sendable reply.` : ''}`, 480)
      let message = base.sendable(raw, 1800)
      if (!message) {
        lastReason = 'The draft was blank or contained meta narration.'
        continue
      }
      if (!base.languageCompatible(latest, message)) {
        lastReason = 'The reply language did not match the inbound message.'
        continue
      }
      if (isWhatsApp) message = `${message}\n\n${automatedDisclosure(latest)}`
      return {allowed: true, message, reply: message, reason: 'reply approved without JSON parsing'}
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
    const business = base.businessGuidance(body?.safeguards || settings.replySafeguards)
    const prompt = `Write the exact LinkedIn comment reply to the newest comment below.
Return ONLY the final sendable reply text.
Do not return JSON. Do not return analysis, a label, quotation marks, markdown, or a proposed reply wrapper.
Never say "as Moshe", "Moshe can reply", "you can answer", or anything describing the reply.
Respond specifically to the newest commenter and continue the visible conversation naturally.
Use no more than two short sentences.
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
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const raw = await ollamaText(`${prompt}\n${attempt ? `Previous draft was rejected because: ${lastReason}. Return only the sendable reply.` : ''}`, 320)
      const reply = base.sendable(raw, 900)
      if (!reply) {
        lastReason = 'The draft was blank or contained meta narration.'
        continue
      }
      if (!base.languageCompatible(latest, reply)) {
        lastReason = 'The reply language did not match the newest comment.'
        continue
      }
      return {allowed: true, reply, message: reply, reason: 'comment reply approved without JSON parsing'}
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
