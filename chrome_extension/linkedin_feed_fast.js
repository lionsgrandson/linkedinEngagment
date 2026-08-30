;(() => {
  if (location.hostname !== 'www.linkedin.com' || !location.pathname.startsWith('/feed')) return
  if (new URLSearchParams(location.search).has('cc_scheduled_post')) return
  if (window.__codeCrafterBridge) return
  window.__codeCrafterBridge = true

  const VERSION = '3.20.14'
  const CYCLE_MS = 3500
  const SUBMIT_COUNTDOWN_MS = 2500
  const ACTION_SETTLE_MIN_MS = 1200
  const ACTION_SETTLE_MAX_MS = 2200
  const processed = new Set()
  let busy = false
  let paused = false

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const visible = (node) => Boolean(node && node.isConnected && node.offsetParent !== null)
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim()
  const api = (path, method = 'GET', body = null) =>
    chrome.runtime.sendMessage({type: 'localApi', path, method, body})

  function panel() {
    if (document.getElementById('cc-fast-feed-controls')) return
    const box = document.createElement('div')
    box.id = 'cc-fast-feed-controls'
    box.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;width:240px;padding:12px;border-radius:12px;background:#111827;color:white;font:13px Arial;box-shadow:0 8px 30px #0006'
    box.innerHTML = `<b>CodeCrafter LinkedIn v${VERSION}</b><div id="cc-fast-feed-status" style="margin:8px 0">Starting...</div><button id="cc-fast-feed-pause" style="width:100%;padding:8px;border:0;border-radius:8px;background:#f59e0b;font-weight:700;cursor:pointer">Pause</button>`
    document.documentElement.appendChild(box)
    const button = document.getElementById('cc-fast-feed-pause')
    button.onclick = () => {
      paused = !paused
      button.textContent = paused ? 'Resume' : 'Pause'
      button.style.background = paused ? '#22c55e' : '#f59e0b'
      status(paused ? 'Paused. Nothing will be submitted.' : 'Running.')
    }
    CodeCrafterSettings.load().then(({ui}) => {
      if (!ui.showOverlay) box.style.display = 'none'
      if (ui.compactOverlay) Object.assign(box.style, {width: '205px', padding: '8px', fontSize: '12px'})
    }).catch(() => {})
  }

  function status(message) {
    panel()
    const node = document.getElementById('cc-fast-feed-status')
    if (node) node.textContent = message
  }

  async function waitWhilePaused() {
    while (paused) await sleep(150)
  }

  async function settle() {
    await waitWhilePaused()
    const ms = ACTION_SETTLE_MIN_MS + Math.random() * (ACTION_SETTLE_MAX_MS - ACTION_SETTLE_MIN_MS)
    await sleep(ms)
  }

  async function countdown(label) {
    const started = Date.now()
    while (Date.now() - started < SUBMIT_COUNTDOWN_MS) {
      await waitWhilePaused()
      const left = Math.max(0, SUBMIT_COUNTDOWN_MS - (Date.now() - started))
      status(`${label} sends in ${(left / 1000).toFixed(1)}s`)
      await sleep(100)
    }
    return !paused
  }

  function postNodes() {
    const legacy = [...document.querySelectorAll('div.feed-shared-update-v2')].filter(visible)
    if (legacy.length) return legacy
    return [...document.querySelectorAll('h2')]
      .filter((heading) => normalize(heading.textContent) === 'Feed post')
      .map((heading) => heading.closest("[role='listitem']"))
      .filter((node, index, all) => visible(node) && all.indexOf(node) === index)
  }

  function commentRoots(root) {
    return [...root.querySelectorAll(
      ".comments-comment-item,[data-view-name='comment-item'],[data-urn*='comment']",
    )].filter(visible)
  }

  function commentAuthor(root) {
    const actor = root.querySelector(
      "[data-view-name='comment-actor-name'],.comments-post-meta__name-text,.comments-comment-meta__description-title,a[href*='/in/']",
    )
    return normalize(actor?.innerText || actor?.textContent)
  }

  function hasOwnComment(root) {
    return commentRoots(root).some((comment) => /\bMoshe Schwartzberg\b/i.test(commentAuthor(comment)))
  }

  function hasExactComment(root, expected) {
    const signature = normalize(expected).slice(0, 100)
    return Boolean(signature) && commentRoots(root).some((comment) => normalize(comment.innerText).includes(signature))
  }

  function postIdentity(node, postText) {
    const urnNode = node.closest('[data-urn]') || node.querySelector('[data-urn]')
    const urn = urnNode?.getAttribute('data-urn') || node.getAttribute('data-id') || ''
    if (urn) return urn
    const activity = [...node.querySelectorAll("a[href*='/feed/update/'],a[href*='/posts/']")]
      .map((link) => link.href).find(Boolean)
    return activity || postText.slice(0, 300)
  }

  function extractPosts() {
    return postNodes().map((node, index) => {
      const postText = normalize(node.innerText).replace(/^Feed post\s*/i, '').slice(0, 5000)
      const authorLinks = [...node.querySelectorAll("a[href*='/in/']")]
      const authorUrl = authorLinks.find((link) => visible(link))?.href || authorLinks[0]?.href || ''
      const key = postIdentity(node, postText)
      return {
        index,
        key,
        text: postText,
        authorUrl,
        alreadyCommented: hasOwnComment(node),
        sponsored: /\b(?:Promoted|Sponsored)\b/i.test(node.innerText || ''),
        liked: Boolean(node.querySelector(
          "button[aria-pressed='true'],button[aria-label*='unreact' i],button[aria-label='Reaction button state: Like']",
        )),
        mediaUrls: [...node.querySelectorAll('img,video')]
          .filter((element) => element.tagName === 'VIDEO' || Number(element.naturalWidth || 0) >= 180)
          .map((element) => element.currentSrc || element.src || element.poster || '')
          .filter(Boolean).slice(0, 3),
      }
    }).filter((item) => item.text.length > 30 && !item.sponsored && !processed.has(item.key)).slice(0, 6)
  }

  function findActionNode(action) {
    const signature = normalize(action.sourceText || action.key).replace(/^Feed post\s*/i, '').slice(0, 180)
    if (!signature) return null
    return postNodes().find((node) => {
      const current = normalize(node.innerText).replace(/^Feed post\s*/i, '')
      return current.startsWith(signature) || current.includes(signature)
    }) || null
  }

  function setEditorText(editor, value) {
    editor.focus()
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      const prototype = editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(editor, value)
      editor.dispatchEvent(new Event('input', {bubbles: true}))
      editor.dispatchEvent(new Event('change', {bubbles: true}))
    } else {
      editor.textContent = ''
      document.execCommand('insertText', false, value)
      editor.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: value}))
    }
    return normalize(editor instanceof HTMLTextAreaElement ? editor.value : editor.textContent) === normalize(value)
  }

  async function waitForEditor(root, timeout = 6000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const editor = [...root.querySelectorAll(
        "div[contenteditable='true'][role='textbox'],textarea.comments-comment-box-comment__text-editor,textarea",
      )].find(visible)
      if (editor) return editor
      await sleep(150)
    }
    return null
  }

  async function confirmComment(root, expected, timeout = 8000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (hasExactComment(root, expected)) return true
      const feedback = normalize(document.querySelector("[role='alert'],.artdeco-toast-item")?.textContent)
      if (/couldn.?t|failed|try again|something went wrong/i.test(feedback)) return false
      await sleep(200)
    }
    return false
  }

  async function queueConnection(url) {
    if (!url) return
    const result = await chrome.runtime.sendMessage({type: 'openProfiles', urls: [url]})
    if (!result?.ok) status('Comment worked, but the profile could not be queued for connection.')
  }

  async function execute(action) {
    const node = findActionNode(action)
    if (!node) {
      status('LinkedIn moved the selected post. Skipping it and rescanning.')
      return false
    }
    node.scrollIntoView({behavior: 'smooth', block: 'center'})
    await sleep(350)

    if (action.like) {
      const like = [...node.querySelectorAll('button')].find((button) => {
        const label = `${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`
        return visible(button) && /Reaction button state: no reaction|React Like|^Like\b/i.test(label)
      })
      if (like && like.getAttribute('aria-pressed') !== 'true') {
        like.click()
        await sleep(350)
        await api('/result', 'POST', {
          ok: true,
          kind: 'like',
          actionId: `linkedin:like:${action.key}`,
          reason: 'LinkedIn like clicked in fast feed mode',
        })
      }
    }

    if (!action.comment) {
      if (action.connect) await queueConnection(action.authorUrl)
      return true
    }

    const commentButton = [...node.querySelectorAll("button,[role='button']")]
      .filter(visible)
      .find((button) => /^(Comment|Comment on this post)\b/i.test(normalize(`${button.textContent || ''} ${button.getAttribute('aria-label') || ''}`)))
    commentButton?.click()
    await sleep(450)

    if (hasOwnComment(node)) {
      status('Skipped duplicate: you already commented on this post.')
      return true
    }
    if (hasExactComment(node, action.comment)) {
      status('Skipped duplicate: the exact comment is already visible.')
      return true
    }

    const editor = await waitForEditor(node)
    if (!editor) {
      status('Comment editor was not found. The post will be retried later.')
      return false
    }
    if (!setEditorText(editor, action.comment)) {
      status('LinkedIn did not retain the comment draft. Retrying later.')
      return false
    }
    if (!(await countdown('Comment'))) return false

    if (hasOwnComment(node) || hasExactComment(node, action.comment)) {
      editor.textContent = ''
      editor.dispatchEvent(new Event('input', {bubbles: true}))
      status('Duplicate comment prevented before submit.')
      return true
    }

    const submit = node.querySelector('button.comments-comment-box__submit-button') ||
      [...node.querySelectorAll("button,[role='button']")]
        .filter(visible)
        .find((button) => /^(Comment|Post)$/i.test(normalize(button.textContent)) && !button.disabled)
    if (!submit || submit.disabled) {
      status('Comment Send button is not ready. The post will be retried.')
      return false
    }

    submit.click()
    const confirmed = await confirmComment(node, action.comment)
    await api('/result', 'POST', {
      ok: confirmed,
      kind: confirmed ? 'comment' : undefined,
      actionId: `linkedin:comment:${action.key}:${normalize(action.comment).slice(0, 160)}`,
      reason: confirmed ? 'LinkedIn displayed the exact fast feed comment' : 'LinkedIn did not confirm the comment',
    })
    status(confirmed ? 'Comment posted. Moving to the next post.' : 'Comment was not confirmed. It will be retried.')
    if (confirmed && action.connect) await queueConnection(action.authorUrl)
    return confirmed
  }

  async function cycle() {
    if (busy || paused) return
    busy = true
    try {
      const settings = await CodeCrafterSettings.load()
      const config = settings.platforms.linkedin
      if (!config?.enabled) {
        status('LinkedIn automation is disabled in Settings.')
        return
      }
      const candidates = extractPosts()
      if (!candidates.length) {
        status('No new visible posts. Scrolling for more...')
        postNodes().at(-1)?.scrollIntoView({behavior: 'smooth', block: 'end'})
        window.scrollBy({top: 650, behavior: 'smooth'})
        await settle()
        return
      }

      status(`Reviewing ${candidates.length} visible posts with Ollama...`)
      const response = await api('/cycle', 'POST', {
        posts: candidates,
        topics: config.topics,
        writingStyle: settings.writingStyle,
        safeguards: settings.replySafeguards,
        features: {
          likes: config.likes,
          comments: config.comments,
          commentEveryOrganicPost: config.commentEveryOrganicPost,
          connections: config.connections,
          imageRecognition: config.imageRecognition,
        },
      })
      if (!response?.ok) {
        status(`Ollama error: ${response?.data?.error || response?.error || 'unknown error'}`)
        return
      }

      const info = response.data || {}
      if (!info.action) {
        candidates.slice(0, Math.max(1, Number(info.checked || 1))).forEach((item) => processed.add(item.key))
        status(`No action selected. ${info.last_reason || 'Moving on.'}`)
        await settle()
        return
      }

      const succeeded = await execute(info.action)
      if (succeeded) processed.add(info.action.key)
      const node = findActionNode(info.action)
      node?.scrollIntoView({behavior: 'smooth', block: 'end'})
      window.scrollBy({top: 500, behavior: 'smooth'})
      await settle()
    } catch (error) {
      status(`Feed automation error: ${String(error).slice(0, 180)}`)
    } finally {
      busy = false
    }
  }

  panel()
  setInterval(cycle, CYCLE_MS)
  cycle()
})()