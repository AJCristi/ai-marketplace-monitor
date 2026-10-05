import {safeUrl, matchPhotoUrl} from './console-model.js';
import {createRelatedView} from './related.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const matchId = row => JSON.stringify([row.key, row.item]);
export function groupMatches(rows, by = 'search', item = '') {
  const groups = new Map();
  for (const row of rows) {
    const names = by === 'none' ? [''] : by === 'date' ? [row.found_at?.slice(0,10) || 'Unknown date'] : [...new Set([row.item,...row.filed_under])].filter(name=>!item || name===item);
    for (const name of names) {
      if (!groups.has(name)) groups.set(name,[]);
      const group = groups.get(name);
      const existing = by==='search' ? group.findIndex(entry=>entry.key===row.key) : -1;
      const entry = {...row, filed_by_you:by==='search' && name!==row.item};
      if (existing < 0) group.push(entry);
      else if (by==='search' && row.item===name) group[existing]=entry;
    }
  }
  return groups;
}
export function mergeMatchRows(previous, incoming, holdOrder) {
  if (!holdOrder) return incoming;
  const updates = new Map(incoming.map(row=>[matchId(row),row]));
  return previous.map(row=>{const next=updates.get(matchId(row));updates.delete(matchId(row));return next||row;}).concat([...updates.values()]);
}
export function applyRecheckResult(rows, result) {
  return rows.map(row=>{
    if(row.marketplace!==result.marketplace||row.listing_id!==result.listing_id||![result.original_item||result.item,result.item].includes(row.item))return row;
    const updated={...row,...(result.item===row.item&&result.status!=='error'?{evaluation_status:result.status}:{}),recheck:{at:result.at,status:result.status,old_score:result.old_score,old_price:result.old_price,reason:result.reason,threshold:result.threshold,checked_item:result.item}};
    if(result.price!=null)updated.current_price=result.price;
    if(result.item===row.item&&['passed','below_threshold'].includes(result.status))for(const field of ['score','conclusion','comment','ai_name'])if(Object.hasOwn(result,field))updated[field]=result[field];
    return updated;
  });
}
export function matchDate(value) {
  if (!value) return '—';
  const date=new Date(value); if(Number.isNaN(date.valueOf()))return '—';
  const today=new Date(), yesterday=new Date();yesterday.setDate(today.getDate()-1);
  const day=date.toDateString()===today.toDateString()?'Today':date.toDateString()===yesterday.toDateString()?'Yesterday':date.toLocaleDateString([], {month:'short',day:'numeric',...(date.getFullYear()===today.getFullYear()?{}:{year:'numeric'})});
  return `${day} · ${date.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`;
}
const numericPrice = value => {const match=String(value||'').match(/^\s*(?:[A-Z]{3}|[$£€₱¥])?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(?:[A-Z]{3}|[$£€₱¥])?\s*$/i);return match?Number(match[1].replaceAll(',','')):NaN;};
export const priceDropped = row => Number.isFinite(numericPrice(row.current_price)) && numericPrice(row.current_price)<numericPrice(row.recheck?.old_price || row.price);
const aiText = value => String(value ?? '').replaceAll('**','');
const score = row => row.score == null ? '—' : `${row.score}/5`;
const sellerStatus = row => ({established:['Established','ok'],caution:['Caution','warn'],unknown:['Unknown','d']})[row.seller_assessment?.status] || ['Unknown','d'];
const sellerBadge = row => {const [label,color]=sellerStatus(row);return `<span class="tag ${color}">Seller: ${label}</span>`;};
function sellerDetail(row) {
  const assessment=row.seller_assessment, url=safeUrl(assessment?.profile_url);
  const reasons=assessment?.reasons?.length?assessment.reasons:['Seller evidence is not available. Re-check this listing to collect it.'];
  return `<section aria-label="Seller credibility"><h3>Seller credibility</h3><p>${sellerBadge(row)}</p><ul class="sm">${reasons.map(reason=>`<li>${esc(reason)}</li>`).join('')}</ul>${url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">View seller profile ↗</a>`:''}${assessment?.checked_at?`<p class="xs d">Checked ${esc(matchDate(assessment.checked_at))}</p>`:''}<p class="xs d">Based on the listing’s seller panel. This does not verify identity or guarantee a safe transaction.</p></section>`;
}
const photo = row => `<span class="match-photo"><span>no photo</span>${matchPhotoUrl(row)?`<img src="${esc(matchPhotoUrl(row))}" alt="" loading="lazy" referrerpolicy="no-referrer">`:''}</span>`;
export function galleryHtml(row, selected = 0) {
  const photos=(row.photos||[]).filter(photo=>matchPhotoUrl(row,photo));
  if(!photos.length)return '<section class="match-gallery" aria-label="Photos"><div class="gallery-main">No photos saved</div><p class="xs d">Photos are saved by the monitor. Re-check to collect a listing’s gallery.</p></section>';
  selected=((selected%photos.length)+photos.length)%photos.length;
  return `<section class="match-gallery" aria-label="Photos"><div class="gallery-main"><img src="${esc(matchPhotoUrl(row,photos[selected]))}" alt="Photo ${selected+1} of ${photos.length} — ${esc(row.title)}">${photos.length>1?'<div class="gallery-controls row"><button class="btn sm" data-photo-step="-1" aria-label="Previous photo">‹</button><button class="btn sm" data-photo-step="1" aria-label="Next photo">›</button></div>':''}</div>${photos.length>1?`<div class="gallery-thumbs" role="group" aria-label="Choose a photo">${photos.map((photo,index)=>`<button type="button" data-photo-index="${index}" aria-label="Photo ${index+1} of ${photos.length}" aria-pressed="${index===selected}"><img src="${esc(matchPhotoUrl(row,photo))}" alt="" loading="lazy"></button>`).join('')}</div>`:''}<p class="xs d">${photos.length} saved ${photos.length===1?'photo':'photos'}${row.photo_pending?` · ${row.photo_pending} awaiting capture or unavailable`:''} · archived on the monitor, available after the listing is removed.</p></section>`;
}
const lastCheck = row => row.recheck ? `Re-checked ${matchDate(row.recheck.at)} · ${row.recheck.checked_item || row.item}: ${row.recheck.status.replaceAll('_',' ')}${row.recheck.old_score!=null?` · was ${row.recheck.old_score}/5`:''}${row.score!=null?` → now ${score(row)}`:''}${row.recheck.threshold?` · minimum ${row.recheck.threshold}`:''}` : 'Not re-checked yet';

export function createMatchesView({state, json, pageHeader, exportCsv, toast, renderSidebar, searchSummary}) {
  const $ = selector=>document.querySelector(selector);
  let data=null, rows=[], selected=null, request=0, cutoff='', visited=false, error='', loading=false;
  const expanded=new Set(), collapsed=new Set(), jobs=new Map();
  const relatedView=createRelatedView({json,toast});
  let busy=false, refreshTimer=null, filterTimer=null, detailRow=null, photoIndex=0, photoSelection=null, listScroll=0, listWindowScroll=0;
  const dismissedRows=new Map(), pendingStates=new Set();
  let focusDetail=false, loadedView=null;
  const storage=(store,key,value)=>{try{return value===undefined?store.getItem(key):value===null?store.removeItem(key):store.setItem(key,value);}catch{return null;}};
  try{cutoff=localStorage.getItem('aimm-matches-seen')||'';}catch{}
  try{for(const id of JSON.parse(sessionStorage.getItem('aimm-recheck-jobs')||'[]'))jobs.set(id,{job_id:id,state:'queued',results:[],done:0,total:0});}catch{}
  const active=()=>state.route.split('?')[0]==='#/monitor/matches'||state.route.startsWith('#/monitor/matches/');
  const detail=()=>state.route.split('?')[0].startsWith('#/monitor/matches/');
  const query=()=>new URLSearchParams(state.route.split('?')[1]||'');
  const viewKeys=['item','min_score','status','include_dismissed','price_drop','q','sort','group'];
  const viewSignature=()=>JSON.stringify(viewKeys.filter(key=>key!=='group').map(key=>query().get(key)));
  const filters=()=>[...query()].filter(([key,value])=>viewKeys.includes(key)&&!['group','sort'].includes(key)&&value&&!(key==='status'&&value==='all')&&!(['include_dismissed','price_drop'].includes(key)&&value!=='true'));
  function rememberView(p){try{storage(localStorage,'aimm-matches-view',new URLSearchParams([...p].filter(([key])=>viewKeys.includes(key))).toString());}catch{}}
  function updateQuery(p){state.route='#/monitor/matches'+(p.size?'?'+p:'');history.replaceState(null,'',state.route);rememberView(p);const clear=$('#matches-clear');if(clear)clear.hidden=!filters().length;}
  const running=()=>[...jobs.values()].some(job=>['queued','running'].includes(job.state));
  const rememberJobs=()=>{try{storage(sessionStorage,'aimm-recheck-jobs',JSON.stringify([...jobs.values()].filter(job=>['queued','running'].includes(job.state)).map(job=>job.job_id)));}catch{}};
  const params=()=>{const p=query();p.delete('group');p.delete('match_item');p.set('limit','200');if(cutoff)p.set('since',cutoff);return p;};
  function setFilter(name,value){if(!active())return;const p=query();if(value)p.set(name,value);else p.delete(name);p.delete('cursor');updateQuery(p);expanded.clear();dismissedRows.clear();listScroll=0;load();}
  function notify(message, action) {
    toast(message);
    if(action){const button=document.createElement('button');button.className='btn';button.textContent='Undo';button.onclick=action;$('#toast').append(' ',button);}
  }
  async function summary(){
    try{let seen=cutoff;try{seen=storage(localStorage,'aimm-matches-seen')||cutoff;}catch{}const p=new URLSearchParams({limit:'1'});if(seen)p.set('since',seen);const result=await json('/api/matches?'+p);state.matchSummary=result;renderSidebar();}catch{}
  }
  async function load(more=false, quiet=false, reuse=false) {
    if(!active())return;
    const token=++request;error='';loading=!quiet&&!more;
    if(loading)renderBody();
    const p=params();if(more&&data?.next_cursor)p.set('cursor',data.next_cursor);
    try{
      const result=reuse?data:await json('/api/matches?'+p);
      if(token!==request||!active())return;
      const retain=loadedView===viewSignature()&&(reuse||detail());
      if(!retain){
        const incoming=new Set(result.matches.map(matchId));
        const retained=rows.filter(row=>incoming.has(matchId(row))||dismissedRows.has(matchId(row)));
        rows=more?mergeMatchRows(rows,result.matches,true):mergeMatchRows(dismissedRows.size?retained:rows,result.matches,(running()&&quiet)||dismissedRows.size>0);
      }
      const nextCursor=retain?data?.next_cursor:result.next_cursor;
      data={...result,next_cursor:nextCursor};loadedView=viewSignature();state.matchSummary=result;
      if(detail()){
        const parts=state.route.split('?')[0].split('/');
        const item=query().get('match_item');
        if(!item)throw new Error('The detail link needs a search name.');
        const found=await json(`/api/matches/${parts[3]}/${parts[4]}/detail?item=${encodeURIComponent(item)}`);
        if(token!==request||!active())return;
        detailRow=found;selected=matchId(found);
      }
      loading=false;
      const searchSelect=document.querySelector('[data-match-filter="item"]');
      if(searchSelect){const names=[...new Set([...Object.keys(state.config.item||{}),...result.groups.map(group=>group.item)])].filter(Boolean);searchSelect.innerHTML='<option value="">All searches</option>'+names.map(name=>`<option value="${esc(name)}">${esc(name)}${Object.hasOwn(state.config.item||{},name)?'':' (removed search)'}</option>`).join('');searchSelect.value=query().get('item')||'';}
      renderSidebar();renderCounts();renderBody();
      if(!detail()&&reuse){const pane=$('#pane');pane.scrollTop=listScroll;if(typeof window!=='undefined')window.scrollTo?.(0,listWindowScroll);}
      if(!visited){visited=true;try{storage(localStorage,'aimm-matches-seen',new Date().toISOString());}catch{}}
    }catch(err){if(token!==request)return;loading=false;error=err.message;renderBody();}
  }
  function renderCounts(){for(const button of document.querySelectorAll('[data-match-status]')){const name=button.dataset.matchStatus;button.textContent=({all:'All',shortlisted:'★ Shortlist',contacted:'Contacted',dismissed:'Dismissed'})[name]+' '+(data?.counts[name]??'—');}}
  function selectHtml(name,label,options){const value=query().get(name)||'';return `<label class="sm">${label}<select class="in" data-match-filter="${name}">${options.map(([id,text])=>`<option value="${esc(id)}" ${id===value?'selected':''}>${esc(text)}</option>`).join('')}</select></label>`;}
  function render(restore=true) {
    clearTimeout(filterTimer);relatedView.unmount();
    if(detail()){
      focusDetail=true;
      $('#pane').innerHTML='<div id="match-page-top"></div><div id="matches-progress"></div><span class="vh" id="matches-announcement" aria-live="polite" aria-atomic="true"></span><div id="matches-body"></div>';
      load();pollJobs();return;
    }
    const returning=detailRow&&loadedView===viewSignature();
    if(returning)for(const row of rows)if(row.key===detailRow.key)row.state=detailRow.state;
    detailRow=null;dismissedRows.clear();
    if(restore&&!state.route.includes('?')){
      try{
        const saved=new URLSearchParams(storage(localStorage,'aimm-matches-view')||''), p=new URLSearchParams([...saved].filter(([key])=>viewKeys.includes(key)));
        if(p.has('item')&&!Object.hasOwn(state.config.item||{},p.get('item'))&&!state.matchSummary?.groups?.some(group=>group.item===p.get('item')))p.delete('item');
        for(const [key,values] of Object.entries({status:['all','shortlisted','contacted','dismissed'],min_score:['1','2','3','4','5'],sort:['newest','last_seen','price','score'],group:['search','date','none'],include_dismissed:['true','false'],price_drop:['true','false']}))if(p.has(key)&&!values.includes(p.get(key)))p.delete(key);
        updateQuery(p);
      }catch{}
    }else rememberView(query());
    try{cutoff=storage(localStorage,'aimm-matches-seen')||'';}catch{}visited=false;
    const p=query();
    $('#pane').innerHTML=pageHeader('Matches',"Every listing that passed a search’s filters and AI minimum. Saved in your library, with a record of when each listing appears again.",'<button class="btn" id="export-csv">Export CSV</button>')+
      `<div class="bar matches-filters"><div class="row wr" role="group" aria-label="Match status">${['all','shortlisted','contacted','dismissed'].map(name=>`<button class="pill" data-match-status="${name}" aria-pressed="${(p.get('status')||'all')===name}">${name}</button>`).join('')}</div>`+
      selectHtml('item','Search',[['','All searches'],...Object.keys(state.config.item||{}).map(name=>[name,name])])+
      selectHtml('min_score','AI rating',[['','Any'],['4','≥4'],['5','5']])+
      selectHtml('price_drop','Price',[['','Any'],['true','Price dropped']])+
      selectHtml('group','Group by',[['','Search'],['date','Date found'],['none','None']])+
      selectHtml('sort','Sort',[['','Newest'],['last_seen','Last seen'],['price','Listed price ↑'],['score','Rating ↓']])+
      `<label class="sm">Contains<input class="in" type="search" id="matches-query" value="${esc(p.get('q')||'')}" placeholder="Title, seller…"></label><button class="btn" id="matches-clear" ${filters().length?'':'hidden'}>Clear filters</button></div><div id="matches-progress"></div><span class="vh" id="matches-announcement" aria-live="polite" aria-atomic="true"></span><div id="matches-body"></div>`;
    $('#export-csv').onclick=()=>{clearTimeout(filterTimer);const p=query(), text=$('#matches-query').value;if(text!==(p.get('q')||'')){if(text)p.set('q',text);else p.delete('q');p.delete('cursor');updateQuery(p);load();}const exportParams=new URLSearchParams([...p].filter(([key])=>viewKeys.includes(key)&&key!=='group'));return exportCsv({url:'/api/matches.csv'+(exportParams.size?'?'+exportParams:''),emptyMessage:'No matches for these filters to export.',filename:'matches.csv'});};
    $('#matches-clear').onclick=()=>{clearTimeout(filterTimer);const p=query();for(const key of [...viewKeys,'cursor'])if(!['sort','group'].includes(key))p.delete(key);updateQuery(p);expanded.clear();render(false);$('#matches-query').focus();};
    document.querySelectorAll('[data-match-status]').forEach(button=>button.onclick=()=>{setFilter('status',button.dataset.matchStatus);document.querySelectorAll('[data-match-status]').forEach(b=>b.setAttribute('aria-pressed',b===button));});
    document.querySelectorAll('[data-match-filter]').forEach(select=>select.onchange=()=>{if(select.dataset.matchFilter==='group'){const p=query();if(select.value)p.set('group',select.value);else p.delete('group');updateQuery(p);renderBody();}else setFilter(select.dataset.matchFilter,select.value);});
    $('#matches-query').oninput=event=>{clearTimeout(filterTimer);const input=event.target,value=input.value;filterTimer=setTimeout(()=>{if(active()&&$('#matches-query')===input)setFilter('q',value);},250);};
    renderCounts();renderProgress();load(false,false,returning);pollJobs();
  }
  function rowHtml(row,index,group) {
    const check=row.recheck, invalid=row.evaluation_status?['below_threshold','filtered_out'].includes(row.evaluation_status):(check&&check.checked_item===row.item&&['below_threshold','filtered_out'].includes(check.status));
    const badges=[row.found_at&&(!cutoff||new Date(row.found_at)>new Date(cutoff))?'<span class="tag ok">new</span>':'',(row.seen_count>1||(row.imported&&row.seen_count>0))?'<span class="tag">seen again</span>':'',row.state.shortlisted?'<span class="warn" aria-label="Shortlisted">★</span>':'',row.state.contacted?'<span class="tag">contacted</span>':'',row.filed_by_you?'<span class="tag">filed by you</span>':'',invalid?'<span class="tag warn">no longer passes</span>':'',check?.status==='unavailable'?'<span class="tag">no longer listed</span>':'',check?.status==='error'?`<span class="tag warn" title="${esc(check.reason)}">couldn’t re-check</span>`:''].join(' ');
    if(dismissedRows.has(matchId(row)))return `<div class="match-row match-dismissed" role="status">Dismissed ${esc(row.title)} · <button class="btn q" data-undo-row="${esc(matchId(row))}">Undo</button></div>`;
    return `<div class="match-row" data-match-row="${index}" data-group="${esc(group)}"><span class="m d match-date">${esc(matchDate(row.found_at)).replace(' · ','<br>')}</span>${photo(row)}<span class="col gr"><span class="${invalid?'d':'b'}"><a class="match-title" href="${esc(detailRoute(row))}" data-open-match="${index}" data-group="${esc(group)}">${esc(row.title||'Listing details unavailable')}</a> ${badges} ${sellerBadge(row)}${row.related_count?` <span class="tag">${row.related_count} possible connections</span>`:''}</span><span class="m d">${esc(row.current_price||row.price||'—')}${priceDropped(row)?` <span class="ok">↓ from ${esc(row.recheck?.old_price||row.price)}</span>`:''} · ${esc(row.location||'—')}${row.condition?' · '+esc(row.condition):''}</span><span class="sm mu">${row.score==null?'no AI rating — sends every listing that passes the filters':`<strong>${esc(row.conclusion)}</strong> — ${esc(aiText(row.comment))}`}</span><span class="xs d">${row.last_seen?'Last seen '+esc(matchDate(row.last_seen))+' · ':''}${check?esc(lastCheck(row))+' · ':''}${row.notified_users.length?'sent to '+esc(row.notified_users.join(', ')):row.source==='recheck'?'Saved by re-check · no notification sent':'No recorded delivery'}</span></span><span class="match-row-actions"><span class="score ${row.score==null||invalid?'lo':''}">${score(row)}</span><span class="row"><button class="btn sm q" data-row-state="shortlisted" data-match-id="${esc(matchId(row))}" aria-label="${row.state.shortlisted?'Unshortlist':'Shortlist'} ${esc(row.title)}" aria-pressed="${row.state.shortlisted}">${row.state.shortlisted?'★':'☆'}</button><button class="btn sm q" data-row-state="dismissed" data-match-id="${esc(matchId(row))}" aria-label="${row.state.dismissed?'Restore':'Dismiss'} ${esc(row.title)}">${row.state.dismissed?'Restore':'✕'}</button></span></span></div>`;
  }
  function renderBody() {
    if(!active()||!$('#matches-body'))return;
    const focused=document.activeElement;
    const openDetails=[...document.querySelectorAll('#match-detail details[open]')].map(el=>el.querySelector('summary')?.textContent);
    const focusAttribute=['data-state','data-file-under','data-photo-index','data-photo-step','data-collapse','data-expand','data-recheck-group'].find(name=>focused?.hasAttribute(name));
    const focusValue=focusAttribute?focused.getAttribute(focusAttribute):null, focusId=focused?.id;
    if(loading){$('#matches-body').innerHTML='<div class="match-skeleton" role="status">Loading matches…</div>'.repeat(3);renderProgress();return;}
    if(error){$('#matches-body').innerHTML=`<div class="empty"><p class="err">${esc(error)}</p><button class="btn" id="matches-retry">Retry</button></div>`;$('#matches-retry').onclick=()=>load();renderProgress();return;}
    if(detail()){
      const otherSearch=$('#check-other')?.value;
      $('#matches-body').innerHTML='<article class="match-detail" id="match-detail" aria-label="Match details"></article>';
      renderDetail();
      if(otherSearch&&$('#check-other'))$('#check-other').value=otherSearch;
      document.querySelectorAll('#match-detail details').forEach(el=>{el.open=openDetails.includes(el.querySelector('summary')?.textContent);});
      if(focusDetail){$('#match-title')?.focus({preventScroll:true});focusDetail=false;}
      else if(focusId)document.getElementById(focusId)?.focus({preventScroll:true});
      else if(focusAttribute)[...document.querySelectorAll('['+focusAttribute+']')].find(el=>el.getAttribute(focusAttribute)===focusValue)?.focus({preventScroll:true});
      renderProgress();return;
    }
    if(!rows.length){const filtered=filters();$('#matches-body').innerHTML=`<div class="empty"><h2>${filtered.length?'No matches for these filters':'No matches yet'}</h2><p>${filtered.length?esc(filtered.map(([k,v])=>k+': '+v).join(' · ')):"Listings that pass a search’s filters and AI minimum will collect here."}</p>${filtered.length?'':'<a href="#/monitor/all">View searches</a>'}</div>`;renderProgress();return;}
    const ordered=navigationEntries();
    if(!ordered.some(entry=>matchId(entry.row)===selected))selected=ordered.length?matchId(ordered[0].row):null;
    const by=query().get('group')||'search', groups=groupMatches(rows,by,query().get('item')||'');
    $('#matches-body').innerHTML=(query().get('sort')==='price'?'<p class="sm d">Uses the amount shown in the listing; shorthand and placeholder prices may be misleading. Confirm the asking price with the seller.</p>':'')+'<div class="matches-layout"><div class="matches-list">'+[...groups].map(([name,entries])=>{
      const count=by==='search'?data.filtered_groups.find(group=>group.item===name)?.count:entries.length;
      const last=state.records.findLast(record=>record.extra?.kind==='search_summary'&&record.extra.item===name);
      return `<section class="match-group">${by!=='none'?`<header><div class="row wr"><button class="btn q" data-collapse="${esc(name)}" aria-expanded="${!collapsed.has(name)}">${collapsed.has(name)?'▸':'▾'} <strong class="m">${esc(name||'Unknown search')}</strong></button><span class="sm d">${by==='search'?Object.hasOwn(state.config.item||{},name)?esc(searchSummary(name)):'Removed search':''}</span></div><div class="row wr m d">${count??entries.length} matches${by==='search'?' · last searched '+(last?esc(matchDate(new Date(last.time*1000).toISOString())):'—'):''}<button class="btn" data-recheck-group="${esc(name)}" ${running()||(by==='search'&&(!state.config.item?.[name]||state.config.item[name].enabled===false))?'disabled':''} title="At most 25 listings per job">${[...jobs.values()].some(job=>['queued','running'].includes(job.state)&&job.searches?.length===1&&job.searches[0]===name)?'Re-checking…':(count||entries.length)>25?'Re-check newest 25':'↻ Re-check '+Math.min(count??entries.length,25)}</button></div></header><div data-group-progress="${esc(name)}"></div>`:''}${collapsed.has(name)?'':entries.slice(0,expanded.has(name)?entries.length:3).map((row,index)=>rowHtml(row,index,name)).join('')}${!collapsed.has(name)&&entries.length>3&&!expanded.has(name)?`<button class="btn q match-more" data-expand="${esc(name)}">Show ${entries.length-3} more${name?' from '+esc(name):''}</button>`:''}</section>`;
    }).join('')+`${data.next_cursor?'<button class="btn match-more" id="matches-more">Load more matches</button>':''}<p class="section-note">${by==='search'?Object.keys(state.config.item||{}).filter(name=>!data.groups.some(group=>group.item===name)).map(name=>esc(name)+' has no matches').join(' · '):''}${query().get('status')!=='dismissed'?' · dismissed matches are hidden':''}</p></div></div>`;
    document.querySelectorAll('[data-open-match]').forEach(link=>link.onclick=event=>{if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();openMatch(groups.get(link.dataset.group)[Number(link.dataset.openMatch)]);});
    document.querySelectorAll('[data-row-state]').forEach(button=>button.onclick=()=>{const row=rows.find(row=>matchId(row)===button.dataset.matchId);if(row)saveState(row,{[button.dataset.rowState]:!row.state[button.dataset.rowState]},true);});
    document.querySelectorAll('[data-undo-row]').forEach(button=>button.onclick=()=>{const saved=dismissedRows.get(button.dataset.undoRow);if(saved)saveState(saved.row,{dismissed:saved.previous},true);});
    document.querySelectorAll('[data-collapse]').forEach(button=>button.onclick=()=>{const name=button.dataset.collapse;collapsed.has(name)?collapsed.delete(name):collapsed.add(name);renderBody();});
    document.querySelectorAll('[data-expand]').forEach(button=>button.onclick=()=>{expanded.add(button.dataset.expand);renderBody();});
    document.querySelectorAll('[data-recheck-group]').forEach(button=>button.onclick=()=>startGroup(button.dataset.recheckGroup,groups.get(button.dataset.recheckGroup),by));
    $('#matches-more')?.addEventListener('click',()=>load(true));bindPhotos();renderProgress();
    document.querySelectorAll('#match-detail details').forEach(el=>{el.open=openDetails.includes(el.querySelector('summary')?.textContent);});
    if(focusAttribute){const replacement=[...document.querySelectorAll('['+focusAttribute+']')].find(el=>el.getAttribute(focusAttribute)===focusValue);(replacement||document.querySelector('[data-match-row]'))?.focus({preventScroll:true});}
    else if(focusId&&document.getElementById(focusId))document.getElementById(focusId).focus({preventScroll:true});
  }
  function bindPhotos(){document.querySelectorAll('.match-photo img').forEach(img=>{img.onerror=()=>img.remove();});}
  function navigationEntries() {
    const seen=new Set(), entries=[];
    for(const [group,matches] of groupMatches(rows,query().get('group')||'search',query().get('item')||''))for(const row of matches){const id=matchId(row);if(!seen.has(id)){seen.add(id);entries.push({group,row});}}
    return entries;
  }
  function detailRoute(row) {
    const p=query();p.set('match_item',row.item);
    return `#/monitor/matches/${encodeURIComponent(row.marketplace||row.key.split(':')[0])}/${encodeURIComponent(row.listing_id||row.key.split(':').slice(1).join(':'))}?${p}`;
  }
  function openMatch(row,replace=false) {
    if(!detail()){listScroll=$('#pane').scrollTop||0;listWindowScroll=typeof window==='undefined'?0:window.scrollY;}
    if(selected!==matchId(row))photoIndex=0;
    selected=matchId(row);detailRow=row;state.route=detailRoute(row);
    history[replace?'replaceState':'pushState'](null,'',state.route);render();$('#pane').scrollTop=0;
  }
  function moveSelection(direction) {
    const entries=navigationEntries(), index=entries.findIndex(entry=>matchId(entry.row)===selected), next=entries[index+direction];
    if(next)openMatch(next.row,true);
  }
  function renderDetail() {
    const row=detailRow||rows.find(row=>matchId(row)===selected);if(!row||!$('#match-detail'))return;
    if(photoSelection!==selected){photoIndex=0;photoSelection=selected;}
    const listingUrl=safeUrl(row.url);
    const others=Object.entries(state.config.item||{}).filter(([name,item])=>name!==row.item&&item.enabled!==false);
    const entries=navigationEntries(), index=entries.findIndex(entry=>matchId(entry.row)===selected);
    $('#match-detail').tabIndex=-1;
    $('#match-detail').innerHTML=`<nav class="row wr" aria-label="Match navigation"><button class="btn" id="match-previous" ${index<=0?'disabled':''}>Previous</button><span class="sm d">${index<0?'Outside the loaded matches':`${index+1} of ${entries.length} loaded`}</span><button class="btn" id="match-next" ${index<0||index>=entries.length-1?'disabled':''}>Next</button></nav>`+`<div class="match-detail-columns"><div class="match-detail-main" id="match-detail-main"><div id="match-gallery"></div><section class="sect"><h2>AI rating</h2><p class="m d">${esc(row.price||'—')} · listed price when found (unverified)${row.current_price&&row.current_price!==row.price?'<br>Current listed price (unverified): '+esc(row.current_price):''}</p><p><span class="m ai">${score(row)}</span> <strong>${esc(row.conclusion||'')}</strong></p>${row.comment?`<blockquote>${esc(aiText(row.comment))}</blockquote>`:'<p class="sm d">no AI rating — sends every listing that passes the filters</p>'}</section><section class="sect"><h2>Listing</h2><dl>${[['First found',matchDate(row.found_at)],['Last seen',matchDate(row.last_seen)],['Search sightings',row.seen_count?`${row.seen_count}${row.imported?' since tracking began':''}`:'Not tracked yet'],['Location',row.location],['Seller',row.seller],['Condition',row.condition],['Search',row.item],['Filed by you',row.state.filed_under.join(', ')],['Sent to',row.notified_users.join(', ')]].map(([label,value])=>`<dt>${label}</dt><dd>${esc(value||'—')}</dd>`).join('')}</dl>${row.imported?`<p class="xs d">Imported record. Repeat tracking began ${esc(matchDate(row.tracking_since))}; earlier sightings are unknown.</p>`:''}<details id="match-history"><summary>History</summary><div id="match-history-body"></div></details>${sellerDetail(row)}<details><summary>Seller’s description</summary><p>${esc(row.description||'—')}</p></details></section></div><aside class="match-detail-rail" aria-label="Actions"><div class="match-recheck"><h2>${esc(row.current_price||row.price||'—')}</h2><p><span class="m ai">${score(row)}</span> ${esc(row.conclusion||'')}</p><div class="row wr">${listingUrl?`<a class="btn p" href="${esc(listingUrl)}" target="_blank" rel="noopener noreferrer">Open on Facebook ↗</a><button class="btn" id="copy-listing-link">Copy link</button>`:''}<button class="btn" data-state="shortlisted" aria-pressed="${row.state.shortlisted}">★ ${row.state.shortlisted?'Shortlisted':'Shortlist'}</button></div></div>${listingUrl?`<div id="copy-link-fallback" hidden><label class="sm" for="listing-link">Listing link — select and copy</label><input class="in" id="listing-link" type="text" readonly value="${esc(listingUrl)}"></div>`:''}<div class="match-recheck"><h3>Re-check</h3><p class="sm d">${esc(lastCheck(row))}</p>${row.recheck?.reason?`<p class="sm warn">${esc(row.recheck.reason)}</p>${state.status.vnc_enabled?'<a href="/vnc/vnc.html?autoconnect=true&path=ws/vnc" target="_blank" rel="noopener">Open Browser ↗</a>':''}`:''}<button class="btn" id="recheck-one" ${running()||!state.config.item?.[row.item]||state.config.item[row.item].enabled===false?'disabled':''}>↻ Re-check now</button><p class="sm d">${!state.config.item?.[row.item]?'Original search removed. Choose another search below to re-check.':state.config.item[row.item].enabled===false?'Original search paused. Resume it or choose another search below.':`Opens the listing again and rates it against ${esc(row.item)}’s current settings.`}</p><label class="sm" for="check-other">Check against another search</label><div class="row"><select class="in gr" id="check-other"><option value="">Choose search</option>${others.map(([name])=>`<option>${esc(name)}</option>`).join('')}</select><button class="btn" id="recheck-other" ${running()?'disabled':''}>Run</button></div><p class="sm d">If it passes there, it’s filed under that search too.</p><details><summary>Move to…</summary><p class="sm d">File by hand without changing its rating.</p>${Object.keys(state.config.item||{}).filter(name=>name!==row.item).map(name=>`<label class="row sm"><input type="checkbox" data-file-under="${esc(name)}" ${row.state.filed_under.includes(name)?'checked':''}>${esc(name)}</label>`).join('')}</details></div><div class="row wr"><button class="btn" data-state="contacted" aria-pressed="${row.state.contacted}">${row.state.contacted?'Contacted':'Mark contacted'}</button><button class="btn q" data-state="dismissed" aria-pressed="${row.state.dismissed}">${row.state.dismissed?'Restore':'Dismiss'}</button></div><p class="xs d">Photos and details are the monitor’s saved copy. Your library survives cache cleanup.</p></aside></div>`;
    if(row.marketplace&&row.listing_id){
      $('#match-detail-main')?.insertAdjacentHTML('beforeend','<div id="related-listings" class="match-recheck" role="region" aria-label="Related listings"></div>');
      relatedView.mount($('#related-listings'),row);
    }
    const back=query();back.delete('match_item');
    $('#match-page-top').innerHTML=`<div class="ph"><div><a id="match-back" href="#/monitor/matches${back.size?'?'+back:''}">← Matches</a><p class="m d sm">${esc(row.item)}${state.config.item?.[row.item]?'':' (removed search)'}</p><h1 id="match-title" tabindex="-1">${esc(row.title||'Listing details unavailable')}</h1><p class="m d sm">${esc([row.current_price||row.price,row.location,row.condition].filter(Boolean).join(' · '))}</p></div></div>${row.state.dismissed?'<div class="nt" role="status">Dismissed. Hidden from Matches. <button class="btn q" id="detail-undo">Undo</button></div>':''}`;
    $('#match-back').onclick=event=>{if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();state.route='#/monitor/matches'+(back.size?'?'+back:'');history.pushState(null,'',state.route);render(false);};
    $('#detail-undo')?.addEventListener('click',()=>saveState(row,{dismissed:false}));
    function drawGallery(){
      const target=$('#match-gallery');if(!target)return;
      const count=(row.photos||[]).filter(photo=>matchPhotoUrl(row,photo)).length;photoIndex=count?((photoIndex%count)+count)%count:0;
      target.innerHTML=galleryHtml(row,photoIndex);
      target.querySelectorAll('[data-photo-step]').forEach(button=>button.onclick=()=>{photoIndex+=Number(button.dataset.photoStep);drawGallery();target.querySelector(`[data-photo-step="${button.dataset.photoStep}"]`)?.focus({preventScroll:true});});
      target.querySelectorAll('[data-photo-index]').forEach(button=>button.onclick=()=>{photoIndex=Number(button.dataset.photoIndex);drawGallery();target.querySelector(`[data-photo-index="${photoIndex}"]`)?.focus({preventScroll:true});});
      target.onkeydown=event=>{if(count<2||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();photoIndex+=event.key==='ArrowLeft'?-1:1;drawGallery();target.querySelector(`[data-photo-index="${photoIndex}"]`)?.focus({preventScroll:true});};
      target.querySelectorAll('img').forEach(img=>img.onerror=()=>{img.alt='Saved photo unavailable';img.removeAttribute('src');});
    }
    drawGallery();
    $('#match-history')?.addEventListener('toggle',()=>{if($('#match-history')?.open)loadHistory(row);});
    $('#match-previous').onclick=()=>moveSelection(-1);$('#match-next').onclick=()=>moveSelection(1);
    const copyButton=$('#copy-listing-link'), copyFallback=$('#copy-link-fallback'), copyInput=$('#listing-link');
    if(copyButton)copyButton.onclick=async()=>{
      copyButton.disabled=true;
      try{await navigator.clipboard.writeText(listingUrl);toast('Listing link copied.');}
      catch{
        if(copyButton.isConnected){copyFallback.hidden=false;copyInput.focus();copyInput.select();toast('Could not copy automatically. Copy the selected listing link.');}
      }
      finally{copyButton.disabled=false;}
    };
    document.querySelectorAll('[data-state]').forEach(button=>button.onclick=()=>saveState(row,{[button.dataset.state]:!row.state[button.dataset.state]}));
    document.querySelectorAll('[data-file-under]').forEach(input=>input.onchange=()=>saveState(row,{filed_under:[...document.querySelectorAll('[data-file-under]:checked')].map(el=>el.dataset.fileUnder)}));
    $('#recheck-one').onclick=()=>start([row]);$('#recheck-other').onclick=()=>{const item=$('#check-other').value;if(item)start([row],item);else toast('Choose a search first.');};bindPhotos();
  }
  async function saveState(row,patch,fromRow=false) {
    if(pendingStates.has(row.key))return;
    pendingStates.add(row.key);
    const route=state.route;
    const previous=Object.fromEntries(Object.keys(patch).map(key=>[key,row.state[key]]));
    Object.assign(row.state,patch);
    if(fromRow&&patch.dismissed===true)dismissedRows.set(matchId(row),{row,previous:previous.dismissed});
    if(fromRow&&patch.dismissed===false)dismissedRows.delete(matchId(row));
    renderBody();
    try{
      const updated=await json(`/api/matches/${encodeURIComponent(row.marketplace)}/${encodeURIComponent(row.listing_id)}/state`,{method:'PUT',body:JSON.stringify(patch)});
      Object.assign(row.state,updated);
      if(state.route===route){await load(false,true);if(fromRow&&patch.dismissed===true)document.querySelector('[data-undo-row]')?.focus();}
    }catch(err){Object.assign(row.state,previous);dismissedRows.delete(matchId(row));if(state.route===route)renderBody();toast(err.message);}
    finally{pendingStates.delete(row.key);}
  }
  async function startGroup(name,entries,by){
    try{if(by==='search'){const p=new URLSearchParams(filters());p.set('item',name);p.set('sort','newest');p.set('limit','25');const result=await json('/api/matches?'+p);entries=result.matches;}await start(entries.slice(0,25));}catch(err){toast(err.message);}
  }
  async function start(entries,item) {
    try{const listings=[...new Map(entries.map(row=>[row.key,{marketplace:row.marketplace,listing_id:row.listing_id,original_item:row.item}])).values()].slice(0,25);const result=await json('/api/matches/recheck',{method:'POST',body:JSON.stringify({listings,item,refresh:true})});jobs.set(result.job_id,{job_id:result.job_id,state:'queued',done:0,total:result.queued,results:[],item,searches:[...new Set(entries.map(row=>row.item))]});rememberJobs();renderProgress();renderBody();}
    catch(err){toast(err.message);}
  }
  async function loadHistory(row, cursor=0) {
    const target=$('#match-history-body');if(!target)return;
    if(!cursor)target.textContent='Loading history…';
    try {
      const result=await json(`/api/matches/${encodeURIComponent(row.marketplace)}/${encodeURIComponent(row.listing_id)}/history?cursor=${cursor}`);
      if(!target.isConnected||selected!==matchId(row))return;
      const content=result.events.map(event=>{
        const details=event.data||{};
        const label=({imported:'Imported from cache',matched:'Matched search',rating:'Rating changed',changed:'Listing changed',recheck:'Re-checked'})[event.kind]||event.kind;
        let text=event.kind==='changed'?Object.entries(details.changes||{}).map(([key,value])=>`${key}: ${value.before||'—'} → ${value.after||'—'}`).join('\n'):event.kind==='imported'?'Earlier sightings are unknown.':event.kind==='recheck'?`${details.status?.replaceAll('_',' ')||''}${details.reason?' · '+details.reason:''}${details.fresh_details?' · details fetched':' · no fresh details confirmed'}`:`${details.score==null?'No AI rating':details.score+'/5'}${details.status?' · '+details.status.replaceAll('_',' '):''}${details.comment?' · '+aiText(details.comment):''}`;
        return `<li><time class="xs d">${esc(matchDate(event.at))}</time><p class="sm b">${esc(label)}${event.item?' · '+esc(event.item):''}</p><p class="sm match-history-text">${esc(text)}</p>${details.source?`<p class="xs d">${esc(details.source)}</p>`:''}</li>`;
      }).join('');
      if(!cursor)target.innerHTML='<ol class="match-history-list"></ol>';
      target.querySelector('ol').insertAdjacentHTML('beforeend',content);
      target.querySelector('button')?.remove();
      if(result.next_cursor){const more=document.createElement('button');more.className='btn sm';more.textContent='More history';more.onclick=()=>{more.disabled=true;loadHistory(row,result.next_cursor);};target.append(more);}
      else if(!result.events.length&&!cursor)target.textContent='No history recorded yet.';
    }catch{if(target.isConnected){target.innerHTML='<p class="err sm">Could not load history.</p>';const retry=document.createElement('button');retry.className='btn sm';retry.textContent='Retry';retry.onclick=()=>loadHistory(row);target.append(retry);}}
  }
  function renderProgress() {
    if(!active()||!$('#matches-progress'))return;
    const placeholders=[...document.querySelectorAll('[data-group-progress]')];
    for(const node of placeholders)node.innerHTML='';
    $('#matches-progress').innerHTML='';
    for(const job of jobs.values()){
      const changed=job.results.filter(row=>['filtered_out','below_threshold'].includes(row.status)).length;
      const drops=job.results.filter(row=>numericPrice(row.price)<numericPrice(row.old_price)).length;
      const scope=job.searches?.length===1?job.searches[0]:null;
      const target=(query().get('group')||'search')==='search'&&scope?placeholders.find(node=>node.dataset.groupProgress===scope):null;
      const html=`<div class="match-job row wr sb sm" role="status"><span>Re-check ${esc(scope||job.item||'matches')} · ${esc(job.state)} · <strong>${job.done} of ${job.total}</strong> · ${drops} price drops · ${changed} no longer pass</span>${['queued','running'].includes(job.state)?`<button class="btn sm q" data-stop-job="${esc(job.job_id)}">Stop</button>`:''}</div>`;
      (target||$('#matches-progress')).insertAdjacentHTML('beforeend',html);
    }
    document.querySelectorAll('[data-stop-job]').forEach(button=>button.onclick=async()=>{try{jobs.set(button.dataset.stopJob,await json('/api/matches/recheck/'+encodeURIComponent(button.dataset.stopJob),{method:'DELETE'}));rememberJobs();renderBody();renderProgress();}catch(err){toast(err.message);}});
  }
  async function pollJobs(){
    if(busy||!jobs.size)return;busy=true;let changed=false,announce=false;
    try{for(const [id,old] of jobs){if(!['queued','running'].includes(old.state))continue;try{const job=await json('/api/matches/recheck/'+id);jobs.set(id,job);changed ||= old.done!==job.done||old.state!==job.state;announce ||= Math.floor(old.done/3)!==Math.floor(job.done/3)||old.state!==job.state;if(['done','stopped'].includes(job.state)){notify(`Re-check ${job.state}: ${job.done} of ${job.total} checked. ${job.results.filter(row=>row.status==='passed').length} pass.`);}}catch(err){jobs.set(id,{...old,state:'stopped'});toast(err.message);changed=true;}}
      rememberJobs();if(announce&&$('#matches-announcement'))$('#matches-announcement').textContent=[...jobs.values()].map(job=>`Re-check ${job.state}, ${job.done} of ${job.total}`).join('. ');if(changed){await load(false,true);renderProgress();}
    }finally{busy=false;}
  }
  function onRecord(record){if(['match_recorded','match_seen','recheck_result','recheck_done','image_matching_done','match_photo_saved'].includes(record.extra?.kind)){if(record.extra.kind==='recheck_result'&&active()){rows=applyRecheckResult(rows,record.extra);renderBody();}clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{if(active())load(false,true);else summary();pollJobs();},350);}}
  setInterval(()=>{pollJobs();if(active())relatedView.refresh();else relatedView.unmount();},3000);
  return {render,onRecord,summary};
}
