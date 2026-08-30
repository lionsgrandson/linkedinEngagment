;(() => {
  if (location.hostname !== 'www.linkedin.com' || !location.pathname.startsWith('/in/')) return
  if (window.__codeCrafterBridge) return
  window.__codeCrafterBridge = true

  const VERSION='3.20.18'
  const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms))
  const normalize=(value)=>String(value||'').replace(/\s+/g,' ').trim()
  const visible=(node)=>Boolean(node&&node.isConnected&&node.offsetParent!==null)
  const labels=(node)=>[node?.innerText,node?.textContent,node?.getAttribute?.('aria-label'),node?.getAttribute?.('title')].filter(Boolean).map(normalize)
  const controls=(root=document)=>[...root.querySelectorAll("button,a,[role='button']")].filter(visible)
  const findControl=(pattern,root=document)=>controls(root).find((node)=>labels(node).some((value)=>pattern.test(value)))
  const api=(path,method='GET',body=null)=>chrome.runtime.sendMessage({type:'localApi',path,method,body})

  function panel(){
    if(document.getElementById('cc-profile-v2'))return
    const box=document.createElement('div');box.id='cc-profile-v2'
    box.style.cssText='position:fixed;right:18px;bottom:18px;z-index:2147483647;width:285px;padding:14px;border-radius:12px;background:#111827;color:white;font:14px Arial;box-shadow:0 8px 30px #0006'
    box.innerHTML=`<b>CodeCrafter Connection v${VERSION}</b><div id="cc-profile-status" style="margin-top:9px">Starting...</div>`
    document.documentElement.appendChild(box)
  }
  function status(value){panel();document.getElementById('cc-profile-status').textContent=value}
  async function finish(task,outcome='done',reason=''){await chrome.runtime.sendMessage({type:'clearProfileTask',url:task.url||location.href,outcome,reason})}
  async function waitForDialog(timeout=6000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const dialog=[...document.querySelectorAll("[role='dialog']")].filter(visible).at(-1);if(dialog)return dialog;await sleep(150)}return null}
  async function confirmConnection(timeout=10000){
    const deadline=Date.now()+timeout
    while(Date.now()<deadline){
      const feedback=normalize([...document.querySelectorAll("[role='alert'],.artdeco-toast-item")].filter(visible).map((n)=>n.innerText).join(' '))
      if(/invitation (?:was )?sent|request (?:was )?sent|invitation sent/i.test(feedback))return true
      if(findControl(/^Pending(?:\s|$)|Invitation pending/i))return true
      if(/couldn.?t|failed|try again|invitation limit|email address required/i.test(feedback))return false
      await sleep(250)
    }
    return false
  }
  function editor(){return [...document.querySelectorAll("div[contenteditable='true'][role='textbox'],textarea[placeholder*='message' i],textarea")].filter(visible).find((node)=>!/search/i.test(`${node.getAttribute('aria-label')||''} ${node.getAttribute('placeholder')||''}`))||null}
  function editorValue(input){return normalize(input instanceof HTMLTextAreaElement?input.value:input?.textContent)}
  function putDraft(input,value){
    input.focus()
    if(input instanceof HTMLTextAreaElement){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,value);input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}))}
    else{input.textContent='';document.execCommand('insertText',false,value);input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}))}
    return editorValue(input)===normalize(value)
  }
  async function sendMessage(input,expected){
    const root=input.closest('form,.msg-form,[role=dialog]')||document
    let send=findControl(/^Send(?: message)?$/i,root)
    if(send&&!send.disabled){send.click()}else if(input.closest('form')?.requestSubmit){input.closest('form').requestSubmit()}else{input.focus();input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));input.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}))}
    const deadline=Date.now()+10000
    while(Date.now()<deadline){
      const body=normalize(document.querySelector('main')?.innerText||document.body.innerText)
      if(body.includes(normalize(expected).slice(0,80))&&!editorValue(editor()))return true
      await sleep(250)
    }
    return false
  }

  async function run(){
    panel();status('Loading connection task...')
    const stored=await chrome.runtime.sendMessage({type:'getProfileTask',url:location.href});const task=stored?.task
    if(!task){status('No connection task for this profile.');return}
    await sleep(700)
    const root=document.querySelector('main')||document
    const connect=()=>findControl(/^(?:Connect(?: with .+)?|Invite .+ to connect)$/i,root)||findControl(/^(?:Connect(?: with .+)?|Invite .+ to connect)$/i)
    const message=()=>findControl(/^Message(?:\s|$)/i,root)||findControl(/^Message(?:\s|$)/i)

    if(task.mode==='acceptedCheck'){
      if(findControl(/^Pending(?:\s|$)|Invitation pending/i,root)||connect()){status('Connection is still pending.');await finish(task);return}
      const messageButton=message();if(!messageButton){status('Could not confirm acceptance.');await finish(task);return}
      const draft=await api('/draft-message','POST',{stage:'accepted',context:normalize(root.innerText).slice(0,5000)})
      if(!draft?.ok||!draft.data?.allowed||!draft.data?.message){status('Accepted connection opener was not drafted.');await finish(task);return}
      messageButton.click();await sleep(800);const input=editor()
      if(!input||!putDraft(input,draft.data.message)){status('Message composer was unavailable.');await finish(task,'retry','accepted connection composer unavailable');return}
      await sleep(1200);const confirmed=await sendMessage(input,draft.data.message)
      await api('/result','POST',{ok:confirmed,kind:confirmed?'message':undefined,actionId:`linkedin:message:${task.url}`,url:task.url,reason:confirmed?'Accepted connection opener sent':'Accepted connection opener not confirmed'})
      status(confirmed?'Connection opener sent.':'Connection opener was not confirmed.');await finish(task,confirmed?'done':'retry',confirmed?'':'message not confirmed');return
    }

    if(findControl(/^Pending(?:\s|$)|Invitation pending/i,root)){status('Connection request is already pending.');await finish(task);return}
    if(message()&&!connect()){status('Already connected.');await finish(task);return}
    let button=connect()
    if(!button){const more=findControl(/^More$|More actions/i,root);more?.click();await sleep(500);button=connect()}
    if(!button){status('Connect button was not found.');await finish(task,'retry','Connect button not found');return}
    button.click();let dialog=await waitForDialog()
    if(!dialog){const confirmed=await confirmConnection(4000);await api('/result','POST',{ok:confirmed,kind:confirmed?'connection':undefined,actionId:`linkedin:connection:${task.url}`,url:task.url,reason:confirmed?'Connection request confirmed':'Connection request not confirmed'});await finish(task,confirmed?'done':'retry',confirmed?'':'connection not confirmed');return}

    status('Sending connection request without a note...')
    await sleep(900)
    dialog=[...document.querySelectorAll("[role='dialog']")].filter(visible).at(-1)||dialog
    let send=findControl(/^Send without a note$/i,dialog)||findControl(/^Send(?: invitation| now)?$/i,dialog)
    if(!send){
      const addNote=findControl(/^Add a note$|Personalize invitation/i,dialog)
      if(addNote){
        const without=findControl(/^Send without a note$/i,dialog)
        if(without)send=without
      }
    }
    if(!send||send.disabled){status('LinkedIn did not expose Send without a note.');await finish(task,'retry','Send without a note unavailable');return}
    send.click();const confirmed=await confirmConnection()
    await api('/result','POST',{ok:confirmed,kind:confirmed?'connection':undefined,actionId:`linkedin:connection:${task.url}`,url:task.url,reason:confirmed?'LinkedIn connection sent without a note':'LinkedIn did not confirm connection request'})
    status(confirmed?'Connection request sent without a note.':'Connection request was not confirmed.');await finish(task,confirmed?'done':'retry',confirmed?'':'connection not confirmed')
  }

  run().catch(async(error)=>{status(`Connection automation error: ${String(error).slice(0,160)}`)})
})()
