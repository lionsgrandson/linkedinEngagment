;(() => {
  if (window.__codeCrafterFacebookBridge || location.pathname.startsWith('/messages')) return
  window.__codeCrafterFacebookBridge = true
  const EXTENSION_VERSION = '3.20.10'
  const EXTENSION_BUILD = '4c4b609b3dee'
  const processed = new Set()
  let profileState = null
  let busy = false
  let paused = false
  let groupBaselineReady = false
  let groupLastReload = Date.now()
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const api = (path, method = 'GET', body = null) =>
    chrome.runtime.sendMessage({ type: 'localApi', path, method, body })
  const visible = (element) => element && element.offsetParent !== null
  const labels = (element) => [element?.textContent, element?.getAttribute?.('aria-label'), element?.getAttribute?.('title')]
    .filter(Boolean).map((value) => value.replace(/\s+/g, ' ').trim())
  const findControl = (root, pattern) => [...root.querySelectorAll("button,[role='button']")]
    .filter(visible).find((element) => labels(element).some((value) => pattern.test(value)))

  function panel() {
    if (document.getElementById('cc-fb-controls')) return
    const box = document.createElement('div'); box.id = 'cc-fb-controls'
    box.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;width:270px;padding:14px;border-radius:12px;background:#111827;color:white;font:14px Arial;box-shadow:0 8px 30px #0006'
    box.innerHTML = `<style>@keyframes ccFbPulse{50%{opacity:.35}}</style><b>CodeCrafter Facebook Bot v${EXTENSION_VERSION}</b><div id="cc-fb-status" style="margin:9px 0">Loading feed…</div><div id="cc-fb-skeleton" style="height:8px;width:70%;border-radius:8px;background:#475569;animation:ccFbPulse 1s infinite"></div><button id="cc-fb-pause" style="margin-top:10px;width:100%;padding:10px;border:0;border-radius:8px;background:#f59e0b;font-weight:700;cursor:pointer;transition:filter .15s">Pause bot</button>`
    document.documentElement.appendChild(box)
    CodeCrafterSettings.load().then(({ui}) => {
      if (!ui.showOverlay) box.style.display = 'none'
      if (ui.compactOverlay) Object.assign(box.style, {width: '205px', padding: '8px', fontSize: '12px'})
    })
    const button = box.querySelector('#cc-fb-pause')
    button.onmouseenter = () => (button.style.filter = 'brightness(1.15)')
    button.onmouseleave = () => (button.style.filter = 'none')
    button.onclick = () => { paused = !paused; button.textContent = paused ? 'Resume bot' : 'Pause bot'; status(paused ? 'Paused' : 'Running', 'filled') }
  }
  function status(message, phase = 'filled') {
    panel(); const node = document.getElementById('cc-fb-status'); node.textContent = message; node.dataset.phase = phase
    document.getElementById('cc-fb-skeleton').style.display = phase === 'loading' ? 'block' : 'none'
  }
  async function waitActive(ms) {
    let left = ms
    while (left > 0) { while (paused) await sleep(200); const start = Date.now(); await sleep(Math.min(200, left)); left -= Date.now() - start }
  }
  async function countdown(label) {
    let left = 10000
    while (left > 0) { while (paused) await sleep(200); status(`${label} in ${(left / 1000).toFixed(1)}s`); const start = Date.now(); await sleep(100); left -= Date.now() - start }
    return !paused
  }
  function facebookPostNodes() {
    const controls = [...document.querySelectorAll(
      "[aria-label='Like'],[aria-label='Unlike'],[aria-label='Remove Like'],[aria-label='React']",
    )].filter(visible)
    const nodes = controls.map((control) => {
      let node = control
      while (node && node !== document.body) {
        if (node.querySelector("[aria-label^='Actions for this post']") &&
            node.querySelector("[aria-label='Leave a comment']")) return node
        node = node.parentElement
      }
      return null
    }).filter(Boolean)
    return nodes.filter((node, index) => nodes.indexOf(node) === index)
  }
  function facebookItems() {
    return facebookPostNodes().filter(visible).map((node) => {
      const rect = node.getBoundingClientRect()
      const message = node.querySelector(
        "[data-ad-rendering-role='story_message'],[data-ad-comet-preview='message'],[data-ad-preview='message']",
      )
      const text = (message?.innerText || message?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 5000)
      const mediaUrls = [...node.querySelectorAll('img,video')]
        .filter((element) => element.tagName === 'VIDEO' || element.naturalWidth >= 180)
        .map((element) => element.currentSrc || element.src || element.poster || '').filter(Boolean).slice(0, 3)
      const postLinks = [...node.querySelectorAll("a[href*='/posts/']:not([href*='comment_id']),a[href*='permalink']:not([href*='comment_id'])")]
      const permalink = postLinks
        .map((link) => link.href).find(Boolean)
      const timeLabels = [...postLinks, ...node.querySelectorAll('abbr,time')]
        .flatMap((element) => labels(element)).join(' ')
      let ageSeconds = Number.POSITIVE_INFINITY
      if (/\b(?:just now|now|new)\b/i.test(timeLabels)) ageSeconds = 0
      const relative = timeLabels.match(/\b(\d+)\s*(s|sec(?:ond)?s?|m|min(?:ute)?s?)\b/i)
      if (relative) ageSeconds = Number(relative[1]) * (/^s/i.test(relative[2]) ? 1 : 60)
      const timestamp = [...node.querySelectorAll('time[datetime]')]
        .map((element) => Date.parse(element.getAttribute('datetime'))).find(Number.isFinite)
      if (Number.isFinite(timestamp)) ageSeconds = Math.max(0, (Date.now() - timestamp) / 1000)
      return {node, text, mediaUrls, ageSeconds, key: permalink || node.getAttribute('aria-posinset') || text.slice(0, 300), distance: Math.abs(rect.top + rect.height / 2 - innerHeight / 2)}
    }).filter((item) => item.text.length > 10)
  }
  function currentPost(excluded = null) {
    return facebookItems().filter((item) => !excluded?.has(item.key)).sort((a, b) => a.distance - b.distance)[0]
  }
  async function matchesConfiguredTopics(item, config) {
    if (CodeCrafterSettings.matchesTopics(item.text, config.topics)) return true
    if (!config.imageRecognition || !config.topics.length || !item.mediaUrls?.length) return false
    const response = await api('/analyze-social-images', 'POST', {
      site: 'facebook', imageUrls: item.mediaUrls, topics: config.topics,
    })
    return Boolean(response?.ok && response.data.allowed && response.data.relevant)
  }

  const facebookReservedPaths = new Set([
    'bookmarks', 'events', 'feed', 'friends', 'gaming', 'groups', 'marketplace',
    'memories', 'messages', 'notifications', 'pages', 'reel', 'reels', 'saved',
    'settings', 'stories', 'watch',
  ])
  function isFacebookProfilePage() {
    if (location.pathname === '/profile.php') return true
    const parts = location.pathname.split('/').filter(Boolean)
    if (parts[0]?.toLowerCase() === 'people' && parts.length >= 2) return true
    return parts.length === 1 && !facebookReservedPaths.has(parts[0]?.toLowerCase())
  }
  async function likeFacebookPost(item, reasonPrefix = 'Facebook', canLike = true) {
    if (!canLike) return {confirmed: false, already: false, limited: true}
    const already = findControl(item.node, /^(Unlike|Remove Like)$/i)
    if (already) return {confirmed: false, already: true}
    const like = findControl(item.node, /^Like$/i)
    if (!like) return {confirmed: false, already: false}
    like.click(); await waitActive(500)
    const confirmed = Boolean(findControl(item.node, /^(Unlike|Remove Like)$/i))
    await api('/result', 'POST', {
      ok: confirmed,
      kind: confirmed ? 'facebook_like' : undefined,
      actionId: `facebook:like:${item.key}`,
      reason: confirmed ? `${reasonPrefix} confirmed like` : `${reasonPrefix} like not confirmed`,
    })
    return {confirmed, already: false}
  }
  async function scrollFacebookProfileToBottom() {
    status('Profile top batch complete - scrolling to the bottom...', 'loading')
    let stable = 0; let previousHeight = -1
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const height = document.documentElement.scrollHeight
      window.scrollTo({top: height, behavior: 'smooth'}); await waitActive(1200)
      const currentHeight = document.documentElement.scrollHeight
      const atBottom = window.scrollY + innerHeight >= currentHeight - 24
      const loading = [...document.querySelectorAll("[role='progressbar'],[aria-label*='Loading']")].some(visible)
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
  async function runFacebookProfileBatch(config) {
    if (!isFacebookProfilePage()) { profileState = null; return false }
    if (!config.profileLikes) {
      status('Blank state - Facebook profile batch likes disabled', 'blank')
      return true
    }
    const profileUrl = `${location.origin}${location.pathname}${location.search}`
    if (!profileState || profileState.profileUrl !== profileUrl) {
      profileState = {profileUrl, phase: 'top', top: 0, bottom: 0, processed: new Set(), initialized: false}
    }
    const target = config.profileLikeCount
    if (!profileState.initialized) {
      profileState.initialized = true
      window.scrollTo({top: 0, behavior: 'smooth'}); await waitActive(700)
    }
    if (profileState.phase === 'top' && profileState.top >= target) {
      if (!(await scrollFacebookProfileToBottom())) return true
      profileState.phase = 'bottom'
    }
    if (profileState.phase === 'bottom' && profileState.bottom >= target) profileState.phase = 'done'
    if (profileState.phase === 'done') {
      status(`Success - profile complete; returning home after ${target} top and ${target} bottom likes`, 'success')
      profileState = null
      await waitActive(900)
      location.assign('https://www.facebook.com/')
      return true
    }
    const availability = await api('/social-availability', 'POST', {
      site: 'facebook', dailyLikeLimit: config.dailyLikeLimit,
      dailyFollowLimit: config.dailyFollowLimit,
    })
    if (availability?.data?.canLike === false) {
      status('Blank state - Facebook daily like limit reached; profile batch resumes tomorrow', 'blank')
      return true
    }
    const item = currentPost(profileState.processed)
    if (!item) {
      status(`Blank state - looking for another ${profileState.phase} profile post`, 'blank')
      window.scrollBy({top: profileState.phase === 'top' ? 650 : -650, behavior: 'smooth'})
      await waitActive(700)
      return true
    }
    profileState.processed.add(item.key)
    const result = await likeFacebookPost(item, 'Facebook profile batch', availability?.data?.canLike !== false)
    if (result.confirmed) profileState[profileState.phase] += 1
    if (result.limited) profileState.processed.delete(item.key)
    status(
      result.confirmed
        ? `Success - ${profileState.phase} profile batch ${profileState[profileState.phase]} of ${target} liked`
        : result.limited ? 'Blank state - Facebook daily like limit reached'
          : result.already ? 'Blank state - profile post already liked' : 'Failure - profile Like control not found',
      result.confirmed ? 'success' : result.already || result.limited ? 'blank' : 'failure',
    )
    window.scrollBy({top: profileState.phase === 'top' ? 650 : -300, behavior: 'smooth'})
    await waitActive(800)
    return true
  }
  async function setEditor(editor, text) {
    editor.focus(); document.execCommand('insertText', false, text)
    editor.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: text}))
  }
  async function comment(item, config, settings, endpoint = '/draft-social-comment') {
    const draft = await api(endpoint, 'POST', {
      site: 'facebook',
      context: item.text,
      topics: config.topics,
      writingStyle: settings.writingStyle,
      safeguards: settings.replySafeguards,
      intent: config.groupIntent,
    })
    if (!draft?.ok || !draft.data.allowed || !draft.data.comment) return {ok: false, reason: draft?.data?.reason || 'comment draft failed'}
    findControl(item.node, /^(Comment|Write a comment|Leave a comment)$/i)?.click(); await waitActive(600)
    const editor = [...item.node.querySelectorAll("[contenteditable='true'][role='textbox']")].find(visible)
    if (!editor) return {ok: false, reason: 'Facebook comment editor not found'}
    await setEditor(editor, draft.data.comment)
    if (!(await countdown('Facebook comment'))) return {ok: false, reason: 'paused'}
    editor.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true}))
    editor.dispatchEvent(new KeyboardEvent('keyup', {key: 'Enter', code: 'Enter', bubbles: true}))
    for (let i = 0; i < 24; i += 1) { await sleep(250); if (!editor.textContent.trim()) return {ok: true, reason: 'Facebook confirmed comment'} }
    return {ok: false, reason: 'Facebook did not confirm comment'}
  }
  const currentGroupUrl = () => {
    const match = location.pathname.match(/^\/groups\/([^/]+)/i)
    return match ? `https://www.facebook.com/groups/${match[1]}/` : ''
  }
  async function runFacebookGroupMonitor(settings, config) {
    const groupUrl = currentGroupUrl()
    if (!groupUrl || !new URLSearchParams(location.search).has('cc_group_monitor')) return false
    const groupId = location.pathname.match(/^\/groups\/([^/]+)/i)?.[1]
    const configured = config.groupUrls.some((raw) => {
      try { return new URL(raw).pathname.match(/^\/groups\/([^/]+)/i)?.[1] === groupId }
      catch (_error) { return false }
    })
    if (!config.groupMonitoring || !configured) {
      status('Blank state - this Facebook group is not enabled for monitoring', 'blank')
      return true
    }
    const items = facebookItems()
    const stored = await chrome.storage.local.get(['ccFacebookGroupSeen', 'ccFacebookGroupDetected'])
    const seen = stored.ccFacebookGroupSeen || {}
    const detected = stored.ccFacebookGroupDetected || {}
    if (!groupBaselineReady && !seen[groupUrl]) {
      seen[groupUrl] = Object.fromEntries(items.map((item) => [item.key, Date.now()]))
      await chrome.storage.local.set({ccFacebookGroupSeen: seen})
      groupBaselineReady = true
      status(`Blank state - monitoring baseline saved for ${items.length} existing group posts`, 'blank')
      return true
    }
    groupBaselineReady = true
    const groupSeen = seen[groupUrl] || {}
    const staleUnseen = items.filter((candidate) => !groupSeen[candidate.key] && candidate.ageSeconds > 120)
    for (const candidate of staleUnseen) groupSeen[candidate.key] = Date.now()
    if (staleUnseen.length) {
      seen[groupUrl] = groupSeen
      await chrome.storage.local.set({ccFacebookGroupSeen: seen})
    }
    const item = items.find((candidate) => !groupSeen[candidate.key] && candidate.ageSeconds <= 120)
    if (!item) {
      status('Blank state - waiting for a new Facebook group post', 'blank')
      if (Date.now() - groupLastReload > 60000) { groupLastReload = Date.now(); location.reload() }
      return true
    }
    const detectionKey = `${groupUrl}|${item.key}`
    if (!detected[detectionKey]) {
      detected[detectionKey] = Date.now()
      await chrome.storage.local.set({ccFacebookGroupDetected: detected})
    }
    const delayMs = Math.max(5, config.groupCommentDelaySeconds || 10) * 1000
    const remaining = delayMs - (Date.now() - detected[detectionKey])
    if (remaining > 0) {
      status(`Loading - new group post detected; reading it in ${(remaining / 1000).toFixed(1)}s`, 'loading')
      return true
    }
    status('Loading - checking the new group post against your requested intent', 'loading')
    const result = await comment(item, config, settings, '/draft-facebook-group-comment')
    groupSeen[item.key] = Date.now()
    seen[groupUrl] = groupSeen
    delete detected[detectionKey]
    await chrome.storage.local.set({ccFacebookGroupSeen: seen, ccFacebookGroupDetected: detected})
    await api('/result', 'POST', {ok: result.ok, kind: result.ok ? 'facebook_group_comment' : undefined,
      actionId: `facebook:group-comment:${item.key}`, reason: result.reason})
    status(result.ok ? 'Success - new Facebook group post comment confirmed'
      : `Blank state - new group post skipped: ${result.reason}`, result.ok ? 'success' : 'blank')
    return true
  }
  async function cycle() {
    if (busy || paused) return
    busy = true
    try {
      const settings = await CodeCrafterSettings.load(); const config = settings.platforms.facebook
      if (!config.enabled) return status('Blank state — Facebook automation disabled', 'blank')
      if (await runFacebookGroupMonitor(settings, config)) return
      if (await runFacebookProfileBatch(config)) return
      const item = currentPost()
      if (!item) { status('Blank state — no visible Facebook post', 'blank'); window.scrollBy({top: 700, behavior: 'smooth'}); return }
      if (processed.has(item.key)) { window.scrollBy({top: 650, behavior: 'smooth'}); return }
      processed.add(item.key)
      if (!(await matchesConfiguredTopics(item, config))) { status('Blank state — post does not match text or visual topics', 'blank'); window.scrollBy({top: 650, behavior: 'smooth'}); return }
      status('Processing matching Facebook post…', 'loading')
      const availability = await api('/social-availability', 'POST', {
        site: 'facebook', dailyLikeLimit: config.dailyLikeLimit,
        dailyFollowLimit: config.dailyFollowLimit,
      })
      if (config.likes) await likeFacebookPost(item, 'Facebook', availability?.data?.canLike !== false)
      if (config.follows && availability?.data?.canFollow !== false) {
        const follow = findControl(item.node, /^Follow$/i)
        if (follow) {
          follow.click(); await waitActive(600)
          const followed = Boolean(findControl(item.node, /^(Following|Requested)$/i))
          await api('/result', 'POST', {ok: followed, kind: followed ? 'facebook_follow' : undefined,
            actionId: `facebook:follow:${item.key}`,
            reason: followed ? 'Facebook confirmed follow' : 'Facebook follow not confirmed'})
        }
      }
      if (config.comments) { const result = await comment(item, config, settings); await api('/result', 'POST', {ok: result.ok, kind: result.ok ? 'facebook_comment' : undefined, actionId: `facebook:comment:${item.key}`, reason: result.reason}) }
      status('Success — Facebook post processed', 'success'); window.scrollBy({top: 650, behavior: 'smooth'}); await waitActive(900)
    } catch (error) { status(`Failure — ${String(error).slice(0, 140)}`, 'failure') }
    finally { busy = false }
  }
  panel(); api('/extension-heartbeat', 'POST', {site: 'facebook', extensionVersion: EXTENSION_VERSION, extensionBuild: EXTENSION_BUILD, url: location.href})
  setInterval(cycle, 5000); cycle()
})()
