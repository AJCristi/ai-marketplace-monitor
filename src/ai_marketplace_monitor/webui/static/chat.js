import {esc} from './console-model.js';

export const CHAT_STARTERS = ['Is the price fair?','What should I check in person?','Draft a message to the seller','Any red flags?'];
// The server accepts alternating turns that start with the user; an odd count keeps that true.
const HISTORY_LIMIT = 39;

export async function* chatEvents(body) {
  const reader=body.getReader(), decoder=new TextDecoder();
  let buffer='';
  for(;;){
    const {done,value}=await reader.read();
    buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});
    const lines=buffer.split('\n');
    buffer=done?'':lines.pop();
    for(const line of lines)if(line.trim())yield JSON.parse(line);
    if(done)return;
  }
}

export function splitNoteProposal(content) {
  const match=content.match(/<note>([\s\S]*?)(?:<\/note>|$)/);
  if(!match)return {text:content,proposal:''};
  return {text:(content.slice(0,match.index)+content.slice(match.index+match[0].length)).trim(),proposal:match[1].trim()};
}

export function chatHtml(row, {messages=[], busy=false, error='', draft='', photos=false}={}) {
  const photoCount=(row.photos||[]).length;
  const log=messages.map((message,index)=>{
    const isLast=index===messages.length-1, {text,proposal}=splitNoteProposal(message.content);
    const showProposal=message.role==='assistant'&&proposal&&!(busy&&isLast);
    const proposalHtml=showProposal?`<div class="chat-note"><span class="xs d">Suggested addition to your note</span><p>${esc(proposal)}</p>${message.noteStatus==='saved'?'<span class="xs d">Added to your note.</span>':`<button class="btn sm" type="button" data-chat-save-note="${index}" ${busy||message.noteStatus==='saving'?'disabled':''}>Add to note</button>`}</div>`:'';
    return `<div class="chat-msg ${message.role}"><span class="xs d">${message.role==='user'?'You':'AI'}</span><p${isLast&&message.role==='assistant'?' data-chat-reply':''}>${esc(text.replaceAll('**',''))||'…'}</p>${proposalHtml}</div>`;
  }).join('');
  return `<h2 class="match-h">Chat about this match</h2>`+
    (messages.length?`<div class="chat-log" aria-live="polite">${log}</div>`:`<p class="sm d">Ask the search’s AI about this listing. Chats are not saved.</p><div class="row wr">${CHAT_STARTERS.map(starter=>`<button class="btn sm" type="button" data-chat-starter="${esc(starter)}" ${busy?'disabled':''}>${esc(starter)}</button>`).join('')}</div>`)+
    (error?`<p class="sm warn" role="alert">${esc(error)}</p>`:'')+
    `<form class="chat-form"><label class="vh" for="chat-input">Ask about this listing</label><textarea class="ta" id="chat-input" rows="2" maxlength="2000" placeholder="Ask about this listing… (Enter to send)">${esc(draft)}</textarea>`+
    `<div class="row wr">${photoCount?`<label class="row sm"><input type="checkbox" id="chat-photos" ${photos?'checked':''}>Include photos (${Math.min(photoCount,4)})</label><span class="xs d gr">Costs more; the AI model must support images.</span>`:'<span class="gr"></span>'}`+
    `${messages.length&&!busy?'<button class="btn q" type="button" data-chat-clear>Clear</button>':''}${busy?'<button class="btn" type="button" data-chat-stop>Stop</button>':'<button class="btn p" type="submit">Send</button>'}</div></form>`;
}

export function createChatView({api, appendNote}) {
  const conversations=new Map();
  let current=null, controller=null, busyKey=null, photos=false;
  const conversation=key=>{if(!conversations.has(key))conversations.set(key,{messages:[],error:'',draft:''});return conversations.get(key);};
  const path=row=>`/api/matches/${encodeURIComponent(row.marketplace)}/${encodeURIComponent(row.listing_id)}/chat`;
  function draw(){
    if(!current)return;
    const {container,key}=current, input=container.querySelector?.('#chat-input');
    const refocus=typeof document!=='undefined'&&input&&document.activeElement===input;
    container.innerHTML=chatHtml(current.row,{...conversation(key),busy:busyKey!==null,photos});
    const log=container.querySelector?.('.chat-log');if(log)log.scrollTop=log.scrollHeight;
    if(refocus){const next=container.querySelector('#chat-input');next.focus({preventScroll:true});next.setSelectionRange(next.value.length,next.value.length);}
  }
  function showReply(text){
    const node=current?.container.querySelector?.('[data-chat-reply]');
    if(!node){draw();return;}
    node.textContent=splitNoteProposal(text).text.replaceAll('**','');
    const log=current.container.querySelector('.chat-log');if(log)log.scrollTop=log.scrollHeight;
  }
  async function send(text){
    text=text.trim();
    if(!text||busyKey!==null||!current)return;
    const {row,key}=current, chat=conversation(key);
    chat.messages.push({role:'user',content:text});
    const payload=chat.messages.slice(-HISTORY_LIMIT).map(({role,content})=>({role,content})), reply={role:'assistant',content:''};
    chat.messages.push(reply);chat.draft='';chat.error='';
    const own=controller=new AbortController();busyKey=key;
    draw();
    try{
      const response=await api(path(row),{method:'POST',body:JSON.stringify({item:row.item,messages:payload,photos}),signal:own.signal});
      if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.detail||data.error||`Chat failed (${response.status}).`);}
      for await(const event of chatEvents(response.body)){
        if(event.error)throw new Error(event.error);
        reply.content+=event.text||'';
        if(current?.key===key)showReply(reply.content);
      }
      if(!reply.content.trim())throw new Error('The AI returned an empty answer.');
    }catch(error){
      if(!reply.content.trim()){chat.messages.splice(-2);chat.draft||=text;}
      if(error.name!=='AbortError')chat.error=error.message;
    }finally{
      if(controller===own){controller=null;busyKey=null;}
      if(current?.key===key)draw();
    }
  }
  async function saveProposal(index){
    if(!current)return;
    const {row,key}=current, chat=conversation(key), message=chat.messages[index];
    const proposal=message&&splitNoteProposal(message.content).proposal;
    if(!proposal||message.noteStatus)return;
    message.noteStatus='saving';draw();
    try{await appendNote(row,proposal);message.noteStatus='saved';chat.error='';}
    catch(error){delete message.noteStatus;chat.error=error.message;}
    if(current?.key===key)draw();
  }
  function mount(container,row){
    if(!container)return;
    const key=JSON.stringify([row.marketplace,row.listing_id,row.item]);
    if(busyKey!==null&&busyKey!==key)controller?.abort();
    current={container,row,key};
    draw();
    container.oninput=event=>{if(event.target.id==='chat-input')conversation(key).draft=event.target.value;};
    container.onchange=event=>{if(event.target.id==='chat-photos')photos=event.target.checked;};
    container.onsubmit=event=>{event.preventDefault();send(conversation(key).draft);};
    container.onkeydown=event=>{if(event.target.id==='chat-input'&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();send(conversation(key).draft);}};
    container.onclick=event=>{
      const button=event.target.closest?.('button');if(!button||button.disabled)return;
      if(button.dataset.chatStarter)send(button.dataset.chatStarter);
      else if(button.dataset.chatSaveNote!==undefined)saveProposal(Number(button.dataset.chatSaveNote));
      else if(button.hasAttribute('data-chat-stop'))controller?.abort();
      else if(button.hasAttribute('data-chat-clear')){conversations.delete(key);draw();}
    };
  }
  return {mount,send};
}
