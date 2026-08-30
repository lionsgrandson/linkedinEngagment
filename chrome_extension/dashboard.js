;(() => {
  const $ = (id) => document.getElementById(id)
  const dayKey = (date = new Date()) => [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
  const number = (value) => Number(value || 0)
  const total = (record) => Object.values(record || {}).reduce((sum, value) => sum + number(value), 0)
  const title = (key) => String(key || '')
    .replace(/^linkedin_/, 'LinkedIn ')
    .replace(/^instagram_/, 'Instagram ')
    .replace(/^facebook_/, 'Facebook ')
    .replace(/^whatsapp_/, 'WhatsApp ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
  const ageText = (timestamp) => {
    if (!timestamp) return 'never'
    const age = Math.max(0, Date.now() - new Date(timestamp).getTime())
    if (age < 60000) return `${Math.round(age / 1000)}s ago`
    if (age < 3600000) return `${Math.round(age / 60000)}m ago`
    if (age < 86400000) return `${Math.round(age / 3600000)}h ago`
    return `${Math.round(age / 86400000)}d ago`
  }

  function metricGrid(node, record, emptyText) {
    node.textContent = ''
    const entries = Object.entries(record || {}).filter(([, value]) => number(value) > 0)
      .sort((a, b) => number(b[1]) - number(a[1]))
    if (!entries.length) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = emptyText
      node.appendChild(empty)
      return
    }
    for (const [key, value] of entries) {
      const card = document.createElement('article')
      card.className = 'action'
      const label = document.createElement('span')
      label.textContent = title(key)
      const strong = document.createElement('strong')
      strong.textContent = String(number(value))
      card.append(label, strong)
      node.appendChild(card)
    }
  }

  function renderActivity(log) {
    const node = $('activity')
    node.textContent = ''
    const entries = [...(Array.isArray(log) ? log : [])].reverse().slice(0, 30)
    if (!entries.length) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = 'No v3.20.15 activity has been recorded yet. The next confirmed action or failed submission will appear here.'
      node.appendChild(empty)
      return
    }
    for (const entry of entries) {
      const card = document.createElement('div')
      card.className = 'event'
      const head = document.createElement('div')
      head.className = 'event-head'
      const name = document.createElement('strong')
      name.className = entry.ok ? 'good' : 'bad'
      name.textContent = `${entry.ok ? 'CONFIRMED' : 'FAILED'}  ${title(entry.kind)}`
      const time = document.createElement('time')
      time.textContent = new Date(entry.at).toLocaleString()
      head.append(name, time)
      const reason = document.createElement('p')
      reason.textContent = entry.reason || entry.actionId || 'No additional result text was recorded.'
      card.append(head, reason)
      node.appendChild(card)
    }
  }

  function renderHeartbeats(status) {
    const node = $('heartbeats')
    node.textContent = ''
    const sites = status?.sites && typeof status.sites === 'object' ? status.sites : {}
    const entries = Object.entries(sites).sort((a, b) =>
      new Date(b[1]?.seenAt || 0).getTime() - new Date(a[1]?.seenAt || 0).getTime())
    if (!entries.length) {
      node.innerHTML = '<div class="empty">No browser heartbeat has been recorded. Reload the extension and refresh the automation tabs.</div>'
      return
    }
    for (const [site, heartbeat] of entries) {
      const row = document.createElement('div')
      row.className = 'heartbeat'
      const label = document.createElement('div')
      label.textContent = site
      const age = Date.now() - new Date(heartbeat?.seenAt || 0).getTime()
      const state = document.createElement('div')
      state.className = age < 90000 ? 'good' : age < 300000 ? 'warn' : 'bad'
      state.textContent = `${age < 90000 ? 'LIVE' : age < 300000 ? 'STALE' : 'OFFLINE'}  ${ageText(heartbeat?.seenAt)}`
      row.append(label, state)
      node.appendChild(row)
    }
  }

  async function liveTabCount(ids) {
    let live = 0
    for (const id of ids.filter((value) => Number.isInteger(Number(value)))) {
      try { await chrome.tabs.get(Number(id)); live += 1 } catch (_error) {}
    }
    return live
  }

  async function renderQueues(stored) {
    const node = $('queues')
    node.textContent = ''
    const pendingConnections = Array.isArray(stored.ccLinkedInPendingConnections)
      ? stored.ccLinkedInPendingConnections.length : 0
    const notificationTasks = Object.keys(stored).filter((key) => key.startsWith('notificationTask:')).length
    const profileTasks = Object.keys(stored).filter((key) => key.startsWith('profileTask:')).length
    const transactions = stored.ccWhatsAppSendTransactions && typeof stored.ccWhatsAppSendTransactions === 'object'
      ? Object.values(stored.ccWhatsAppSendTransactions) : []
    const txStates = transactions.reduce((result, tx) => {
      const state = String(tx?.state || 'unknown')
      result[state] = number(result[state]) + 1
      return result
    }, {})
    const messageTabs = stored.ccMessageAutomationTabs && typeof stored.ccMessageAutomationTabs === 'object'
      ? Object.values(stored.ccMessageAutomationTabs) : []
    const followupTabs = stored.ccLinkedInFollowupTabs && typeof stored.ccLinkedInFollowupTabs === 'object'
      ? Object.values(stored.ccLinkedInFollowupTabs) : []
    const liveTabs = await liveTabCount([
      ...messageTabs,
      ...followupTabs,
      stored.ccWhatsAppAutomationTabId,
    ])

    const facts = [
      ['Pending LinkedIn connections', pendingConnections],
      ['Queued notification replies', notificationTasks],
      ['Queued profile tasks', profileTasks],
      ['Live managed automation tabs', liveTabs],
    ]
    for (const [label, value] of facts) {
      const row = document.createElement('div')
      row.className = 'heartbeat'
      row.innerHTML = `<div>${label}</div><div class="${value ? 'warn' : 'muted'}">${value}</div>`
      node.appendChild(row)
    }
    for (const [state, value] of Object.entries(txStates).sort((a, b) => number(b[1]) - number(a[1]))) {
      const row = document.createElement('div')
      row.className = 'heartbeat'
      row.innerHTML = `<div>WhatsApp ${state}</div><div>${value}</div>`
      node.appendChild(row)
    }
  }

  async function render() {
    const statusNode = $('status')
    statusNode.textContent = 'Reading Chrome extension storage…'
    try {
      const stored = await chrome.storage.local.get(null)
      const today = dayKey()
      const native = stored.ccNativeMetrics || {day: today, totals: {}}
      const todayTotals = native.day === today && native.totals && typeof native.totals === 'object'
        ? native.totals : {}
      const lifetime = stored.ccLifetimeMetrics && typeof stored.ccLifetimeMetrics === 'object'
        ? stored.ccLifetimeMetrics : {}
      const activity = Array.isArray(stored.ccRealActivityLog) ? stored.ccRealActivityLog : []
      const failures = activity.filter((entry) => entry && entry.ok === false).length
      const pending = Array.isArray(stored.ccLinkedInPendingConnections)
        ? stored.ccLinkedInPendingConnections.length : 0

      $('today-total').textContent = String(total(todayTotals))
      $('today-date').textContent = today
      $('lifetime-total').textContent = String(total(lifetime))
      $('failure-total').textContent = String(failures)
      $('pending-total').textContent = String(pending)

      const startedAt = Number(stored.ccRealMetricsStartedAt || 0)
      $('tracking-since').textContent = startedAt
        ? new Date(startedAt).toLocaleString()
        : 'Starts with the next recorded result'
      $('tracking-note').textContent = startedAt
        ? `Lifetime counts below are real confirmed actions recorded since ${new Date(startedAt).toLocaleString()}. Older actions are not guessed or reconstructed.`
        : 'Lifetime tracking is newly enabled. Existing daily counters are shown under Today, and lifetime tracking starts with the next confirmed action. Older history will not be invented.'

      metricGrid($('today-actions'), todayTotals, 'No confirmed actions are stored for today.')
      metricGrid($('lifetime-actions'), lifetime, 'No lifetime actions have been recorded by the new real activity tracker yet.')
      renderActivity(activity)
      renderHeartbeats(stored.ccExtensionStatus)
      await renderQueues(stored)

      const latest = stored.ccLastBrowserResult
      $('latest-result').textContent = latest
        ? JSON.stringify(latest, null, 2)
        : 'No browser result has been recorded yet.'

      statusNode.textContent = `Loaded ${Object.keys(todayTotals).length} today metric types, ${activity.length} real activity records, and ${Object.keys(stored.ccExtensionStatus?.sites || {}).length} heartbeat sources.`
    } catch (error) {
      statusNode.textContent = `Dashboard failed to read extension data: ${String(error)}`
    }
  }

  $('version').textContent = `v${chrome.runtime.getManifest().version}`
  $('refresh').onclick = render
  $('open-settings').onclick = () => chrome.runtime.openOptionsPage()
  render()
})()
