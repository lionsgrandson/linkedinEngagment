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
  const visibleControlsText = () => [...document.querySelectorAll('button,a,[role=button]')]
    .map(visibleText).filter(Boolean).join(' | ')

  function extract() {
    const host = location.hostname
    if (host === 'www.instagram.com') {
      const reserved = new Set(['', 'accounts', 'direct', 'explore', 'reels', 'stories'])
      const slug = location.pathname.split('/').filter(Boolean)[0] || ''
      if (reserved.has(slug)) return null
      if (!/\bEdit profile\b/i.test(visibleControlsText())) return null
      const source = visibleText(document.querySelector('header'))
      if (!source) return null
      return {source: 'instagram', verification: {
        status: 'verified', method: 'self_profile_dom', account: slug, url: location.href,
      }, metrics: {
        posts: matchMetric(source, /([\d,.KMB]+)\s+posts?/i),
        followers: matchMetric(source, /([\d,.KMB]+)\s+followers?/i),
        following: matchMetric(source, /([\d,.KMB]+)\s+following/i),
      }}
    }
    if (host === 'www.linkedin.com' && location.pathname.startsWith('/mynetwork')) {
      const source = `${visibleText(document.querySelector('main'))} ${visibleControlsText()}`
      const connections = matchMetric(source, /(?:Show\s+)?([\d,.KMB+]+)\s+connections?/i)
      const navMe = [...document.querySelectorAll("button[aria-label$=' Me']")]
        .map((node) => (node.getAttribute('aria-label') || '').replace(/\s+Me$/, '').trim())
        .find(Boolean) || 'linkedin-self-network'
      if (!Number.isFinite(connections)) return null
      return {source: 'linkedin', verification: {
        status: 'verified', method: 'self_network_dom', account: navMe, url: location.href,
      }, metrics: {connections}}
    }
    if (host === 'www.linkedin.com' && /\/in\/|\/dashboard\//.test(location.pathname)) {
      const ownDashboard = location.pathname.includes('/dashboard/')
      const navMe = [...document.querySelectorAll("button[aria-label$=' Me']")]
        .map((node) => (node.getAttribute('aria-label') || '').replace(/\s+Me$/, '').trim())
        .find(Boolean) || ''
      const profileName = visibleText(document.querySelector('main h1'))
      if (!ownDashboard && (!navMe || !profileName || navMe.toLocaleLowerCase() !== profileName.toLocaleLowerCase()))
        return null
      const source = visibleText(document.querySelector('main'))
      return {source: 'linkedin', verification: {
        status: 'verified', method: 'self_profile_dom', account: navMe || 'linkedin-dashboard', url: location.href,
      }, metrics: {
        connections: matchMetric(source, /([\d,.KMB+]+)\s+connections?/i),
        followers: matchMetric(source, /([\d,.KMB]+)\s+followers?/i),
        profile_views: matchMetric(source, /([\d,.KMB]+)\s+profile viewers?/i),
        post_impressions: matchMetric(source, /([\d,.KMB]+)\s+post impressions?/i),
        search_appearances: matchMetric(source, /([\d,.KMB]+)\s+search appearances?/i),
      }}
    }
    if (host === 'www.facebook.com' && location.pathname !== '/') {
      if (!/\b(?:Edit profile|Manage Page|Professional dashboard)\b/i.test(visibleControlsText()))
        return null
      const source = visibleText(document.querySelector('main header, main [role=banner], main'))
      return {source: 'facebook', verification: {
        status: 'verified', method: 'self_profile_dom', account: location.pathname, url: location.href,
      }, metrics: {
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
