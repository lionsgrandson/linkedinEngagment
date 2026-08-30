;(() => {
  if (location.hostname !== 'www.linkedin.com' || !location.pathname.startsWith('/messaging')) return
  if (window.__codeCrafterInboxBridge) return
  window.__codeCrafterInboxBridge = true

  const VERSION = '3.20.18'
  const SCAN_MS = 2000
  const SEND_DELAY_MS = 1600
  const processed = new Set()
  const attempted = new Set()
  let busy = false

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim()
  const visible = (node) => Boolean(node && node.isConnected && node.offsetParent !== null)
  const text = (node) => normalize(node?.innerText || node?.textContent || '')
  const unique = (items) => [...new Set(items.filter(Boolean))]
  const api = (path, method = 'GET', body = null) => chrome.runtime.sendMessage({type:'localApi', path, method, body})
  const fingerprint = (value) => {
    let hash = 2166136261
    for (const ch of String(value || '').normalize('NFKC')) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619) }
    return (hash >>> 0).toString(16)
  }

  function panel() {
    if (document.getElementById('cc-linkedin-inbox-v4')) return
    const box = document.createElement('div')
    box.id = 'cc-linkedin-inbox-v4'
    box.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;width:310px;padding:14px;border-radius:12px;background:#111827;color:white;font:14px Arial;box-shadow:0 8px 30px #0006'
    box.innerHTML = `<b>CodeCrafter LinkedIn Inbox v${VERSION}</b><div id="cc-li4-status" style="margin-top:9px">Starting...</div><div id="cc-li4-detail" style="margin-top:7px;color:#cbd5e1;font-size:11px"></div>`
    document.documentElement.appendChild(box)
    CodeCrafterSettings.load().then(({ui}) => { if (!ui.showOverlay) box.style.display='none' }).catch(()=>{})
  }
  function status(message, detail='') {
    panel()
    document.getElementById('cc-li4-status').textContent = message
    document.getElementById('cc-li4-detail').textContent = detail
  }

  function conversationRows() {
    const containers = [
      ...document.querySelectorAll('li.msg-conversation-listitem,.msg-conversations-container__convo-item'),
      ...document.querySelectorAll("[data-view-name='message-list-item'],[data-testid*='conversation-list-item' i]"),
      ...document.querySelectorAll("[role='listitem']"),
    ]
    const anchors = [...document.querySelectorAll("a[href*='/messaging/']")]
      .filter((a) => !/compose|settings/i.test(a.href))
      .map((a) => a.closest("li,[role='listitem'],[data-view-name='message-list-item'],[class*='conversation']"))
    return unique([...containers, ...anchors]).filter((row) => {
      if (!visible(row)) return false
      const content = text(row)
      if (!content || content.length > 2500) return false
      return Boolean(row.querySelector("a[href*='/messaging/']") || /conversation/i.test(String(row.className || '')))
    })
  }
  function rowHref(row) {
    return [...row?.querySelectorAll?.("a[href*='/messaging/']") || []]
      .map((a)=>a.href).find((href)=>!/compose|settings/i.test(href)) || ''
  }
  function rowSelected(row) {
    if (!row) return false
    if (row.matches?.("[aria-selected='true'],.msg-conversation-listitem--active")) return true
    if (row.querySelector?.("[aria-current='page'],[aria-selected='true'],.msg-conversation-listitem__link--active,.msg-conversations-container__convo-item-link--active")) return true
    const href = rowHref(row)
    try { return Boolean(href && location.pathname.startsWith(new URL(href).pathname.replace(/\/+$/, ''))) }
    catch { return false }
  }
  function boldUnreadSignal(row) {
    const candidates = [...row.querySelectorAll('span,p,strong,b')].filter(visible)
    return candidates.some((node) => {
      const value = text(node)
      if (!value || value.length > 400) return false
      const weight = Number.parseInt(getComputedStyle(node).fontWeight, 10)
      return Number.isFinite(weight) && weight >= 600
    })
  }
  function rowUnread(row) {
    const value = `${row.className || ''} ${text(row)} ${row.getAttribute?.('aria-label') || ''}`
    if (/\bunread\b|\bnew message\b|\b[1-9]\d* new messages?\b/i.test(value)) return true
    if (row.matches?.('.msg-conversation-listitem--unread,[data-unread=true],[aria-label*="unread" i]')) return true
    if (row.querySelector?.("[aria-label*='unread' i],[aria-label*='new message' i],[class*='unread' i],[data-testid*='unread' i],[data-view-name*='unread' i],.notification-badge,[class*='badge']")) return true
    return !rowSelected(row) && boldUnreadSignal(row)
  }
  function activeRow() { return conversationRows().find(rowSelected) || null }
  function contactName(row) {
    if (!row) return ''
    const nodes = [
      row.querySelector('.msg-conversation-card__participant-names'), row.querySelector('.msg-conversation-listitem__participant-names'),
      row.querySelector("[data-testid*='title' i]"), row.querySelector("[class*='participant' i]"), row.querySelector('img[alt]'), row.querySelector("[dir='auto']"),
    ].filter(Boolean)
    for (const node of nodes) {
      const value = node.tagName === 'IMG' ? normalize(node.alt) : text(node)
      if (value && !/^(?:unread|new message|messages?)$/i.test(value)) return value.slice(0,250)
    }
    return text(row).split(/\s{2,}/)[0].slice(0,250)
  }

  function threadRoot() { return document.querySelector('.msg-s-message-list-container,.msg-s-message-list,.msg-thread,[data-view-name*=message-thread],main') || document.body }
  function messageEvents() {
    const root = threadRoot()
    return unique([
      ...root.querySelectorAll('li.msg-s-message-list__event,.msg-s-event-listitem'),
      ...root.querySelectorAll("[data-view-name='message'],[data-testid*='message-item' i]"),
    ]).filter((event)=>visible(event) && text(event))
  }
  function direction(event) {
    const content = text(event)
    const classes = String(event?.className || '')
    const labels = [event?.getAttribute?.('aria-label') || '', ...[...event?.querySelectorAll?.('[aria-label]') || []].slice(0,10).map((n)=>n.getAttribute('aria-label')||'')].join(' ')
    if (/outbound|message-out|from-me/i.test(classes) || /\b(?:you sent|sent by you|your message)\b/i.test(labels)) return 'OUTBOUND'
    if (/\bMoshe Schwartzberg sent the following message\b/i.test(content)) return 'OUTBOUND'
    const sender = text(event?.querySelector?.(".msg-s-message-group__name,.msg-s-message-list__event-actor,.msg-s-event-listitem__name,[data-view-name='message-sender'],a[href*='/in/']"))
    if (/^(?:Moshe Schwartzberg|You)$/i.test(sender)) return 'OUTBOUND'
    return 'INBOUND'
  }
  function eventBody(event) {
    const node = ['.msg-s-event-listitem__body','.msg-s-message-list__event-content','.msg-s-message-list__event-content p',"[data-view-name='message-body']","[data-testid*='message-text' i]"]
      .map((s)=>event?.querySelector?.(s)).find(Boolean)
    let value = text(node || event).replace(/^Moshe Schwartzberg sent the following message\s*/i,'').replace(/^You\s*/i,'').replace(/\b(?:Seen|Delivered|Sent)\s*$/i,'').trim()
    return /^(?:Seen|Delivered|Sent|Today|Yesterday|\d{1,2}:\d{2}(?:\s*[AP]M)?)$/i.test(value) ? '' : value
  }
  function messages() { return messageEvents().map((event)=>({direction:direction(event),body:eventBody(event)})).filter((m)=>m.body) }
  function latestInbound() { const m=messages().at(-1); return m?.direction==='INBOUND' ? m.body : '' }
  function context() { return messages().slice(-30).map((m)=>`${m.direction}: ${m.body}`).join('\n').slice(-10000) }
  function threadSignature() { return fingerprint(messages().slice(-8).map((m)=>`${m.direction}:${m.body}`).join('|')) }
  function editor() {
    return [...document.querySelectorAll("div.msg-form__contenteditable[contenteditable='true'],div[contenteditable='true'][role='textbox'],textarea[placeholder*='message' i],textarea")]
      .filter(visible).find((node)=>!/search/i.test(`${node.getAttribute('aria-label')||''} ${node.getAttribute('placeholder')||''}`)) || null
  }
  function editorValue(input) { return normalize(input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement ? input.value : input?.textContent) }
  function putDraft(input,value) {
    input.focus()
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const proto=input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto,'value').set.call(input,value)
      input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value})); input.dispatchEvent(new Event('change',{bubbles:true}))
    } else {
      const selection=window.getSelection(); const range=document.createRange(); range.selectNodeContents(input); selection.removeAllRanges(); selection.addRange(range)
      document.execCommand('delete',false); document.execCommand('insertText',false,value)
      input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}))
      const end=document.createRange(); end.selectNodeContents(input); end.collapse(false); selection.removeAllRanges(); selection.addRange(end)
      document.execCommand('insertText',false,' '); input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:' '}))
      document.execCommand('delete',false); input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward',data:null}))
    }
    return editorValue(input)===normalize(value)
  }
  function exactOutgoing(expected) {
    const wanted=normalize(expected)
    return Boolean(wanted && messages().some((m)=>m.direction==='OUTBOUND' && (normalize(m.body).includes(wanted)||wanted.includes(normalize(m.body)))))
  }
  async function waitForOutgoing(expected,before,timeout=12000) {
    const deadline=Date.now()+timeout
    while(Date.now()<deadline){
      if(exactOutgoing(expected)) return true
      const latest=messages().at(-1); const input=editor()
      if(latest?.direction==='OUTBOUND' && threadSignature()!==before && !editorValue(input)) return true
      const feedback=text(document.querySelector("[role='alert'],.artdeco-toast-item")); if(/couldn.?t send|failed|try again|something went wrong/i.test(feedback)) return false
      await sleep(200)
    }
    return false
  }
  function sendControl(input) {
    const roots=unique([input?.closest?.('form'),input?.closest?.('.msg-form'),threadRoot(),document])
    const selectors=['button.msg-form__send-button','button.msg-form__send-btn',"button[type='submit']","button[aria-label='Send']","button[aria-label*='send message' i]","button[data-control-name*='send' i]","button[data-view-name*='send' i]","[role='button'][aria-label*='send' i]"]
    for(const root of roots){ for(const selector of selectors){ const node=root?.querySelector?.(selector); if(visible(node)&&!node.disabled&&node.getAttribute('aria-disabled')!=='true') return node } }
    return null
  }
  async function submitDraft(input,expected) {
    const before=threadSignature(); const control=sendControl(input); let method=''
    if(control){method='button';control.click()}
    else { const form=input?.closest?.('form')||input?.closest?.('.msg-form')?.querySelector?.('form'); if(form?.requestSubmit){method='form';form.requestSubmit()} else {method='enter';input.focus();input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));input.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}))}}
    return {confirmed:await waitForOutgoing(expected,before),method}
  }
  async function openRow(row) {
    if(rowSelected(row)&&editor()&&messages().length) return true
    const target=[...row.querySelectorAll("a[href*='/messaging/']")].find((a)=>!/compose|settings/i.test(a.href))||row
    const before=threadSignature(); target.scrollIntoView?.({block:'center'}); target.click?.()
    const deadline=Date.now()+9000
    while(Date.now()<deadline){ if(editor()&&messages().length&&(rowSelected(row)||threadSignature()!==before)) return true; await sleep(200) }
    return false
  }
  function diagnostics() {
    const rows=conversationRows(); const unread=rows.filter(rowUnread).length; const events=messageEvents().length
    return `${rows.length} rows, ${unread} unread candidates, ${events} message events`
  }

  async function cycle() {
    if(busy) return; busy=true
    try {
      const settings=await CodeCrafterSettings.load(); const config=settings.platforms.linkedin
      if(!config?.enabled||!config.messages){status('LinkedIn inbox replies are disabled.',diagnostics());return}
      const rows=conversationRows(); const unread=rows.find(rowUnread); const active=activeRow(); const row=unread || (active&&latestInbound()?active:null)
      if(!row){status('Watching for new LinkedIn messages...',diagnostics());return}
      const contactBefore=contactName(row)
      if(!rowSelected(row)){status(`Opening ${contactBefore||'unread conversation'}...`,diagnostics()); if(!(await openRow(row))){status('Conversation did not finish loading. Retrying...',diagnostics());return}}
      await sleep(300)
      const inbound=latestInbound(); const current=activeRow()||row; const contact=contactName(current)||contactBefore; const href=rowHref(current)||rowHref(row); const key=`${href||contact||'linkedin'}|${fingerprint(inbound)}`
      if(!inbound){status('Conversation opened, but the newest visible message is not inbound.',diagnostics());return}
      if(processed.has(key)){status('This inbound message was already handled.',diagnostics());return}
      if(attempted.has(key)){status('A send was already attempted for this inbound message. Duplicate retry blocked.',diagnostics());return}
      const policy=CodeCrafterSettings.replyDecision(settings,contact,false); if(!policy.allowed){processed.add(key);status(`Reply blocked: ${policy.reason}`,diagnostics());return}
      status(`Drafting a reply to ${contact||'the newest message'}...`,diagnostics())
      const draft=await api('/draft-inbox-reply','POST',{site:'linkedin',context:context(),writingStyle:settings.writingStyle,safeguards:settings.replySafeguards,contact,isGroup:false})
      if(!draft?.ok||!draft.data?.allowed||!draft.data?.message){status('Could not draft a safe reply. Retrying...',draft?.data?.reason||draft?.error||diagnostics());return}
      if(exactOutgoing(draft.data.message)){processed.add(key);status('That reply is already visible.',diagnostics());return}
      const input=editor(); if(!input){status('Message editor was not found.',diagnostics());return}
      if(!putDraft(input,draft.data.message)){status('LinkedIn did not retain the draft.',diagnostics());return}
      const started=Date.now(); while(Date.now()-started<SEND_DELAY_MS){const left=Math.max(0,SEND_DELAY_MS-(Date.now()-started));status(`Reply ready. Sending in ${(left/1000).toFixed(1)}s`,diagnostics());await sleep(100)}
      if(!latestInbound()){status('Conversation changed before send. Rereading first...',diagnostics());return}
      attempted.add(key); const result=await submitDraft(input,draft.data.message)
      if(!result.confirmed){status(`Send attempted using ${result.method}, but LinkedIn did not confirm it. Duplicate retry blocked.`,diagnostics());await api('/result','POST',{ok:false,site:'linkedin',reason:`LinkedIn inbox submit via ${result.method} was not confirmed`});return}
      processed.add(key); const actionId=`linkedin:reply:${href||contact}:${fingerprint(inbound)}:${fingerprint(draft.data.message)}`
      await api('/result','POST',{ok:true,kind:'inbox_reply',actionId,site:'linkedin',reason:`LinkedIn confirmed inbox reply via ${result.method}`})
      status('Reply sent successfully.',diagnostics())
    } catch(error){status('Inbox watcher error.',String(error).slice(0,240))} finally{busy=false}
  }

  panel(); setInterval(cycle,SCAN_MS); cycle()
})()
