import {esc} from './console-model.js';
import {chatEvents} from './chat.js';

export const SEARCH_CHAT_STARTERS = ['Make it stricter','Add similar models','Rewrite the description'];
// The server accepts alternating turns that start with the user; an odd count keeps that true.
const HISTORY_LIMIT = 39;

export function hideSearchBlock(content) {
  return content.replace(/<search>[\s\S]*?(?:<\/search>|$)/g,'').replaceAll('**','').trim();
}

export function searchChatHtml({isNew=true, backend='', canSearchWeb=false, messages=[], busy=false, error='', draft='', webSearch=false}={}) {
  const log=messages.map((message,index)=>{
    const isLast=index===messages.length-1;
    const applied=message.applied?.length?`<span class="chat-applied">Updated ${esc(message.applied.join(', '))}</span>`:'';
    const warning=message.warning?`<span class="xs warn">${esc(message.warning)}</span>`:'';
    return `<div class="chat-msg ${message.role}"><span class="xs d">${message.role==='user'?'You':'AI'}</span><p${isLast&&message.role==='assistant'?' data-chat-reply':''}>${esc(hideSearchBlock(message.content))||'…'}</p>${applied}${warning}</div>`;
  }).join('');
  const intro=isNew
    ?'<p class="sm d">Describe what you want to find. The AI asks only what it needs and fills the form as you go. Review the fields, then save.</p>'
    :`<p class="sm d">Ask for changes to this search. The AI sees its current values and edits the form; nothing is saved until you save.</p><div class="row wr">${SEARCH_CHAT_STARTERS.map(starter=>`<button class="btn sm" type="button" data-chat-starter="${esc(starter)}" ${busy?'disabled':''}>${esc(starter)}</button>`).join('')}</div>`;
  const webSearchHtml=canSearchWeb
    ?`<label class="row sm"><input type="checkbox" id="search-chat-web" ${webSearch?'checked':''} ${busy?'disabled':''}>Search the web</label><span class="xs d gr">Billed by your AI provider.</span>`
    :'<span class="gr"></span>';
  return `<div class="row sb"><h2 class="match-h">Set up with AI</h2><span class="xs d m">${backend?esc(backend)+' · ':''}not saved</span></div>`+
    (messages.length?`<div class="chat-log" aria-live="polite">${log}</div>`:intro)+
    (error?`<p class="sm warn" role="alert">${esc(error)}</p>`:'')+
    `<form class="chat-form"><label class="vh" for="search-chat-input">Message the AI about this search</label><textarea class="ta" id="search-chat-input" rows="3" maxlength="2000" placeholder="${isNew?'e.g. iphone 13 pro, good battery, under 600':'e.g. exclude cracked screens'} (Enter to send)">${esc(draft)}</textarea>`+
    `<div class="row wr">${webSearchHtml}${messages.length&&!busy?'<button class="btn q" type="button" data-chat-clear>Clear</button>':''}${busy?'<button class="btn" type="button" data-chat-stop>Stop</button>':'<button class="btn p" type="submit">Send</button>'}</div></form>`;
}

export function createSearchChatView({api, currentFields, applyFields}) {
  let current=null, controller=null, busyForm=null;
  const conversation=form=>form.searchChat||={messages:[],error:'',draft:'',webSearch:false,backend:'',canSearchWeb:false};
  function draw(){
    if(!current)return;
    const {container,form}=current, chat=conversation(form), input=container.querySelector?.('#search-chat-input');
    const refocus=typeof document!=='undefined'&&input&&document.activeElement===input;
    container.innerHTML=searchChatHtml({...chat,isNew:form.new,busy:busyForm!==null});
    const log=container.querySelector?.('.chat-log');if(log)log.scrollTop=log.scrollHeight;
    if(refocus){const next=container.querySelector('#search-chat-input');next.focus({preventScroll:true});next.setSelectionRange(next.value.length,next.value.length);}
  }
  function showReply(text){
    const node=current?.container.querySelector?.('[data-chat-reply]');
    if(!node){draw();return;}
    node.textContent=hideSearchBlock(text);
    const log=current.container.querySelector('.chat-log');if(log)log.scrollTop=log.scrollHeight;
  }
  async function loadCapabilities(form){
    const chat=conversation(form);
    try{
      const response=await api(`/api/items/suggest?item=${encodeURIComponent(form.new?'':form.name)}`);
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.detail||data.error||`AI unavailable (${response.status}).`);
      chat.backend=data.backend;chat.canSearchWeb=data.web_search===true;
    }catch(error){chat.error=error.message;}
    if(current?.form===form)draw();
  }
  async function send(text){
    text=text.trim();
    if(!text||busyForm!==null||!current)return;
    const {form}=current, chat=conversation(form);
    chat.messages.push({role:'user',content:text});
    const messages=chat.messages.slice(-HISTORY_LIMIT).map(({role,content})=>({role,content})), reply={role:'assistant',content:''};
    chat.messages.push(reply);chat.draft='';chat.error='';
    const own=controller=new AbortController();busyForm=form;
    draw();
    try{
      const body={item:form.new?'':form.name,messages,fields:currentFields(),web_search:chat.canSearchWeb&&chat.webSearch};
      const response=await api('/api/items/suggest',{method:'POST',body:JSON.stringify(body),signal:own.signal});
      if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.detail||data.error||`Chat failed (${response.status}).`);}
      for await(const event of chatEvents(response.body)){
        if(event.error)throw new Error(event.error);
        if(event.warning)reply.warning=event.warning;
        if(event.fields&&current?.form===form)reply.applied=applyFields(event.fields);
        reply.content+=event.text||'';
        if(current?.form===form)showReply(reply.content);
      }
      if(!reply.content.trim())throw new Error('The AI returned an empty answer.');
    }catch(error){
      if(!reply.content.trim()){chat.messages.splice(-2);chat.draft||=text;}
      if(error.name!=='AbortError')chat.error=error.message;
    }finally{
      if(controller===own){controller=null;busyForm=null;}
      if(current?.form===form)draw();
    }
  }
  function mount(container,form){
    if(!container)return;
    if(busyForm!==null&&busyForm!==form)controller?.abort();
    current={container,form};
    const chat=conversation(form);
    draw();
    if(!chat.backend&&!chat.error)loadCapabilities(form);
    container.oninput=event=>{if(event.target.id==='search-chat-input')chat.draft=event.target.value;};
    container.onchange=event=>{if(event.target.id==='search-chat-web')chat.webSearch=event.target.checked;};
    container.onsubmit=event=>{event.preventDefault();send(chat.draft);};
    container.onkeydown=event=>{if(event.target.id==='search-chat-input'&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();send(chat.draft);}};
    container.onclick=event=>{
      const button=event.target.closest?.('button');if(!button||button.disabled)return;
      if(button.dataset.chatStarter)send(button.dataset.chatStarter);
      else if(button.hasAttribute('data-chat-stop'))controller?.abort();
      else if(button.hasAttribute('data-chat-clear')){Object.assign(chat,{messages:[],error:'',draft:''});draw();}
    };
  }
  return {mount,send};
}
