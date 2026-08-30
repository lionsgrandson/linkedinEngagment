;(() => {
  if (location.hostname !== 'www.linkedin.com' || !/^\/feed\/?$/.test(location.pathname)) return
  if (new URLSearchParams(location.search).has('cc_scheduled_post')) return
  if (window.__codeCrafterBridge) return
  window.__codeCrafterBridge = true

  const VERSION='3.20.18'
  const CYCLE_MS=3500
  const HANDLED_KEY='ccLinkedInHandledPosts'
  const HANDLED_TTL=30*24*60*60*1000
  const processed=new Set();const persistent=new Set();let busy=false;let paused=false
  const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms))
  const normalize=(value)=>String(value||'').replace(/\s+/g,' ').trim()
  const visible=(node)=>Boolean(node&&node.isConnected&&node.offsetParent!==null)
  const api=(path,method='GET',body=null)=>chrome.runtime.sendMessage({type:'localApi',path,method,body})

  const ready=chrome.storage.local.get(HANDLED_KEY).then((stored)=>{const now=Date.now();for(const [key,value] of Object.entries(stored[HANDLED_KEY]||{})){const at=Number(value?.at||value||0);if(key&&at&&now-at<HANDLED_TTL)persistent.add(key)}}).catch(()=>{})
  async function markHandled(key,state='handled'){if(!key)return;processed.add(key);persistent.add(key);const stored=await chrome.storage.local.get(HANDLED_KEY).catch(()=>({}));const current=stored[HANDLED_KEY]||{};current[key]={at:Date.now(),state};const pruned=Object.fromEntries(Object.entries(current).filter(([,value])=>Date.now()-Number(value?.at||value||0)<HANDLED_TTL).sort((a,b)=>Number(b[1]?.at||b[1]||0)-Number(a[1]?.at||a[1]||0)).slice(0,1500));await chrome.storage.local.set({[HANDLED_KEY]:pruned}).catch(()=>{})}

  function panel(){if(document.getElementById('cc-feed-v2'))return;const box=document.createElement('div');box.id='cc-feed-v2';box.style.cssText='position:fixed;right:18px;bottom:18px;z-index:2147483647;width:250px;padding:12px;border-radius:12px;background:#111827;color:white;font:13px Arial;box-shadow:0 8px 30px #0006';box.innerHTML=`<b>CodeCrafter LinkedIn v${VERSION}</b><div id="cc-feed-v2-status" style="margin:8px 0">Starting...</div><button id="cc-feed-v2-pause" style="width:100%;padding:8px;border:0;border-radius:8px;background:#f59e0b;font-weight:700;cursor:pointer">Pause</button>`;document.documentElement.appendChild(box);const button=document.getElementById('cc-feed-v2-pause');button.onclick=()=>{paused=!paused;button.textContent=paused?'Resume':'Pause';status(paused?'Paused.':'Running.')};CodeCrafterSettings.load().then(({ui})=>{if(!ui.showOverlay)box.style.display='none'}).catch(()=>{})}
  function status(value){panel();document.getElementById('cc-feed-v2-status').textContent=value}

  function postNodes(){const legacy=[...document.querySelectorAll('div.feed-shared-update-v2')].filter(visible);if(legacy.length)return legacy;return [...document.querySelectorAll('h2')].filter((h)=>normalize(h.textContent)==='Feed post').map((h)=>h.closest("[role='listitem']")).filter((n,i,a)=>visible(n)&&a.indexOf(n)===i)}
  function postBody(node){
    const selectors=["[data-view-name='feed-commentary']",'.update-components-text','.feed-shared-update-v2__description','.feed-shared-text','.break-words']
    for(const selector of selectors){const parts=[...node.querySelectorAll(selector)].filter(visible).map((n)=>normalize(n.innerText||n.textContent)).filter((v)=>v.length>20);if(parts.length)return [...new Set(parts)].join(' ').slice(0,5000)}
    let fallback=normalize(node.innerText||'')
    fallback=fallback.replace(/Reaction button state:\s*(?:no reaction|Like)/ig,' ').replace(/\b(?:Like|Comment|Repost|Send)\b(?:\s+\b(?:Like|Comment|Repost|Send)\b){2,}/ig,' ').replace(/\b\d+\s+(?:reactions?|comments?|reposts?)\b/ig,' ')
    return normalize(fallback).slice(0,5000)
  }
  function identity(node,body){const urn=[node.getAttribute('data-urn'),node.getAttribute('data-id'),node.closest('[data-urn]')?.getAttribute('data-urn'),node.querySelector('[data-urn]')?.getAttribute('data-urn')].find(Boolean);const link=[...node.querySelectorAll("a[href*='/feed/update/'],a[href*='/posts/'],a[href*='activity-']")].map((a)=>a.href.split('?')[0]).find(Boolean);return urn||link||body.slice(0,500)}
  function commentRoots(node){return [...node.querySelectorAll(".comments-comment-item,[data-view-name='comment-item'],[data-urn*='comment']")].filter(visible)}
  function hasOwnComment(node){return commentRoots(node).some((comment)=>/\bMoshe Schwartzberg\b/i.test(normalize(comment.innerText||'')))}
  function hasExactComment(node,expected){const sig=normalize(expected).slice(0,100);return Boolean(sig&&commentRoots(node).some((c)=>normalize(c.innerText||'').includes(sig)))}
  function extract(){return postNodes().map((node,index)=>{const body=postBody(node);const key=identity(node,body);const author=[...node.querySelectorAll("a[href*='/in/']")].find(visible)?.href||'';return{index,key,text:body,authorUrl:author,alreadyCommented:hasOwnComment(node),sponsored:/\b(?:Promoted|Sponsored)\b/i.test(node.innerText||''),liked:Boolean(node.querySelector("button[aria-pressed='true'],button[aria-label*='unreact' i]")),mediaUrls:[]}}).filter((p)=>p.text.length>30&&!p.sponsored&&!p.alreadyCommented&&!processed.has(p.key)&&!persistent.has(p.key)).slice(0,6)}
  function findNode(action){return postNodes().find((node)=>identity(node,postBody(node))===action.key)||null}
  function setEditor(editor,value){editor.focus();editor.textContent='';document.execCommand('insertText',false,value);editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));return normalize(editor.textContent)===normalize(value)}
  async function waitEditor(node,timeout=6000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const e=[...node.querySelectorAll("div[contenteditable='true'][role='textbox'],textarea")].find(visible);if(e)return e;await sleep(150)}return null}
  async function confirm(node,expected,timeout=7000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(hasExactComment(node,expected)||hasOwnComment(node))return true;await sleep(200)}return false}

  async function execute(action){
    const node=findNode(action);if(!node){await markHandled(action.key,'moved');status('Post moved. Skipping it.');return}
    node.scrollIntoView({behavior:'smooth',block:'center'});await sleep(300)
    if(action.like){const like=[...node.querySelectorAll('button')].find((b)=>visible(b)&&/Reaction button state: no reaction|React Like|^Like\b/i.test(`${b.getAttribute('aria-label')||''} ${b.textContent||''}`));if(like&&like.getAttribute('aria-pressed')!=='true'){like.click();await api('/result','POST',{ok:true,kind:'like',actionId:`linkedin:like:${action.key}`,site:'linkedin',reason:'LinkedIn like clicked'})}}
    if(!action.comment){await markHandled(action.key,'no_comment');if(action.connect&&action.authorUrl)await chrome.runtime.sendMessage({type:'openProfiles',urls:[action.authorUrl]});return}
    const commentButton=[...node.querySelectorAll("button,[role='button']")].filter(visible).find((b)=>/^(Comment|Comment on this post)\b/i.test(normalize(`${b.textContent||''} ${b.getAttribute('aria-label')||''}`)));commentButton?.click();await sleep(350)
    if(hasOwnComment(node)||hasExactComment(node,action.comment)){await markHandled(action.key,'duplicate');status('Already commented here. Moving on.');return}
    const editor=await waitEditor(node);if(!editor||!setEditor(editor,action.comment)){await markHandled(action.key,'editor_failed');status('Comment editor failed. Moving on.');return}
    for(let left=1800;left>0;left-=100){if(paused)return;status(`Comment sends in ${(left/1000).toFixed(1)}s`);await sleep(100)}
    const submit=node.querySelector('button.comments-comment-box__submit-button')||[...node.querySelectorAll("button,[role='button']")].filter(visible).find((b)=>/^(Comment|Post)$/i.test(normalize(b.textContent))&&!b.disabled)
    if(!submit){await markHandled(action.key,'submit_missing');status('Comment submit unavailable. Moving on.');return}
    await markHandled(action.key,'submit_attempted');submit.click();const ok=await confirm(node,action.comment);await markHandled(action.key,ok?'confirmed':'unconfirmed_no_retry');await api('/result','POST',{ok,kind:ok?'comment':undefined,actionId:`linkedin:comment:${action.key}:${normalize(action.comment).slice(0,120)}`,site:'linkedin',reason:ok?'LinkedIn comment confirmed':'Comment attempted but not confirmed; post locked'});status(ok?'Comment posted. Moving on.':'Comment attempted. Moving on without retry.');if(ok&&action.connect&&action.authorUrl)await chrome.runtime.sendMessage({type:'openProfiles',urls:[action.authorUrl]})
  }

  async function cycle(){if(busy||paused)return;busy=true;try{await ready;const settings=await CodeCrafterSettings.load();const config=settings.platforms.linkedin;if(!config?.enabled){status('LinkedIn automation disabled.');return}const posts=extract();if(!posts.length){status('No new visible posts. Scrolling...');window.scrollBy({top:750,behavior:'smooth'});await sleep(1200);return}status(`Reviewing ${posts.length} posts...`);const response=await api('/cycle','POST',{posts,topics:config.topics,writingStyle:settings.writingStyle,safeguards:settings.replySafeguards,features:{likes:config.likes,comments:config.comments,commentEveryOrganicPost:config.commentEveryOrganicPost,connections:config.connections,imageRecognition:config.imageRecognition}});if(!response?.ok){status(`Ollama error: ${response?.error||'unknown'}`);return}const info=response.data||{};if(!info.action){for(const item of posts.slice(0,Math.max(1,Number(info.checked||1))))await markHandled(item.key,'reviewed_no_action');window.scrollBy({top:650,behavior:'smooth'});status('No action selected. Moving on.');return}await execute(info.action);window.scrollBy({top:650,behavior:'smooth'});await sleep(1200)}catch(error){status(`Feed error: ${String(error).slice(0,150)}`)}finally{busy=false}}

  panel();setInterval(cycle,CYCLE_MS);cycle()
})()
