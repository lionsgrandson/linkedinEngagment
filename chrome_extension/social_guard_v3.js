;(() => {
  const base = globalThis.CodeCrafterNativeBackend
  if (!base?.handle || globalThis.__codeCrafterSocialGuardV3) return
  globalThis.__codeCrafterSocialGuardV3 = true

  const originalHandle = base.handle.bind(base)
  const clean = (value, limit = 10000) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
  const UI_NOISE = /\b(?:Reaction button state:\s*(?:no reaction|Like)|React Like|Like Comment Repost Send|Add a comment|Open control menu for post|Follow|Connect)\b/ig
  const UNSUPPORTED_PERSONAL_CLAIM = /\b(?:i(?:'m| am|’m) (?:going|attending|joining)|i(?:'ll| will) (?:be there|attend|join|stop by|swing by|see you|catch you|meet you)|we(?:'re| are) (?:going|attending|joining)|we(?:'ll| will) (?:be there|attend|join|stop by|see you|meet you)|see you there|catch you there|can(?:'t|not) wait to (?:see|catch|meet|join)|looking forward to (?:seeing|meeting|catching) you|i(?:'ve| have) (?:used|tried|worked with|bought|implemented)|we(?:'ve| have) (?:used|tried|worked with|implemented)|as (?:a|your) customer|our clients (?:use|love|rely)|in my experience with (?:your|this))\b/i

  const sanitizePost = (value) => clean(String(value || '')
    .replace(UI_NOISE, ' ')
    .replace(/\b\d+\s+(?:reactions?|comments?|reposts?)\b/ig, ' ')
    .replace(/\b(?:Like|Comment|Repost|Send)\b(?:\s+\b(?:Like|Comment|Repost|Send)\b){2,}/ig, ' '), 7000)

  const unsupportedClaim = (comment) => UNSUPPORTED_PERSONAL_CLAIM.test(clean(comment, 3000))

  async function ollamaText(prompt, numPredict = 300) {
    const settings = await CodeCrafterSettings.load()
    const url = clean(settings.browserRuntime?.ollamaUrl, 1000)
    const model = clean(settings.browserRuntime?.ollamaModel, 200)
    if (!url || !model) throw new Error('Ollama URL and model are required in browser settings.')
    const response = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({model, prompt, stream: false, think: false,
        options: {temperature: 0.32, num_predict: numPredict}}),
    })
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`)
    const data = await response.json()
    return String(data?.response || '').trim()
  }

  async function groundedComment(postText, body) {
    const settings = await CodeCrafterSettings.load()
    const source = sanitizePost(postText)
    const writing = base.writingGuidance(body?.writingStyle || settings.writingStyle)
    const business = base.businessGuidance(body?.safeguards || settings.replySafeguards)
    const prompt = `Write one short LinkedIn comment responding to the post below.
Return ONLY the exact comment text to publish.
Maximum 2 short sentences and maximum 420 characters.
Sound like a normal person reacting to the idea in the post, not a salesperson and not an AI assistant.
Do not use markdown, headings, hashtags unless they are naturally necessary, numbered lists, or promotional language.
CRITICAL REALITY RULE: Never claim Moshe is attending an event, going somewhere, meeting the author, visiting a booth, using a product, being a customer, working with the company, having personal experience with the product, or having clients who use it unless that exact fact appears in VERIFIED BUSINESS INFORMATION. The post itself is not evidence about Moshe.
Never say things like "see you there", "can't wait to catch you", "I'll be there", "I've used this", or "we've worked with this" unless explicitly verified.
When a post announces an event, comment on the topic, idea, challenge, or question. Do not imply attendance.
Do not repeat LinkedIn interface text such as reaction buttons, Like, Comment, Repost, Send, or notification labels.
A useful default is one specific observation or one genuine question about the post.
Match the post language.
${writing}
${business}
POST CONTENT:
${source}`
    let reason = 'blank reply'
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const raw = await ollamaText(`${prompt}\n${attempt ? `Previous draft was rejected because: ${reason}. Rewrite only the final comment.` : ''}`, 260)
      const comment = base.sendable(raw, 600)
      if (!comment) { reason = 'meta narration or blank text'; continue }
      if ([...comment].length > 420) { reason = 'too long'; continue }
      if (unsupportedClaim(comment)) { reason = 'invented personal attendance, relationship, usage, or experience'; continue }
      if (/Reaction button state|React Like|Like Comment Repost Send/i.test(comment)) { reason = 'LinkedIn interface text leaked into the comment'; continue }
      if (!base.languageCompatible(source, comment)) { reason = 'wrong language'; continue }
      return comment
    }
    return ''
  }

  async function handle(path, method = 'GET', body = {}) {
    if (path === '/cycle' && String(method).toUpperCase() === 'POST') {
      const sanitizedBody = {...body, posts: Array.isArray(body.posts) ? body.posts.map((post) => ({
        ...post,
        text: sanitizePost(post?.text),
      })) : []}
      const result = await originalHandle(path, method, sanitizedBody)
      if (!result?.action?.comment) return result
      const selected = sanitizedBody.posts.find((post) => post.key === result.action.key) ||
        sanitizedBody.posts[Number(result.action.index)] || null
      const comment = clean(result.action.comment, 2000)
      if (!unsupportedClaim(comment) && !/Reaction button state|React Like|Like Comment Repost Send/i.test(comment)) return result
      const replacement = await groundedComment(selected?.text || result.action.sourceText || '', sanitizedBody)
      if (!replacement) {
        result.action.comment = null
        result.action.draftReason = 'Comment blocked because it invented a personal fact or contained LinkedIn interface text.'
        return result
      }
      result.action.comment = replacement
      result.action.sourceText = selected?.text || result.action.sourceText
      result.action.draftReason = 'Grounded comment rewritten to avoid invented personal claims.'
      return result
    }
    return originalHandle(path, method, body)
  }

  globalThis.CodeCrafterNativeBackend.handle = handle
})()
