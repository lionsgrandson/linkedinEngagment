;(() => {
  const dayKey = (date = new Date()) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')].join('-')
  const PUBLIC_WEBSITE = 'https://mosheschwartzberg.com'
  const COMMENT_MAX_CHARS = 500
  const clean = (value, limit = 10000) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
  const writingGuidance = (style) => {
    const content = clean(style?.content, 20000)
    if (!content) return 'No writing-style setting is configured. Write naturally, directly, and without hype.'
    return style?.sourceType === 'samples'
      ? `WRITING SAMPLES (use only as tone and rhythm evidence; never copy claims):\n${content}`
      : `WRITING INSTRUCTIONS (authoritative; follow them exactly):\n${content}`
  }
  const businessGuidance = (safeguards) => {
    const facts = clean(safeguards?.businessFacts, 30000)
    return facts
      ? `VERIFIED BUSINESS INFORMATION (the only company claims you may make):\n${facts}\nVerified website: ${PUBLIC_WEBSITE}`
      : `Verified website: ${PUBLIC_WEBSITE}. No other verified business information is configured. Do not invent services, contact details, prices, clients, availability, or results.`
  }
  const takeChars = (value, limit) => [...String(value || '')].slice(0, limit).join('')
  const hasMarkdown = (value) => /```|\*\*|__|`|^\s{0,3}#{1,6}\s|^\s*[-*+]\s|\[[^\]]+\]\([^)]+\)/m.test(String(value || ''))
  const sanitize = (value, limit = 2500) => takeChars(clean(String(value || '')
    .replace(/```(?:\w+)?/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^(?:here(?:'s| is)\s+)?(?:a\s+)?(?:proposed|suggested|good|possible)?\s*(?:comment|reply|post)(?:\s+as\s+moshe[^:]*)?\s*[:\-]\s*/i, '')
    .replace(/^(?:this\s+is\s+)?(?:a\s+)?good\s+way\s+to\s+(?:fix|write)\s+(?:the\s+)?comment(?:\s+in\s+(?:this|the)\s+post)?\s*[:\-.]?\s*/i, '')
    .replace(/^(?:moshe(?:\s+schwartzberg|\s+s\.?)?)\s*:\s*/i, ''), 20000), limit)

  const fitComment = (value, requiredWebsite = false) => {
    let comment = sanitize(value, 20000)
    if (requiredWebsite && comment && !comment.includes('mosheschwartzberg.com'))
      comment = `${comment.replace(/[.!?]?$/, '.')} ${PUBLIC_WEBSITE}`
    if ([...comment].length <= COMMENT_MAX_CHARS) return comment
    const suffix = requiredWebsite ? ` ${PUBLIC_WEBSITE}` : ''
    const room = COMMENT_MAX_CHARS - [...suffix].length
    let body = takeChars(comment.replace(PUBLIC_WEBSITE, '').trim(), room).replace(/\s+\S*$/, '').trim()
    body = body.replace(/[,;:\-\s]+$/, '')
    return `${body}${suffix}`.trim()
  }

  const POLITICAL_POST = /\b(?:politic(?:s|al|ian)?|election|ballot|government|parliament|congress|senate|president|prime minister|minister|democrat|republican|labou?r party|likud|knesset|coalition|opposition|geopolitic|zionis[mt]|gaza|palestin(?:e|ian)|hamas|hezbollah|netanyahu|trump|biden|war in (?:israel|ukraine))\b|(?:פוליטיק|בחירות|ממשלה|כנסת|קואליציה|אופוזיציה|ציונות|נתניהו|עזה|פלסטינ|חמאס|חיזבאללה)/iu
  const isPoliticalPost = (value) => POLITICAL_POST.test(clean(value, 10000))

  const scriptFamily = (value) => {
    const text = String(value || '')
    const counts = {
      he: (text.match(/[\u0590-\u05ff]/g) || []).length,
      ar: (text.match(/[\u0600-\u06ff]/g) || []).length,
      cyrl: (text.match(/[\u0400-\u04ff]/g) || []).length,
      han: (text.match(/[\u3400-\u9fff]/g) || []).length,
      latin: (text.match(/[A-Za-z\u00c0-\u024f]/g) || []).length,
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[1] >= 3
      ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : 'unknown'
  }
  const languageCompatible = (post, comment) => {
    const postScript = scriptFamily(post)
    const commentScript = scriptFamily(comment)
    return postScript === 'unknown' || commentScript === 'unknown' || postScript === commentScript
  }

  async function ollama(prompt, {json = false, numPredict = 700} = {}) {
    const settings = await CodeCrafterSettings.load()
    const url = settings.browserRuntime.ollamaUrl
    const model = settings.browserRuntime.ollamaModel
    if (!url || !model) throw new Error('Ollama URL and model are required in browser settings.')
    const response = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({model, prompt, stream: false, think: false, format: json ? 'json' : undefined,
        options: {temperature: 0.35, num_predict: numPredict}}),
    })
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`)
    const data = await response.json()
    return clean(data.response, 20000)
  }

  const parseJson = (value) => {
    try { return JSON.parse(value) }
    catch (_error) {
      const match = String(value).match(/\{[\s\S]*\}/)
      if (!match) throw new Error('The local model did not return valid JSON.')
      return JSON.parse(match[0])
    }
  }

  async function increment(kind, actionId = '') {
    const stored = await chrome.storage.local.get(['ccNativeMetrics', 'ccNativeActionIds'])
    const ids = stored.ccNativeActionIds || {}
    if (actionId && ids[actionId]) return {duplicate: true}
    const metrics = stored.ccNativeMetrics || {day: dayKey(), totals: {}}
    if (metrics.day !== dayKey()) { metrics.day = dayKey(); metrics.totals = {} }
    metrics.totals[kind] = Number(metrics.totals[kind] || 0) + 1
    if (actionId) ids[actionId] = Date.now()
    const pruned = Object.fromEntries(Object.entries(ids).sort((a, b) => b[1] - a[1]).slice(0, 3000))
    await chrome.storage.local.set({ccNativeMetrics: metrics, ccNativeActionIds: pruned})
    return {duplicate: false, count: metrics.totals[kind]}
  }

  async function draftSocialComment(site, context, style, safeguards, intent = '', requiredWebsite = false,
      feedComment = false) {
    if (!clean(context, 5000)) return {allowed: false, reason: 'The post text is blank.'}
    if (isPoliticalPost(context)) return {allowed: false, reason: 'Political content is never eligible for a comment.'}
    const analysis = parseJson(await ollama(`Identify the main language and whether this post is political.
Political includes elections, politicians, government, parties, geopolitical conflicts, war advocacy, nationalism, or political campaigning.
Return JSON only: {"language":"ISO 639-1 code","political":true|false,"reason":"short reason"}.
POST:\n${clean(context, 7000)}`, {json: true, numPredict: 160}))
    if (analysis.political) return {allowed: false, reason: `Political content is never eligible for a comment: ${clean(analysis.reason, 240)}`}
    const postLanguage = clean(analysis.language, 12).toLowerCase() || 'unknown'
    const prompt = `Write one sendable ${site} comment that responds specifically to the post below.
Return only the comment. No label, quotation marks, analysis, or markdown.
Write entirely in the post's main language (${postLanguage}). Do not switch languages; proper names and URLs are the only exceptions.
Use at most two short sentences and ${COMMENT_MAX_CHARS} characters. Never use asterisks, Markdown emphasis, headings, or bullet lists.
Write as Moshe in first person (I or we). Never refer to Moshe Schwartzberg in third person.
Sound like a real person leaving a quick comment, not a content-marketing assistant. Use plain words and a natural rhythm.
Avoid canned AI phrases such as "great insights", "this really resonates", "valuable perspective", "game changer",
"in today's rapidly evolving world", "it's not just about", "a powerful reminder", or "couldn't agree more".
If the author is explicitly requesting relevant help, make a concise helpful offer using only verified business facts.
If the author is sharing an insight rather than asking for help, add one useful observation or question and do not pitch services or mention a website.
Never claim that we already know the author or have delivered an unverified result.
The WRITING INSTRUCTIONS or WRITING SAMPLES control the voice. Business information is factual reference only and must never become corporate marketing copy.
${intent ? `TARGET INTENT:\n${clean(intent, 5000)}\n` : ''}
${writingGuidance(style)}
${businessGuidance(safeguards)}
POST:\n${clean(context, 7000)}`
    let lastReason = 'The local model returned a blank comment.'
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rawComment = await ollama(`${prompt}
${attempt ? 'The previous draft failed a safeguard. Make it shorter, more natural, more specific, and entirely in the required post language.' : ''}
${requiredWebsite ? `Include ${PUBLIC_WEBSITE} naturally in the comment.` : ''}`, {numPredict: 350})
      const usedMarkdown = hasMarkdown(rawComment)
      const comment = fitComment(rawComment, requiredWebsite)
      if (!comment) continue
      if (feedComment)
        return {allowed: true, comment, reason: 'Non-political feed post received a sendable comment.'}
      if (!languageCompatible(context, comment)) {
        lastReason = 'Comment language script does not match the post.'
        continue
      }
      const review = parseJson(await ollama(`Strictly review the proposed public comment against the post and saved writing style.
Reject it unless it is specific, natural, entirely in ${postLanguage}, non-political, no more than ${COMMENT_MAX_CHARS} characters, and follows the writing style instead of turning business facts into marketing copy.
Reject generic narration such as "this is a good way to fix the comment in this post", third-person references to Moshe, unrelated service promotion, or text reusable under an unrelated post.
Return JSON only: {"related":true|false,"sameLanguage":true|false,"styleMatch":true|false,"political":true|false,"reason":"short evidence","commentLanguage":"ISO 639-1 code"}.
${writingGuidance(style)}
POST:\n${clean(context, 7000)}\nPROPOSED COMMENT:\n${comment}`, {json: true, numPredict: 180}))
      if (review.related && review.sameLanguage && review.styleMatch && !review.political &&
          !usedMarkdown && [...comment].length <= COMMENT_MAX_CHARS &&
          clean(review.commentLanguage, 12).toLowerCase() === postLanguage)
        return {allowed: true, comment, reason: `Post/comment relevance confirmed: ${clean(review.reason, 300)}`}
      lastReason = `Comment safeguards rejected the draft: ${clean(review.reason, 300) || 'language, style, relevance, politics, Markdown, or length check failed'}`
    }
    return {allowed: false, reason: lastReason}
  }

  async function handle(path, method = 'GET', body = {}) {
    const settings = await CodeCrafterSettings.load()
    if (path === '/') return {version: chrome.runtime.getManifest().version, runtime: 'browser', ok: true}
    if (path === '/settings-audit') {
      const styleLength = Math.max(settings.writingStyle.content.length, writingGuidance(settings.writingStyle).length)
      const factLength = Math.max(settings.replySafeguards.businessFacts.length, businessGuidance(settings.replySafeguards).length)
      const reply = await ollama(`Reply with exactly OK after reading both blocks.\n${writingGuidance(settings.writingStyle)}\n${businessGuidance(settings.replySafeguards)}`, {numPredict: 32})
      return {ok: /^OK\b/i.test(reply), writingStyleCharacters: styleLength,
        businessFactCharacters: factLength, model: settings.browserRuntime.ollamaModel,
        runtime: 'browser', response: reply.slice(0, 80)}
    }
    if (path === '/extension-heartbeat') {
      const stored = await chrome.storage.local.get('ccExtensionStatus')
      const status = stored.ccExtensionStatus || {sites: {}}
      const heartbeat = {...body, seen: true, seenAt: new Date().toISOString()}
      status.sites[body.site || 'unknown'] = heartbeat
      status.latest = heartbeat
      await chrome.storage.local.set({ccExtensionStatus: status})
      return {ok: true, runtime: 'browser'}
    }
    if (path === '/extension-status') return (await chrome.storage.local.get('ccExtensionStatus')).ccExtensionStatus || {seen: false}
    if (path === '/result') {
      if (body.ok && body.kind) await increment(body.kind, body.actionId)
      if (body.ok && body.kind === 'instagram_like') {
        const stored = await chrome.storage.local.get('ccInstagramStoryState')
        const state = stored.ccInstagramStoryState || {likesSinceStories: 0, storyMode: false}
        state.likesSinceStories = Number(state.likesSinceStories || 0) + 1
        const interval = settings.platforms.instagram.storyIntervalLikes || 100
        state.storyMode = state.likesSinceStories >= interval
        await chrome.storage.local.set({ccInstagramStoryState: state})
      }
      await chrome.storage.local.set({ccLastBrowserResult: {...body, at: new Date().toISOString()}})
      return {ok: true}
    }
    if (path === '/social-availability') {
      const metrics = (await chrome.storage.local.get('ccNativeMetrics')).ccNativeMetrics || {day: dayKey(), totals: {}}
      const totals = metrics.day === dayKey() ? metrics.totals : {}
      const likes = Number(totals[`${body.site}_like`] || totals[`${body.site}_likes`] || 0)
      const follows = Number(totals[`${body.site}_follow`] || 0)
      return {canLike: !body.dailyLikeLimit || likes < body.dailyLikeLimit,
        canFollow: !body.dailyFollowLimit || follows < body.dailyFollowLimit, likes, follows}
    }
    if (path === '/instagram-status') {
      const stored = await chrome.storage.local.get('ccInstagramStoryState')
      const state = stored.ccInstagramStoryState || {likesSinceStories: 0, storyMode: false}
      const interval = Math.max(1, Number(body.storyIntervalLikes || settings.platforms.instagram.storyIntervalLikes || 100))
      const metrics = (await chrome.storage.local.get('ccNativeMetrics')).ccNativeMetrics || {day: dayKey(), totals: {}}
      const totals = metrics.day === dayKey() ? metrics.totals : {}
      const likes = Number(totals.instagram_like || 0)
      const follows = Number(totals.instagram_follow || 0)
      return {...state, canLike: !body.dailyLikeLimit || likes < body.dailyLikeLimit,
        canFollow: !body.dailyFollowLimit || follows < body.dailyFollowLimit,
        likesUntilStories: Math.max(0, interval - Number(state.likesSinceStories || 0)),
        shouldWatchStories: Boolean(state.storyMode || Number(state.likesSinceStories || 0) >= interval)}
    }
    if (path === '/instagram-story-batch-complete') {
      await chrome.storage.local.set({ccInstagramStoryState: {likesSinceStories: 0, storyMode: false}})
      return {ok: true, likesUntilStories: settings.platforms.instagram.storyIntervalLikes || 100}
    }
    if (path === '/draft-social-comment') return draftSocialComment(body.site || 'social', body.context,
      body.writingStyle || settings.writingStyle, body.safeguards || settings.replySafeguards)
    if (path === '/draft-facebook-group-comment') {
      const intent = clean(body.intent || settings.platforms.facebook.groupIntent, 5000)
      const decision = parseJson(await ollama(`Decide whether this new Facebook group post matches the target intent.
Return JSON only: {"relevant":true|false,"reason":"short reason"}.
TARGET INTENT:\n${intent}\nPOST:\n${clean(body.context, 7000)}`, {json: true, numPredict: 180}))
      if (!decision.relevant) return {allowed: false, reason: clean(decision.reason, 300) || 'Post does not match group intent.'}
      return draftSocialComment('Facebook group', body.context, body.writingStyle || settings.writingStyle,
        body.safeguards || settings.replySafeguards, intent, true)
    }
    if (path === '/draft-linkedin-post') {
      const prompt = `Write one original LinkedIn post ready to publish now.
Return only the post. No title label, analysis, markdown fences, or placeholders.
Make it useful and specific, end with a natural conversation question, and use only verified claims.
TOPICS:\n${settings.platforms.linkedin.topics.join(', ') || 'web development and business'}
${writingGuidance(settings.writingStyle)}
${businessGuidance(settings.replySafeguards)}`
      const post = sanitize(await ollama(prompt, {numPredict: 850}), 3000)
      return post ? {allowed: true, post, reason: 'Browser scheduled post used saved writing style and business information'}
        : {allowed: false, reason: 'The local model returned a blank post.'}
    }
    if (path === '/cycle') {
      const posts = Array.isArray(body.posts) ? body.posts.slice(0, 8) : []
      if (!posts.length) return {received: 0, checked: 0, action: null, last_reason: 'no visible posts'}
      const topics = Array.isArray(body.topics) ? body.topics : []
      const features = body.features || {}
      const eligible = posts.map((post, index) => ({post, index})).filter(({post}) =>
        !post.sponsored && !post.alreadyCommented && !isPoliticalPost(post.text) && clean(post.text, 5000))
      if (!eligible.length) return {received: posts.length, checked: posts.length, action: null, last_reason: 'no uncommented visible post'}
      const selection = features.commentEveryOrganicPost !== false
        ? {index: eligible[0].index, score: 100, reason: 'first visible non-sponsored post'}
        : parseJson(await ollama(`Choose the single LinkedIn post where a specific, useful comment from Moshe would be most relevant.
Use semantic meaning, not exact keyword matching. Reject job-seeker spam, unrelated promotions, politics outside the configured topics, and posts where a comment would add no value.
Return JSON only: {"index":number,"score":0-100,"reason":"specific reason"}. Use index -1 when none is at least 60/100 relevant.
CONFIGURED TOPICS:\n${topics.join(', ') || 'web development, technology, business, and personal growth'}
POSTS:\n${eligible.map(({post, index}) => `[${index}] ${clean(post.text, 1800)}`).join('\n\n')}`, {json: true, numPredict: 320}))
      const index = Number(selection.index)
      if (!Number.isInteger(index) || index < 0 || Number(selection.score || 0) < 60 || !posts[index])
        return {received: posts.length, checked: posts.length, action: null,
          last_reason: `semantic review found no suitable post: ${clean(selection.reason, 300) || 'below relevance threshold'}`}
      const item = posts[index]
      const commentResult = features.comments === false ? {allowed: false} : await draftSocialComment(
        'LinkedIn', item.text, body.writingStyle || settings.writingStyle,
        body.safeguards || settings.replySafeguards, '', false, true,
      )
      if (features.comments !== false && !commentResult.allowed && features.likes === false && features.connections !== true)
        return {received: posts.length, checked: index + 1, action: null,
          last_reason: `post selected ${Number(selection.score || 0)}/100 but comment rejected: ${commentResult.reason}`}
      return {received: posts.length, checked: index + 1,
        last_reason: `semantic relevance ${Number(selection.score || 0)}/100: ${clean(selection.reason, 300)}`,
        action: {index: Number(item.index ?? index), key: item.key, like: features.likes !== false, connect: features.connections === true,
          authorUrl: item.authorUrl || '', comment: commentResult.allowed ? commentResult.comment : '',
          sourceText: item.text, draftReason: commentResult.reason || 'comments disabled'}}
    }
    if (path === '/daily-followups') {
      const stored = await chrome.storage.local.get('ccLastDailyFollowupDay')
      const due = stored.ccLastDailyFollowupDay !== dayKey()
      if (due) await chrome.storage.local.set({ccLastDailyFollowupDay: dayKey()})
      return {due, pendingConnections: []}
    }
    if (path === '/notification-replies') return {candidates: []}
    if (path === '/draft-notification-reply' || path === '/draft-message' ||
        path === '/draft-connection' || path === '/draft-inbox-reply') {
      if (path === '/draft-inbox-reply') {
        const decision = CodeCrafterSettings.replyDecision(settings, body.contact, body.isGroup)
        if (!decision.allowed) return {allowed: false, reason: decision.reason}
      }
      const context = body.latestReply || body.context || body.message || body.profile || ''
      const drafted = await draftSocialComment(path.includes('connection') ? 'LinkedIn connection' : 'social reply',
        context, body.writingStyle || settings.writingStyle, body.safeguards || settings.replySafeguards)
      return drafted.allowed ? {allowed: true, reply: drafted.comment, message: drafted.comment, reason: drafted.reason}
        : drafted
    }
    if (path === '/analyze-social-images') return {allowed: false, relevant: false,
      reason: 'Browser-only image recognition requires a configured vision model.'}
    if (path === '/crm-test') {
      const crm = body.crm || settings.integrations.crm
      if (!crm?.enabled || !/^https:\/\//i.test(crm.webhookUrl || '')) return {delivered: false, error: 'CRM is not enabled or has no HTTPS webhook.'}
      const response = await fetch(crm.webhookUrl, {method: 'POST', headers: {'Content-Type': 'application/json',
        ...(crm.apiToken ? {Authorization: `Bearer ${crm.apiToken}`} : {})},
        body: JSON.stringify({type: 'connection_test', source: 'browser-extension'})})
      return {delivered: response.ok, status: response.status, error: response.ok ? '' : `CRM returned HTTP ${response.status}.`}
    }
    if (path === '/crm-event') {
      const crm = body.crm || settings.integrations.crm
      if (!crm?.enabled || !/^https:\/\//i.test(crm.webhookUrl || '')) return {delivered: false, error: 'CRM is not enabled or has no HTTPS webhook.'}
      const response = await fetch(crm.webhookUrl, {method: 'POST', headers: {'Content-Type': 'application/json',
        ...(crm.apiToken ? {Authorization: `Bearer ${crm.apiToken}`} : {})},
        body: JSON.stringify(body.event || {})})
      return {delivered: response.ok, status: response.status,
        error: response.ok ? '' : `CRM returned HTTP ${response.status}.`}
    }
    throw new Error(`Browser runtime does not support ${method} ${path}.`)
  }

  globalThis.CodeCrafterNativeBackend = {handle, writingGuidance, businessGuidance, sanitize,
    fitComment, hasMarkdown, isPoliticalPost, languageCompatible, COMMENT_MAX_CHARS}
})()
