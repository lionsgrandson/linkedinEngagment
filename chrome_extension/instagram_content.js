;(() => {
  if (window.__codeCrafterInstagramBridge) return
  window.__codeCrafterInstagramBridge = true

  const EXTENSION_VERSION = '3.5.1'
  const EXTENSION_BUILD = 'e3e1b329a904'
  const processed = new Set()
  const explored = new Set()
  let paused = false
  let busy = false
  let sequence = 0
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const api = (path, method = 'GET', body = null) =>
    chrome.runtime.sendMessage({ type: 'localApi', path, method, body })

  function panel() {
    if (document.getElementById('cc-ig-controls')) return
    const box = document.createElement('div')
    box.id = 'cc-ig-controls'
    box.style.cssText =
      'position:fixed;right:18px;bottom:18px;z-index:2147483647;width:270px;padding:14px;border-radius:12px;background:#111827;color:#fff;font:14px Arial;box-shadow:0 8px 30px #0006'
    box.innerHTML = `<style>@keyframes ccIgPulse{50%{opacity:.35}}</style><b>CodeCrafter Instagram Bot v${EXTENSION_VERSION}</b><div id="cc-ig-status" style="margin:9px 0">Loading feed...</div><div id="cc-ig-skeleton" aria-label="Loading" style="display:grid;gap:6px;margin:8px 0"><i style="height:8px;background:#475569;border-radius:4px;animation:ccIgPulse 1s infinite"></i><i style="height:8px;width:68%;background:#475569;border-radius:4px;animation:ccIgPulse 1s infinite"></i></div><button id="cc-ig-pause" style="width:100%;padding:10px;border:0;border-radius:8px;background:#f59e0b;font-weight:700;cursor:pointer;transition:filter .15s">Pause bot</button>`
    document.documentElement.appendChild(box)
    const button = box.querySelector('#cc-ig-pause')
    button.onmouseenter = () => (button.style.filter = 'brightness(1.12)')
    button.onmouseleave = () => (button.style.filter = 'none')
    button.onclick = () => {
      paused = !paused
      button.textContent = paused ? 'Resume bot' : 'Pause bot'
      button.style.background = paused ? '#22c55e' : '#f59e0b'
      status(paused ? 'Paused - nothing will submit' : 'Running')
    }
  }

  function status(message, phase = 'filled') {
    panel()
    const statusNode = document.getElementById('cc-ig-status')
    statusNode.textContent = message
    statusNode.dataset.phase = phase
    document.getElementById('cc-ig-skeleton').style.display = phase === 'loading' ? 'grid' : 'none'
  }

  async function countdown(label) {
    let remaining = 10000
    while (remaining > 0) {
      while (paused) await sleep(200)
      status(`${label} in ${(remaining / 1000).toFixed(1)}s - Pause to hold`)
      const started = Date.now()
      await sleep(Math.min(100, remaining))
      remaining -= Date.now() - started
    }
    return !paused
  }

  const visible = (element) => {
    if (!element || element.offsetParent === null) return false
    const rect = element.getBoundingClientRect()
    return rect.bottom > 80 && rect.top < innerHeight - 80
  }

  function candidates() {
    const articles = [...document.querySelectorAll('article')]
    const reelVideos = [...document.querySelectorAll('main video')]
      .map((video) => video.closest("div[role='presentation']") || video.parentElement?.parentElement)
      .filter(Boolean)
    return [...new Set([...articles, ...reelVideos])].filter(visible)
  }

  function currentItem() {
    return candidates()
      .map((node) => {
        const rect = node.getBoundingClientRect()
        const caption = (node.innerText || '').trim().slice(0, 5000)
        const permalink = node.querySelector("a[href*='/p/'],a[href*='/reel/']")?.href || ''
        const authorLinks = node.querySelectorAll("header a[href^='/'],a[href^='/']")
        const authorUrl = [...authorLinks]
          .map((link) => link.href)
          .find((href) => !/\/(p|reel|explore|stories)\//.test(href)) || ''
        return { node, caption, permalink, authorUrl, distance: Math.abs(rect.top + rect.height / 2 - innerHeight / 2) }
      })
      .filter((item) => item.caption.length > 10)
      .sort((a, b) => a.distance - b.distance)[0]
  }

  async function advance() {
    const close = document.querySelector("div[role='dialog'] svg[aria-label='Close']")?.closest('button')
    if (close) {
      close.click()
      await sleep(800)
      return
    }
    window.scrollBy({ top: Math.max(600, innerHeight * 0.82), behavior: 'smooth' })
    await sleep(1000)
  }

  async function openExploreItem() {
    if (!location.pathname.startsWith('/explore')) return undefined
    const tile = [...document.querySelectorAll("main a[href*='/p/'],main a[href*='/reel/']")]
      .find((link) => visible(link) && !explored.has(link.href))
    if (!tile) return undefined
    explored.add(tile.href)
    sequence += 1
    if (sequence % 2 === 1) {
      status(`Skipped Explore item ${sequence} - every-other-post mode`, 'blank')
      await advance()
      return null
    }
    status(`Loading Explore item ${sequence}...`, 'loading')
    tile.click()
    await sleep(1200)
    return currentItem()
  }

  function controlLabel(element) {
    return [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.textContent,
      ...[...element.querySelectorAll('svg[aria-label],svg title')]
        .map((child) => child.getAttribute('aria-label') || child.textContent),
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  }

  function controlsNear(node) {
    const roots = [node]
    let parent = node.parentElement
    for (let depth = 0; parent && depth < 7; depth += 1) {
      roots.push(parent)
      if (parent.matches("article,div[role='dialog'],main")) break
      parent = parent.parentElement
    }
    roots.push(document.querySelector("div[role='dialog']"), document.querySelector('main'))
    const elements = [...new Set(roots.filter(Boolean).flatMap((root) =>
      [...root.querySelectorAll("button,div[role='button']")],
    ))].filter(visible)
    const center = node.getBoundingClientRect().top + node.getBoundingClientRect().height / 2
    return elements.sort((a, b) => {
      const aRect = a.getBoundingClientRect()
      const bRect = b.getBoundingClientRect()
      return Math.abs(aRect.top + aRect.height / 2 - center) - Math.abs(bRect.top + bRect.height / 2 - center)
    })
  }

  function findControl(node, kind) {
    const patterns = {
      like: /(^|\s)(like|curtir|me gusta|gefällt mir|j’aime|אהבתי)(\s|$)/i,
      unlike: /(unlike|remove like|no longer like)/i,
      comment: /(comment|תגובה|comentar|commenter)/i,
    }
    return controlsNear(node).find((element) => patterns[kind].test(controlLabel(element)))
  }

  function controlDiagnostics(node) {
    return controlsNear(node).map(controlLabel).filter(Boolean).slice(0, 8).join(' / ').slice(0, 500)
  }

  function clickLike(node) {
    if (findControl(node, 'unlike')) return { ok: true, changed: false, reason: 'Already liked' }
    const button = findControl(node, 'like')
    if (!button) return { ok: false, changed: false, reason: `Like control not found; controls=${controlDiagnostics(node)}` }
    button.click()
    return { ok: true, changed: true, reason: 'Instagram like clicked' }
  }

  async function addComment(node, comment) {
    if (!comment) return { ok: false, reason: 'Comment text was empty' }
    const commentControl = findControl(node, 'comment')
    commentControl?.click()
    let editor
    for (let attempt = 0; attempt < 10 && !editor; attempt += 1) {
      await sleep(200)
      editor = [...document.querySelectorAll("textarea,div[contenteditable='true'][role='textbox']")]
        .find((element) => visible(element) && !/search/i.test(element.getAttribute('aria-label') || ''))
    }
    if (!editor) return { ok: false, reason: `Comment editor unavailable; controls=${controlDiagnostics(node)}` }
    editor.focus()
    if (editor instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(editor, comment)
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      document.execCommand('insertText', false, comment)
    }
    await sleep(250)
    const submitRoot = editor.closest("form,div[role='dialog']") || document
    const submit = [...submitRoot.querySelectorAll('button,div[role="button"]')]
      .find((element) => visible(element) && (/^(Post|Submit)$/i.test(element.textContent.trim()) ||
        /^(Post|Submit) comment$/i.test(element.getAttribute('aria-label') || '')))
    if (!submit) return { ok: false, reason: 'Comment submit control unavailable' }
    submit.click()
    return { ok: true, reason: 'Instagram comment submitted' }
  }

  async function report(kind, ok, reason) {
    await api('/result', 'POST', { kind, ok, reason })
  }

  async function cycle() {
    panel()
    if (busy || paused) return
    busy = true
    try {
      let item = currentItem()
      let sequenceChosen = false
      if (!item) {
        const exploreItem = await openExploreItem()
        if (exploreItem === null) return
        if (exploreItem) {
          item = exploreItem
          sequenceChosen = true
        }
      }
      if (!item) {
        status('Blank state - no visible post or reel found', 'blank')
        return
      }
      const key = item.permalink || item.caption.slice(0, 250)
      if (processed.has(key)) {
        await advance()
        return
      }
      processed.add(key)
      if (!sequenceChosen) sequence += 1
      if (!sequenceChosen && sequence % 2 === 1) {
        status(`Skipped item ${sequence} - every-other-post mode`)
        await advance()
        return
      }
      status('Loading OCR - capturing the visible item...', 'loading')
      const controls = document.getElementById('cc-ig-controls')
      const previousDisplay = controls?.style.display || ''
      if (controls) controls.style.display = 'none'
      await sleep(80)
      let capture
      try {
        capture = await chrome.runtime.sendMessage({ type: 'captureVisible' })
      } finally {
        if (controls) controls.style.display = previousDisplay
      }
      if (!capture?.ok) {
        status('Failure - screenshot capture was blocked. Click the extension icon once on this tab.', 'failure')
        return
      }
      const response = await api('/instagram-decide', 'POST', {
        caption: item.caption,
        screenshot: capture.screenshot,
        diagnostics: { extensionVersion: EXTENSION_VERSION, extensionBuild: EXTENSION_BUILD },
      })
      if (!response?.ok || !response.data.allowed) {
        status(`Skipped after OCR - ${response?.data?.reason || 'decision failed'}`, 'blank')
        await advance()
        return
      }
      if (!(await countdown('Interaction starts'))) return
      if (response.data.like) {
        const liked = clickLike(item.node)
        if (liked.changed) await report('instagram_like', liked.ok, liked.reason)
        else await api('/result', 'POST', { ok: liked.ok, reason: liked.reason })
      }
      if (response.data.comment) {
        const commented = await addComment(item.node, response.data.comment)
        await report('instagram_comment', commented.ok, commented.reason)
      }
      status(`Success - interacted with item ${sequence}`, 'success')
      await advance()
    } catch (error) {
      status(`Failure - ${String(error).slice(0, 100)}`, 'failure')
    } finally {
      busy = false
    }
  }

  panel()
  api('/extension-heartbeat', 'POST', {
    site: 'instagram',
    extensionVersion: EXTENSION_VERSION,
    extensionBuild: EXTENSION_BUILD,
    url: location.href,
  }).then((heartbeat) => {
    if (!heartbeat?.ok) status('Failure - start Python with: python linkedin_bot.py', 'failure')
  })
  setInterval(cycle, 8000)
  cycle()
})()
