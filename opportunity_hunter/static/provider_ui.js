;(() => {
  const select = document.getElementById('job-provider')
  if (select) {
    select.innerHTML = `
      <option value="auto">Auto (recommended)</option>
      <option value="tavily">Tavily</option>
      <option value="searxng">Local SearXNG</option>
      <option value="adzuna">Adzuna</option>
      <option value="brave">Brave Search (legacy/optional)</option>`
  }

  const rewriteIntegrationCard = () => {
    const root = document.getElementById('integration-grid')
    if (!root) return
    for (const card of root.querySelectorAll('.integration')) {
      const name = card.querySelector('strong')
      const detail = card.querySelector('span')
      if (!name || name.textContent !== 'Brave Search') continue
      name.textContent = 'Web Search'
      if (detail?.textContent === 'API key configured') {
        detail.textContent = 'Tavily, SearXNG, or Brave configured'
      } else if (detail) {
        detail.textContent = 'Use TAVILY_API_KEY or local SEARXNG_URL'
      }
    }
  }

  const root = document.getElementById('integration-grid')
  if (root) {
    rewriteIntegrationCard()
    new MutationObserver(rewriteIntegrationCard).observe(root, {childList: true, subtree: true})
  }
})()
