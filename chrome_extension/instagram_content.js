;(() => {
  if (window.__codeCrafterInstagramBridge || location.pathname.startsWith('/direct')) return
  window.__codeCrafterInstagramBridge = true

  const EXTENSION_VERSION = '3.18.3'
  const EXTENSION_BUILD = '6ab978f63b59'
  const processedPosts = new Set()
  const viewedStoryFrames = new Set()
  const PROFILE_STATE_KEY = 'ccInstagramProfileBatch'
  const STORY_ACTIVE_KEY = 'ccInstagramStoryBatchActive'
  const STORY_COUNT_KEY = 'ccInstagramStoryBatchCount'
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
    CodeCrafterSettings.load().then(({ui}) => {
      if (!ui.showOverlay) box.style.display = 'none'
      if (ui.compactOverlay) Object.assign(box.style, {width: '205px', padding: '8px', fontSize: '12px'})
    })
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
      const mediaUrls = [...node.querySelectorAll('img,video')]
        .filter((element) => element.tagName === 'VIDEO' || element.naturalWidth >= 180)
        .map((element) => element.currentSrc || element.src || element.poster || '').filter(Boolean).slice(0, 3)
      const text = (node.innerText || '').trim().slice(0, 5000)
      return { node, text, mediaUrls, key: permalink || media || text.slice(0, 250),
        distance: Math.abs(rect.top + rect.height / 2 - innerHeight / 2) }
    }).filter((item) => item.key).sort((a, b) => a.distance - b.distance)[0]
  }

  async function advanceFeed() {
    const close = document.querySelector("div[role='dialog'] svg[aria-label='Close']")?.closest('button')
    if (close) close.click()
    else window.scrollBy({ top: Math.max(600, innerHeight * 0.82), behavior: 'smooth' })
    await waitActive(900)
  }

  async function matchesConfiguredTopics(item, config) {
    if (CodeCrafterSettings.matchesTopics(item.text, config.topics)) return true
    if (!config.imageRecognition || !config.topics.length || !item.mediaUrls?.length) return false
    const response = await api('/analyze-social-images', 'POST', {
      site: 'instagram', imageUrls: item.mediaUrls, topics: config.topics,
    })
    return Boolean(response?.ok && response.data.allowed && response.data.relevant)
  }

  const instagramReservedPaths = new Set([
    'accounts', 'direct', 'explore', 'p', 'reel', 'reels', 'stories', 'web',
  ])

  function isInstagramProfilePage() {
    const parts = location.pathname.split('/').filter(Boolean)
    return parts.length === 1 && !instagramReservedPaths.has(parts[0].toLowerCase())
  }

  function readProfileState() {
    try { return JSON.parse(sessionStorage.getItem(PROFILE_STATE_KEY) || 'null') }
    catch { return null }
  }

  function writeProfileState(state) {
    sessionStorage.setItem(PROFILE_STATE_KEY, JSON.stringify(state))
  }

  function newProfileState(profileUrl) {
    return {profileUrl, phase: 'top', top: 0, bottom: 0, pending: '', processed: [], initialized: false}
  }

  function profilePostLinks(state) {
    return [...document.querySelectorAll("main a[href*='/p/'],main a[href*='/reel/']")]
      .filter(visible)
      .map((link) => ({link, url: new URL(link.href, location.origin).href}))
      .filter((item) => !state.processed.includes(item.url))
      .sort((a, b) => a.link.getBoundingClientRect().top - b.link.getBoundingClientRect().top)
  }

  async function scrollProfileToLoadedBottom() {
    status('Profile top batch complete - scrolling to the bottom...', 'loading')
    let stable = 0
    let previousHeight = -1
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const height = document.documentElement.scrollHeight
      window.scrollTo({top: height, behavior: 'smooth'})
      await waitActive(1200)
      const currentHeight = document.documentElement.scrollHeight
      const atBottom = window.scrollY + innerHeight >= currentHeight - 24
      const loading = [...document.querySelectorAll("[role='progressbar'],svg[aria-label='Loading...']")].some(visible)
      stable = currentHeight === previousHeight && atBottom && !loading ? stable + 1 : 0
      previousHeight = currentHeight
      if (stable >= 3) {
        status('Success - confirmed the full loaded profile bottom', 'success')
        return true
      }
    }
    status('Failure - profile bottom never stabilized; bottom batch is paused', 'failure')
    return false
  }

  async function likeProfilePost(item, actionId, canLike = true) {
    if (!canLike) return {confirmed: false, already: false, limited: true}
    const unlike = findControl(item.node, /(Unlike|Remove like|No longer like)/i)
    if (unlike) return {confirmed: false, already: true}
    const like = findControl(item.node, /^(Like|Curtir|Me gusta|Gefällt mir|J’aime|אהבתי)$/i)
    if (!like) return {confirmed: false, already: false}
    like.click()
    let confirmed = false
    for (let attempt = 0; attempt < 12 && !confirmed; attempt += 1) {
      await waitActive(250)
      confirmed = Boolean(findControl(item.node, /(Unlike|Remove like|No longer like)/i))
    }
    await api('/result', 'POST', {
      kind: confirmed ? 'instagram_like' : undefined,
      ok: confirmed,
      actionId: `instagram:like:${actionId}`,
      reason: confirmed ? 'Instagram confirmed profile-batch like' : 'Instagram profile-batch like not confirmed',
    })
    return {confirmed, already: false}
  }

  async function returnToProfile(state) {
    const close = document.querySelector("div[role='dialog'] svg[aria-label='Close']")?.closest('button')
    if (close) close.click()
    else if (/^\/(?:p|reel)\//.test(location.pathname)) history.back()
    await waitActive(900)
    state.pending = ''
    writeProfileState(state)
  }

  async function processPendingProfilePost(state, config) {
    if (!state?.pending) return false
    const viewerOpen = Boolean(document.querySelector("div[role='dialog']")) ||
      /^\/(?:p|reel)\//.test(location.pathname)
    if (!viewerOpen) {
      state.pending = ''
      writeProfileState(state)
      status('Failure - profile post did not open; moving to the next post', 'failure')
      return true
    }
    const item = currentPost()
    if (!item) {
      status('Failure - opened profile post was not ready', 'failure')
      return true
    }
    const availability = await api('/social-availability', 'POST', {
      site: 'instagram', dailyLikeLimit: config.dailyLikeLimit,
      dailyFollowLimit: config.dailyFollowLimit,
    })
    const result = await likeProfilePost(item, state.pending, availability?.data?.canLike !== false)
    if (result.confirmed) state[state.phase] += 1
    if (result.limited) state.processed = state.processed.filter((url) => url !== state.pending)
    writeProfileState(state)
    status(
      result.confirmed
        ? `Success - ${state.phase} profile batch ${state[state.phase]} liked`
        : result.limited ? 'Blank state - Instagram daily like limit reached'
          : result.already ? 'Blank state - profile post already liked' : 'Failure - profile Like control not found',
      result.confirmed ? 'success' : result.already || result.limited ? 'blank' : 'failure',
    )
    await returnToProfile(state)
    return true
  }

  async function runProfileBatch(config) {
    let state = readProfileState()
    if (state?.pending) return processPendingProfilePost(state, config)
    if (!isInstagramProfilePage()) return false
    const profileUrl = `${location.origin}${location.pathname}`
    if (!state || state.profileUrl !== profileUrl) state = newProfileState(profileUrl)
    if (!config.profileLikes) {
      status('Blank state - Instagram profile batch likes disabled', 'blank')
      return true
    }
    const target = config.profileLikeCount
    if (!state.initialized) {
      state.initialized = true
      window.scrollTo({top: 0, behavior: 'smooth'})
      await waitActive(700)
      writeProfileState(state)
    }
    if (state.phase === 'top' && state.top >= target) {
      if (!(await scrollProfileToLoadedBottom())) return true
      state.phase = 'bottom'
      writeProfileState(state)
    }
    if (state.phase === 'bottom' && state.bottom >= target) {
      state.phase = 'done'
      writeProfileState(state)
    }
    if (state.phase === 'done') {
      sessionStorage.removeItem(PROFILE_STATE_KEY)
      status(`Success - profile complete; returning home after ${target} top and ${target} bottom likes`, 'success')
      await waitActive(900)
      location.assign('/')
      return true
    }
    const availability = await api('/social-availability', 'POST', {
      site: 'instagram', dailyLikeLimit: config.dailyLikeLimit,
      dailyFollowLimit: config.dailyFollowLimit,
    })
    if (availability?.data?.canLike === false) {
      status('Blank state - Instagram daily like limit reached; profile batch resumes tomorrow', 'blank')
      return true
    }
    const links = profilePostLinks(state)
    const candidate = state.phase === 'bottom' ? links[links.length - 1] : links[0]
    if (!candidate) {
      status(`Blank state - no unprocessed ${state.phase} profile post found`, 'blank')
      return true
    }
    state.processed.push(candidate.url)
    state.pending = candidate.url
    writeProfileState(state)
    status(`Opening ${state.phase} profile post ${state[state.phase] + 1} of ${target}...`, 'loading')
    candidate.link.click()
    await waitActive(1200)
    return processPendingProfilePost(state, config)
  }

  function nextStoryEntry() {
    const link = [...document.querySelectorAll("a[href*='/stories/']")]
      .filter((item) => !item.getAttribute('href')?.includes('/highlights/'))
      .filter((item) => !/your story|view as codesite|codesite\.il/i.test(labels(item).join(' ')))
      .find(visible)
    if (link) return link
    return [...document.querySelectorAll("main button,main [role='button']")]
      .filter(visible)
      .find((item) => labels(item).some((label) =>
        /(?:view|open|watch).*stor|stor(?:y|ies)/i.test(label) &&
        !/your story|view as codesite|codesite\.il/i.test(label),
      ))
  }

  async function startStoryBatch() {
    if (location.pathname.startsWith('/stories/')) return false
    status('100 likes reached - scrolling to Stories...', 'loading')
    window.scrollTo({top: 0, behavior: 'smooth'})
    for (let attempt = 0; attempt < 20 && window.scrollY > 20; attempt += 1) await waitActive(200)
    await waitActive(600)
    const entry = nextStoryEntry()
    if (!entry) {
      status('Failure - Stories entry was not found; 100-like trigger remains pending', 'failure')
      return false
    }
    viewedStoryFrames.clear()
    sessionStorage.setItem(STORY_COUNT_KEY, '0')
    status('100 likes reached - loading stories...', 'loading')
    sessionStorage.setItem(STORY_ACTIVE_KEY, 'opening')
    entry.click()
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await waitActive(250)
      if (location.pathname.startsWith('/stories/')) {
        sessionStorage.setItem(STORY_ACTIVE_KEY, '1')
        status('Success - Stories opened', 'success')
        return true
      }
    }
    sessionStorage.removeItem(STORY_ACTIVE_KEY)
    status('Failure - Stories did not open; 100-like trigger remains pending', 'failure')
    return false
  }

  function storyFrameKey() {
    const media = [...document.querySelectorAll('main video,main img')]
      .filter(visible)
      .find((item) => item.tagName === 'VIDEO' || item.naturalWidth >= 300 || item.clientWidth >= 300)
    return `${location.href}|${media?.currentSrc || media?.src || ''}`
  }

  async function storyWatchTimeMs() {
    const video = [...document.querySelectorAll('main video')].find(visible)
    if (!video) return 7000
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      await Promise.race([
        new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, {once: true})),
        waitActive(2500),
      ])
    }
    if (!Number.isFinite(video.duration) || video.duration <= 0) return 10000
    return Math.max(1000, Math.min(120000, (video.duration - video.currentTime) * 1000 + 500))
  }

  async function finishStoryBatch() {
    findControl(document, /^(Close|Exit)$/i)?.click()
    await api('/instagram-story-batch-complete', 'POST', {})
    sessionStorage.removeItem(STORY_ACTIVE_KEY)
    sessionStorage.removeItem(STORY_COUNT_KEY)
    status('Success - watched stories to the end; returning to feed', 'success')
    await waitActive(900)
    if (location.pathname.startsWith('/stories/')) location.assign('https://www.instagram.com/')
  }

  async function viewStory(config) {
    const visibleText = (document.querySelector('main')?.innerText || '').replace(/\s+/g, ' ')
    if (/view as codesite|view story as codesite|your story/i.test(visibleText)) {
      status('Blank state - own CodeSite story is not an automation target', 'blank')
      await finishStoryBatch()
      return
    }
    const key = storyFrameKey()
    if (!key || /\|$/.test(key)) {
      status('Failure - story media did not finish loading', 'failure')
      const next = findControl(document, /^(Next|Tap to skip)$/i)
      if (next && !next.disabled) next.click()
      else await finishStoryBatch()
      return
    }
    if (viewedStoryFrames.has(key)) {
      const next = findControl(document, /^(Next|Tap to skip)$/i)
      if (next && !next.disabled) next.click()
      else {
        await finishStoryBatch()
      }
      return
    }
    viewedStoryFrames.add(key)
    status('Viewing story...', 'loading')
    await waitActive(await storyWatchTimeMs())
    const advancedAutomatically = storyFrameKey() !== key
    const next = findControl(document, /^(Next|Tap to skip)$/i)
    await api('/result', 'POST', {
      kind: 'instagram_story_view',
      ok: true,
      actionId: `instagram:story:${key}`,
      reason: 'Instagram story viewed before advancing',
    })
    const batchCount = Number(sessionStorage.getItem(STORY_COUNT_KEY) || 0) + 1
    sessionStorage.setItem(STORY_COUNT_KEY, String(batchCount))
    if (config.storyBatchLimit > 0 && batchCount >= config.storyBatchLimit) {
      await finishStoryBatch()
      return
    }
    if (advancedAutomatically) {
      status('Success - story played to the end', 'success')
      return
    }
    if (next && !next.disabled) {
      next.click()
      status('Success - viewed story and advancing', 'success')
      return
    }
    await finishStoryBatch()
  }

  async function likeAndMoveOn(availability, config) {
    const item = currentPost()
    if (!item) {
      status('Blank state - no new post or reel found', 'blank')
      await advanceFeed(); return
    }
    if (processedPosts.has(item.key)) { await advanceFeed(); return }
    processedPosts.add(item.key)
    if (!(await matchesConfiguredTopics(item, config))) {
      status('Blank state - item does not match Instagram topics', 'blank')
      await advanceFeed(); return
    }
    let liked = false
    let followed = false
    if (config.likes && availability.data.canLike) {
      const unlike = findControl(item.node, /(Unlike|Remove like|No longer like)/i)
      const like = unlike ? null : findControl(item.node, /^(Like|Curtir|Me gusta|Gefällt mir|J’aime|אהבתי)$/i)
      if (like) {
        like.click()
        for (let attempt = 0; attempt < 12 && !liked; attempt += 1) {
          await waitActive(250)
          liked = Boolean(findControl(item.node, /(Unlike|Remove like|No longer like)/i))
        }
        await api('/result', 'POST', {kind: liked ? 'instagram_like' : undefined, ok: liked,
          actionId: `instagram:like:${item.key}`,
          reason: liked ? 'Instagram confirmed like' : 'Instagram did not confirm like'})
      }
    }
    if (config.follows && availability.data.canFollow) {
      const follow = findControl(item.node, /^Follow$/i)
      if (follow) {
        follow.click(); await waitActive(600)
        followed = Boolean(findControl(item.node, /^(Following|Requested)$/i))
        await api('/result', 'POST', {kind: followed ? 'instagram_follow' : undefined, ok: followed,
          actionId: `instagram:follow:${item.key}`,
          reason: followed ? 'Instagram confirmed follow' : 'Instagram follow not confirmed'})
      }
    }
    const remaining = liked ? Math.max(0, availability.data.likesUntilStories - 1) :
      availability.data.likesUntilStories
    status(
      liked ? `Success - liked; ${remaining} likes until stories`
        : followed ? 'Success - matching account followed'
          : 'Blank state - no enabled action was available',
      liked || followed ? 'success' : 'blank',
    )
    await advanceFeed()
  }

  async function cycle() {
    panel()
    if (busy || paused) return
    busy = true
    try {
      const settings = await CodeCrafterSettings.load()
      const config = settings.platforms.instagram
      if (!config.enabled) return status('Blank state - Instagram automation disabled', 'blank')
      if (await runProfileBatch(config)) return
      if (location.pathname.startsWith('/stories/')) {
        if (sessionStorage.getItem(STORY_ACTIVE_KEY) === 'opening')
          sessionStorage.setItem(STORY_ACTIVE_KEY, '1')
        await viewStory(config)
      }
      else if (sessionStorage.getItem(STORY_ACTIVE_KEY) === '1') await finishStoryBatch()
      else {
        const availability = await api('/instagram-status', 'POST', {
          storyIntervalLikes: config.storyIntervalLikes,
          dailyLikeLimit: config.dailyLikeLimit,
          dailyFollowLimit: config.dailyFollowLimit,
          diagnostics: { extensionVersion: EXTENSION_VERSION, extensionBuild: EXTENSION_BUILD },
        })
        if (!availability?.ok) {
          status('Failure - start Python with: python linkedin_bot.py', 'failure')
        } else if (availability.data.shouldWatchStories && config.stories) {
          await startStoryBatch()
        } else {
          await likeAndMoveOn(availability, config)
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
