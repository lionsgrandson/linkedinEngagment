;(() => {
  const state = { jobs: [], clients: [], approvals: [], resume: {}, integrations: {} }
  const $ = (selector, root = document) => root.querySelector(selector)
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]
  const notice = (message, phase = 'blank') => {
    const node = $('#notice')
    node.textContent = message
    node.dataset.phase = phase
  }
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"]/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]))

  async function api(path, body) {
    const options = body === undefined ? {} : {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Hunter-Request': '1'},
      body: JSON.stringify(body),
    }
    const response = await fetch(path, options)
    const payload = await response.json().catch(() => ({ok: false, error: `HTTP ${response.status}`}))
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`)
    return payload
  }

  function switchTab(name) {
    $$('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === name))
    $$('.panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === name))
  }

  $$('.tab').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)))

  function renderResume() {
    const resume = state.resume || {}
    $('#resume-status').textContent = resume.characters
      ? `${resume.name || 'Resume'} · ${Number(resume.characters).toLocaleString()} chars`
      : 'No resume loaded'
    $('#resume-preview').textContent = resume.preview || 'Nothing loaded yet.'
  }

  function renderIntegrations() {
    const rows = [
      ['Ollama', Boolean(state.ollama?.ok), state.ollama?.ok ? `Model: ${state.ollama.selected}` : state.ollama?.error || 'Not reachable'],
      ['Brave Search', Boolean(state.integrations?.braveSearch?.configured), state.integrations?.braveSearch?.configured ? 'API key configured' : 'Add BRAVE_SEARCH_API_KEY'],
      ['Adzuna', Boolean(state.integrations?.adzuna?.configured), state.integrations?.adzuna?.configured ? `Country: ${state.integrations.adzuna.country}` : 'Optional structured job source'],
      ['Email / SMTP', Boolean(state.integrations?.smtp?.configured), state.integrations?.smtp?.configured ? `From: ${state.integrations.smtp.from}` : 'Optional until you want approved email sending'],
      ['Twilio Voice', Boolean(state.integrations?.twilio?.configured), state.integrations?.twilio?.configured ? `From: ${state.integrations.twilio.from}` : 'Optional until you want approved TTS calls'],
    ]
    $('#integration-grid').innerHTML = rows.map(([name, configured, detail]) => `
      <article class="card integration">
        <div><strong>${escapeHtml(name)}</strong><span>${escapeHtml(detail)}</span></div>
        <i class="dot ${configured ? 'on' : ''}" aria-label="${configured ? 'configured' : 'not configured'}"></i>
      </article>`).join('')
    $('#health').innerHTML = state.ollama?.ok
      ? `<span class="health-good">Ollama connected</span><br>${escapeHtml(state.ollama.selected)}`
      : `<span class="health-bad">Ollama offline</span><br>${escapeHtml(state.ollama?.error || 'Start Ollama')}`
  }

  function renderJobs() {
    const root = $('#job-results')
    if (!state.jobs.length) {
      root.innerHTML = '<div class="empty">No job results yet.</div>'
      return
    }
    root.innerHTML = state.jobs.map((job) => `
      <article class="result-card" data-job-id="${escapeHtml(job.id)}">
        <div class="result-top">
          <div><h3>${escapeHtml(job.title || 'Untitled job')}</h3><div class="meta">${escapeHtml(job.company || job.source || '')}${job.location ? ` · ${escapeHtml(job.location)}` : ''}</div></div>
          <div class="score">${Number(job.matchScore || 0)}%</div>
        </div>
        <p class="description">${escapeHtml(job.matchReason || job.description || '').slice(0, 1200)}</p>
        ${job.gaps?.length ? `<div class="contact-list">${job.gaps.map((gap) => `<span class="contact-chip">Gap: ${escapeHtml(gap)}</span>`).join('')}</div>` : ''}
        <div class="result-actions">
          <button class="primary small" data-action="application">Prepare application</button>
          <a class="secondary small" href="${escapeHtml(job.url)}" target="_blank" rel="noreferrer">Open job</a>
        </div>
      </article>`).join('')
    $$('[data-action="application"]', root).forEach((button) => {
      button.addEventListener('click', () => prepareApplication(button.closest('[data-job-id]').dataset.jobId))
    })
  }

  function contactChips(client) {
    const values = [
      ...(client.emails || []).map((value) => `Email: ${value}`),
      ...(client.phones || []).map((value) => `Phone: ${value}`),
    ]
    return values.length ? `<div class="contact-list">${values.map((value) => `<span class="contact-chip">${escapeHtml(value)}</span>`).join('')}</div>` : ''
  }

  function renderClients() {
    const root = $('#client-results')
    if (!state.clients.length) {
      root.innerHTML = '<div class="empty">No client candidates yet.</div>'
      return
    }
    root.innerHTML = state.clients.map((client) => `
      <article class="result-card" data-client-id="${escapeHtml(client.id)}">
        <div class="result-top">
          <div><h3>${escapeHtml(client.name || client.domain || 'Potential client')}</h3><div class="meta">${escapeHtml(client.domain || '')}</div></div>
          ${client.fitScore ? `<div class="score">${Number(client.fitScore)}%</div>` : ''}
        </div>
        <p class="description">${escapeHtml(client.fitReason || client.research || client.snippet || '').slice(0, 1400)}</p>
        ${contactChips(client)}
        <div class="result-actions">
          <button class="secondary small" data-action="research">Research website</button>
          <button class="primary small" data-action="email">Draft email</button>
          <button class="secondary small" data-action="whatsapp">Draft WhatsApp</button>
          <button class="secondary small" data-action="call">Draft TTS call</button>
          <a class="secondary small" href="${escapeHtml(client.website)}" target="_blank" rel="noreferrer">Open website</a>
        </div>
      </article>`).join('')
    for (const action of ['research', 'email', 'whatsapp', 'call']) {
      $$(`[data-action="${action}"]`, root).forEach((button) => {
        button.addEventListener('click', () => runClientAction(action, button.closest('[data-client-id]').dataset.clientId))
      })
    }
  }

  function renderApprovals() {
    const root = $('#approval-results')
    if (!state.approvals.length) {
      root.innerHTML = '<div class="empty">No pending approvals. Drafts appear here until they are used.</div>'
      return
    }
    root.innerHTML = state.approvals.slice().reverse().map((item) => {
      const payload = item.payload || {}
      const client = payload.client || {}
      const summary = payload.subject || payload.message || payload.script || payload.applicationPack?.summary || ''
      return `<article class="result-card">
        <div class="result-top"><div><h3>${escapeHtml(item.kind.replaceAll('_', ' '))}</h3><div class="meta">${escapeHtml(client.name || payload.job?.title || '')} · ${escapeHtml(item.createdAt || '')}</div></div></div>
        <p class="description">${escapeHtml(summary).slice(0, 1200)}</p>
        <div class="meta">Approval ID: ${escapeHtml(item.id)}</div>
      </article>`
    }).join('')
  }

  async function refreshStatus() {
    const payload = await api('/api/status')
    state.resume = payload.resume || {}
    state.jobs = payload.jobs || []
    state.clients = payload.clients || []
    state.approvals = payload.approvals || []
    state.integrations = payload.integrations || {}
    state.ollama = payload.ollama || {}
    renderResume(); renderJobs(); renderClients(); renderApprovals(); renderIntegrations()
  }

  $('#resume-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (file.size > 8_000_000) return notice('Resume is larger than 8 MB.', 'failure')
    notice(`Reading ${file.name}…`, 'loading')
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      const chunk = 0x8000
      for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
      await api('/api/resume/upload', {name: file.name, content: btoa(binary)})
      await refreshStatus()
      notice(`Resume loaded: ${file.name}`, 'success')
    } catch (error) {
      notice(`Resume failed: ${error.message}`, 'failure')
    } finally {
      event.target.value = ''
    }
  })

  $('#save-resume-text').addEventListener('click', async () => {
    notice('Saving pasted resume…', 'loading')
    try {
      await api('/api/resume/text', {name: 'Pasted resume', text: $('#resume-text').value})
      await refreshStatus()
      notice('Pasted resume saved locally.', 'success')
    } catch (error) { notice(error.message, 'failure') }
  })

  $('#search-jobs').addEventListener('click', async () => {
    const query = $('#job-query').value.trim()
    if (!query) return notice('Enter the type of job you want.', 'failure')
    notice('Searching jobs and ranking them with Ollama…', 'loading')
    try {
      const payload = await api('/api/jobs/search', {
        query,
        location: $('#job-location').value.trim(),
        country: $('#job-country').value.trim(),
        provider: $('#job-provider').value,
        limit: 15,
      })
      state.jobs = payload.jobs || []
      renderJobs()
      notice(`Found ${state.jobs.length} jobs via ${payload.provider || 'search'}.`, 'success')
    } catch (error) { notice(`Job search failed: ${error.message}`, 'failure') }
  })

  async function prepareApplication(id) {
    const job = state.jobs.find((item) => item.id === id)
    if (!job) return
    notice(`Preparing application for ${job.title}…`, 'loading')
    try {
      const payload = await api('/api/jobs/application-pack', {job})
      const app = payload.application
      showDraft('Application pack', `
        <div class="draft-field"><strong>Fit summary</strong><p>${escapeHtml(app.summary || '')}</p></div>
        <div class="draft-field"><strong>Cover letter</strong><textarea rows="12" readonly>${escapeHtml(app.coverLetter || '')}</textarea></div>
        <div class="draft-field"><strong>Likely questions</strong>${(app.likelyQuestions || []).map((item) => `<p><b>${escapeHtml(item.question)}</b><br>${escapeHtml(item.answer)}</p>`).join('') || '<p>None generated.</p>'}</div>
        <div class="draft-field"><strong>Warnings to verify</strong><p>${escapeHtml((app.warnings || []).join(' · ') || 'None')}</p></div>`, [
          {label: 'Open application page', primary: true, click: () => window.open(job.url, '_blank', 'noopener,noreferrer')},
        ])
      await refreshApprovalsOnly()
      notice('Application pack ready. Review it before applying.', 'success')
    } catch (error) { notice(`Application draft failed: ${error.message}`, 'failure') }
  }

  $('#search-clients').addEventListener('click', async () => {
    const serviceType = $('#client-type').value.trim()
    if (!serviceType) return notice('Enter the type of client or service you want to sell.', 'failure')
    notice('Searching for potential clients…', 'loading')
    try {
      const payload = await api('/api/clients/search', {
        serviceType,
        location: $('#client-location').value.trim(),
        country: $('#client-country').value.trim(),
        limit: 12,
      })
      state.clients = payload.clients || []
      renderClients()
      notice(`Found ${state.clients.length} potential client websites. Research each before outreach.`, 'success')
    } catch (error) { notice(`Client search failed: ${error.message}`, 'failure') }
  })

  async function runClientAction(action, id) {
    const client = state.clients.find((item) => item.id === id)
    if (!client) return
    const serviceType = $('#client-type').value.trim()
    const senderContext = $('#sender-context').value.trim()
    if (action === 'research') {
      notice(`Researching ${client.name}…`, 'loading')
      try {
        const payload = await api('/api/clients/research', {client, serviceType})
        state.clients = state.clients.map((item) => item.id === id ? payload.client : item)
        renderClients()
        notice(`Research complete for ${client.name}.`, 'success')
      } catch (error) { notice(`Research failed: ${error.message}`, 'failure') }
      return
    }
    if (!client.research) return notice('Research this client first so outreach is based on actual website evidence.', 'failure')
    if (action === 'email') return draftEmail(client, serviceType, senderContext)
    if (action === 'whatsapp') return draftWhatsApp(client, serviceType, senderContext)
    if (action === 'call') return draftCall(client, serviceType, senderContext)
  }

  async function draftEmail(client, serviceType, senderContext) {
    notice(`Drafting email for ${client.name}…`, 'loading')
    try {
      const payload = await api('/api/outreach/email/draft', {client, serviceType, senderContext})
      const draft = payload.draft
      const body = document.createElement('div')
      body.innerHTML = `
        <div class="draft-field"><strong>To</strong><input id="draft-email-to" value="${escapeHtml(draft.to || '')}" placeholder="client@example.com"></div>
        <div class="draft-field"><strong>Subject</strong><input id="draft-email-subject" value="${escapeHtml(draft.subject || '')}"></div>
        <div class="draft-field"><strong>Body</strong><textarea id="draft-email-body" rows="14">${escapeHtml(draft.body || '')}</textarea></div>
        <div class="draft-field"><strong>Why this angle</strong><p>${escapeHtml(draft.reason || '')}</p></div>`
      showDraftNode('Approve email', body, [{
        label: 'Approve and send email', primary: true, click: async () => {
          const result = await api('/api/outreach/email/send', {
            approvalId: draft.approvalId,
            to: $('#draft-email-to', body).value.trim(),
            subject: $('#draft-email-subject', body).value,
            body: $('#draft-email-body', body).value,
          })
          $('#draft-dialog').close()
          await refreshStatus()
          notice(`Email sent to ${result.to}.`, 'success')
        },
      }])
      await refreshApprovalsOnly()
      notice('Email draft ready. Nothing sends until you approve it.', 'success')
    } catch (error) { notice(`Email draft failed: ${error.message}`, 'failure') }
  }

  async function draftWhatsApp(client, serviceType, senderContext) {
    notice(`Drafting WhatsApp for ${client.name}…`, 'loading')
    try {
      const payload = await api('/api/outreach/whatsapp/draft', {client, serviceType, senderContext})
      const draft = payload.draft
      const body = document.createElement('div')
      body.innerHTML = `
        <div class="draft-field"><strong>Phone</strong><input id="draft-wa-phone" value="${escapeHtml(draft.phone || '')}" placeholder="+972..."></div>
        <div class="draft-field"><strong>Message</strong><textarea id="draft-wa-message" rows="10">${escapeHtml(draft.message || '')}</textarea></div>
        <div class="draft-field"><strong>Why this angle</strong><p>${escapeHtml(draft.reason || '')}</p></div>`
      showDraftNode('Approve WhatsApp', body, [{
        label: 'Approve and open WhatsApp', primary: true, click: async () => {
          const result = await api('/api/outreach/whatsapp/open', {
            approvalId: draft.approvalId,
            phone: $('#draft-wa-phone', body).value.trim(),
            message: $('#draft-wa-message', body).value,
          })
          window.open(result.url, '_blank', 'noopener,noreferrer')
          $('#draft-dialog').close()
          await refreshStatus()
          notice('Approved message opened in WhatsApp. Review once more before pressing Send.', 'success')
        },
      }])
      await refreshApprovalsOnly()
      notice('WhatsApp draft ready. It will only open after approval.', 'success')
    } catch (error) { notice(`WhatsApp draft failed: ${error.message}`, 'failure') }
  }

  async function draftCall(client, serviceType, senderContext) {
    notice(`Drafting call script for ${client.name}…`, 'loading')
    try {
      const payload = await api('/api/outreach/call/draft', {client, serviceType, senderContext})
      const draft = payload.draft
      const body = document.createElement('div')
      body.innerHTML = `
        <div class="draft-field"><strong>Phone</strong><input id="draft-call-phone" value="${escapeHtml(draft.phone || '')}" placeholder="+972..."></div>
        <div class="draft-field"><strong>TTS script</strong><textarea id="draft-call-script" rows="12">${escapeHtml(draft.script || '')}</textarea></div>
        <div class="draft-field"><strong>Why this script</strong><p>${escapeHtml(draft.reason || '')}</p></div>`
      showDraftNode('Approve TTS call', body, [{
        label: 'Approve and place call', primary: true, click: async () => {
          if (!confirm('Place this exact TTS call now?')) return
          const result = await api('/api/outreach/call/start', {
            approvalId: draft.approvalId,
            phone: $('#draft-call-phone', body).value.trim(),
            script: $('#draft-call-script', body).value,
          })
          $('#draft-dialog').close()
          await refreshStatus()
          notice(`Call started. Provider status: ${result.status || 'queued'}.`, 'success')
        },
      }])
      await refreshApprovalsOnly()
      notice('Call script ready. The call cannot start until you approve it.', 'success')
    } catch (error) { notice(`Call draft failed: ${error.message}`, 'failure') }
  }

  function showDraft(title, html, actions) {
    const body = document.createElement('div')
    body.innerHTML = html
    showDraftNode(title, body, actions)
  }

  function showDraftNode(title, body, actions) {
    $('#draft-title').textContent = title
    const host = $('#draft-body')
    host.textContent = ''
    host.appendChild(body)
    const actionHost = $('#draft-actions')
    actionHost.textContent = ''
    for (const action of actions || []) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = action.primary ? 'primary' : 'secondary'
      button.textContent = action.label
      button.onclick = async () => {
        button.disabled = true
        try { await action.click() }
        catch (error) { notice(error.message, 'failure'); button.disabled = false }
      }
      actionHost.appendChild(button)
    }
    const cancel = document.createElement('button')
    cancel.type = 'button'; cancel.className = 'secondary'; cancel.textContent = 'Cancel'; cancel.onclick = () => $('#draft-dialog').close()
    actionHost.prepend(cancel)
    $('#draft-dialog').showModal()
  }

  async function refreshApprovalsOnly() {
    try {
      const payload = await api('/api/approvals')
      state.approvals = payload.approvals || []
      renderApprovals()
    } catch (_) {}
  }

  $('#refresh-approvals').addEventListener('click', async () => {
    notice('Refreshing approvals…', 'loading')
    await refreshApprovalsOnly()
    notice('Approvals refreshed.', 'success')
  })

  refreshStatus()
    .then(() => notice('Opportunity Hunter is ready.', 'success'))
    .catch((error) => notice(`Could not load local Hunter: ${error.message}`, 'failure'))
})()
