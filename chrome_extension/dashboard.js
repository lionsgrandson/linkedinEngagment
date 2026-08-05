;(() => {
  const labels = {
    linkedin_like: 'LinkedIn likes', linkedin_comment: 'LinkedIn comments', linkedin_post: 'LinkedIn posts',
    facebook_like: 'Facebook likes', facebook_comment: 'Facebook comments', facebook_group_comment: 'Facebook group comments',
    instagram_like: 'Instagram likes', instagram_follow: 'Instagram follows', inbox_reply: 'Inbox replies',
  }
  async function render() {
    const status = document.getElementById('status'); const metrics = document.getElementById('metrics')
    status.textContent = 'Loading browser activity…'; status.dataset.phase = 'loading'; metrics.setAttribute('aria-busy', 'true')
    try {
      const stored = await chrome.storage.local.get(['ccNativeMetrics', 'ccLastBrowserResult'])
      const totals = stored.ccNativeMetrics?.totals || {}
      metrics.textContent = ''
      for (const [key, label] of Object.entries(labels)) {
        const card = document.createElement('article'); card.className = 'card'
        const name = document.createElement('span'); name.textContent = label
        const value = document.createElement('strong'); value.textContent = String(totals[key] || 0)
        card.append(name, value); metrics.appendChild(card)
      }
      const count = Object.values(totals).reduce((sum, value) => sum + Number(value || 0), 0)
      status.textContent = count ? `Success — ${count} confirmed browser actions recorded today.` : 'Blank state — no confirmed browser actions recorded today.'
      status.dataset.phase = count ? 'success' : 'blank'; metrics.setAttribute('aria-busy', 'false')
    } catch (error) {
      status.textContent = `Failure — ${String(error)}`; status.dataset.phase = 'failure'; metrics.setAttribute('aria-busy', 'false')
    }
  }
  document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`
  document.getElementById('refresh').onclick = render
  render()
})()
