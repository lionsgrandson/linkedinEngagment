;(() => {
  const DEFAULT_SETTINGS = {
    ui: {
      showOverlay: true,
      compactOverlay: true,
    },
    writingStyle: {
      sourceType: 'summary',
      content: '',
    },
    replySafeguards: {
      businessFacts: '',
      conversationScope: 'all',
      contactMode: 'all',
      allowedContacts: [],
      blockedContacts: [],
    },
    integrations: {
      crm: {
        provider: 'none',
        webhookUrl: '',
        apiToken: '',
        enabled: false,
      },
    },
    platforms: {
      linkedin: {
        enabled: true,
        likes: true,
        comments: true,
        connections: true,
        incomingInvites: true,
        notificationReplies: true,
        notificationInterrupts: false,
        imageRecognition: true,
        messages: false,
        topics: [
          'web development', 'B2B startups', 'personal growth', 'Zionism',
          'technology', 'software development', 'artificial intelligence',
        ],
      },
      instagram: {
        enabled: true,
        likes: true,
        stories: true,
        follows: true,
        imageRecognition: true,
        profileLikes: true,
        profileLikeCount: 5,
        dailyLikeLimit: 0,
        dailyFollowLimit: 20,
        storyIntervalLikes: 100,
        storyBatchLimit: 0,
        messages: false,
        topics: [],
      },
      facebook: {
        enabled: true,
        likes: true,
        comments: true,
        follows: true,
        imageRecognition: true,
        profileLikes: true,
        profileLikeCount: 5,
        dailyLikeLimit: 0,
        dailyFollowLimit: 20,
        messages: false,
        topics: [],
      },
      whatsapp: {
        enabled: false,
        messages: false,
        optedIn: false,
        consentRevision: 0,
        topics: [],
      },
    },
  }

  const clone = (value) => JSON.parse(JSON.stringify(value))
  const merge = (defaults, saved) => {
    const result = clone(defaults)
    if (saved?.ui) {
      result.ui.showOverlay = saved.ui.showOverlay !== false
      result.ui.compactOverlay = saved.ui.compactOverlay !== false
    }
    if (saved?.writingStyle) {
      result.writingStyle.sourceType = saved.writingStyle.sourceType === 'samples'
        ? 'samples'
        : 'summary'
      result.writingStyle.content = String(saved.writingStyle.content || '').trim().slice(0, 20000)
    }
    if (saved?.replySafeguards) {
      const policy = saved.replySafeguards
      result.replySafeguards.businessFacts = String(policy.businessFacts || '').trim().slice(0, 30000)
      result.replySafeguards.conversationScope = ['all', 'direct', 'groups'].includes(policy.conversationScope)
        ? policy.conversationScope : 'all'
      result.replySafeguards.contactMode = policy.contactMode === 'allowlist' ? 'allowlist' : 'all'
      for (const key of ['allowedContacts', 'blockedContacts']) {
        result.replySafeguards[key] = Array.isArray(policy[key])
          ? [...new Set(policy[key].map((value) => String(value).trim()).filter(Boolean))].slice(0, 500)
          : []
      }
    }
    if (saved?.integrations?.crm) {
      const crm = saved.integrations.crm
      const providers = ['none', 'codecrafter', 'creativecrm', 'compatible', 'custom']
      result.integrations.crm.provider = providers.includes(crm.provider) ? crm.provider : 'none'
      result.integrations.crm.webhookUrl = String(crm.webhookUrl || '').trim().slice(0, 2000)
      result.integrations.crm.apiToken = String(crm.apiToken || '').trim().slice(0, 4000)
      result.integrations.crm.enabled = crm.enabled === true && result.integrations.crm.provider !== 'none'
    }
    for (const [platform, values] of Object.entries(saved?.platforms || {})) {
      if (!result.platforms[platform]) continue
      result.platforms[platform] = { ...result.platforms[platform], ...values }
      result.platforms[platform].topics = Array.isArray(values.topics)
        ? values.topics.map((topic) => String(topic).trim()).filter(Boolean)
        : result.platforms[platform].topics
      if ('profileLikeCount' in result.platforms[platform]) {
        const count = Number(values.profileLikeCount)
        result.platforms[platform].profileLikeCount = Number.isFinite(count)
          ? Math.max(1, Math.min(100, Math.round(count)))
          : result.platforms[platform].profileLikeCount
      }
      for (const key of ['dailyLikeLimit', 'dailyFollowLimit', 'storyIntervalLikes', 'storyBatchLimit']) {
        if (!(key in result.platforms[platform])) continue
        const value = Number(values[key])
        const minimum = key === 'storyIntervalLikes' ? 1 : 0
        if (Number.isFinite(value)) result.platforms[platform][key] = Math.max(minimum, Math.min(10000, Math.round(value)))
      }
      if (platform === 'whatsapp') {
        const revision = Number(values.consentRevision)
        result.platforms[platform].consentRevision = Number.isFinite(revision) ? revision : 0
      }
    }
    return result
  }

  async function load() {
    const stored = await chrome.storage.local.get('ccSettings')
    return merge(DEFAULT_SETTINGS, stored.ccSettings)
  }

  async function save(settings) {
    const normalized = merge(DEFAULT_SETTINGS, settings)
    await chrome.storage.local.set({ ccSettings: normalized })
    return normalized
  }

  function matchesTopics(text, topics) {
    if (!topics?.length) return true
    const normalized = String(text || '').toLocaleLowerCase()
    return topics.some((topic) => normalized.includes(String(topic).toLocaleLowerCase()))
  }

  const normalizeContact = (value) => String(value || '').normalize('NFKC').trim().toLocaleLowerCase()

  function replyDecision(settings, contact, isGroup) {
    const policy = settings?.replySafeguards || DEFAULT_SETTINGS.replySafeguards
    const normalized = normalizeContact(contact)
    const blocked = policy.blockedContacts.map(normalizeContact)
    const allowed = policy.allowedContacts.map(normalizeContact)
    if (normalized && blocked.includes(normalized)) return {allowed: false, reason: `contact ${contact} is blocked`}
    if (policy.conversationScope === 'groups' && isGroup !== true) return {allowed: false, reason: 'only group conversations are allowed'}
    if (policy.conversationScope === 'direct' && isGroup === true) return {allowed: false, reason: 'group conversations are disabled'}
    if (policy.contactMode === 'allowlist' && (!normalized || !allowed.includes(normalized))) {
      return {allowed: false, reason: normalized ? `contact ${contact} is not on the allowlist` : 'contact could not be identified for allowlist mode'}
    }
    return {allowed: true, reason: 'reply policy allows this conversation'}
  }

  globalThis.CodeCrafterSettings = { DEFAULT_SETTINGS, load, save, matchesTopics, replyDecision }
})()
