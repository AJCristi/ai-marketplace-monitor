import {esc, safeUrl} from './console-model.js';
import {chatEvents} from './chat.js';

export const SEARCH_CHAT_STARTERS = ['Make it stricter','Add similar models','Rewrite the description'];
// The server accepts alternating turns that start with the user; an odd count keeps that true.
const HISTORY_LIMIT = 39;
const PRICE_CHECK_POLL_MS = 2000;

export function hideSearchBlock(content) {
  return content.replace(/<search>[\s\S]*?(?:<\/search>|$)/g,'').replaceAll('**','').trim();
}

const termList=value=>(Array.isArray(value)?value:filledText(value)?[value]:[]).filter(filledText);
const filledText=value=>typeof value==='string'&&value.trim()!=='';
const checking=check=>['queued','running'].includes(check?.state);

export function priceCheckHtml(check) {
  if(!check)return '';
  const card=body=>`<div class="chat-note price-check"><span class="xs d">Facebook prices</span>${body}</div>`;
  if(checking(check))return card('<p class="sm" role="status">Checking Facebook results pages… a running search goes first.</p><button class="btn sm" type="button" data-price-stop>Stop</button>');
  if(check.state==='error')return card(`<p class="sm warn" role="alert">${esc(check.error)}</p>`);
  if(check.state==='stopped')return card('<p class="sm d">Price check stopped.</p>');
  const result=check.result, searched=result.searched||{phrases:[],cities:[]};
  const searchedText=`Searched ${searched.phrases.map(phrase=>`“${phrase}”`).join(', ')} in ${searched.cities.join(', ')}.`;
  if(!result.count)return card(`<p class="sm">No priced listings found.</p><p class="xs d">${esc(searchedText)}</p>`);
  const money=value=>esc(result.currency+Number(value).toLocaleString('en-US'));
  const others=Object.entries(result.other_currencies||{}).map(([currency,count])=>` · ${count} in ${currency||'no symbol'} not counted`).join('');
  const examples=result.examples.map(example=>{
    const url=safeUrl(example.url);
    const title=esc(example.title||'Untitled');
    return `<li>${url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${title}</a>`:title} <span class="m d">${esc(example.price)}</span></li>`;
  }).join('');
  const applied=check.applied===undefined
    ?'<button class="btn sm" type="button" data-price-apply>Use typical range</button>'
    :`<span class="chat-applied">${check.applied.length?`Updated ${esc(check.applied.join(', '))}`:'Already set to the typical range'}</span>`;
  return card(`<p><strong>${money(result.p25)}–${money(result.p75)}</strong> typical · median ${money(result.median)} · range ${money(result.low)}–${money(result.high)}</p>`+
    `<p class="xs d">${result.count} listings${result.excluded?` · ${result.excluded} excluded by anti-keywords`:''}${esc(others)}. ${esc(searchedText)}</p>`+
    `<ul class="price-examples sm">${examples}</ul>${applied}`+
    `<p class="xs d">${check.shared?'Shared with the AI.':'The AI sees these results with your next message.'}</p>`);
}

export function searchChatHtml({isNew=true, backend='', canSearchWeb=false, messages=[], busy=false, error='', draft='', webSearch=false, priceCheck=null}={}) {
  const log=messages.map((message,index)=>{
    const isLast=index===messages.length-1;
    const applied=message.applied?.length?`<span class="chat-applied">Updated ${esc(message.applied.join(', '))}</span>`:'';
    const warning=message.warning?`<span class="xs warn">${esc(message.warning)}</span>`:'';
    return `<div class="chat-msg ${message.role}"><span class="xs d">${message.role==='user'?'You':'AI'}</span><p${isLast&&message.role==='assistant'?' data-chat-reply':''}>${esc(hideSearchBlock(message.shown??message.content))||'…'}</p>${applied}${warning}</div>`;
  }).join('');
  const intro=isNew
    ?'<p class="sm d">Describe what you want to find. The AI asks only what it needs and fills the form as you go. Review the fields, then save.</p>'
    :`<p class="sm d">Ask for changes to this search. The AI sees its current values and edits the form; nothing is saved until you save.</p><div class="row wr">${SEARCH_CHAT_STARTERS.map(starter=>`<button class="btn sm" type="button" data-chat-starter="${esc(starter)}" ${busy?'disabled':''}>${esc(starter)}</button>`).join('')}</div>`;
  const webSearchHtml=canSearchWeb
    ?`<label class="row sm"><input type="checkbox" id="search-chat-web" ${webSearch?'checked':''} ${busy?'disabled':''}>Search the web</label><span class="xs d gr">Billed by your AI provider.</span>`
    :'<span class="gr"></span>';
  return `<div class="row sb"><h2 class="match-h">Set up with AI</h2><span class="xs d m">${backend?esc(backend)+' · ':''}not saved</span></div>`+
    (messages.length?`<div class="chat-log" aria-live="polite">${log}</div>`:intro)+
    priceCheckHtml(priceCheck)+
    `<div class="row wr"><button class="btn sm" type="button" data-price-check ${busy||checking(priceCheck)?'disabled':''}>Check Facebook prices</button><span class="xs d gr">Summarizes asking prices for your search phrases.</span></div>`+
    (error?`<p class="sm warn" role="alert">${esc(error)}</p>`:'')+
    `<form class="chat-form"><label class="vh" for="search-chat-input">Message the AI about this search</label><textarea class="ta" id="search-chat-input" rows="3" maxlength="2000" placeholder="${isNew?'e.g. iphone 13 pro, good battery, under 600':'e.g. exclude cracked screens'} (Enter to send)">${esc(draft)}</textarea>`+
    `<div class="row wr">${webSearchHtml}${messages.length&&!busy?'<button class="btn q" type="button" data-chat-clear>Clear</button>':''}${busy?'<button class="btn" type="button" data-chat-stop>Stop</button>':'<button class="btn p" type="submit">Send</button>'}</div></form>`;
}

export function createSearchChatView({api, currentFields, applyFields, pollMs=PRICE_CHECK_POLL_MS}) {
  let current=null, controller=null, busyForm=null;
  const conversation=form=>form.searchChat||={messages:[],error:'',draft:'',webSearch:false,backend:'',canSearchWeb:false,priceCheck:null,priceContext:''};
  const redraw=form=>{if(current?.form===form)draw();};
  async function request(path,options){
    const response=await api(path,options), data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.detail||data.error||`Request failed (${response.status}).`);
    return data;
  }
  async function checkPrices(){
    if(!current)return;
    const {form}=current, chat=conversation(form);
    if(checking(chat.priceCheck))return;
    const fields=currentFields(), phrases=termList(fields.search_phrases);
    if(!phrases.length){chat.error='Add search phrases first, or describe the item to the AI.';draw();return;}
    chat.error='';chat.priceCheck={state:'queued'};draw();
    try{
      let job=await request('/api/items/price-check',{method:'POST',body:JSON.stringify({item:form.new?'':form.name,search_phrases:phrases,antikeywords:termList(fields.antikeywords)})});
      chat.priceCheck=job;redraw(form);
      while(checking(job)){
        await new Promise(resolve=>setTimeout(resolve,pollMs));
        if(chat.priceCheck?.job_id!==job.job_id||!checking(chat.priceCheck))return;
        job=await request(`/api/items/price-check/${job.job_id}`);
        chat.priceCheck=job;redraw(form);
      }
      chat.priceContext=job.state==='done'?job.result.context:'';
    }catch(error){chat.priceCheck={state:'error',error:error.message};}
    redraw(form);
  }
  async function stopPriceCheck(){
    const form=current?.form, check=form&&conversation(form).priceCheck;
    if(!check?.job_id)return;
    try{conversation(form).priceCheck=await request(`/api/items/price-check/${check.job_id}`,{method:'DELETE'});}
    catch(error){conversation(form).error=error.message;}
    redraw(form);
  }
  function applyPriceRange(){
    const chat=current&&conversation(current.form), result=chat?.priceCheck?.result;
    if(!result?.count||chat.priceCheck.applied!==undefined)return;
    chat.priceCheck.applied=applyFields({min_price:String(result.p25),max_price:String(result.p75)});
    draw();
  }
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
    const {form}=current, chat=conversation(form), attached=chat.priceContext;
    chat.messages.push(attached?{role:'user',content:`${attached}\n\n${text}`,shown:text}:{role:'user',content:text});
    chat.priceContext='';
    if(attached)chat.priceCheck.shared=true;
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
      if(!reply.content.trim()){
        chat.messages.splice(-2);chat.draft||=text;
        if(attached){chat.priceContext=attached;chat.priceCheck.shared=false;}
      }
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
      else if(button.hasAttribute('data-price-check'))checkPrices();
      else if(button.hasAttribute('data-price-stop'))stopPriceCheck();
      else if(button.hasAttribute('data-price-apply'))applyPriceRange();
      else if(button.hasAttribute('data-chat-clear')){Object.assign(chat,{messages:[],error:'',draft:''});draw();}
    };
  }
  return {mount,send,checkPrices};
}
