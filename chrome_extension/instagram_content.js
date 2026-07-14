;(() => {
  if (window.__codeCrafterInstagramBridge) return
  window.__codeCrafterInstagramBridge = true

  const EXTENSION_VERSION = '3.7.0'
  const EXTENSION_BUILD = 'fd2bf36f0dac'
  const processedPosts = new Set()
  const viewedStoryFrames = new Set()
  let paused = false
  let busy = false
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const api = (path, method = 'GET', body = null) =>
    chrome.runtime.sendMessage({ type: 'localApi', path, method, body })

  function panel() {
    if (document.getElementById('cc-ig-controls')) return
    const box = document.createElement('div')
    box.id = 'cc-ig-controls'
    box.style.cssText =
      'position:fixed;right:18px;bottom:18px;z-index:2147483647;width:270px;padding:14px;border-radius:12px;background:#111827;color:#fff;font:14px Arial;box-shadow:0 8px 30px #0006'
    box.innerHTML = `<style>@keyframes ccIgPulse{50%{opacity:.35}}</style><b>CodeCrafter Instagram Bot v${EXTENSION_VERSION}</b><div id="cc-ig-status" style="margin:9px 0">Loading Instagram...</div><div id="cc-ig-skeleton" aria-label="Loading" style="display:grid;gap:6px;margin:8px 0"><i style="height:8px;background:#475569;border-radius:4px;animation:ccIgPulse 1s infinite"></i><i style="height:8px;width:68%;background:#475569;border-radius:4px;animation:ccIgPulse 1s infinite"></i></div><button id="cc-ig-pause" style="width:100%;padding:10px;border:0;border-radius:8px;background:#f59e0b;font-weight:700;cursor:pointer;transition:filter .15s">Pause bot</button>`
    document.documentElement.appendChild(box)
    const button = box.querySelector('#cc-ig-pause')
    button.onmouseenter = () => (button.style.filter = 'brightness(1.12)')
    button.onmouseleave = () => (button.style.filter = 'none')
    button.onclick = () => {
      paused = !paused
      button.textContent = paused ? 'Resume bot' : 'Pause bot'
      button.style.background = paused ? '#22c55e' : '#f59e0b'
      status(paused ? 'Paused - no likes or story advances' : 'Running')
    }
  }

  function status(message, phase = 'filled') {
    panel()
    const statusNode = document.getElementById('cc-ig-status')
    statusNode.textContent = message
    statusNode.dataset.phase = phase
    document.getElementById('cc-ig-skeleton').style.display = phase === 'loading' ? 'grid' : 'none'
  }

  async function waitActive(milliseconds) {
    let remaining = milliseconds
    while (remaining > 0) {
      while (paused) await sleep(200)
      const started = Date.now()
      await sleep(Math.min(200, remaining))
      remaining -= Date.now() - started
    }
  }

  const visible = (element) => {
    if (!element || element.offsetParent === null) return false
    const rect = element.getBoundingClientRect()
    return rect.bottom > 70 && rect.top < innerHeight - 70
  }

  const labels = (element) => [
    element?.textContent,
    element?.getAttribute?.('aria-label'),
    element?.getAttribute?.('title'),
    ...[...(element?.querySelectorAll?.('svg[aria-label],svg title') || [])]
      .map((child) => child.getAttribute('aria-label') || child.textContent),
  ].filter(Boolean).map((value) => value.replace(/\s+/g, ' ').trim())

  function controlsNear(node) {
    const roots = [node]
    let parent = node?.parentElement
    for (let depth = 0; parent && depth < 7; depth += 1) {
      roots.push(parent)
      if (parent.matches("article,div[role='dialog'],main")) break
      parent = parent.parentElement
    }
    roots.push(document.querySelector("div[role='dialog']"), document.querySelector('main'))
    return [...new Set(roots.filter(Boolean).flatMap((root) =>
      [...root.querySelectorAll("button,div[role='button']")],
    ))].filter(visible)
  }

  function findControl(node, pattern) {
    return controlsNear(node).find((element) => labels(element).some((value) => pattern.test(value)))
  }

  function currentPost() {
    const nodes = [
      ...document.querySelectorAll('article'),
      ...[...document.querySelectorAll('main video')]
        .map((video) => video.closest("div[role='presentation']") || video.parentElement?.parentElement),
    ].filter(Boolean).filter(visible)
    return [...new Set(nodes)].map((node) => {
      const rect = node.getBoundingClientRect()
      const permalink = node.querySelector("a[href*='/p/'],a[href*='/reel/']")?.href || ''
      const media = node.querySelector('video,img')?.currentSrc || node.querySelector('video,img')?.src || ''
      return { node, key: permalink || media || (node.innerText || '').slice(0, 250),
        distance: Math.abs(rect.top + rect.height / 2 - innerHeight / 2) }
    }).filter((item) => item.key).sort((a, b) => a.distance - b.distance)[0]
  }

  async function advanceFeed() {
    const close = document.querySelector("div[role='dialog'] svg[aria-label='Close']")?.closest('button')
    if (close) close.click()
    else window.scrollBy({ top: Math.max(600, innerHeight * 0.82), behavior: 'smooth' })
    await waitActive(900)
  }

  function nextStoryLink() {
    return [...document.querySelectorAll("a[href*='/stories/']")]
      .find(visible)
  }

  async function startStoryBatch() {
    if (location.pathname.startsWith('/stories/')) return false
    const link = nextStoryLink()
    if (!link) {
      await api('/instagram-story-batch-complete', 'POST', {})
      status('Blank state - no stories available; returning to likes', 'blank')
      return false
    }
    viewedStoryFrames.clear()
    status('100 likes reached - loading stories...', 'loading')
    link.click()
    await waitActive(1200)
    return true
  }

  function storyFrameKey() {
    const media = [...document.querySelectorAll('main video,main img')].find(visible)
    return `${location.href}|${media?.currentSrc || media?.src || ''}`
  }

  async function viewStory() {
    const key = storyFrameKey()
    if (!key || viewedStoryFrames.has(key)) {
      const next = findControl(document, /^(Next|Tap to skip)$/i)
      if (next && !next.disabled) next.click()
      else {
        findControl(document, /^(Close|Exit)$/i)?.click()
        await api('/instagram-story-batch-complete', 'POST', {})
        status('Success - watched stories to the end; returning to likes', 'success')
      }
      return
    }
    viewedStoryFrames.add(key)
    status('Viewing story...', 'loading')
    await waitActive(4000)
    const next = findControl(document, /^(Next|Tap to skip)$/i)
    const close = findControl(document, /^(Close|Exit)$/i)
    await api('/result', 'POST', {
      kind: 'instagram_story_view',
      ok: true,
      reason: 'Instagram story viewed before advancing',
    })
    if (next && !next.disabled) {
      next.click()
      status('Success - viewed story and advancing', 'success')
      return
    }
    close?.click()
    await api('/instagram-story-batch-complete', 'POST', {})
    status('Success - watched stories to the end; returning to likes', 'success')
  }

  async function likeAndMoveOn(availability) {
    const item = currentPost()
    if (!item) {
      status('Blank state - no new post or reel found', 'blank')
      await advanceFeed()
      return
    }
    if (processedPosts.has(item.key)) {
      await advanceFeed()
      return
    }
    processedPosts.add(item.key)
    const unlike = findControl(item.node, /(Unlike|Remove like|No longer like)/i)
    if (unlike) {
      status('Already liked - moving on', 'blank')
      await advanceFeed()
      return
    }
    const like = findControl(item.node, /^(Like|Curtir|Me gusta|Gefällt mir|J’aime|אהבתי)$/i)
    if (!like) {
      status('Failure - Like control not found; moving on', 'failure')
      await advanceFeed()
      return
    }
    like.click()
    let confirmed = false
    for (let attempt = 0; attempt < 12 && !confirmed; attempt += 1) {
      await waitActive(250)
      confirmed = Boolean(findControl(item.node, /(Unlike|Remove like|No longer like)/i))
    }
    await api('/result', 'POST', {
      kind: confirmed ? 'instagram_like' : undefined,
      ok: confirmed,
      reason: confirmed ? 'Instagram confirmed like' : 'Instagram did not confirm like',
    })
    const remaining = confirmed ? Math.max(0, availability.data.likesUntilStories - 1) :
      availability.data.likesUntilStories
    status(
      confirmed
        ? `Success - liked and moving on; ${remaining} likes until stories`
        : 'Failure - like was not confirmed',
      confirmed ? 'success' : 'failure',
    )
    await advanceFeed()
  }

  async function cycle() {
    panel()
    if (busy || paused) return
    busy = true
    try {
      if (location.pathname.startsWith('/stories/')) await viewStory()
      else {
        const availability = await api('/instagram-status', 'POST', {
          diagnostics: { extensionVersion: EXTENSION_VERSION, extensionBuild: EXTENSION_BUILD },
        })
        if (!availability?.ok) {
          status('Failure - start Python with: python linkedin_bot.py', 'failure')
        } else if (availability.data.shouldWatchStories) {
          await startStoryBatch()
        } else {
          await likeAndMoveOn(availability)
        }
      }
    } catch (error) {
      status(`Failure - ${String(error).slice(0, 120)}`, 'failure')
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
  setInterval(cycle, 6000)
  cycle()
})()
