;(() => {
  if (location.hostname !== 'www.linkedin.com') return
  const onNotifications = location.pathname.startsWith('/notifications')
  if (onNotifications && window.__codeCrafterBridge) return
  if (onNotifications) window.__codeCrafterBridge = true

  const VERSION = '3.20.18'
  let scanning = false
  let priorityRequested = false
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim()
  const visible = (node) => Boolean(node && node.isConnected && node.offsetParent !== null)
  const api = (path, method='GET', body=null) => chrome.runtime.sendMessage({type:'localApi', path, method, body})

  function panel() {
    if (!onNotifications || document.getElementById('cc-linkedin-notifications-v2')) return
    const box=document.createElement('div')
    box.id='cc-linkedin-notifications-v2'
    box.style.cssText='position:fixed;right:18px;bottom:18px;z-index:2147483647;width:300px;padding:14px;border-radius:12px;background:#111827;color:white;font:14px Arial;box-shadow:0 8px 30px #0006'
    box.innerHTML=`<b>CodeCrafter Notifications v${VERSION}</b><div id="cc-notify-status" style="margin-top:9px">Starting...</div><div id="cc-notify-detail" style="margin-top:7px;color:#cbd5e1;font-size:11px"></div>`
    document.documentElement.appendChild(box)
  }
  function status(message,detail=''){ if(!onNotifications)return; panel(); document.getElementById('cc-notify-status').textContent=message; document.getElementById('cc-notify-detail').textContent=detail }

  function notificationCards() {
    const nodes=[
      ...document.querySelectorAll("[data-view-name='notification-card'],.nt-card,[data-finite-scroll-hotkey-item]"),
      ...document.querySelectorAll("main article,main li,main [role='listitem']"),
    ]
    return [...new Set(nodes)].filter((node)=>visible(node)&&normalize(node.innerText).length>8&&normalize(node.innerText).length<3000)
  }
  function actionableText(value) {
    return /\b(?:replied|responded|commented|mentioned|tagged|answered)\b/i.test(value) &&
      /\b(?:comment|reply|post|activity|you|your)\b/i.test(value)
  }
  function notificationLink(card) {
    const links=[...card.querySelectorAll('a[href]')].filter((a)=>a.href&&visible(a))
    const preferred=links.find((a)=>/commentUrn=|\/feed\/update\/|\/posts\/|activity-|\/comments?\//i.test(a.href))
    if(preferred) return preferred.href
    return links.map((a)=>a.href).find((href)=>!(/\/in\/|\/company\/|\/jobs\/|\/notifications\/?$/i.test(href)))||''
  }
  async function scanPage() {
    if(scanning)return; scanning=true
    try{
      await sleep(1200)
      const cards=notificationCards(); const candidates=[]; const seen=new Set()
      for(const card of cards){
        const notificationText=normalize(card.innerText)
        if(!actionableText(notificationText)) continue
        const url=notificationLink(card); if(!url) continue
        const id=`${url}|${notificationText.slice(0,700)}`; if(seen.has(id))continue; seen.add(id)
        candidates.push({id,url,notificationText:notificationText.slice(0,1400)})
      }
      status(`Read ${cards.length} notification cards.`,`${candidates.length} comment or reply notifications are actionable`)
      const response=await api('/notification-replies','POST',{candidates})
      const unseen=response?.data?.candidates||[]
      if(unseen.length){
        const queued=await chrome.runtime.sendMessage({type:'queueNotificationReplies',candidates:unseen})
        status(`Queued ${queued?.queued ?? unseen.length} notification replies.`,`${cards.length} cards read, ${candidates.length} actionable`)
      } else status('No new comment replies need an answer.',`${cards.length} cards read, ${candidates.length} actionable`)
      await sleep(1200)
      if(new URLSearchParams(location.search).has('cc_priority')) await chrome.runtime.sendMessage({type:'finishLinkedInPriorityScan'})
      else if(new URLSearchParams(location.search).has('cc_followups')) await chrome.runtime.sendMessage({type:'closeAutomationTab'})
    }catch(error){status('Notification scan failed.',String(error).slice(0,240))}finally{scanning=false}
  }

  async function checkBadge() {
    if(onNotifications||priorityRequested)return
    const links=[...document.querySelectorAll("a[href*='/notifications']")].filter(visible)
    const link=links.find((node)=>{
      const value=normalize(`${node.innerText||''} ${node.getAttribute('aria-label')||''} ${node.title||''}`)
      const badge=node.querySelector("[aria-label*='new notification' i],[class*='badge'],[data-test-icon*='notification'],strong")
      return Boolean(badge||/\b[1-9]\d*\s+(?:new\s+)?notifications?\b/i.test(value))
    })
    if(!link)return
    priorityRequested=true
    const result=await chrome.runtime.sendMessage({type:'triggerLinkedInPriority'}).catch(()=>null)
    if(!result?.ok)priorityRequested=false
    setTimeout(()=>{priorityRequested=false},5*60*1000)
  }

  if(onNotifications){panel();scanPage()} else {setInterval(checkBadge,5000);checkBadge()}
})()
