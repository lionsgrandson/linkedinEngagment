;(() => {
  if (window.__codeCrafterAccountMetrics) return
  window.__codeCrafterAccountMetrics = true

  const visibleText = (node) => node && node.offsetParent !== null
    ? (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim()
    : ''
  const number = (value) => {
    const match = String(value).replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i)
    if (!match) return null
    const scale = {K: 1e3, M: 1e6, B: 1e9}[String(match[2] || '').toUpperCase()] || 1
    return Math.round(Number(match[1]) * scale)
  }
  const matchMetric = (source, pattern) => {
    const match = source.match(pattern)
    return match ? number(match[1]) : null
  }

  function extract() {
    const host = location.hostname
    if (host === 'www.instagram.com') {
      const reserved = new Set(['', 'accounts', 'direct', 'explore', 'reels', 'stories'])
      const slug = location.pathname.split('/').filter(Boolean)[0] || ''
      if (reserved.has(slug)) return null
      const source = visibleText(document.querySelector('header'))
      if (!source) return null
      return {source: 'instagram', metrics: {
        posts: matchMetric(source, /([\d,.KMB]+)\s+posts?/i),
        followers: matchMetric(source, /([\d,.KMB]+)\s+followers?/i),
        following: matchMetric(source, /([\d,.KMB]+)\s+following/i),
      }}
    }
    if (host === 'www.linkedin.com' && /\/in\/|\/dashboard\//.test(location.pathname)) {
      const source = visibleText(document.querySelector('main'))
      return {source: 'linkedin', metrics: {
        connections: matchMetric(source, /([\d,.KMB+]+)\s+connections?/i),
        followers: matchMetric(source, /([\d,.KMB]+)\s+followers?/i),
        profile_views: matchMetric(source, /([\d,.KMB]+)\s+profile viewers?/i),
        post_impressions: matchMetric(source, /([\d,.KMB]+)\s+post impressions?/i),
        search_appearances: matchMetric(source, /([\d,.KMB]+)\s+search appearances?/i),
      }}
    }
    if (host === 'www.facebook.com' && location.pathname !== '/') {
      const source = visibleText(document.querySelector('main header, main [role=banner], main'))
      return {source: 'facebook', metrics: {
        followers: matchMetric(source, /([\d,.KMB]+)\s+followers?/i),
        page_likes: matchMetric(source, /([\d,.KMB]+)\s+(?:people\s+)?likes?/i),
        friends: matchMetric(source, /([\d,.KMB]+)\s+friends?/i),
      }}
    }
    return null
  }

  async function capture() {
    const snapshot = extract()
    if (!snapshot) return
    snapshot.metrics = Object.fromEntries(
      Object.entries(snapshot.metrics).filter(([, value]) => Number.isFinite(value)),
    )
    if (!Object.keys(snapshot.metrics).length) return
    const storageKey = `ccAccountSnapshot:${snapshot.source}`
    const previous = (await chrome.storage.local.get(storageKey))[storageKey] || {}
    const current = JSON.stringify(snapshot.metrics)
    if (previous.metrics === current && Date.now() - Number(previous.at || 0) < 21600000) return
    const response = await chrome.runtime.sendMessage({
      type: 'localApi', path: '/account-snapshot', method: 'POST', body: snapshot,
    })
    if (response?.ok) {
      await chrome.storage.local.set({[storageKey]: {at: Date.now(), metrics: current}})
    }
  }

  setTimeout(() => capture().catch(() => {}), 4000)
  setInterval(() => capture().catch(() => {}), 300000)
})()
