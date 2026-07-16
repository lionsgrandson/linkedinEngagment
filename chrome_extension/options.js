;(() => {
  const definitions = {
    linkedin: { name: 'LinkedIn', features: { likes: 'Likes', comments: 'Comments', connections: 'Send connection invitations', incomingInvites: 'Accept incoming invitations', notificationReplies: 'Ongoing comment conversations', notificationInterrupts: 'Interrupt the active tab for new notifications', imageRecognition: 'Visual topic recognition', messages: 'Inbox messages' } },
    instagram: { name: 'Instagram', features: { likes: 'Feed likes', stories: 'Story batches', follows: 'Follow matching accounts', imageRecognition: 'Visual topic recognition', profileLikes: 'Profile batch likes', messages: 'Inbox messages' }, numbers: { profileLikeCount: 'Posts per profile section (X)', dailyLikeLimit: 'Daily like limit (0 = unlimited)', dailyFollowLimit: 'Daily follow limit', storyIntervalLikes: 'Likes between story batches', storyBatchLimit: 'Stories per batch (0 = all)' } },
    facebook: { name: 'Facebook', features: { likes: 'Feed likes', comments: 'Feed comments', follows: 'Follow matching accounts', imageRecognition: 'Visual topic recognition', profileLikes: 'Profile batch likes', messages: 'Inbox messages' }, numbers: { profileLikeCount: 'Posts per profile section (X)', dailyLikeLimit: 'Daily like limit (0 = unlimited)', dailyFollowLimit: 'Daily follow limit' } },
    whatsapp: {
      name: 'WhatsApp Web',
      features: { messages: 'Reply to unread client messages' },
      topicsTitle: 'Automatic clients',
      topicsDescription: 'Add exact client names that may send immediately. Every other client gets the visible 10-second timer.',
      topicPlaceholder: 'Exact WhatsApp client name',
    },
  }
  let settings
  const cards = new Map()
  const status = (message, phase) => {
    const node = document.getElementById('status')
    node.querySelector('span').textContent = message
    node.dataset.phase = phase
  }
  const renderTopics = (platform) => {
    const { card } = cards.get(platform)
    const list = card.querySelector('.topic-list')
    list.textContent = ''
    const topics = settings.platforms[platform].topics
    if (!topics.length) {
      const empty = document.createElement('span')
      empty.textContent = 'Blank state — all topics are allowed.'
      empty.style.color = '#94a3b8'
      list.appendChild(empty)
      return
    }
    topics.forEach((topic, index) => {
      const chip = document.createElement('span')
      chip.className = 'topic'
      chip.append(document.createTextNode(topic))
      const edit = document.createElement('button')
      edit.type = 'button'; edit.textContent = '\u270e'; edit.title = `Edit ${topic}`
      edit.onclick = () => {
        const entry = card.querySelector('.topic-entry input')
        entry.value = topic
        settings.platforms[platform].topics.splice(index, 1)
        renderTopics(platform)
        entry.focus()
        status(`Edit ${topic}, then press Add topic.`, 'filled')
      }
      const remove = document.createElement('button')
      remove.type = 'button'; remove.textContent = '×'; remove.title = `Remove ${topic}`
      remove.onclick = () => { settings.platforms[platform].topics.splice(index, 1); renderTopics(platform) }
      chip.append(edit, remove); list.appendChild(chip)
    })
  }
  const buildCard = (platform, definition) => {
    const card = document.getElementById('platform-template').content.firstElementChild.cloneNode(true)
    card.dataset.platform = platform
    card.querySelector('.site-label').textContent = platform
    card.querySelector('h2').textContent = definition.name
    card.querySelector('.topics h3').textContent = definition.topicsTitle || 'Topics'
    card.querySelector('.topics p').textContent = definition.topicsDescription || 'Empty means all topics. Add, edit, or remove terms at any time.'
    card.querySelector('.topic-entry input').placeholder = definition.topicPlaceholder || 'e.g. hightech, HR'
    const master = card.querySelector('.master input')
    master.checked = settings.platforms[platform].enabled
    master.onchange = () => {
      settings.platforms[platform].enabled = master.checked
      if (platform === 'whatsapp') {
        settings.platforms[platform].optedIn = master.checked && settings.platforms[platform].messages
        settings.platforms[platform].consentRevision = settings.platforms[platform].optedIn ? 2 : 0
      }
      card.classList.toggle('disabled', !master.checked)
    }
    card.classList.toggle('disabled', !master.checked)
    const features = card.querySelector('.features')
    for (const [key, label] of Object.entries(definition.features)) {
      const row = document.createElement('label'); row.className = 'feature switch'
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = settings.platforms[platform][key]
      input.onchange = () => {
        settings.platforms[platform][key] = input.checked
        if (platform === 'whatsapp' && key === 'messages') {
          settings.platforms[platform].optedIn = input.checked && master.checked
          settings.platforms[platform].consentRevision = settings.platforms[platform].optedIn ? 2 : 0
        }
      }
      const slider = document.createElement('span'); const text = document.createElement('em'); text.textContent = label
      row.append(input, slider, text); features.appendChild(row)
    }
    for (const [key, label] of Object.entries(definition.numbers || {})) {
      const row = document.createElement('label'); row.className = 'number-setting'
      const text = document.createElement('span'); text.textContent = label
      const input = document.createElement('input'); input.type = 'number'; input.min = ['profileLikeCount', 'storyIntervalLikes'].includes(key) ? '1' : '0'; input.max = '10000'
      input.value = settings.platforms[platform][key]
      input.onchange = () => {
        const minimum = ['profileLikeCount', 'storyIntervalLikes'].includes(key) ? 1 : 0
        settings.platforms[platform][key] = Math.max(minimum, Math.min(10000, Math.round(Number(input.value) || minimum)))
        input.value = settings.platforms[platform][key]
      }
      row.append(text, input); features.appendChild(row)
    }
    if (definition.topics === false) {
      card.querySelector('.topics').remove()
      cards.set(platform, { card })
      document.getElementById('platforms').appendChild(card)
      return
    }
    const entry = card.querySelector('.topic-entry input')
    const add = () => {
      const topic = entry.value.trim()
      if (!topic) return status('Blank topic was not added.', 'blank')
      if (!settings.platforms[platform].topics.some((value) => value.toLowerCase() === topic.toLowerCase())) settings.platforms[platform].topics.push(topic)
      entry.value = ''; renderTopics(platform); status(`${definition.name} topic added.`, 'filled')
    }
    card.querySelector('.topic-entry button').onclick = add
    entry.onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); add() } }
    cards.set(platform, { card }); document.getElementById('platforms').appendChild(card); renderTopics(platform)
  }
  async function start() {
    document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`
    settings = await CodeCrafterSettings.load()
    const showOverlay = document.getElementById('show-overlay')
    const compactOverlay = document.getElementById('compact-overlay')
    showOverlay.checked = settings.ui.showOverlay
    compactOverlay.checked = settings.ui.compactOverlay
    showOverlay.onchange = () => { settings.ui.showOverlay = showOverlay.checked }
    compactOverlay.onchange = () => { settings.ui.compactOverlay = compactOverlay.checked }
    const styleSource = document.getElementById('style-source')
    const styleContent = document.getElementById('style-content')
    const styleCount = document.getElementById('style-count')
    const syncStyle = () => {
      settings.writingStyle.sourceType = styleSource.value
      settings.writingStyle.content = styleContent.value.slice(0, 20000)
      styleCount.textContent = `${settings.writingStyle.content.length.toLocaleString()} / 20,000`
    }
    styleSource.value = settings.writingStyle.sourceType
    styleContent.value = settings.writingStyle.content
    styleSource.onchange = syncStyle
    styleContent.oninput = syncStyle
    document.getElementById('style-file').onchange = async (event) => {
      const file = event.target.files?.[0]
      if (!file) return
      if (file.size > 100000) return status('Failure - style file is too large.', 'failure')
      styleContent.value = (await file.text()).slice(0, 20000)
      syncStyle()
      status(`Filled state - imported ${file.name}.`, 'filled')
      event.target.value = ''
    }
    syncStyle()
    const businessFacts = document.getElementById('business-facts')
    const factsCount = document.getElementById('facts-count')
    const conversationScope = document.getElementById('conversation-scope')
    const contactMode = document.getElementById('contact-mode')
    const allowedContacts = document.getElementById('allowed-contacts')
    const blockedContacts = document.getElementById('blocked-contacts')
    const splitContacts = (value) => [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))].slice(0, 500)
    const syncSafeguards = () => {
      settings.replySafeguards.businessFacts = businessFacts.value.slice(0, 30000)
      settings.replySafeguards.conversationScope = conversationScope.value
      settings.replySafeguards.contactMode = contactMode.value
      settings.replySafeguards.allowedContacts = splitContacts(allowedContacts.value)
      settings.replySafeguards.blockedContacts = splitContacts(blockedContacts.value)
      factsCount.textContent = `${settings.replySafeguards.businessFacts.length.toLocaleString()} / 30,000`
    }
    businessFacts.value = settings.replySafeguards.businessFacts
    conversationScope.value = settings.replySafeguards.conversationScope
    contactMode.value = settings.replySafeguards.contactMode
    allowedContacts.value = settings.replySafeguards.allowedContacts.join('\n')
    blockedContacts.value = settings.replySafeguards.blockedContacts.join('\n')
    for (const input of [businessFacts, conversationScope, contactMode, allowedContacts, blockedContacts]) {
      input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', syncSafeguards)
    }
    syncSafeguards()
    const crmProvider = document.getElementById('crm-provider')
    const crmWebhookUrl = document.getElementById('crm-webhook-url')
    const crmApiToken = document.getElementById('crm-api-token')
    const crmEnabled = document.getElementById('crm-enabled')
    const crmState = document.getElementById('crm-state')
    const guidedCrmSetup = document.getElementById('codecrafter-setup')
    const syncCrm = () => {
      const crm = settings.integrations.crm
      crm.provider = crmProvider.value
      crm.webhookUrl = crmWebhookUrl.value.trim()
      crm.apiToken = crmApiToken.value.trim()
      crm.enabled = crmEnabled.checked && crm.provider !== 'none'
      crmEnabled.disabled = crm.provider === 'none'
      crmWebhookUrl.disabled = crm.provider === 'none'
      crmApiToken.disabled = crm.provider === 'none'
      guidedCrmSetup.style.display = crm.provider === 'codecrafter' ? 'grid' : 'none'
      if (crm.provider === 'none') {
        crmState.textContent = 'Blank state — CRM logging is not configured.'
        crmState.dataset.phase = 'blank'
      } else if (crm.enabled && crm.webhookUrl) {
        crmState.textContent = `Filled state — ${crmProvider.selectedOptions[0].textContent} is ready to test.`
        crmState.dataset.phase = 'filled'
      } else {
        crmState.textContent = 'Blank state — enter a webhook endpoint and enable CRM logging.'
        crmState.dataset.phase = 'blank'
      }
    }
    const decodeSetupCode = (value) => {
      const encoded = String(value || '').trim().replace(/^CCCRM1\./i, '')
      const decoded = JSON.parse(atob(encoded))
      if (decoded?.v !== 1 || decoded.provider !== 'codecrafter' ||
          !/^https:\/\//i.test(decoded.webhookUrl || '') || !String(decoded.apiToken || '').startsWith('cccrm_')) {
        throw new Error('This is not a valid CodeCrafter CRM setup code.')
      }
      return decoded
    }
    const testCrm = async () => {
      syncCrm()
      if (settings.integrations.crm.provider === 'none' || !settings.integrations.crm.webhookUrl) {
        crmState.textContent = 'Failure — choose a CRM and connect it first.'
        crmState.dataset.phase = 'failure'
        return false
      }
      crmState.textContent = 'Loading — testing the CRM connection…'
      crmState.dataset.phase = 'loading'
      const result = await chrome.runtime.sendMessage({
        type: 'localApi', path: '/crm-test', method: 'POST', body: {crm: settings.integrations.crm},
      })
      const connected = Boolean(result?.ok && result.data?.delivered)
      crmState.textContent = connected
        ? 'Success — CodeCrafter CRM is connected and ready.'
        : `Failure — ${result?.data?.error || result?.error || 'the CRM rejected the connection test.'}`
      crmState.dataset.phase = connected ? 'success' : 'failure'
      return connected
    }
    const crm = settings.integrations.crm
    crmProvider.value = ['hubspot', 'salesforce', 'monday'].includes(crm.provider) ? 'custom' : crm.provider
    crmWebhookUrl.value = crm.webhookUrl
    crmApiToken.value = crm.apiToken
    crmEnabled.checked = crm.enabled
    for (const input of [crmProvider, crmWebhookUrl, crmApiToken, crmEnabled]) {
      input.addEventListener(input.tagName === 'SELECT' || input.type === 'checkbox' ? 'change' : 'input', syncCrm)
    }
    syncCrm()
    document.getElementById('test-crm').onclick = () => void testCrm()
    document.getElementById('paste-crm-code').onclick = async () => {
      crmState.textContent = 'Loading — reading and checking the setup code…'
      crmState.dataset.phase = 'loading'
      try {
        const connection = decodeSetupCode(await navigator.clipboard.readText())
        crmProvider.value = 'codecrafter'
        crmWebhookUrl.value = connection.webhookUrl
        crmApiToken.value = connection.apiToken
        crmEnabled.checked = true
        syncCrm()
        settings = await CodeCrafterSettings.save(settings)
        await testCrm()
      } catch (error) {
        crmState.textContent = `Failure — ${error instanceof Error ? error.message : String(error)}`
        crmState.dataset.phase = 'failure'
      }
    }
    document.getElementById('clear-whatsapp-retries').onclick = async () => {
      const stored = await chrome.storage.local.get('ccWhatsAppSendTransactions')
      const transactions = stored.ccWhatsAppSendTransactions || {}
      let cleared = 0
      for (const [id, transaction] of Object.entries(transactions)) {
        if (transaction?.state === 'failed') { delete transactions[id]; cleared += 1 }
      }
      await chrome.storage.local.set({ccWhatsAppSendTransactions: transactions})
      status(cleared
        ? `Success — cleared ${cleared} failed WhatsApp retry lock${cleared === 1 ? '' : 's'}.`
        : 'Blank state — there are no failed WhatsApp retries to clear.', cleared ? 'success' : 'blank')
    }
    Object.entries(definitions).forEach(([platform, definition]) => buildCard(platform, definition))
    document.getElementById('platforms').setAttribute('aria-busy', 'false')
    status('Filled state — settings loaded.', 'filled')
    document.getElementById('save').onclick = async () => {
      status('Saving settings…', 'loading')
      try {
        syncSafeguards()
        syncCrm()
        const whatsapp = settings.platforms.whatsapp
        whatsapp.optedIn = whatsapp.enabled && whatsapp.messages
        whatsapp.consentRevision = whatsapp.optedIn ? 2 : 0
        settings = await CodeCrafterSettings.save(settings)
        status('Success — settings saved and active.', 'success')
      }
      catch (error) { status(`Failure — ${String(error)}`, 'failure') }
    }
    document.getElementById('run-messages').onclick = async () => {
      syncSafeguards()
      syncCrm()
      status('Opening enabled inbox tabs…', 'loading')
      const whatsapp = settings.platforms.whatsapp
      whatsapp.optedIn = whatsapp.enabled && whatsapp.messages
      whatsapp.consentRevision = whatsapp.optedIn ? 2 : 0
      settings = await CodeCrafterSettings.save(settings)
      const result = await chrome.runtime.sendMessage({ type: 'runMessageRepliesNow' })
      status(result?.ok ? `Success — opened ${result.opened} inbox tabs.` : `Failure — ${result?.error || 'could not open inboxes'}`, result?.ok ? 'success' : 'failure')
    }
    document.getElementById('open-dashboard').onclick = async () => {
      status('Opening statistics dashboard…', 'loading')
      await chrome.tabs.create({url: 'http://127.0.0.1:8765/dashboard', active: true})
      status('Success — dashboard opened.', 'success')
    }
  }
  start().catch((error) => status(`Failure — ${String(error)}`, 'failure'))
})()
