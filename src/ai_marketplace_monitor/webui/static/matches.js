import {safeUrl, matchPhotoUrl, esc} from './console-model.js';
import {createRelatedView} from './related.js';

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
export function recheckStatuses(jobs) {
  const statuses=new Map();
  for(const job of jobs){
    if(!['queued','running'].includes(job.state))continue;
    (job.listings||[]).slice(job.done).forEach((listing,index)=>{
      const key=listing.marketplace+':'+listing.listing_id, status=index===0&&job.state==='running'?'checking':'queued';
      if(statuses.get(key)!=='checking')statuses.set(key,status);
    });
  }
  return statuses;
}
export function matchDate(value) {
  if (!value) return '—';
  const date=new Date(value); if(Number.isNaN(date.valueOf()))return '—';
  const today=new Date(), yesterday=new Date();yesterday.setDate(today.getDate()-1);
  const day=date.toDateString()===today.toDateString()?'Today':date.toDateString()===yesterday.toDateString()?'Yesterday':date.toLocaleDateString([], {month:'short',day:'numeric',...(date.getFullYear()===today.getFullYear()?{}:{year:'numeric'})});
  return `${day} · ${date.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`;
}
const validDate = value => {const date=value?new Date(value):null;return date&&!Number.isNaN(date.valueOf())?date:null;};
const timeOfDay = date => date.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
export function relativeDate(value, now = new Date()) {
  const date=validDate(value);if(!date)return '';
  const minutes=(now-date)/60000;
  if(minutes>=0&&minutes<1)return 'just now';
  if(minutes>=1&&minutes<60)return `${Math.floor(minutes)} min ago`;
  const startOfToday=new Date(now), startOfDay=new Date(date);startOfToday.setHours(0,0,0,0);startOfDay.setHours(0,0,0,0);
  const days=Math.round((startOfToday-startOfDay)/86400000);
  if(days===0&&minutes>=0)return `today ${timeOfDay(date)}`;
  if(days===1)return `yesterday ${timeOfDay(date)}`;
  if(days>1&&days<7)return `${date.toLocaleDateString([], {weekday:'short'})} ${timeOfDay(date)}`;
  return date.toLocaleDateString([], {month:'short',day:'numeric',...(date.getFullYear()===now.getFullYear()?{}:{year:'numeric'})});
}
export const fullDate = value => validDate(value)?.toLocaleString([], {weekday:'short',year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) || '';
const datePair = value => validDate(value) ? `${relativeDate(value)} · ${fullDate(value)}` : '—';
export function dayGroupLabel(key, now = new Date()) {
  const date=validDate(key+'T12:00:00');if(!date)return key;
  const day=date.toLocaleDateString([], {weekday:'short',month:'short',day:'numeric',...(date.getFullYear()===now.getFullYear()?{}:{year:'numeric'})});
  const today=new Date(now);today.setHours(12,0,0,0);
  const days=Math.round((today-date)/86400000);
  return days===0?`Today · ${day}`:days===1?`Yesterday · ${day}`:day;
}
export function rowDate(row, sort) {
  const seen=sort==='last_seen'&&row.last_seen;
  const value=seen?row.last_seen:row.found_at, verb=seen?'Seen':row.source==='manual'?'Added':'Found';
  return validDate(value)?{label:`${verb} ${relativeDate(value)}`,full:`${verb} ${fullDate(value)}`,iso:value}:{label:'Date unknown',full:'',iso:''};
}
const RATING_WORDS = {5:'Great deal',4:'Good',3:'Fair',2:'Unclear',1:'Poor'};
export const ratingWord = value => RATING_WORDS[value] || 'Not rated';
const ratingMeter = value => `<span class="match-meter" role="img" aria-label="${value==null?'Not rated':`AI rating ${value} of 5`}">${[1,2,3,4,5].map(step=>`<i${value!=null&&step<=value?' class="on"':''}></i>`).join('')}</span>`;
const numericPrice = value => {const match=String(value||'').match(/^\s*(?:[A-Z]{3}|[$£€₱¥])?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(?:[A-Z]{3}|[$£€₱¥])?\s*$/i);return match?Number(match[1].replaceAll(',','')):NaN;};
export const priceDropped = row => Number.isFinite(numericPrice(row.current_price)) && numericPrice(row.current_price)<numericPrice(row.recheck?.old_price || row.price);
export function priceDropText(row) {
  if(!priceDropped(row))return '';
  const before=numericPrice(row.recheck?.old_price||row.price), after=numericPrice(row.current_price);
  const currency=String(row.current_price).match(/^\s*([A-Z]{3}\s?|[$£€₱¥])/i)?.[1]||'';
  return `−${currency}${(before-after).toLocaleString('en-US',{maximumFractionDigits:2})} (−${Math.round((before-after)/before*100)}%)`;
}
const aiText = value => String(value ?? '').replaceAll('**','');
const score = row => row.score == null ? '—' : `${row.score}/5`;
const sellerStatus = row => ({established:['Established','good'],caution:['Caution','warn'],unknown:['Unknown','']})[row.seller_assessment?.status] || ['Unknown',''];
const sellerBadge = row => {const [label,kind]=sellerStatus(row);return `<span class="match-badge ${kind}">Seller: ${label}</span>`;};
function sellerDetail(row) {
  const assessment=row.seller_assessment, url=safeUrl(assessment?.profile_url);
  const reasons=assessment?.reasons?.length?assessment.reasons:['Seller evidence is not available. Re-check this listing to collect it.'];
  return `<section class="match-more-body" aria-label="Seller credibility"><p>${sellerBadge(row)}</p><ul class="sm">${reasons.map(reason=>`<li>${esc(reason)}</li>`).join('')}</ul>${url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">View seller profile ↗</a>`:''}${assessment?.checked_at?`<p class="xs d">Checked ${esc(matchDate(assessment.checked_at))}</p>`:''}<p class="xs d">Based on the listing’s seller panel. This does not verify identity or guarantee a safe transaction.</p></section>`;
}
const photo = row => {const url=matchPhotoUrl(row,undefined,'thumb');return `<span class="match-photo"><span>no photo</span>${url?`<img src="${esc(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`:''}</span>`;};
export function galleryHtml(row, selected = 0) {
  const photos=(row.photos||[]).filter(photo=>matchPhotoUrl(row,photo));
  if(!photos.length)return '<section class="match-gallery" aria-label="Photos"><div class="gallery-main">No photos saved</div><p class="xs d">Photos are saved by the monitor. Re-check to collect a listing’s gallery.</p></section>';
  selected=((selected%photos.length)+photos.length)%photos.length;
  return `<section class="match-gallery" aria-label="Photos"><div class="gallery-main"><img src="${esc(matchPhotoUrl(row,photos[selected]))}" alt="Photo ${selected+1} of ${photos.length} — ${esc(row.title)}">${photos.length>1?'<div class="gallery-controls row"><button class="btn sm" data-photo-step="-1" aria-label="Previous photo">‹</button><button class="btn sm" data-photo-step="1" aria-label="Next photo">›</button></div>':''}</div>${photos.length>1?`<div class="gallery-thumbs" role="group" aria-label="Choose a photo">${photos.map((photo,index)=>`<button type="button" data-photo-index="${index}" aria-label="Photo ${index+1} of ${photos.length}" aria-pressed="${index===selected}"><img src="${esc(matchPhotoUrl(row,photo,'thumb'))}" alt="" loading="lazy" decoding="async"></button>`).join('')}</div>`:''}<p class="xs d">${photos.length} saved ${photos.length===1?'photo':'photos'}${row.photo_pending?` · ${row.photo_pending} awaiting capture or unavailable`:''} · archived on the monitor, available after the listing is removed.</p></section>`;
}
const unratedText = row => row.source==='manual' ? row.evaluation_status==='error' ? row.assessment_reason||'AI assessment failed. Open the listing to retry.' : 'Awaiting AI assessment. Open the listing to retry if the monitor restarted.' : 'no AI rating — sends every listing that passes the filters';
function attrsHtml(row, sort) {
  const date=rowDate(row,sort);
  return `<span class="match-price">${esc(row.current_price||row.price||'Price not stated')}</span>${priceDropped(row)?` <s>${esc(row.recheck?.old_price||row.price)}</s>`:''} · ${esc(row.location||'Location not stated')} · ${esc(row.condition||'Condition not stated')} · <time datetime="${esc(date.iso)}" title="${esc(date.full)}">${esc(date.label)}</time>${row.filed_by_you?' · filed by you':''}`;
}
const priceHtml = row => `<p class="match-big-price"><strong>${esc(row.current_price||row.price||'Price not stated')}</strong>${priceDropped(row)?` <s class="d">${esc(row.recheck?.old_price||row.price)}</s> <span class="match-badge good">${esc(priceDropText(row))}</span>`:''}</p>`;
function decisionButtons(row, attribute) {
  const button=(name,key,pressed,label)=>`<button class="btn" type="button" ${attribute}="${name}" aria-keyshortcuts="${key}" aria-pressed="${pressed}">${label} <kbd>${key}</kbd></button>`;
  return `<div class="match-decisions">${button('shortlisted','s',row.state.shortlisted,row.state.shortlisted?'★ Shortlisted':'☆ Shortlist')}${button('dismissed','e',row.state.dismissed,row.state.dismissed?'Restore':'Dismiss')}${button('contacted','c',row.state.contacted,'Contacted')}</div>`;
}
export function keyDates(row) {
  const dates=[
    [row.source==='manual'?'Added by you':'Found',row.found_at,row.notified_users?.length?'sent to '+row.notified_users.join(', '):row.source==='manual'?'no notification sent':''],
    ['Last seen by a search',row.last_seen,row.seen_count?`${row.seen_count} ${row.seen_count===1?'sighting':'sightings'}`:''],
    ['Re-checked',row.recheck?.at,row.recheck?.status?.replaceAll('_',' ')||'']
  ].filter(([,value])=>validDate(value)).sort((a,b)=>new Date(b[1])-new Date(a[1]));
  return dates.map(([what,value,note])=>`<li><span>${esc(what)}</span><time datetime="${esc(value)}" title="${esc(fullDate(value))}">${esc(relativeDate(value))}</time><span class="xs d">${esc(note)}</span><span class="xs d match-abs">${esc(fullDate(value))}</span></li>`).join('')||'<li class="d">No dates recorded.</li>';
}
const lastCheck = row => row.recheck ? `Re-checked ${matchDate(row.recheck.at)} · ${row.recheck.checked_item || row.item}: ${row.recheck.status.replaceAll('_',' ')}${row.recheck.old_score!=null?` · was ${ratingWord(row.recheck.old_score)}`:''}${row.score!=null?` → now ${ratingWord(row.score)}`:''}${row.recheck.threshold?` · minimum ${ratingWord(Number(row.recheck.threshold))}`:''}` : 'Not re-checked yet';

const SHORTCUTS = {x:'select',j:'next',k:'previous',o:'open',u:'back',Escape:'back',s:'shortlisted',e:'dismissed',c:'contacted',v:'facebook',z:'undo','?':'help','/':'search'};
export function matchShortcut(event) {
  if(event.defaultPrevented||event.ctrlKey||event.metaKey||event.altKey||event.isComposing)return null;
  if(event.target?.closest?.('input,textarea,select,[contenteditable="true"],dialog'))return null;
  return SHORTCUTS[event.key]||null;
}
const STATE_MESSAGES = {shortlisted:['Shortlisted','Removed from shortlist'],dismissed:['Dismissed','Restored'],contacted:['Marked contacted','Unmarked contacted']};
const MATCH_VIEWS = [['new','New'],['shortlisted','★ Shortlist'],['contacted','Contacted'],['dismissed','Dismissed'],['all','All']];
const SIDEBAR_KEYS = ['status','item','source'];
const BAR_FILTER_KEYS = ['min_score','price_drop','q','include_dismissed'];
const joinNames = names => names.length>1 ? `${names.slice(0,-1).join(', ')} and ${names.at(-1)}` : names[0] || '';

export function createMatchesView({state, json, pageHeader, exportCsv, toast, renderSidebar, searchSummary}) {
  const $ = selector=>document.querySelector(selector);
  let data=null, rows=[], selected=null, request=0, cutoff='', error='', loading=false, cursorKey=null, lastUndo=null, previewKey=null, previewPhoto=0;
  const collapsed=new Set(), jobs=new Map();
  const relatedView=createRelatedView({json,toast});
  let busy=false, refreshTimer=null, filterTimer=null, noteTimer=null, detailRow=null, photoIndex=0, photoSelection=null, listScroll=0, listWindowScroll=0;
  const dismissedRows=new Map(), pendingStates=new Set(), selectedKeys=new Set();
  let selectionAnchor=null, arrivals=0, keepList=false;
  let focusDetail=false, loadedView=null, recheckState=new Map(), openSections=new Set();
  const storage=(name,key,value)=>{try{const store=globalThis[name];return value===undefined?store.getItem(key):value===null?store.removeItem(key):store.setItem(key,value);}catch{return null;}};
  cutoff=storage('localStorage','aimm-matches-seen')||'';
  try{for(const id of JSON.parse(sessionStorage.getItem('aimm-recheck-jobs')||'[]'))jobs.set(id,{job_id:id,state:'queued',results:[],done:0,total:0});}catch{}
  const active=()=>state.route.split('?')[0]==='#/monitor/matches'||state.route.startsWith('#/monitor/matches/');
  const detail=()=>state.route.split('?')[0].startsWith('#/monitor/matches/');
  const query=()=>new URLSearchParams(state.route.split('?')[1]||'');
  const viewKeys=['item','source','min_score','status','include_dismissed','price_drop','q','sort','group'];
  const viewSignature=()=>JSON.stringify(viewKeys.filter(key=>key!=='group').map(key=>query().get(key)));
  const currentStatus=()=>query().get('status')||'new';
  const shortcutsOn=()=>storage('localStorage','aimm-shortcuts')!=='off';
  const filters=()=>[...query()].filter(([key,value])=>viewKeys.includes(key)&&!['group','sort'].includes(key)&&value&&!(key==='status'&&['all','new'].includes(value))&&!(['include_dismissed','price_drop'].includes(key)&&value!=='true'));
  const barFilters=()=>filters().filter(([key])=>!SIDEBAR_KEYS.includes(key));
  function rememberView(p){storage('localStorage','aimm-matches-view',new URLSearchParams([...p].filter(([key])=>viewKeys.includes(key))).toString());}
  function updateQuery(p){state.route='#/monitor/matches'+(p.size?'?'+p:'');history.replaceState(null,'',state.route);rememberView(p);const clear=$('#matches-clear');if(clear)clear.hidden=!barFilters().length;renderChips();renderSidebar();}
  const density=()=>storage('localStorage','aimm-matches-density')==='compact'?'compact':'comfortable';
  function chipLabel(key,value){
    if(key==='min_score')return ({4:'Good or better',5:'Great deal only'})[value]||`${ratingWord(Number(value))} or better`;
    if(key==='q')return `Contains “${value}”`;
    return ({price_drop:'Price dropped',include_dismissed:'Including dismissed'})[key]||'';
  }
  function renderChips(){
    const target=$('#match-chips'), row=$('#match-chips-row');if(!target)return;
    const chips=barFilters();
    if(row)row.hidden=!chips.length;
    const toggle=$('#matches-filters-toggle');if(toggle)toggle.textContent=chips.length?`Filters (${chips.length})`:'Filters';
    target.innerHTML=chips.map(([key,value])=>`<span class="match-chip">${esc(chipLabel(key,value))}<button type="button" data-remove-filter="${esc(key)}" aria-label="Remove filter: ${esc(chipLabel(key,value))}">✕</button></span>`).join('');
    document.querySelectorAll('[data-remove-filter]').forEach(button=>button.onclick=()=>{clearTimeout(filterTimer);const p=query();p.delete(button.dataset.removeFilter);p.delete('cursor');updateQuery(p);render(false);});
  }
  const running=()=>[...jobs.values()].some(job=>['queued','running'].includes(job.state));
  const rememberJobs=()=>{storage('sessionStorage','aimm-recheck-jobs',JSON.stringify([...jobs.values()].filter(job=>['queued','running'].includes(job.state)).map(job=>job.job_id)));};
  const params=()=>{const p=query();p.delete('group');p.delete('match_item');p.set('limit','200');if(!p.get('status'))p.set('status','new');if(cutoff)p.set('since',cutoff);return p;};
  const setFilter=(name,value)=>setFilters({[name]:value});
  function setFilters(values){if(!active())return;const p=query();for(const [name,value] of Object.entries(values))if(value)p.set(name,value);else p.delete(name);applyListQuery(p);}
  function applyListQuery(p){p.delete('cursor');updateQuery(p);dismissedRows.clear();selectedKeys.clear();listScroll=0;keepList=true;load();}
  function notify(message, action) {
    toast(message);
    const host=$('#toast');if(action&&host){const button=document.createElement('button');button.className='btn';button.textContent='Undo';button.onclick=action;host.append(' ',button);}
  }
  async function summary(){
    try{const seen=storage('localStorage','aimm-matches-seen')||cutoff;const p=active()?params():new URLSearchParams();p.set('limit','1');p.delete('cursor');if(seen)p.set('since',seen);const result=await json('/api/matches?'+p);state.matchSummary=result;renderSidebar();}catch{}
  }
  async function load(more=false, quiet=false, reuse=false) {
    if(!active())return;
    const token=++request, showStale=keepList&&rows.length>0&&!detail();error='';loading=!quiet&&!more&&!showStale;keepList=false;
    if(loading)renderBody();
    if(showStale)$('#matches-body')?.setAttribute('aria-busy','true');
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
        if(item===null)throw new Error('The detail link needs an assessment or search name.');
        const found=await json(`/api/matches/${parts[3]}/${parts[4]}/detail?item=${encodeURIComponent(item)}`);
        if(token!==request||!active())return;
        detailRow=found;selected=matchId(found);
      }
      loading=false;
      if(!more){arrivals=0;renderArrivals();}
      renderSidebar();renderBody();
      if(!detail()&&reuse){const pane=$('#pane');pane.scrollTop=listScroll;if(typeof window!=='undefined')window.scrollTo?.(0,listWindowScroll);if(cursorKey)focusCursor();}
    }catch(err){if(token!==request)return;loading=false;error=err.message;renderBody();}
    finally{if(token===request&&showStale)$('#matches-body')?.setAttribute('aria-busy','false');}
  }
  const isNewRow=row=>Boolean(row.found_at)&&!row.state.shortlisted&&!row.state.contacted&&!row.state.dismissed&&(!cutoff||new Date(row.found_at)>new Date(cutoff));
  function groupSummary(entries){
    const fresh=entries.filter(isNewRow).length, drops=entries.filter(priceDropped).length, best=Math.max(0,...entries.map(row=>row.score??0));
    return [fresh?`${fresh} new`:'',best?`best: ${ratingWord(best)}`:'',drops?`${drops} price ${drops===1?'drop':'drops'}`:''].filter(Boolean).join(' · ');
  }
  function sidebarHtml(){
    const summary=state.matchSummary||{}, p=query(), searches=state.config.item||{}, status=currentStatus();
    const selectedItem=detail()?p.get('match_item')||'':p.get('item')||'';
    const manualSelected=detail()?p.get('match_item')==='':p.get('source')==='manual';
    const listHref=changes=>{const next=query();for(const key of ['match_item','cursor'])next.delete(key);for(const [key,value] of Object.entries(changes))if(value)next.set(key,value);else next.delete(key);return '#/monitor/matches'+(next.size?'?'+next:'');};
    const entry=({kind,href,on,label,labelClass='b',badge,badgeClass='d',lines=[]})=>`<a class="it${on?' on':''}" href="${esc(href)}" data-match-nav="${kind}"${on?' aria-current="true"':''}><div class="row sb"><span class="${labelClass}">${esc(label)}</span><span class="m xs ${badgeClass}">${esc(String(badge??'—'))}</span></div>${lines.map(line=>`<div class="s">${esc(line)}</div>`).join('')}</a>`;
    const viewCounts=new Map((summary.view_groups||[]).map(group=>[group.item,group.count]));
    const withMatches=new Set((summary.groups||[]).map(group=>group.item));
    const names=[...new Set([...Object.keys(searches).filter(name=>withMatches.has(name)),...withMatches,selectedItem])].filter(Boolean);
    const {awaiting=0,failed=0}=summary.manual||{};
    const showManual=withMatches.has('')||manualSelected;
    const noMatches=summary.groups?Object.keys(searches).filter(name=>!withMatches.has(name)):[];
    return '<div class="sh">Views</div>'+MATCH_VIEWS.map(([key,label])=>entry({kind:'status',href:listHref({status:key}),on:status===key,label,badge:summary.counts?.[key]})).join('')+
      '<div class="sh">Found by</div>'+entry({kind:'source',href:listHref({item:'',source:''}),on:!selectedItem&&!manualSelected,label:'All sources',badge:summary.view_total})+
      names.map(name=>{const known=Object.hasOwn(searches,name);return entry({kind:'source',href:listHref({item:name,source:''}),on:name===selectedItem&&!manualSelected,label:known?name:name+' (removed)',labelClass:'t m',badge:viewCounts.get(name)??0,lines:[known?searchSummary(name):'Removed search']});}).join('')+
      (showManual?entry({kind:'source',href:listHref({item:'',source:'manual'}),on:manualSelected,label:'Manually added',badge:failed?`${failed} failed`:awaiting?`${awaiting} awaiting`:viewCounts.get('')??0,badgeClass:failed?'warn':'d',lines:['Links you add · general AI assessment',...(failed?['AI assessment failed · open it to retry']:awaiting?['Awaiting AI assessment']:[])]}):'')+
      `<p class="sidebar-note">Source counts follow the selected view and filters.${noMatches.length?` ${esc(joinNames(noMatches))} ${noMatches.length===1?'has':'have'} no matches yet.`:''} <a href="#/monitor/all">Manage searches in Monitor →</a></p>`;
  }
  function sidebarClick(event){
    const link=event.target?.closest?.('[data-match-nav]');
    if(!link||!active()||event.defaultPrevented||event.button>0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
    event.preventDefault();clearTimeout(filterTimer);
    const href=link.getAttribute('href');
    if(detail()){state.route=href;history.pushState(null,'',href);render(false);renderSidebar();return;}
    applyListQuery(new URLSearchParams(href.split('?')[1]||''));
  }
  function selectHtml(name,label,options){const value=query().get(name)||'';return `<label class="sm">${label}<select class="in" data-match-filter="${name}">${options.map(([id,text])=>`<option value="${esc(id)}" ${id===value?'selected':''}>${esc(text)}</option>`).join('')}</select></label>`;}
  function render(restore=true) {
    clearTimeout(filterTimer);relatedView.unmount();
    if(detail()){
      focusDetail=true;
      $('#pane').innerHTML='<div id="match-page-top"></div><div id="matches-progress"></div><span class="vh" id="matches-announcement" aria-live="polite" aria-atomic="true"></span><div id="matches-body"></div>'+shortcutsDialog();
      bindShortcutsDialog();load(false,false,Boolean(data)&&loadedView===viewSignature());pollJobs();return;
    }
    const returning=detailRow&&loadedView===viewSignature();
    if(returning)for(const row of rows)if(row.key===detailRow.key)row.state=detailRow.state;
    detailRow=null;dismissedRows.clear();
    if(restore&&!state.route.includes('?')){
      try{
        const saved=new URLSearchParams(storage('localStorage','aimm-matches-view')||''), p=new URLSearchParams([...saved].filter(([key])=>viewKeys.includes(key)));
        if(p.has('item')&&!Object.hasOwn(state.config.item||{},p.get('item'))&&!state.matchSummary?.groups?.some(group=>group.item===p.get('item')))p.delete('item');
        for(const [key,values] of Object.entries({source:['manual'],status:['new','all','shortlisted','contacted','dismissed'],min_score:['1','2','3','4','5'],sort:['newest','last_seen','price','score'],group:['search','date','none'],include_dismissed:['true','false'],price_drop:['true','false']}))if(p.has(key)&&!values.includes(p.get(key)))p.delete(key);
        updateQuery(p);
      }catch{}
    }else rememberView(query());
    cutoff=storage('localStorage','aimm-matches-seen')||'';
    const p=query();
    $('#pane').innerHTML=pageHeader('Matches',"Listings from your saved searches and links you add manually.",'<button class="btn p" id="add-listing">Add listing</button><button class="btn" id="export-csv">Export CSV</button><button class="btn q" id="matches-shortcuts" aria-keyshortcuts="Shift+?">Keyboard shortcuts</button>')+
      `<form id="add-listing-form" class="sect" hidden><label class="sm" for="add-listing-url">Facebook Marketplace listing URL</label><div class="row wr"><input class="in gr" id="add-listing-url" type="url" required maxlength="4096" placeholder="https://www.facebook.com/marketplace/item/…" aria-describedby="add-listing-error"><button class="btn p" id="add-listing-submit" type="submit">Save and assess</button></div><p class="err sm" id="add-listing-error" role="alert"></p></form><div class="bar matches-filters">`+
      `<button class="btn sm match-filters-toggle" id="matches-filters-toggle" aria-expanded="false" aria-controls="match-filter-row">Filters</button><div class="match-filter-row" id="match-filter-row">`+
      selectHtml('min_score','AI rating',[['','Any rating'],['4','Good or better'],['5','Great deal only']])+
      `<label class="opt sm match-price-drop"><input type="checkbox" data-match-filter="price_drop" value="true" ${p.get('price_drop')==='true'?'checked':''}>Price dropped</label><label class="sm">Contains<input class="in" type="search" id="matches-query" value="${esc(p.get('q')||'')}" placeholder="Title, seller…"></label><div class="match-view-controls" role="group" aria-label="View">`+
      selectHtml('sort','Sort',[['','Newest found'],['last_seen','Last seen'],['price','Price: low to high'],['score','Best rating']])+
      selectHtml('group','Group by',[['','Category'],['date','Day found'],['none','None']])+
      `<div class="sm match-density"><span>Density</span><div class="seg" role="group" aria-label="Density">${['comfortable','compact'].map(name=>`<button type="button" data-density="${name}" aria-pressed="${density()===name}">${name[0].toUpperCase()+name.slice(1)}</button>`).join('')}</div></div></div></div><div class="match-chips" id="match-chips-row" ${barFilters().length?'':'hidden'}><span class="row wr" id="match-chips"></span><button class="btn sm q" id="matches-clear" ${barFilters().length?'':'hidden'}>Clear filters</button></div></div><div id="matches-arrivals"></div><div id="matches-progress"></div><span class="vh" id="matches-announcement" aria-live="polite" aria-atomic="true"></span><div id="matches-body"></div>`+shortcutsDialog();
    bindShortcutsDialog();$('#matches-shortcuts').onclick=openShortcuts;
    $('#matches-body').addEventListener?.('focusin',event=>{const target=event.target.closest?.('[data-match-key]');if(target)setCursor(target.dataset.matchKey,false);});
    $('#add-listing').onclick=()=>{const form=$('#add-listing-form');form.hidden=!form.hidden;if(!form.hidden)$('#add-listing-url').focus();};
    $('#add-listing-form').onsubmit=addListing;
    $('#export-csv').onclick=()=>{clearTimeout(filterTimer);const p=query(), text=$('#matches-query').value;if(text!==(p.get('q')||'')){if(text)p.set('q',text);else p.delete('q');p.delete('cursor');updateQuery(p);load();}const exportParams=new URLSearchParams([...p].filter(([key])=>viewKeys.includes(key)&&key!=='group'));if(currentStatus()==='new'){exportParams.set('status','new');if(cutoff)exportParams.set('since',cutoff);}return exportCsv({url:'/api/matches.csv'+(exportParams.size?'?'+exportParams:''),emptyMessage:'No matches for these filters to export.',filename:'matches.csv'});};
    $('#matches-clear').onclick=()=>{clearTimeout(filterTimer);const p=query();for(const key of [...BAR_FILTER_KEYS,'cursor'])p.delete(key);updateQuery(p);render(false);$('#matches-query').focus();};
    document.querySelectorAll('[data-match-filter]').forEach(select=>select.onchange=()=>{const value=select.type==='checkbox'?(select.checked?'true':''):select.value;if(select.dataset.matchFilter==='group'){const p=query();if(value)p.set('group',value);else p.delete('group');updateQuery(p);renderBody();}else setFilter(select.dataset.matchFilter,value);});
    document.querySelectorAll('[data-density]').forEach(button=>button.onclick=()=>{storage('localStorage','aimm-matches-density',button.dataset.density==='compact'?'compact':null);document.querySelectorAll('[data-density]').forEach(other=>other.setAttribute('aria-pressed',other===button));renderBody();});
    $('#matches-filters-toggle').onclick=()=>{const bar=$('.matches-filters'), open=!bar.classList.contains('open');bar.classList.toggle('open',open);$('#matches-filters-toggle').setAttribute('aria-expanded',open);};
    renderChips();
    $('#matches-query').oninput=event=>{clearTimeout(filterTimer);const input=event.target,value=input.value;filterTimer=setTimeout(()=>{if(active()&&$('#matches-query')===input)setFilter('q',value);},250);};
    renderProgress();load(false,false,returning);pollJobs();
  }
  const isInvalid=row=>row.evaluation_status?['below_threshold','filtered_out'].includes(row.evaluation_status):Boolean(row.recheck&&row.recheck.checked_item===row.item&&['below_threshold','filtered_out'].includes(row.recheck.status));
  function badgesHtml(row){
    const check=row.recheck, invalid=isInvalid(row), checking=recheckState.get(row.marketplace+':'+row.listing_id);
    const ratingFell=invalid&&check?.old_score!=null&&row.score!=null&&check.old_score!==row.score;
    return [
      checking==='checking'?['re-checking','busy spin']:checking==='queued'?['queued for re-check','busy']:null,
      check?.status==='error'?['couldn’t re-check','warn',check.reason]:null,
      check?.status==='unavailable'?['no longer listed','']:null,
      ratingFell?[`Rating ${ratingWord(check.old_score)} → ${ratingWord(row.score)}`,'warn']:invalid?['no longer passes','warn']:null,
      priceDropped(row)?[priceDropText(row),'good']:null,
      row.seller_assessment?.status==='caution'?['Seller: Caution','warn']:null
    ].filter(Boolean).slice(0,2).map(([text,kind,title])=>`<span class="match-badge ${kind}"${title?` title="${esc(title)}"`:''}>${esc(text)}</span>`).join('');
  }
  function rowHtml(row,index,group) {
    if(dismissedRows.has(matchId(row)))return `<div class="match-row match-dismissed" role="status">Dismissed ${esc(row.title)} · <button class="btn q" data-undo-row="${esc(matchId(row))}">Undo</button></div>`;
    const isNew=isNewRow(row), summary=row.score==null?unratedText(row):aiText(row.comment)||row.conclusion||'';
    return `<div class="match-row${isInvalid(row)?' match-muted':''}${matchId(row)===cursorKey?' on':''}" data-match-row="${index}" data-group="${esc(group)}" data-match-key="${esc(matchId(row))}"><input type="checkbox" class="match-select" data-select-match="${esc(matchId(row))}" aria-label="Select ${esc(row.title||'listing')}" ${selectedKeys.has(matchId(row))?'checked':''}><span class="match-dot${isNew?' on':''}" aria-hidden="true"></span>${photo(row)}<span class="match-main"><span class="match-line1"><a class="match-title" href="${esc(detailRoute(row))}" data-open-match="${index}" data-group="${esc(group)}">${isNew?'<span class="vh">New: </span>':''}${esc(row.title||'Listing details unavailable')}</a>${badgesHtml(row)}</span><span class="match-attrs">${attrsHtml(row,query().get('sort'))}</span><span class="match-summary">${esc(summary)}</span></span><span class="match-row-actions"><span class="match-rating">${ratingWord(row.score)}</span>${ratingMeter(row.score)}<span class="row"><button class="btn sm q" data-row-state="shortlisted" data-match-id="${esc(matchId(row))}" aria-label="${row.state.shortlisted?'Unshortlist':'Shortlist'} ${esc(row.title)}" aria-pressed="${row.state.shortlisted}">${row.state.shortlisted?'★':'☆'}</button><button class="btn sm q" data-row-state="dismissed" data-match-id="${esc(matchId(row))}" aria-label="${row.state.dismissed?'Restore':'Dismiss'} ${esc(row.title)}">${row.state.dismissed?'Restore':'✕'}</button></span></span></div>`;
  }
  function renderBody() {
    if(!active()||!$('#matches-body'))return;
    const focused=document.activeElement;
    if($('#match-detail'))openSections=new Set([...document.querySelectorAll('#match-detail details[open]')].map(el=>el.dataset.section));
    const focusAttribute=['data-state','data-file-under','data-photo-index','data-photo-step','data-collapse','data-recheck-group','data-select-match','data-bulk','data-density'].find(name=>focused?.hasAttribute(name));
    const focusValue=focusAttribute?focused.getAttribute(focusAttribute):null, focusId=focused?.id;
    if(loading){$('#matches-body').innerHTML='<div class="match-skeleton" role="status">Loading matches…</div>'.repeat(3);renderProgress();return;}
    if(error){$('#matches-body').innerHTML=`<div class="empty"><p class="err">${esc(error)}</p><button class="btn" id="matches-retry">Retry</button></div>`;$('#matches-retry').onclick=()=>load();renderProgress();return;}
    if(detail()){
      const otherSearch=$('#check-other')?.value, noteDraft=$('#match-note')?.value;
      $('#matches-body').innerHTML='<article class="match-detail" id="match-detail" aria-label="Match details"></article>';
      renderDetail();
      if(otherSearch&&$('#check-other'))$('#check-other').value=otherSearch;
      if(noteDraft!=null&&noteDraft!==(detailRow?.state.note||'')&&$('#match-note'))$('#match-note').value=noteDraft;
      if(focusDetail){$('#match-title')?.focus({preventScroll:true});focusDetail=false;}
      else if(focusId)document.getElementById(focusId)?.focus({preventScroll:true});
      else if(focusAttribute)[...document.querySelectorAll('['+focusAttribute+']')].find(el=>el.getAttribute(focusAttribute)===focusValue)?.focus({preventScroll:true});
      renderProgress();return;
    }
    const sinceText=cutoff?`since ${relativeDate(cutoff)}`:'yet';
    if(!rows.length&&currentStatus()==='new'&&!filters().length){$('#matches-body').innerHTML=`<div class="empty" role="status"><h2>You’re all caught up</h2><p>No new matches ${cutoff?`since you marked them seen ${esc(relativeDate(cutoff))}`:'yet'}. New listings from your searches appear here until you shortlist, contact or dismiss them.</p><button class="btn" id="matches-show-all">Show all matches</button></div>`;$('#matches-show-all').onclick=()=>setFilter('status','all');renderProgress();return;}
    if(!rows.length){const filtered=filters();$('#matches-body').innerHTML=`<div class="empty"><h2>${filtered.length?'No matches for these filters':'No matches yet'}</h2><p>${filtered.length?esc(filtered.map(([k,v])=>k+': '+v).join(' · ')):"Listings from searches and links you add manually will collect here."}</p>${filtered.length?'':'<a href="#/monitor/all">View searches</a>'}</div>`;renderProgress();return;}
    const ordered=navigationEntries();
    if(!ordered.some(entry=>matchId(entry.row)===selected))selected=ordered.length?matchId(ordered[0].row):null;
    recheckState=recheckStatuses(jobs.values());
    const by=query().get('group')||'search', groups=groupMatches(rows,by,query().get('item')||'');
    $('#matches-body').innerHTML=(query().get('sort')==='price'?'<p class="sm d">Uses the amount shown in the listing; shorthand and placeholder prices may be misleading. Confirm the asking price with the seller.</p>':'')+(currentStatus()==='new'?`<div class="match-queue" role="status"><span><strong>${data.total??rows.length} new</strong> ${esc(sinceText==='yet'?'— shortlist, contact or dismiss each one':sinceText)}</span><button class="btn sm" id="matches-mark-seen">Mark all seen</button></div>`:'')+`<div class="matches-layout${density()==='compact'?' compact':''}"><div class="matches-list">${batchBar()}`+[...groups].map(([name,entries])=>{
      const count=(by==='search'?data.filtered_groups.find(group=>group.item===name)?.count:null)??entries.length;
      const last=state.records.findLast(record=>record.extra?.kind==='search_summary'&&record.extra.item===name);
      const open=!collapsed.has(name), label=by==='date'?dayGroupLabel(name):name||'Manually added';
      const description=by==='search'?[name?Object.hasOwn(state.config.item||{},name)?searchSummary(name):'Removed search':'Links you add · general AI assessment',name?'last searched '+(last?relativeDate(new Date(last.time*1000).toISOString()):'—'):''].filter(Boolean).join(' · '):'';
      return `<section class="match-group">${by!=='none'?`<header><div class="match-group-head"><h2 class="match-group-title"><button class="btn q" data-collapse="${esc(name)}" aria-expanded="${open}"><span class="match-caret" aria-hidden="true">${open?'▾':'▸'}</span>${by==='search'?`<span class="m">${esc(label)}</span>`:esc(label)}</button></h2><span class="sm match-group-summary">${esc(groupSummary(entries))}</span><span class="m d match-group-count">${count} ${count===1?'match':'matches'}</span><button class="btn sm" data-recheck-group="${esc(name)}" ${running()||(by==='search'&&name&&(!state.config.item?.[name]||state.config.item[name].enabled===false))?'disabled':''} title="At most 25 listings per job">${[...jobs.values()].some(job=>['queued','running'].includes(job.state)&&job.searches?.length===1&&job.searches[0]===name)?'Re-checking…':count>25?'Re-check newest 25':'↻ Re-check '+Math.min(count,25)}</button></div>${description&&open?`<p class="xs d match-group-description">${esc(description)}</p>`:''}</header><div data-group-progress="${esc(name)}"></div>`:''}${open?entries.map((row,index)=>rowHtml(row,index,name)).join(''):''}</section>`;
    }).join('')+`${data.next_cursor?'<button class="btn match-more" id="matches-more">Load more matches</button>':''}${query().get('status')!=='dismissed'?'<p class="section-note">Dismissed matches are hidden</p>':''}${shortcutsOn()?'<p class="match-keys xs d"><span><kbd>j</kbd> <kbd>k</kbd> move</span><span><kbd>s</kbd> shortlist</span><span><kbd>e</kbd> dismiss</span><span><kbd>c</kbd> contacted</span><span><kbd>v</kbd> open on Facebook</span><span><kbd>z</kbd> undo</span><span><kbd>?</kbd> all shortcuts</span></p>':''}</div><aside class="match-preview" id="match-preview" aria-label="Match preview"></aside></div>`;
    $('#matches-mark-seen')?.addEventListener('click',markAllSeen);
    document.querySelectorAll('[data-select-match]').forEach(input=>input.onclick=event=>toggleSelection(input.dataset.selectMatch,input.checked,event.shiftKey));
    document.querySelectorAll('[data-bulk]').forEach(button=>button.onclick=()=>bulkUpdate(button.dataset.bulk));
    $('#matches-select-all')?.addEventListener('click',()=>{for(const entry of cursorEntries())selectedKeys.add(matchId(entry.row));renderBody();});
    $('#matches-select-none')?.addEventListener('click',()=>{selectedKeys.clear();selectionAnchor=null;renderBody();});
    if(previewVisible()&&!cursorEntries().some(entry=>matchId(entry.row)===cursorKey))cursorKey=cursorEntries()[0]?matchId(cursorEntries()[0].row):null;
    if(previewVisible())setCursor(cursorKey,false);
    document.querySelectorAll('[data-open-match]').forEach(link=>link.onclick=event=>{if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();if(previewVisible()){setCursor(matchId(groups.get(link.dataset.group)[Number(link.dataset.openMatch)]),false);return;}openMatch(groups.get(link.dataset.group)[Number(link.dataset.openMatch)]);});
    document.querySelectorAll('[data-row-state]').forEach(button=>button.onclick=()=>{const row=rows.find(row=>matchId(row)===button.dataset.matchId);if(row)saveState(row,{[button.dataset.rowState]:!row.state[button.dataset.rowState]},{fromRow:true});});
    document.querySelectorAll('[data-undo-row]').forEach(button=>button.onclick=()=>{const saved=dismissedRows.get(button.dataset.undoRow);if(saved)saveState(saved.row,{dismissed:saved.previous},{fromRow:true,silent:true});});
    document.querySelectorAll('[data-collapse]').forEach(button=>button.onclick=()=>{const name=button.dataset.collapse;collapsed.has(name)?collapsed.delete(name):collapsed.add(name);renderBody();});
    document.querySelectorAll('[data-recheck-group]').forEach(button=>button.onclick=()=>startGroup(button.dataset.recheckGroup,groups.get(button.dataset.recheckGroup),by));
    $('#matches-more')?.addEventListener('click',()=>load(true));bindPhotos();renderProgress();
    if(focused?.classList?.contains('match-title')&&cursorKey)focusCursor();
    else if(focusAttribute){const replacement=[...document.querySelectorAll('['+focusAttribute+']')].find(el=>el.getAttribute(focusAttribute)===focusValue);(replacement||document.querySelector('[data-match-row]'))?.focus({preventScroll:true});}
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
    selected=matchId(row);cursorKey=selected;detailRow=row;state.route=detailRoute(row);
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
    const manual=row.source==='manual', searchState=state.config.item?.[row.item], sellerStatus=row.seller_assessment?.status;
    const openSection=name=>openSections.has(name)?' open':'';
    const recheckBody=`<p class="sm d">${esc(manual?row.evaluation_status==='error'?row.assessment_reason:row.evaluation_status==='assessed'?'Assessed '+matchDate(row.assessed_at):'Awaiting assessment':lastCheck(row))}</p>${row.recheck?.reason?`<p class="sm warn">${esc(row.recheck.reason)}</p>${state.status.vnc_enabled?'<a href="/vnc/vnc.html?autoconnect=true&path=ws/vnc" target="_blank" rel="noopener">Open Browser ↗</a>':''}`:''}<div class="row wr"><button class="btn" id="recheck-one" ${running()||(!manual&&(!searchState||searchState.enabled===false))?'disabled':''}>${manual?row.evaluation_status==='error'?'Retry assessment':'Assess again':'↻ Re-check now'}</button><span class="sm d">${manual?'Fetches current listing details and runs a general AI assessment.':!searchState?'Original search removed. Choose another search below to re-check.':searchState.enabled===false?'Original search paused. Resume it or choose another search below.':`Opens the listing again and rates it against ${esc(row.item)}’s current settings.`}</span></div><label class="sm" for="check-other">Check against another search</label><div class="row"><select class="in gr" id="check-other"><option value="">Choose search</option>${others.map(([name])=>`<option>${esc(name)}</option>`).join('')}</select><button class="btn" id="recheck-other" ${running()?'disabled':''}>Run</button></div><p class="sm d">If it passes there, it’s filed under that search too. File by hand without changing its rating:</p><div class="row wr">${Object.keys(state.config.item||{}).filter(name=>name!==row.item).map(name=>`<label class="row sm"><input type="checkbox" data-file-under="${esc(name)}" ${row.state.filed_under.includes(name)?'checked':''}>${esc(name)}</label>`).join('')}</div>`;
    const recheckHint=manual?row.evaluation_status==='error'?'failed':row.evaluation_status==='assessed'?'assessed':'awaiting':row.recheck?row.recheck.status.replaceAll('_',' '):'not re-checked';
    const facts=[['Condition',row.condition||'Not stated'],['Location',row.location],['Seller',row.seller],['Search',manual?'Added manually · general assessment':row.item+(searchState?'':' (removed search)')],['Search sightings',row.seen_count?`${row.seen_count}${row.imported?' since tracking began':''}`:'Not tracked yet'],['Filed by you',row.state.filed_under.join(', ')],['Sent to',row.notified_users.join(', ')]];
    $('#match-detail').innerHTML=`<nav class="match-detail-nav" aria-label="Match navigation"><button class="btn sm" id="match-previous" aria-keyshortcuts="k" ${index<=0?'disabled':''}>‹ Previous</button><span class="sm d">${index<0?'Outside the loaded matches':`${index+1} of ${entries.length} loaded`}</span><button class="btn sm" id="match-next" aria-keyshortcuts="j" ${index<0||index>=entries.length-1?'disabled':''}>Next ›</button></nav>`+
      `<div class="match-detail-grid"><div class="match-detail-gallery" id="match-gallery"></div>`+
      `<aside class="match-detail-rail" aria-label="Price and actions"><section class="match-card">${priceHtml(row)}<p class="match-rating-line"><strong>${ratingWord(row.score)}</strong>${ratingMeter(row.score)}</p>${decisionButtons(row,'data-state')}${listingUrl?`<div class="match-links"><a class="btn p" href="${esc(listingUrl)}" target="_blank" rel="noopener noreferrer" aria-keyshortcuts="v">Open on Facebook ↗ <kbd>v</kbd></a><button class="btn" id="copy-listing-link">Copy link</button></div><div id="copy-link-fallback" hidden><label class="sm" for="listing-link">Listing link — select and copy</label><input class="in" id="listing-link" type="text" readonly value="${esc(listingUrl)}"></div>`:''}</section><section class="match-card" aria-label="Your note"><label class="match-h" for="match-note">Your note</label><textarea class="ta" id="match-note" maxlength="2000" placeholder="e.g. Messaged Sat, asked about battery health">${esc(row.state.note||'')}</textarea><p class="xs d" id="match-note-status" role="status">Private to you.</p></section><section class="match-card" aria-label="Key dates"><h2 class="match-h">Key dates</h2><ol class="match-dates">${keyDates(row)}</ol></section></aside>`+
      `<div class="match-detail-main" id="match-detail-main"><section class="match-card" aria-label="AI rating"><h2 class="match-h">AI rating</h2><p class="match-rating-line"><strong>${ratingWord(row.score)}</strong>${ratingMeter(row.score)}<span class="m d">${score(row)}</span><span class="sm d">${manual?'general buying assessment':'for '+esc(row.item)}</span></p>${row.comment?`<p class="match-comment">${esc(aiText(row.comment))}</p>`:`<p class="sm d">${esc(unratedText(row))}</p>`}</section>`+
      `<section class="match-section" aria-label="Seller’s description"><h2 class="match-h">Seller’s description</h2><p class="match-description">${esc(row.description||'No description saved.')}</p></section>`+
      `<section class="match-section" aria-label="Listing"><h2 class="match-h">Listing</h2><dl class="match-facts">${facts.map(([label,value])=>`<dt>${label}</dt><dd>${esc(value||'—')}${label==='Seller'&&['established','caution'].includes(sellerStatus)?' '+sellerBadge(row):''}</dd>`).join('')}</dl>${row.imported?`<p class="xs d">Imported record. Repeat tracking began ${esc(matchDate(row.tracking_since))}; earlier sightings are unknown.</p>`:''}</section>`+
      `<div class="match-more"><details id="match-history" data-section="history"${openSection('history')}><summary>History</summary><div id="match-history-body"></div></details><details data-section="seller"${openSection('seller')}><summary>Seller credibility <span class="sm d">${esc(sellerStatus?sellerStatus[0].toUpperCase()+sellerStatus.slice(1):'Unknown')}</span></summary>${sellerDetail(row)}</details><details data-section="recheck"${openSection('recheck')||(row.evaluation_status==='error'||row.recheck?.reason?' open':'')}><summary>${manual?'AI assessment':'Re-check and filing'} <span class="sm d">${esc(recheckHint)}</span></summary><div class="match-more-body">${recheckBody}</div></details>${row.marketplace&&row.listing_id?`<details data-section="related"${openSection('related')}><summary>Related listings${row.related_count?` <span class="sm d">${row.related_count} possible connections</span>`:''}</summary><div id="related-listings" role="region" aria-label="Related listings"></div></details>`:''}</div></div></div>`;
    if($('#related-listings'))relatedView.mount($('#related-listings'),row);
    const back=query();back.delete('match_item');
    $('#match-page-top').innerHTML=`<div class="ph"><div><a id="match-back" href="#/monitor/matches${back.size?'?'+back:''}">← Matches</a><p class="m d sm">${esc(row.source==='manual'?'Manually added':row.item)}${row.source==='manual'||state.config.item?.[row.item]?'':' (removed search)'}</p><h1 id="match-title" tabindex="-1">${esc(row.title||'Listing details unavailable')}</h1><p class="match-attrs">${attrsHtml(row,'')}</p>${badgesHtml(row)?`<p class="match-line1">${badgesHtml(row)}</p>`:''}</div></div>${row.state.dismissed?'<div class="nt" role="status">Dismissed. Hidden from Matches. <button class="btn q" id="detail-undo">Undo</button></div>':''}`;
    $('#match-back').onclick=event=>{if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();state.route='#/monitor/matches'+(back.size?'?'+back:'');history.pushState(null,'',state.route);render(false);};
    $('#detail-undo')?.addEventListener('click',()=>saveState(row,{dismissed:false},{silent:true}));
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
    const note=$('#match-note');
    if(note)note.oninput=()=>{clearTimeout(noteTimer);$('#match-note-status').textContent='Saving…';noteTimer=setTimeout(()=>saveNote(row,note),600);};
    $('#recheck-one').onclick=()=>start([row]);$('#recheck-other').onclick=()=>{const item=$('#check-other').value;if(item)start([row],item);else toast('Choose a search first.');};bindPhotos();
  }
  function setCursor(key,focus=true){
    cursorKey=key;
    for(const el of document.querySelectorAll('[data-match-key]'))el.classList?.toggle('on',el.dataset.matchKey===key);
    renderPreview();
    if(focus)focusCursor();
  }
  const previewVisible=()=>Boolean($('#match-preview')?.checkVisibility?.());
  function renderPreview(){
    const target=$('#match-preview');if(!target||!previewVisible())return;
    const entries=cursorEntries(), index=entries.findIndex(entry=>matchId(entry.row)===cursorKey), row=entries[index]?.row;
    if(!row){target.innerHTML='<p class="match-preview-empty">Select a match to preview it.</p>';return;}
    if(previewKey!==cursorKey){previewKey=cursorKey;previewPhoto=0;}
    const listingUrl=safeUrl(row.url), sellerStatus=row.seller_assessment?.status;
    target.innerHTML=`<div class="match-preview-top"><span class="m d sm">${esc(row.source==='manual'?'Manually added':row.item)}</span><a href="${esc(detailRoute(row))}" id="match-preview-open">Open full page →</a></div><div id="match-preview-gallery">${galleryHtml(row,previewPhoto)}</div><h2 class="match-preview-title">${esc(row.title||'Listing details unavailable')}</h2>${priceHtml(row)}<p class="match-rating-line"><strong>${ratingWord(row.score)}</strong>${ratingMeter(row.score)}<span class="sm d">${row.source==='manual'?'general buying assessment':'for '+esc(row.item)}</span></p><p class="match-comment">${esc(row.score==null?unratedText(row):aiText(row.comment)||row.conclusion||'')}</p><dl class="match-facts"><dt>Condition</dt><dd>${esc(row.condition||'Not stated')}</dd><dt>Location</dt><dd>${esc(row.location||'—')}</dd><dt>Seller</dt><dd>${esc(row.seller||'—')}${['established','caution'].includes(sellerStatus)?' '+sellerBadge(row):''}</dd></dl>${row.state.note?`<p class="match-preview-note"><span class="match-h">Your note</span> ${esc(row.state.note)}</p>`:''}${decisionButtons(row,'data-preview-state')}${listingUrl?`<a class="btn p match-preview-facebook" href="${esc(listingUrl)}" target="_blank" rel="noopener noreferrer" aria-keyshortcuts="v">Open on Facebook ↗ <kbd>v</kbd></a>`:''}<section aria-label="Key dates"><h3 class="match-h">Key dates</h3><ol class="match-dates">${keyDates(row)}</ol></section>`;
    $('#match-preview-open').onclick=event=>{if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();openMatch(row);};
    target.querySelectorAll('[data-preview-state]').forEach(button=>button.onclick=()=>decide(row,button.dataset.previewState));
    target.querySelectorAll('[data-photo-step]').forEach(button=>button.onclick=()=>{previewPhoto+=Number(button.dataset.photoStep);renderPreview();});
    target.querySelectorAll('[data-photo-index]').forEach(button=>button.onclick=()=>{previewPhoto=Number(button.dataset.photoIndex);renderPreview();});
    target.querySelectorAll('img').forEach(img=>img.onerror=()=>{img.alt='Saved photo unavailable';img.removeAttribute('src');});
    const upcoming=entries[index+1]?.row, upcomingPhoto=upcoming&&matchPhotoUrl(upcoming);
    if(upcomingPhoto&&globalThis.Image)new Image().src=upcomingPhoto;
  }
  function decide(row,field){
    const entries=cursorEntries(), index=entries.findIndex(entry=>matchId(entry.row)===matchId(row)), next=entries[index+1]||entries[index-1];
    if(next)cursorKey=matchId(next.row);
    return saveState(row,{[field]:!row.state[field]},{fromRow:true,viaKey:true});
  }
  function focusCursor(){
    const el=[...document.querySelectorAll('[data-match-key]')].find(node=>node.dataset.matchKey===cursorKey);
    el?.querySelector?.('.match-title')?.focus({preventScroll:true});el?.scrollIntoView?.({block:'nearest'});
  }
  const cursorEntries=()=>navigationEntries().filter(entry=>!collapsed.has(entry.group)&&!dismissedRows.has(matchId(entry.row)));
  function openListing(row){const url=safeUrl(row.url);if(url)globalThis.open?.(url,'_blank','noopener,noreferrer');}
  function markAllSeen(){
    const previous=cutoff;cutoff=new Date().toISOString();storage('localStorage','aimm-matches-seen',cutoff);
    const undo=()=>{if(lastUndo===undo)lastUndo=null;toast('Change undone.');cutoff=previous;storage('localStorage','aimm-matches-seen',previous||null);return load(false,true);};
    lastUndo=undo;notify('Marked all matches as seen',undo);return load(false,true);
  }
  function shortcutsDialog(){
    const keys=[['j / k','Next / previous match'],['o or Enter','Open match'],['u or Esc','Back to Matches'],['s','Shortlist'],['e','Dismiss'],['c','Mark contacted'],['v','Open on Facebook'],['z','Undo'],['x','Select for bulk actions'],['/','Search'],['?','This list']];
    return `<dialog class="dlg" id="match-shortcuts" aria-labelledby="match-shortcuts-title"><h2 id="match-shortcuts-title">Keyboard shortcuts</h2><dl class="match-shortcut-list">${keys.map(([key,action])=>`<dt><kbd>${key}</kbd></dt><dd>${action}</dd>`).join('')}</dl><label class="row sm"><input type="checkbox" id="match-shortcuts-enabled" ${shortcutsOn()?'checked':''}>Use single-key shortcuts in Matches</label><p class="xs d">Shortcuts never fire while you type in a field. This setting is saved in this browser.</p><div class="row" style="justify-content:flex-end"><button class="btn" type="button" id="match-shortcuts-close">Close</button></div></dialog>`;
  }
  function bindShortcutsDialog(){
    const toggle=$('#match-shortcuts-enabled');if(toggle)toggle.onchange=()=>{storage('localStorage','aimm-shortcuts',toggle.checked?null:'off');renderBody();};
    const close=$('#match-shortcuts-close');if(close)close.onclick=()=>$('#match-shortcuts')?.close?.();
  }
  function openShortcuts(){const dialog=$('#match-shortcuts');if(dialog?.showModal&&!dialog.open){$('#match-shortcuts-enabled').checked=shortcutsOn();dialog.showModal();}}
  function onKey(event){
    if(!active())return;
    const action=matchShortcut(event);if(!action||(!shortcutsOn()&&action!=='help'))return;
    if(action==='help'){event.preventDefault();openShortcuts();return;}
    if(action==='undo'){if(lastUndo){event.preventDefault();lastUndo();}return;}
    if(detail()){
      const row=detailRow;if(!row)return;
      const run={next:()=>moveSelection(1),previous:()=>moveSelection(-1),back:()=>$('#match-back')?.click(),facebook:()=>openListing(row),shortlisted:()=>saveState(row,{shortlisted:!row.state.shortlisted}),dismissed:()=>saveState(row,{dismissed:!row.state.dismissed}),contacted:()=>saveState(row,{contacted:!row.state.contacted})}[action];
      if(run){event.preventDefault();run();}
      return;
    }
    if(action==='search'){event.preventDefault();$('#matches-query')?.focus();return;}
    const entries=cursorEntries(), index=entries.findIndex(entry=>matchId(entry.row)===cursorKey);
    if(!entries.length)return;
    if(action==='next'||action==='previous'){event.preventDefault();setCursor(matchId(entries[index<0?0:Math.min(Math.max(index+(action==='next'?1:-1),0),entries.length-1)].row));return;}
    if(index<0)return;
    const row=entries[index].row;
    if(action==='open'){event.preventDefault();openMatch(row);return;}
    if(action==='select'){event.preventDefault();toggleSelection(cursorKey,!selectedKeys.has(cursorKey),event.shiftKey);focusCursor();return;}
    if(action==='facebook'){event.preventDefault();openListing(row);return;}
    if(STATE_MESSAGES[action]){event.preventDefault();decide(row,action);}
  }
  globalThis.document?.addEventListener?.('keydown',onKey);
  function batchBar(){
    if(!selectedKeys.size)return '';
    const dismissedView=currentStatus()==='dismissed';
    return `<div class="match-batch" role="region" aria-label="Bulk actions"><strong>${selectedKeys.size} selected</strong>${dismissedView?'<button class="btn sm" data-bulk="restore">Restore</button>':'<button class="btn sm" data-bulk="shortlisted">Shortlist</button><button class="btn sm" data-bulk="contacted">Mark contacted</button><button class="btn sm" data-bulk="dismissed">Dismiss</button>'}<button class="btn sm q" id="matches-select-all">Select all ${cursorEntries().length} loaded</button><button class="btn sm q" id="matches-select-none">Clear selection</button></div>`;
  }
  function toggleSelection(key,checked,range){
    const keys=cursorEntries().map(entry=>matchId(entry.row)), from=keys.indexOf(selectionAnchor), to=keys.indexOf(key);
    const targets=range&&from>=0&&to>=0?keys.slice(Math.min(from,to),Math.max(from,to)+1):[key];
    for(const target of targets)checked?selectedKeys.add(target):selectedKeys.delete(target);
    selectionAnchor=key;renderBody();
  }
  async function bulkUpdate(action){
    const field=action==='restore'?'dismissed':action, value=action!=='restore';
    const targets=[...new Map(rows.filter(row=>selectedKeys.has(matchId(row))).map(row=>[row.key,row])).values()];
    if(!targets.length)return;
    const previous=targets.map(row=>[row,row.state[field]]);
    const put=(row,patch)=>json(`/api/matches/${encodeURIComponent(row.marketplace)}/${encodeURIComponent(row.listing_id)}/state`,{method:'PUT',body:JSON.stringify(patch)}).then(updated=>Object.assign(row.state,updated));
    try{
      await Promise.all(targets.map(row=>put(row,{[field]:value})));
      selectedKeys.clear();selectionAnchor=null;
      const undo=async()=>{if(lastUndo===undo)lastUndo=null;toast('Change undone.');await Promise.all(previous.map(([row,old])=>put(row,{[field]:old})));return load(false,true);};
      lastUndo=undo;notify(`${({shortlisted:'Shortlisted',contacted:'Marked contacted',dismissed:'Dismissed',restore:'Restored'})[action]} ${targets.length} ${targets.length===1?'match':'matches'}`,undo);
    }catch(err){toast(err.message);}
    await load(false,true);
  }
  async function saveNote(row,input){
    const value=input.value;
    try{const updated=await json(`/api/matches/${encodeURIComponent(row.marketplace)}/${encodeURIComponent(row.listing_id)}/state`,{method:'PUT',body:JSON.stringify({note:value})});Object.assign(row.state,updated);for(const other of rows)if(other.key===row.key)other.state.note=updated.note;if($('#match-note-status'))$('#match-note-status').textContent='Saved.';}
    catch(err){if($('#match-note-status'))$('#match-note-status').textContent='Not saved: '+err.message;}
  }
  function renderArrivals(){
    const target=$('#matches-arrivals');if(!target)return;
    target.innerHTML=arrivals?`<div class="match-arrivals" role="status"><button class="btn sm" id="matches-arrivals-show">${arrivals} new ${arrivals===1?'match':'matches'} · Show</button></div>`:'';
    $('#matches-arrivals-show')?.addEventListener('click',()=>{arrivals=0;renderArrivals();load(false,true);});
  }
  async function saveState(row,patch,{fromRow=false,silent=false,viaKey=false}={}) {
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
      const changed=Object.keys(patch).find(name=>STATE_MESSAGES[name]);
      if(changed&&!silent){const undo=()=>{if(lastUndo===undo)lastUndo=null;toast('Change undone.');return saveState(row,previous,{fromRow,silent:true});};lastUndo=undo;notify(`${STATE_MESSAGES[changed][patch[changed]?0:1]}: ${row.title||'listing'}`,undo);}
      if(state.route===route){await load(false,true);if(viaKey)focusCursor();else if(fromRow&&patch.dismissed===true)document.querySelector('[data-undo-row]')?.focus();}
    }catch(err){Object.assign(row.state,previous);dismissedRows.delete(matchId(row));if(state.route===route)renderBody();toast(err.message);}
    finally{pendingStates.delete(row.key);}
  }
  async function addListing(event) {
    event.preventDefault();
    const input=$('#add-listing-url'), button=$('#add-listing-submit'), error=$('#add-listing-error');
    if(button.disabled)return;
    button.disabled=true;button.textContent='Saving…';error.textContent='';
    try{
      const result=await json('/api/matches/manual',{method:'POST',body:JSON.stringify({url:input.value.trim()})});
      if(result.job_id){jobs.set(result.job_id,{job_id:result.job_id,state:'queued',done:0,total:1,results:[],searches:['']});rememberJobs();}
      if(active()){openMatch(result.match);pollJobs();}
      toast(result.existing?'This listing is already saved.':'Listing saved. Fetching details and assessing with AI…');
    }catch(err){error.textContent=err.message;input.focus();}
    finally{button.disabled=false;button.textContent='Save and assess';}
  }
  async function startGroup(name,entries,by){
    try{if(by==='search'&&name){const p=new URLSearchParams(filters());p.set('item',name);p.set('sort','newest');p.set('limit','25');const result=await json('/api/matches?'+p);entries=result.matches;}await start(entries.slice(0,25));}catch(err){toast(err.message);}
  }
  async function start(entries,item) {
    try{const listings=[...new Map(entries.map(row=>[row.key,{marketplace:row.marketplace,listing_id:row.listing_id,original_item:row.item}])).values()].slice(0,25);const result=await json('/api/matches/recheck',{method:'POST',body:JSON.stringify({listings,item,refresh:true})});jobs.set(result.job_id,{job_id:result.job_id,state:'queued',done:0,total:result.queued,results:[],listings,item,searches:[...new Set(entries.map(row=>row.item))]});rememberJobs();renderProgress();renderBody();}
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
        const label=({imported:'Imported from cache',matched:'Matched search',manual:'Added manually',assessment:'General AI assessment',rating:'Rating changed',changed:'Listing changed',recheck:'Re-checked'})[event.kind]||event.kind;
        let text=event.kind==='changed'?Object.entries(details.changes||{}).map(([key,value])=>`${key}: ${value.before||'—'} → ${value.after||'—'}`).join('\n'):event.kind==='imported'?'Earlier sightings are unknown.':event.kind==='manual'?'Saved by you. No notification sent.':event.kind==='recheck'?`${details.status?.replaceAll('_',' ')||''}${details.reason?' · '+details.reason:''}${details.fresh_details?' · details fetched':' · no fresh details confirmed'}`:`${details.score==null?'No AI rating':`${ratingWord(details.score)} (${details.score}/5)`}${details.status?' · '+details.status.replaceAll('_',' '):''}${details.comment?' · '+aiText(details.comment):''}`;
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
      const html=`<div class="match-job row wr sb sm" role="status"><span>${job.state==='running'?'<span class="spin" aria-hidden="true"></span> ':''}${job.searches?.length===1&&job.searches[0]===''?'AI assessment':'Re-check'} ${esc(scope||job.item||'')} · ${esc(job.state)} · <strong>${job.done} of ${job.total}</strong>${job.searches?.length===1&&job.searches[0]===''?'':` · ${drops} price drops · ${changed} no longer pass`}</span>${['queued','running'].includes(job.state)?`<progress max="${job.total||1}" value="${job.done}" aria-label="Re-check progress"></progress><button class="btn sm q" data-stop-job="${esc(job.job_id)}">Stop</button>`:''}</div>`;
      (target||$('#matches-progress')).insertAdjacentHTML('beforeend',html);
    }
    document.querySelectorAll('[data-stop-job]').forEach(button=>button.onclick=async()=>{try{jobs.set(button.dataset.stopJob,await json('/api/matches/recheck/'+encodeURIComponent(button.dataset.stopJob),{method:'DELETE'}));rememberJobs();renderBody();renderProgress();}catch(err){toast(err.message);}});
  }
  async function pollJobs(){
    if(busy||!jobs.size)return;busy=true;let changed=false,announce=false;
    try{for(const [id,old] of jobs){if(!['queued','running'].includes(old.state))continue;try{const job=await json('/api/matches/recheck/'+id);jobs.set(id,job);changed ||= old.done!==job.done||old.state!==job.state;announce ||= Math.floor(old.done/3)!==Math.floor(job.done/3)||old.state!==job.state;if(['done','stopped'].includes(job.state)){notify(job.searches?.length===1&&job.searches[0]===''?(job.results.at(-1)?.status==='assessed'?'Listing saved and assessed.':job.results.at(-1)?.reason||'Assessment stopped. Retry from the listing.'):`Re-check ${job.state}: ${job.done} of ${job.total} checked. ${job.results.filter(row=>row.status==='passed').length} pass.`);}}catch(err){jobs.set(id,{...old,state:'stopped'});toast(err.message);changed=true;}}
      rememberJobs();if(announce&&$('#matches-announcement'))$('#matches-announcement').textContent=[...jobs.values()].map(job=>`Re-check ${job.state}, ${job.done} of ${job.total}`).join('. ');if(changed){await load(false,true);renderProgress();}
    }finally{busy=false;}
  }
  function onRecord(record){if(['match_recorded','match_seen','manual_listing_result','recheck_result','recheck_done','image_matching_done','match_photo_saved'].includes(record.extra?.kind)){if(record.extra.kind==='recheck_result'&&active()){rows=applyRecheckResult(rows,record.extra);renderBody();}if(record.extra.kind==='match_recorded'&&active()&&!detail()&&rows.length){arrivals++;renderArrivals();clearTimeout(refreshTimer);refreshTimer=setTimeout(summary,350);return;}clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{if(active())load(false,true);else summary();pollJobs();},350);}}
  setInterval(()=>{pollJobs();if(active())relatedView.refresh();else relatedView.unmount();},3000);
  return {render,onRecord,summary,onKey,sidebarHtml,sidebarClick};
}
