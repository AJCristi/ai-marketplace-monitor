import initToml, {parse, edit} from './vendor/toml-edit-js/shims.js';
import {FORM_SCHEMAS, BUILT_IN_REGIONS} from './fields.js';
import {createMatchesView, relativeDate} from './matches.js';
import {list, own, filled, mergeConfig, itemValue, marketplaceFor, scheduleLabel, CHANNELS, userChannels, resolvedUser, available, matchRecord, mergeRecords, searchActivity, searchStatusLabel, safeUrl, renameSection, esc} from './console-model.js';

const $ = selector => document.querySelector(selector);
const time = epoch => new Date(epoch * 1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',hour12:false});
const labelValue = value => Array.isArray(value) ? value.join(', ') : value === undefined ? 'none' : String(value);
const itemRoute = name => '#/monitor/item/' + encodeURIComponent(name);
const state = {
  open:true, initialized:false, status:{}, context:{inherited:{},environment:{},sources:[]},
  base:'', content:'', mtime:null, file:null, config:{}, local:{},
  route:location.hash || '#/monitor', form:null, saving:false, editor:null, editorSetting:false,
  conflict:null, error:'', saved:'', rawInvalid:false, records:[], lastSearches:new Map(), searchRequestedAfter:null, progress:{}, cancelNotice:null, capacity:2000, streamId:null, ws:null,
  connected:false, announceCount:0, disconnectedAt:null, following:true, pending:0, frozen:[], expanded:new Set(),
  credentials:null, credentialsId:0, monitorIssue:null, incidentId:0, loginId:0, loginUntil:0, feedTimer:null, announceTimer:null, pollBusy:false,
};
let matchesView;
let theme=localStorage.getItem('aimm-theme')||'system';
function applyTheme(){document.querySelectorAll('.c').forEach(el=>{el.classList.toggle('dark',theme==='dark');el.classList.toggle('light',theme==='light');});$('#theme').setAttribute('aria-label','Theme: '+theme);$('#theme').title='Theme: '+theme;}
$('#theme').onclick=()=>{theme=['system','light','dark'][(['system','light','dark'].indexOf(theme)+1)%3];localStorage.setItem('aimm-theme',theme);applyTheme();};applyTheme();
$('.skip').onclick=event=>{event.preventDefault();$('#pane').focus();$('#pane').scrollIntoView({block:'start'});};
const dirty = () => state.content !== state.base || (state.form && (Object.keys(state.form.changes).length > 0 || state.form.new));
const csrf = () => document.cookie.match(/(?:^|;\s*)aimm_csrf=([^;]*)/)?.[1];
async function api(path, options = {}) {
  const headers = {...options.headers};
  if (options.method && !['GET','HEAD'].includes(options.method) && csrf()) headers['X-CSRF-Token'] = decodeURIComponent(csrf());
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {...options, headers, credentials:'same-origin'});
  if (response.status === 401) {
    await showLogin(true);
    throw new Error('Session expired. Sign in again; your draft is kept.');
  }
  return response;
}
async function json(path, options = {}) {
  const response = await api(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || data.detail || `Request failed (${response.status}).`);
  return data;
}
function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => {$('#toast').hidden = true;}, 5500);
}
function confirmAction(title, message, accept = 'Discard', cancel = 'Keep editing', html = false) {
  const dialog = $('#action-dialog');
  $('#dialog-title').textContent = title;
  if (html) $('#dialog-body').innerHTML = message; else $('#dialog-body').textContent = message;
  $('#dialog-accept').textContent = accept; $('#dialog-cancel').textContent = cancel;
  return new Promise(resolve => {
    const finish = accepted => { dialog.close(); $('#dialog-accept').onclick = null; $('#dialog-cancel').onclick = null; dialog.oncancel = null; resolve(accepted); };
    $('#dialog-accept').onclick = () => finish(true);
    $('#dialog-cancel').onclick = () => finish(false);
    dialog.oncancel = event => {event.preventDefault(); finish(false);};
    dialog.showModal(); $('#dialog-cancel').focus();
  });
}
async function navigate(route) {
  if (route === state.route) return;
  if (state.saving) {toast('Wait for the save to finish.'); return;}
  if (dirty() && !await confirmAction('Leave without saving?', 'Your unsaved changes will be lost.')) return;
  state.content = state.base; state.form = null; state.error = ''; state.saved = ''; state.conflict = null;
  location.hash = route;
}
const decodeName = value => {try {return decodeURIComponent(value);} catch {return value;}};
function routeParts() {
  const [path, query=''] = state.route.replace(/^#/, '').split('?');
  return {path, parts:path.split('/').filter(Boolean), query:new URLSearchParams(query)};
}
function refreshData() {
  try {state.local = parse(state.content); state.config = mergeConfig(state.context.inherited, state.local);}
  catch {state.local = {}; state.config = structuredClone(state.context.effective || {});}
  state.config.notification_values=state.context.notification_values || {};
}
async function loadConfig(preserve = false) {
  const files = await json('/api/config/files'); state.file = files.files[0];
  const [file, contextResponse] = await Promise.all([
    json('/api/config/file/primary'), api('/api/config/context'),
  ]);
  const contextData = await contextResponse.json();
  if (contextResponse.ok) state.context = contextData;
  else {state.error = contextData.detail || 'Open config.toml to repair the configuration.';state.monitorIssue=state.error;}
  state.base = file.content; state.mtime = file.mtime;
  state.rawInvalid=false;
  if (!preserve) state.content = file.content;
  refreshData();
  return file;
}
async function showLogin(expired = false) {
  if (state.ws) {state.ws.onclose = null; state.ws.close(); state.ws = null;}
  state.connected = false; updateStatus();
  const info = await (await fetch('/api/auth/info', {credentials:'same-origin'})).json();
  state.open = info.open;
  if (info.open) {
    const response = await fetch('/api/login', {method:'POST',body:new FormData(),credentials:'same-origin'});
    if (!response.ok) throw new Error('Unable to open the dashboard.');
    if ($('#login-dialog').open) $('#login-dialog').close();
    await bootstrap(); return;
  }
  if(!expired){
    const session=await fetch('/api/status',{credentials:'same-origin'});
    if(session.ok){if($('#login-dialog').open)$('#login-dialog').close();await bootstrap();return;}
    if(session.status!==401)throw new Error('Unable to check the dashboard session.');
  }
  $('#login-hint').textContent = expired ? 'Your session expired. Sign in again; unsaved changes in this tab are kept.' : 'Use the Facebook credentials configured when this monitor started.';
  $('#login-username').value = info.username_hint || '';
  if (!$('#login-dialog').open) $('#login-dialog').showModal();
  $('#login-username').focus();
}
$('#login-dialog').addEventListener('cancel', event => event.preventDefault());
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const submit = event.target.querySelector('button'); submit.disabled = true;
  try {
    const response = await fetch('/api/login', {method:'POST',body:new FormData(event.target),credentials:'same-origin'});
    const data = await response.json();
    if (!response.ok) throw new Error(response.status === 429 ? 'Too many failed sign-ins. Wait a few minutes and try again.' : data.detail || 'Sign-in failed.');
    $('#login-password').value = ''; $('#login-error').hidden = true; $('#login-dialog').close();
    await bootstrap();
  } catch(error) {$('#login-error').textContent = error.message; $('#login-error').hidden = false;}
  finally {submit.disabled = false;}
});
$('#logout').addEventListener('click', async () => {
  if (dirty() && !await confirmAction('Sign out with unsaved changes?', 'Signing out discards your draft.', 'Sign out')) return;
  await api('/api/logout', {method:'POST'}); state.content = state.base; state.form = null;
  await showLogin();
});
$('#search-all').addEventListener('click', async () => {
  $('#search-all').disabled = true;
  const requestedAfter = state.records.at(-1)?.id ?? 0;
  try {const data = await json('/api/monitor/restart', {method:'POST'}); state.searchRequestedAfter = requestedAfter; toast(data.message);}
  catch(error) {toast(error.message);} finally {updateStatus();}
});
$('#cancel-search').addEventListener('click', async () => {
  $('#cancel-search').disabled = true;
  try {await json('/api/monitor/search/cancel', {method:'POST'}); state.searchRequestedAfter = null; state.progress = {...state.progress, cancelling:true};}
  catch(error) {toast(error.message);} finally {updateStatus();}
});
document.addEventListener('click', event => {
  const anchor = event.target.closest('a[href^="#/"]');
  if (!anchor || event.ctrlKey || event.metaKey || event.shiftKey || event.button > 0) return;
  event.preventDefault(); navigate(anchor.getAttribute('href'));
});
window.addEventListener('beforeunload', event => {if (dirty()) {event.preventDefault(); event.returnValue = '';}});
window.addEventListener('hashchange', async () => {
  const next = location.hash;
  if (next === state.route) return;
  if (state.saving) {history.replaceState(null,'',state.route);toast('Wait for the save to finish.');return;}
  if (dirty() && !await confirmAction('Leave without saving?', 'Your unsaved changes will be lost.')) {history.replaceState(null,'',state.route); return;}
  state.content = state.base; state.form = null; state.error = ''; state.saved = ''; state.route = next;
  state.following = true; state.pending = 0; state.expanded.clear(); refreshData(); render();
});

function setupIssues() {
  const users = Object.keys(state.config.user || {}).filter(name => resolvedUser(state.config,name).enabled !== false && !userChannels(state.config,name,state.context.environment).length);
  return users.length + Number(state.credentials === 'waiting' || (!state.context.facebook_credentials_configured && state.credentials !== 'found'));
}
function enabledSearches() {
  return Object.entries(state.config.item || {}).filter(([name,item]) => item.enabled !== false && state.config.marketplace?.[marketplaceFor(state.config,name)]?.enabled !== false).map(([name]) => name);
}
function currentSearchActivity() {
  const activity = searchActivity(state.records, enabledSearches(), state.searchRequestedAfter);
  if (state.searchRequestedAfter != null && !activity.queued.length && !activity.running) {
    const summaries = state.records.filter(record => record.extra?.kind === 'search_summary' && record.id > state.searchRequestedAfter);
    const found = summaries.reduce((total, record) => total + (record.extra.new_count || 0), 0);
    state.searchRequestedAfter = null;
    if (summaries.length) toast(`✓ Searched ${summaries.length} · ${found} new ${found === 1 ? 'listing' : 'listings'}`);
  }
  return activity;
}
function updateSearchButton() {
  const activity = currentSearchActivity(), requested = state.searchRequestedAfter != null, busy = Boolean(activity.running || requested);
  const {main, detail} = searchStatusLabel({...activity, requested, progress:state.progress});
  const button = $('#search-all');
  button.innerHTML = busy ? `<span class="spin">${esc(main)}</span>${detail ? ` <span class="m d">${esc(detail)}</span>` : ''}` : esc(main);
  button.classList.toggle('busy', busy);
  button.setAttribute('aria-busy', String(busy));
  button.title = requested ? 'All enabled searches are running' : activity.running ? 'A scheduled search is running' : '';
  button.disabled = requested;
  $('#cancel-search').hidden = !busy;
  $('#cancel-search').disabled = Boolean(state.progress.cancelling && activity.running);
}
function updateStatus() {
  const el = $('#live-status');
  const waiting = state.credentials === 'waiting';
  const recent = state.records.at(-1);
  el.className = `m ${waiting || !state.connected ? 'warn' : 'ok'}`;
  el.textContent = waiting ? '● waiting for Facebook login' : state.connected ? `● live${recent ? ' · last activity '+time(recent.time) : ''}` : '◌ reconnecting…';
  $('#setup-count').textContent = setupIssues() ? '· ' + setupIssues() : '';
  $('#browser-link').hidden = !state.status.vnc_enabled;
  $('#browser-link').href = '/vnc/vnc.html?path=ws/vnc&autoconnect=1&resize=scale';
  $('#logout').hidden = state.open;
  updateSearchButton();
  let notice = '';
  if(state.monitorIssue)notice=`<span>${esc(state.monitorIssue)}</span><a class="btn sm" href="#/settings/config">Check config.toml</a><a class="btn sm" href="#/monitor/all?level=ERROR">View errors</a>`;
  else if (waiting) notice = '<span>Waiting for Facebook credentials.</span><a class="btn sm" href="#/settings/marketplace">Add login</a>';
  else if (!state.connected && state.disconnectedAt && Date.now()-state.disconnectedAt > 10000) notice = '<span>Live updates stopped. The monitor may still be running; activity reloads when it reconnects.</span><button class="btn sm" id="retry-stream">Retry</button>';
  else if (Date.now() < state.loginUntil) notice = `<span>Logging in to Facebook. If it asks for a code or CAPTCHA, finish it in ${state.status.vnc_enabled ? 'the Browser view' : 'the browser window on the computer running the monitor'}.</span>`;
  const cancelled = state.cancelNotice;
  const html = notice ? `<div class="nt warn">${notice}</div>` : cancelled ? `<div class="nt"><span class="gr">Cancelled ${esc(cancelled.item)}${cancelled.checked != null ? ` after checking ${cancelled.checked} ${cancelled.checked === 1 ? 'listing' : 'listings'}` : ''} · ${cancelled.found} new ${cancelled.found === 1 ? 'match' : 'matches'} saved. Other searches return to their schedule.</span><button class="btn sm q" id="dismiss-cancel">Dismiss</button></div>` : '';
  if ($('#global-notice').innerHTML !== html) {$('#global-notice').innerHTML = html; $('#retry-stream')?.addEventListener('click',connectStream); $('#dismiss-cancel')?.addEventListener('click',()=>{state.cancelNotice=null;updateStatus();});}
}
function searchSummary(name) {
  const inheritedMark=key=>!own(state.config.item?.[name],key)?'*':'';
  const item = state.config.item?.[name] || {};
  const phrases = list(item.search_phrases);
  const price = [itemValue(state.config,name,'min_price'),itemValue(state.config,name,'max_price')].filter(filled).join('–');
  const ai = list(itemValue(state.config,name,'ai'));
  const rating = list(itemValue(state.config,name,'rating')).join('/');
  return [phrases.length > 1 ? `${phrases[0]} +${phrases.length-1}` : phrases[0],price?price+inheritedMark('max_price'):price,scheduleLabel(state.config,name)+inheritedMark('search_interval'),ai.length ? `AI ≥${rating}${inheritedMark('rating')}` : 'no AI'].filter(Boolean).join(' · ');
}
function manualMatchesSidebarHtml() {
  const count = state.matchSummary?.groups?.find(group => group.item === '')?.count ?? 0;
  if (!count) return '';
  const {awaiting = 0, failed = 0, last_added: lastAdded = null} = state.matchSummary.manual || {};
  const badge = failed ? `<span class="m xs warn">${failed} failed</span>` : awaiting ? `<span class="m xs d">${awaiting} awaiting</span>` : '';
  const status = failed ? 'AI assessment failed · open it to retry' : awaiting ? 'Awaiting AI assessment' : `Last added ${relativeDate(lastAdded) || '—'} · all assessed`;
  return `<div class="sh">Added by you</div><a class="it" id="manual-matches-nav" href="#/monitor/matches?source=manual&status=all"><div class="row sb"><span class="t">Manually added</span>${badge}</div><div class="s">${count} ${count === 1 ? 'match' : 'matches'} · general AI assessment · not searched</div><div class="s">${esc(status)}</div></a>`;
}
function lastSearchedLabel(name) {
  const record = state.lastSearches.get(name);
  return `Last searched at: ${record ? time(record.time) : '—'}`;
}
const counted = name => state.progress.item === name && state.progress.total != null;
function renderSidebar() {
  const {parts} = routeParts(); const settings = parts[0] === 'settings';
  const matches = !settings && parts[1]==='matches';
  for (const [id,active] of [['monitor-nav',!settings&&!matches],['matches-top-nav',matches],['settings-nav',settings]]) {
    const link=$('#'+id);
    link.classList.toggle('on',active);
    if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
  }
  $('#sidebar').setAttribute('aria-label', settings ? 'Settings sections' : matches ? 'Match views' : 'Saved searches');
  const signature = JSON.stringify([state.route,state.config,state.form?.name,state.capacity,state.matchSummary?.groups,state.matchSummary?.manual,state.matchSummary?.library_total,...(matches?[state.matchSummary?.counts,state.matchSummary?.view_groups,state.matchSummary?.view_total]:[])]);
  if ($('#sidebar').dataset.signature !== signature) {
    $('#sidebar').dataset.signature = signature;
    if (matches) $('#sidebar').innerHTML = matchesView.sidebarHtml();
    else if (settings) {
      const rows = [['marketplace','Marketplace',Object.keys(state.config.marketplace || {}).join(' · ')],['ai','AI providers',Object.keys(state.config.ai || {}).join(' · ') || 'None'],['notifications','Notifications',Object.keys(state.config.user || {}).join(' · ')],['more','Image matching and more','Image matching, network and locale options'],['config','config.toml','Edit the file directly']];
      $('#sidebar').innerHTML = '<div class="sh">Settings</div>' + rows.map(([key,title,summary]) => `<a class="it ${parts[1]===key?'on':''}" href="#/settings/${key}" ${parts[1]===key?'aria-current="page"':''}><div class="t">${title}</div><div class="s">${esc(summary)}</div></a>`).join('');
    } else {
      $('#sidebar').innerHTML = `<a class="it ${parts[1]==='all'?'on':''}" href="#/monitor/all"><span class="b">All activity</span><span class="m d" style="float:right">last ${state.capacity.toLocaleString()} events</span></a><div class="sh">Saved searches · ${Object.keys(state.config.item || {}).length}</div>` + Object.entries(state.config.item || {}).map(([name,item]) => `<a class="it ${parts[2]===name || decodeName(parts[2]||'')===name ? 'on':''}" href="${itemRoute(name)}"><div class="row sb"><span class="t m ${item.enabled===false?'d':''}">${esc(name)}</span><span data-item-badge="${esc(name)}" class="m xs d">${item.enabled===false?'disabled':state.form?.name===name?'editing':''}</span></div><div class="s">${esc(searchSummary(name))}</div><div class="s" data-item-last-searched="${esc(name)}">${esc(lastSearchedLabel(name))}</div></a>`).join('') + manualMatchesSidebarHtml() + '<p class="sidebar-note">* marks a Marketplace or built-in default. Earlier files also contribute values. “New” counts come from recent activity.</p>';
    }
  }
  if (!settings && !matches) {
    if (!$('#matches-nav')) {
      const link=document.createElement('a');link.id='matches-nav';link.href='#/monitor/matches';link.className='it';
      $('#sidebar').firstElementChild.after(link);
    }
    $('#matches-nav').innerHTML=`<div class="row sb"><span class="b">Matches</span><span class="m">${state.matchSummary?.library_total??'—'}${state.matchSummary?.new_count?' · '+state.matchSummary.new_count+' new':''}</span></div><div class="s">saved library · remembers returning listings</div>`;
    for(const link of document.querySelectorAll('#sidebar a.it:not(#matches-nav)')){
      const name=link.querySelector('[data-item-badge]')?.dataset.itemBadge;
      if(name){const count=state.matchSummary?.groups?.find(group=>group.item===name)?.count??0;const summary=link.querySelector('.s');summary.textContent=`${count} matches · ${searchSummary(name)}`;}
    }
  }
  const {running, queued} = currentSearchActivity();
  for (const badge of document.querySelectorAll('[data-item-badge]')) {
    const name = badge.dataset.itemBadge, searching = running === name && state.config.item[name].enabled !== false && state.form?.name !== name;
    badge.classList.toggle('spin', searching); badge.classList.toggle('ai', searching); badge.classList.toggle('d', !searching);
    if (state.config.item[name].enabled === false) badge.textContent = 'disabled';
    else if (state.form?.name === name) badge.textContent = 'editing';
    else if (searching) badge.textContent = counted(name) ? `searching · ${state.progress.done}/${state.progress.total}` : 'searching…';
    else if (queued.includes(name)) badge.textContent = 'queued';
    else {const record = state.records.findLast(record => record.extra?.kind==='search_summary' && record.extra.item===name); badge.textContent = record ? `${record.extra.new_count} new` : '';}
    const row = badge.closest('a'); let bar = row?.querySelector('progress.search-progress');
    if (searching && counted(name)) {
      if (!bar) {bar = document.createElement('progress'); bar.className = 'search-progress'; row.append(bar);}
      bar.max = Math.max(state.progress.total, 1); bar.value = state.progress.done; bar.setAttribute('aria-label', `${name} listings checked`);
    } else bar?.remove();
  }
  for (const label of document.querySelectorAll('[data-item-last-searched]')) {
    const name = label.dataset.itemLastSearched, record = state.lastSearches.get(name);
    label.textContent = lastSearchedLabel(name);
    label.title = record ? new Date(record.time * 1000).toLocaleString() : 'No completed search in available activity';
  }
  updateStatus();
}
function pageHeader(title, description = '', actions = '') {
  return `<div class="ph"><div class="col gr" style="gap:4px"><h1>${esc(title)}</h1>${description ? `<p class="d sm">${description}</p>`:''}</div><div class="row wr">${actions}</div></div>`;
}
function renderFirstRun() {
  $('#pane').innerHTML = pageHeader('Finish setting up','A starter config.toml contains a sample search.') + `<div class="body"><ol class="checklist col" style="gap:24px"><li><h2 class="sm">1. Add your Facebook login</h2><p class="hint">FACEBOOK_USERNAME and FACEBOOK_PASSWORD can come from the environment. The monitor waits for credentials before opening its browser.</p><a class="btn p" href="#/settings/marketplace">Add login</a></li><li><h2 class="sm">2. Make the sample search yours</h2><p class="hint">Edit example or add your own saved search.</p><a class="btn" href="${itemRoute('example')}/edit">Edit search</a></li><li><h2 class="sm">3. Give user “me” a channel</h2><p class="hint">Recommended. Without a configured channel, activity appears here.</p><a class="btn" href="#/settings/notifications?edit=me">Add channel</a></li><li><h2 class="sm">4. Add an AI provider</h2><p class="hint">Optional. Without a working AI provider, listings that pass your filters meet the rating threshold.</p><a class="btn" href="#/settings/ai">Add provider</a></li></ol><p class="hint">Keep at least one marketplace, search and user. Other options are available in <a href="#/settings/config">config.toml</a>.</p><button class="btn q" id="dismiss-setup" type="button">Dismiss checklist</button></div>`;
  $('#dismiss-setup').onclick = () => {sessionStorage.setItem('aimm-setup-dismissed','1'); navigate('#/monitor/all');};
}
function filters() {
  const {parts,query} = routeParts();
  return {kind:query.get('kind')||'',item:parts[1]==='item'?decodeName(parts[2]):query.get('item')||'',level:query.get('level')||'',score:query.get('score')||'',text:query.get('text')||''};
}
function filterRoute(key, value) {
  const {path,query} = routeParts(); if (value) query.set(key,value); else query.delete(key);
  state.route = '#' + path + (query.size?'?'+query:''); history.replaceState(null,'',state.route);
  renderFeed(true);
}
function renderActivity(name = null) {
  const item = name ? state.config.item?.[name] : null;
  if (name && !item) {$('#pane').innerHTML = pageHeader('Search not found')+'<div class="empty">Choose a saved search from the list.</div>'; return;}
  const f = filters();
  let description = `Keeps the last ${state.capacity.toLocaleString()} events.`;
  let actions = '<button class="btn" id="export-csv" type="button">Export notified listings (CSV)</button>';
  if (name) {
    const region = itemValue(state.config,name,'search_region');
    const place = region?.length ? 'region: '+labelValue(region) : labelValue(itemValue(state.config,name,'search_city'));
    description = `${esc(searchSummary(name))} · ${esc(place)}${!filled(item.search_city)&&!filled(item.search_region)?'*':''} · AI: ${esc(labelValue(itemValue(state.config,name,'ai')))} · notify: ${esc(labelValue(itemValue(state.config,name,'notify')))} · <span data-item-last-searched="${esc(name)}">${esc(lastSearchedLabel(name))}</span>`;
    actions = `<a class="btn" href="#/monitor/matches?item=${encodeURIComponent(name)}&status=all">View matches</a><button class="btn" id="toggle-search" type="button" ${state.saving?'disabled':''}>${item.enabled===false?'Resume search':'Pause search'}</button><a class="btn" href="${itemRoute(name)}/edit">Edit</a><button class="btn" id="duplicate-search">Duplicate</button><button class="btn x" id="delete-search">Delete</button>`;
  }
  const types = [['','All'],['ai_eval','AI ratings'],['search_summary','Searches'],['listing_skip','Skipped'],...(!name?[['credentials_wait','Login']]:[])];
  $('#pane').innerHTML = pageHeader(name || 'All activity',name?description:esc(description),actions) + (name && item.description?`<p class="section-note">“${esc(item.description)}”</p>`:'') + (!name?'<p class="section-note">Every listing recorded as notified in the cache: link, price, rating, details. Export ignores the filters below.</p>':'') + `<div class="bar"><div class="row wr" role="group" aria-label="Activity type">${types.map(([kind,title])=>`<button class="pill" data-kind="${kind}" aria-pressed="${f.kind===kind}">${title}</button>`).join('')}</div><span class="m xs ok" id="follow-state">following live</span></div>` + (!name?`<div class="bar"><label class="sm">Search <span class="sel"><select id="filter-item" aria-label="Search"><option value="">All searches</option>${Object.keys(state.config.item||{}).map(item=>`<option value="${esc(item)}" ${f.item===item?'selected':''}>${esc(item)}</option>`).join('')}</select></span></label><label class="sm">Level <span class="sel"><select id="filter-level" aria-label="Level">${[['','All'],['INFO','Info'],['WARNING','Warning'],['ERROR','Error']].map(([value,title])=>`<option value="${value}" ${f.level===value?'selected':''}>${title}</option>`).join('')}</select></span></label><label class="sm">AI rating <span class="sel"><select id="filter-score" aria-label="AI rating">${[['','Any'],['3','≥3'],['4','≥4'],['5','5']].map(([value,title])=>`<option value="${value}" ${f.score===value?'selected':''}>${title}</option>`).join('')}</select></span></label><label class="sm gr">Contains <input id="filter-text" class="in" type="search" value="${esc(f.text)}" placeholder="Search activity"></label></div>`:'') + '<div id="pause-bar" class="pause-bar" hidden></div><div class="feed" id="feed"></div>' + (name?'<p class="feed-footnote">Delivery results aren’t tagged with a search yet, so they appear in <a href="#/monitor/all">All activity</a>.</p>':'');
  document.querySelectorAll('[data-kind]').forEach(button=>button.onclick=()=>{filterRoute('kind',button.dataset.kind); document.querySelectorAll('[data-kind]').forEach(b=>b.setAttribute('aria-pressed',b===button));});
  for (const key of ['item','level','score']) $('#filter-'+key)?.addEventListener('change',event=>filterRoute(key,event.target.value));
  $('#filter-text')?.addEventListener('input',event=>filterRoute('text',event.target.value));
  $('#export-csv')?.addEventListener('click',exportCsv);
  $('#toggle-search')?.addEventListener('click',()=>toggleSearch(name));
  $('#delete-search')?.addEventListener('click',()=>deleteSection('item',name));
  $('#duplicate-search')?.addEventListener('click',()=>{
    state.newFields = structuredClone(item); let copy = name+'_copy'; let number = 2;
    while (own(state.config.item,copy)) copy = name+'_copy'+number++;
    state.newName = copy;state.newReturn=itemRoute(name); navigate('#/monitor/new');
  });
  window.onscroll=()=>{if(window.scrollY>0)pauseFeed();};
  $('#pane').onscroll = () => {if ($('#pane').scrollTop > 0) pauseFeed();};
  renderFeed(true);
}
async function toggleSearch(name) {
  if(state.saving)return;
  if(dirty()||state.conflict){toast('Save or discard your pending changes first.');return;}
  const item=state.config.item?.[name];if(!item)return;
  const enabled=item.enabled===false, previous=state.content, button=$('#toggle-search');
  state.saving=true;button.disabled=true;button.textContent='Saving…';
  try{
    state.content=edit(state.content,sectionPath('item',name,'enabled'),enabled);
    await writeDraft(state.content);
    state.saving=false;render();$('#toggle-search')?.focus();
    toast(`${enabled?'Resume':'Pause'} saved. The monitor applies it at its next safe point.`);
  }catch(error){if(!state.conflict)state.content=previous;toast(error.message);}
  finally{state.saving=false;button.disabled=false;button.textContent=state.config.item?.[name]?.enabled===false?'Resume search':'Pause search';}
}
function rowHtml(record) {
  const e = record.extra || {}; let body, trailing = '', type = '';
  if (e.kind === 'ai_eval') {
    const url = safeUrl(e.url); const thresholds = list(itemValue(state.config,e.item,'rating'));
    const low = thresholds.length > 1 && thresholds[0] !== thresholds[1] ? true : e.score < Number(thresholds[0] || 3);
    body = `<div><span class="title">${esc(e.title)}</span> · ${esc(filled(e.price)?e.price:'price not listed')}</div><div class="q"><b>${esc(e.conclusion)}</b> — “${esc(e.comment)}”</div><div class="out d">${esc(e.ai_name||'AI')}${url?` · <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">open listing ↗</a>`:''}</div>`;
    trailing = `<span class="score ${low?'lo':''}" aria-label="Rated ${esc(e.score)} out of 5 against your description">${esc(e.score)}/5</span>`;
  } else if (e.kind === 'search_started') {body = 'Search started'; type='search';}
  else if (e.kind === 'search_summary') {body = `Search ${e.cancelled ? 'cancelled' : 'finished'} — <b>${esc(e.new_count)} new ${e.new_count===1?'listing':'listings'}</b>`; type='search';}
  else if (e.kind === 'listing_skip') {body = `Skipped <b>${esc(e.title)}</b> — ${e.reason==='below_threshold'?`rated ${esc(e.score)}, below ${esc(e.threshold)}`:'already notified'}`; type='skip';}
  else if (e.kind === 'credentials_wait') {body = e.status==='found'?'Facebook credentials found — launching browser':'Waiting for Facebook credentials'; type='login';}
  else if (e.kind === 'browser_ready') {body = `Launched ${esc(e.engine)} browser`; type='browser';}
  else {body = `<span class="message">${esc(record.message)}</span>`;}
  const failure = String(record.message).match(/Max retries reached\. Failed to push note to (.+)\.$/);
  if (failure && own(state.config.user,failure[1])) body += ` <a href="#/settings/notifications?edit=${encodeURIComponent(failure[1])}">Check user settings</a>`;
  const itemTag = routeParts().parts[1]==='all' && e.item ? `<span class="tag">${esc(e.item)}</span> ` : '';
  const details = record.levelno>=40 ? `<details class="dx" data-event-details="${record.id}"><summary>Details</summary><pre class="raw">${esc(record.message)}\n${esc(record.location)}${record.exc_text?'\n'+esc(record.exc_text):''}</pre></details>`:'';
  return `<article class="ev ${record.levelno>=40?'err-row':''}" data-record="${record.id}"><time datetime="${new Date(record.time*1000).toISOString()}">${time(record.time)}</time><div>${itemTag}${body}</div>${trailing || `<span class="tag">${esc(type || record.level.toLowerCase())}</span>`}${details}</article>`;
}
function pauseFeed() {
  if (!state.following) return;
  state.following = false; state.frozen = [...state.records]; state.pending = 0; updatePauseBar();
}
function updatePauseBar() {
  const bar = $('#pause-bar'); if (!bar) return;
  bar.hidden = state.following;
  if (!state.following) {bar.innerHTML = `Paused while you read · ${state.pending} new events <button class="btn sm" id="follow-live">↑ Show and follow live</button>`; $('#follow-live').onclick = () => {state.following=true; state.pending=0; state.expanded.clear(); $('#pane').scrollTop=0; window.scrollTo({top:0}); renderFeed(true);};}
  $('#follow-state').textContent = state.following?'following live':'paused while you read';
  $('#follow-state').className = 'm xs '+(state.following?'ok':'warn');
}
function renderFeed(reset = false) {
  const feed = $('#feed'); if (!feed) return;
  const matching = (state.following?state.records:state.frozen).filter(record=>matchRecord(record,filters()));
  if (!matching.length) {
    const active = Object.entries(filters()).filter(([key,value])=>value&&(key!=='item'||routeParts().parts[1]!=='item')).map(([key,value])=>`${key}: ${value}`).join(', ');
    feed.innerHTML = `<div class="empty"><h2 class="sm">${active?'No events match these filters':'Waiting for first activity'}</h2><p class="d sm">${active?esc(active):'Events appear as the monitor works.'}</p>${active?'<button class="btn" id="clear-filters">Clear filters</button>':'<button class="btn" id="empty-search-all">Search all now</button>'}</div>`;
    $('#clear-filters')?.addEventListener('click',()=>{state.route='#'+routeParts().path; history.replaceState(null,'',state.route);renderActivity(routeParts().parts[1]==='item'?decodeURIComponent(routeParts().parts[2]):null);});
    $('#empty-search-all')?.addEventListener('click',()=>$('#search-all').click());
  } else {
    if (reset || !feed.querySelector('[data-record]')) feed.innerHTML = matching.toReversed().map(rowHtml).join('');
    else {
      const ids = new Set(matching.map(record=>String(record.id)));
      for (const row of feed.querySelectorAll('[data-record]')) if (!ids.has(row.dataset.record)) row.remove();
      const present = new Set([...feed.querySelectorAll('[data-record]')].map(row=>Number(row.dataset.record)));
      const added = matching.filter(record=>!present.has(record.id)).toReversed();
      const newest = Math.max(0,...present);
      if(added.some(record=>record.id<newest))feed.innerHTML=matching.toReversed().map(rowHtml).join('');
      else if (added.length) feed.insertAdjacentHTML('afterbegin',added.map(rowHtml).join(''));
    }
    for (const details of feed.querySelectorAll('[data-event-details]')) {
      details.open = state.expanded.has(Number(details.dataset.eventDetails));
      details.ontoggle = () => {const id=Number(details.dataset.eventDetails); if (details.open) {state.expanded.add(id);pauseFeed();} else state.expanded.delete(id);};
    }
  }
  updatePauseBar();
}
function acceptRecords(records, reset = false) {
  if (reset) state.lastSearches.clear();
  const seen = new Set(state.records.map(record=>record.id));
  const newCount = records.filter(record=>!seen.has(record.id)).length;
  state.records = mergeRecords(reset?[]:state.records,records,state.capacity);
  for (const record of records.toSorted((a,b)=>a.id-b.id)) {
    if (record.extra?.kind==='search_summary' && record.id>(state.lastSearches.get(record.extra.item)?.id ?? 0)) state.lastSearches.set(record.extra.item,record);
    if(record.id>state.incidentId){
      if(record.levelno>=40 && /Error parsing:|No browser could be launched|browser.*(?:crashed|closed unexpectedly)/i.test(record.message)){state.incidentId=record.id;state.monitorIssue=/Error parsing:/.test(record.message)?'The monitor could not load config.toml. Repair and save the configuration.':'The monitor browser stopped. View the error and restart the monitor process.';}
      if(record.extra?.kind==='browser_ready'){state.incidentId=record.id;state.monitorIssue=null;}
    }
    if (record.extra?.kind==='credentials_wait'&&record.id>state.credentialsId){state.credentialsId=record.id;state.credentials=record.extra.status;}
    if (record.id>state.loginId && record.location?.startsWith('facebook:') && /^\s*Waiting \S+/.test(record.message)){state.loginId=record.id;state.loginUntil=Date.now()+60000;}
  }
  if (!state.following) state.pending += newCount;
  clearTimeout(state.feedTimer); state.feedTimer=setTimeout(()=>{if (state.following) renderFeed(reset); else updatePauseBar(); renderSidebar();},200);
  if(newCount&&state.following)state.announceCount+=newCount;
  if (newCount && state.following && !state.announceTimer) state.announceTimer=setTimeout(()=>{if(state.following)$('#feed-announcement').textContent=`${state.announceCount} new events`;state.announceCount=0;state.announceTimer=null;},2000);
}
async function snapshot() {
  const data = await json('/api/logs?limit=1000000000');
  const reset = state.streamId != null && state.streamId !== data.stream_id;
  state.streamId=data.stream_id;const previousCapacity=state.capacity;state.capacity=data.capacity || 2000;
  if(previousCapacity!==state.capacity&&$('#feed'))renderActivity(routeParts().parts[1]==='item'?decodeName(routeParts().parts[2]):null);
  if (reset) {state.searchRequestedAfter=null;state.progress={};state.cancelNotice=null;state.credentials=null;state.credentialsId=0;state.monitorIssue=null;state.incidentId=0;state.loginId=0;state.loginUntil=0;state.following=true;state.pending=0;state.expanded.clear();}
  acceptRecords(data.records,reset); return data;
}
function announceSearch(record) {
  const e = record.extra || {};
  if (e.kind === 'search_started') $('#search-announcement').textContent = `Searching ${e.item}`;
  else if (e.kind === 'search_summary') {
    const found = `${e.new_count} new ${e.new_count === 1 ? 'listing' : 'listings'}`;
    if (e.cancelled) state.cancelNotice = {item:e.item, found:e.new_count, checked:e.checked};
    $('#search-announcement').textContent = e.cancelled ? `Cancelled ${e.item}, ${found} saved` : `${e.item} finished, ${found}`;
    state.progress = {};
  }
}
async function pollSearchProgress() {
  if (!state.connected || state.pollingProgress) return;
  if (!searchActivity(state.records, []).running && state.searchRequestedAfter == null) {if (state.progress.item) {state.progress = {}; renderSidebar();} return;}
  state.pollingProgress = true;
  try {state.progress = await json('/api/monitor/progress'); renderSidebar();}
  catch {state.progress = {};}
  finally {state.pollingProgress = false;}
}
function connectStream() {
  clearTimeout(connectStream.timer);
  if (state.ws) {state.ws.onclose=null;state.ws.close();}
  const socket = new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws/stream`); state.ws=socket;
  socket.onmessage = async event => {
    let data; try {data=JSON.parse(event.data);} catch {return;}
    if (data.type==='hello') {
      if(state.streamId && state.streamId!==data.stream_id){state.searchRequestedAfter=null;state.progress={};state.cancelNotice=null;state.records=[];state.lastSearches.clear();state.credentials=null;state.credentialsId=0;state.monitorIssue=null;state.incidentId=0;state.loginId=0;state.loginUntil=0;state.following=true;state.pending=0;state.expanded.clear();renderFeed(true);renderSidebar();}state.streamId=data.stream_id;
      state.connected=true;state.disconnectedAt=null; updateStatus();
      try {await snapshot();} catch(error) {toast(error.message);} return;
    }
    if (data.type==='log') {
      const last = state.records.at(-1)?.id;
      acceptRecords([data.record]);
      announceSearch(data.record);
      matchesView.onRecord(data.record);
      if (last != null && data.record.id > last+1 && !snapshot.busy) {snapshot.busy=true;try{await snapshot();}finally{snapshot.busy=false;}}
    }
  };
  socket.onclose = async event => {
    state.connected=false;state.disconnectedAt ||= Date.now();updateStatus();
    if (event.code===4401) {await showLogin(true);return;}
    connectStream.timer=setTimeout(connectStream,2000);
  };
  socket.onerror = () => socket.close();
}
async function exportCsv({url:exportUrl='/api/found.csv',emptyMessage='Nothing to export yet. The cache has no notified listings.',filename='notified-listings.csv'} = {}) {
  const button = $('#export-csv'); button.disabled=true;
  try {
    const response = await api(exportUrl);
    if (!response.ok) throw new Error('Export failed. Try again.');
    const blob = await response.blob(); const content = await blob.text();
    if (content.trim().split(/\r?\n/).length<2) {toast(emptyMessage);return;}
    const url=URL.createObjectURL(blob), anchor=document.createElement('a'); anchor.href=url;
    anchor.download=response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] || filename;
    anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  } catch(error) {toast(error.message);} finally {button.disabled=false;}
}

const itemGroups = [
  ['What to look for',['enabled','search_phrases','description']],
  ['Price and location',['min_price','max_price','location']],
  ['AI rating',['ai','rating']],
  ['Schedule and notifications',['search_interval','max_search_interval','start_at','notify']],
];
function fieldDefault(form, key) {
  const without = structuredClone(state.local);
  if (without[form.prefix]?.[form.name]) delete without[form.prefix][form.name][key];
  if (form.prefix === 'monitor') delete without.monitor?.[key];
  const config = mergeConfig(state.context.inherited,without);
  config.notification_values = state.context.notification_values || {};
  if (form.prefix==='item') return itemValue(config,form.name,key);
  if (form.prefix==='marketplace') return itemValue({...config,item:{__defaults:{marketplace:form.name}}},'__defaults',key);
  if (form.prefix==='monitor') return config.monitor?.[key];
  if (form.prefix==='notification') return config.notification_values?.[form.name]?.[key] ?? config.notification?.[form.name]?.[key] ?? (key==='enabled'?true:undefined);
  if (form.prefix==='user') return resolvedUser(config,form.name)?.[key] ?? ({enabled:true,message_format:'plain_text',max_retries:5,retry_delay:60,rate_limit_enabled:true,instance_rate_limit:1,global_rate_limit:30}[key]);
  return config[form.prefix]?.[form.name]?.[key] ?? (key==='enabled'?true:undefined);
}
function formValue(key) {
  const form=state.form;
  if (own(form.changes,key)) return form.changes[key]===null ? fieldDefault(form,key) : form.changes[key];
  return own(form.fields,key) ? form.fields[key] : fieldDefault(form,key);
}
function setChange(key,value) {
  state.form.changes[key]=value; state.saved=''; state.error=''; updateSaveBar();
}
function schemaFor(prefix) {
  return FORM_SCHEMAS[prefix==='marketplace'?'marketplace.facebook':prefix==='monitor'?'monitor':prefix+'.*'] || [];
}
function optionHtml(options,value) {
  return options.map(option=>`<option value="${esc(option.value)}" ${String(option.value)===String(value)?'selected':''}>${esc(option.label)}</option>`).join('');
}
function chipHtml(key,values) {
  return `<div class="chips" data-chips="${key}">${list(values).map((value,index)=>`<span class="chip">${esc(value)}<button type="button" data-chip-remove="${index}" aria-label="Remove ${esc(value)}">×</button></span>`).join('')}<input id="field-${key}" aria-label="Add ${esc(key.replaceAll('_',' '))}" placeholder="Add a value, press Enter"></div>`;
}
function ratingHtml(value) {
  const ratings=list(value); const initial=ratings[0]||3, later=ratings.at(-1)||3;
  const segmented=(id,rating)=>`<div class="seg" role="group" aria-label="${id==='rating'?'Notification minimum':'First search minimum'}" data-rating="${id}">${[1,2,3,4,5].map(n=>`<button type="button" data-score="${n}" aria-pressed="${n===Number(rating)}">${n}</button>`).join('')}</div>`;
  return `${segmented('rating',later)} <span class="hint">4 = Good match · 5 = Great deal</span><label class="opt sm" style="margin-top:10px"><input type="checkbox" id="different-rating" ${ratings.length>1?'checked':''}>Use a different minimum for the first search</label><div id="first-rating-wrap" ${ratings.length>1?'':'hidden'}>${segmented('first-rating',initial)}</div>`;
}
function fieldHtml(field) {
  const form=state.form,key=field.key,value=formValue(key),id='field-'+key;
  let widget=''; let type=field.type;
  if (['ai','notify','marketplace'].includes(key) && ['item','marketplace'].includes(form.prefix)) type='references';
  if (['keywords','antikeywords'].includes(key)) type='textarea';
  if (key==='rating') widget=ratingHtml(value);
  else if (type==='references') {
    const choices=Object.keys(state.config[key==='notify'?'user':key==='ai'?'ai':'marketplace']||{});
    if (key==='marketplace') widget=`<span class="sel"><select id="${id}" data-value="${key}">${choices.map(name=>`<option ${name===value?'selected':''} value="${esc(name)}">${esc(name)}</option>`).join('')}</select></span>`;
    else widget=`<div class="choices" data-references="${key}">${choices.map(name=>`<label class="opt sm"><input type="checkbox" value="${esc(name)}" ${list(value).includes(name)?'checked':''}><span class="m">${esc(name)}</span>${key==='notify'&&!userChannels(state.config,name,state.context.environment).length?'<span class="warn">No channel set up</span>':''}</label>`).join('') || '<span class="hint">None configured. Add one in Settings.</span>'}</div>`;
  } else if (type==='password') {
    const secret=filled(value);
    const environment=typeof value==='string'&&/^\$\{\w+\}$/.test(value);
    const description=environment?`From environment variable ${value.slice(2,-1)}${state.context.environment[value.slice(2,-1)]===false?' (not set)':''}`:secret?'Saved (hidden)':'No value set';
    widget=`<div class="secret" data-secret="${key}"><span class="gr sm">${esc(description)}</span><button class="btn q sm" type="button" data-replace="${key}">Replace</button></div><div class="row wr" data-secret-input="${key}" hidden><input id="${id}" class="in" type="password" autocomplete="new-password" placeholder="Paste a new value or an environment reference" style="flex:1"><button class="btn q sm" type="button" data-secret-keep="${key}">Keep current</button></div>`;
  } else if (type==='boolean') widget=`<span class="sel"><select id="${id}" data-value="${key}">${optionHtml([{value:'true',label:key==='enabled'?'Enabled':'Yes'},{value:'false',label:key==='enabled'?'Disabled':'No'}],value===false?'false':'true')}</select></span>`;
  else if (type==='list') widget=chipHtml(key,value);
  else if (type==='firstlater') {
    const values=list(value); const later=values.at(-1)??field.options[0]?.value;
    widget=`<div class="first-later" data-firstlater="${key}"><span class="sel"><select id="${id}" data-later>${optionHtml(field.options,later)}</select></span><label class="opt sm"><input type="checkbox" data-different ${values.length>1?'checked':''}>Different for first search</label><span class="sel" data-first-wrap ${values.length>1?'':'hidden'}><select data-first aria-label="${esc(field.label)} for the first search">${optionHtml(field.options,values[0]??later)}</select></span></div>`;
  } else if (type==='checkboxes') widget=`<div class="choices" data-references="${key}">${field.options.map(option=>`<label class="opt sm"><input type="checkbox" value="${esc(option.value)}" ${list(value).map(String).includes(String(option.value))?'checked':''}>${esc(option.label)}</label>`).join('')}</div>`;
  else if (type==='select') {
    let options=field.options;
    if (filled(value) && !options.some(option=>String(option.value)===String(value))) options=[{value,label:String(value)},...options];
    widget=`<span class="sel"><select id="${id}" data-value="${key}">${optionHtml(options,value)}</select></span>`;
  } else if (type==='textarea') widget=`<textarea class="ta" id="${id}" data-value="${key}" rows="${key==='description'?3:2}">${esc(Array.isArray(value)?value.join('\n'):value)}</textarea>`;
  else widget=`<input class="in ${type==='number'?'':'mono'}" id="${id}" data-value="${key}" type="${type==='number'?'number':'text'}" ${type==='number'?'step="any"':''} value="${esc(labelValue(value===undefined?'':value))}">`;
  const inheritable= ['item','marketplace'].includes(form.prefix) && !['search_phrases','description','enabled','username','password','login_wait_time','language'].includes(key);
  const mode=own(form.changes,key)?form.changes[key]!==null:own(form.fields,key);
  const defaultValue=fieldDefault(form,key);
  const source=state.context.inherited[form.prefix]?.[form.name]?.[key];
  const sourceNote=filled(source)?`<p class="hint">Earlier file: ${esc(labelValue(source))}${Array.isArray(source)?'. Lists are combined across files; edit the source file to remove earlier entries.':''}</p>`:'';
  const modeHtml=inheritable?`<span class="sel field-mode"><select data-mode="${key}" aria-label="${esc(field.label)} source"><option value="default" ${!mode?'selected':''}>Use default — ${esc(labelValue(defaultValue))}</option><option value="custom" ${mode?'selected':''}>Custom</option></select></span>`:'';
  return `<label class="l" for="${id}">${esc(field.label)}</label><div class="field" data-field="${key}">${modeHtml}<div class="field-value">${widget}</div>${sourceNote}${field.help?`<p class="hint">${esc(field.help)}</p>`:''}<p class="ferr" id="error-${key}" hidden></p></div>`;
}
function locationHtml() {
  const form=state.form;
  const region=form.fields.search_region, cities=form.fields.search_city;
  const mode=filled(region)?'region':filled(cities)?'cities':'default';
  const effectiveCities=list(fieldDefault(form,'search_city'));
  const effectiveRegions=list(fieldDefault(form,'search_region'));
  const selectedCities=list(cities).length?list(cities):list(itemValue(state.config,form.name,'search_city'));
  const radius=list(form.fields.radius), currency=list(form.fields.currency);
  const rows=selectedCities.map((city,index)=>cityRow(city,radius[index]??(radius.length===1?radius[0]:''),currency[index]??(currency.length===1?currency[0]:''))).join('');
  const options=Object.keys(state.config.region||{});
  return `<span class="l">Where</span><div class="field" data-field="location"><div class="choices" role="group" aria-label="Search location">${[['default','Use default — '+labelValue(effectiveRegions.length?effectiveRegions:effectiveCities)],['cities','Cities — each with its own radius and currency'],['region','Region — one or more built-in or custom regions']].map(([value,label])=>`<label class="opt sm"><input type="radio" name="where" value="${value}" ${mode===value?'checked':''}>${esc(label)}</label>`).join('')}</div><div id="city-editor" ${mode==='cities'?'':'hidden'}><div class="city-labels"><span>City</span><span>Radius (km)</span><span>Currency</span><span></span></div><div id="city-rows">${rows||cityRow('','','')}</div><button class="btn sm" id="add-city" type="button">+ Add city</button><p class="hint">Use the city name or numeric ID from its Facebook Marketplace URL. Leave all radiuses or currencies blank to use the default.</p></div><div id="region-editor" class="choices" ${mode==='region'?'':'hidden'}>${options.map(name=>`<label class="opt sm"><input type="checkbox" value="${esc(name)}" ${list(region).includes(name)?'checked':''}><span class="m">${esc(name)}</span></label>`).join('')}</div><p id="error-location" class="ferr" hidden></p></div>`;
}
function cityRow(city,radius,currency) {
  return `<div class="city-row"><input class="in mono" aria-label="City" data-city value="${esc(city)}"><input class="in mono" type="number" min="1" aria-label="Radius in kilometres" data-radius value="${esc(radius)}"><input class="in mono" aria-label="Currency code" data-currency value="${esc(currency)}" placeholder="USD"><button class="btn q sm" data-remove-city type="button" aria-label="Remove city">×</button></div>`;
}
function fieldsHtml(keys) {
  const schema=schemaFor(state.form.prefix);
  return '<div class="f">'+keys.map(key=>key==='location'?locationHtml():fieldHtml(schema.find(field=>field.key===key))).join('')+'</div>';
}
function saveBarHtml() {
  return '<div class="save"><span class="message" id="save-message" role="status"></span><span class="row"><button class="btn" id="form-cancel" type="button">Cancel</button><button class="btn p" id="form-save" type="submit" form="section-form">Save</button></span></div>';
}
function prepareForm(prefix,name,isNew = false,preset = {}) {
  const local=prefix==='monitor'?state.local.monitor||{}:state.local[prefix]?.[name]||{};
  state.form={prefix,name,new:isNew,fields:structuredClone(isNew?preset:local),changes:{},newName:name,returnRoute:isNew&&prefix==='item'?(state.newReturn||'#/monitor'):null};
  state.saved='';
}
function formHtml() {
  const form=state.form;
  const nameHtml=form.prefix==='monitor'?'':`<div class="f"><label class="l" for="section-name">Name</label><div class="field"><input class="in mono" id="section-name" value="${esc(form.newName)}" style="max-width:320px"><p class="hint" id="section-hint">Saved as [${esc(form.prefix)}.${esc(form.newName)}]. Letters, numbers and underscores for new names.</p><p class="ferr" id="error-name" hidden></p></div></div>`;
  let content='';
  if (form.prefix==='item') {
    const included=itemGroups.flatMap(group=>group[1]).filter(key=>key!=='location');
    content=itemGroups.map(([title,keys],index)=>`<section class="sect"><h2>${title}</h2>${index===0?nameHtml:''}${fieldsHtml(keys)}${title==='AI rating'?'<p class="hint">Fit with your description. With no working AI, every listing that passes your filters meets the rating threshold.</p>':''}</section>`).join('');
    const advanced=schemaFor('item').filter(field=>!included.includes(field.key)&&!['search_city','search_region','radius','currency'].includes(field.key));
    const count=advanced.filter(field=>own(form.fields,field.key)).length;
    content+=`<details><summary class="sm">Advanced options · ${count} customized</summary><div class="group-fields">${fieldsHtml(advanced.map(field=>field.key))}</div></details>`;
  } else if (form.prefix==='marketplace') {
    const account=['enabled','username','password','login_wait_time','language'];
    const primary=['search_city','search_region','radius','currency','search_interval','max_search_interval','ai','rating','notify'];
    content=`<section class="sect"><h2>Facebook account</h2>${nameHtml}${fieldsHtml(account)}<p class="hint">These credentials also protect remote dashboard access. Dashboard sign-in uses the credentials present when the process started; restart it after changing them.</p></section><section class="sect"><h2>Where to search and search defaults</h2>${fieldsHtml(primary)}<p class="hint">Regions replace cities. These defaults apply unless a saved search supplies its own value.</p></section><details><summary class="sm">More defaults</summary><div class="group-fields">${fieldsHtml(schemaFor('marketplace').filter(field=>![...account,...primary].includes(field.key)).map(field=>field.key))}</div></details>`;
  } else if (form.prefix==='ai') {
    content=`<section class="sect"><h2>Provider</h2>${nameHtml}<div class="f"><label class="l" for="provider-choice">Provider</label><span class="sel"><select id="provider-choice">${['openai','anthropic','deepseek','gemini','ollama'].map(provider=>`<option value="${provider}" ${(form.fields.provider||form.name).toLowerCase()===provider?'selected':''}>${provider==='openai'?'OpenAI':provider[0].toUpperCase()+provider.slice(1)}</option>`).join('')}</select></span></div>${fieldsHtml(['model','api_key','enabled'])}<p class="hint">For a new provider, leaving the key blank uses its environment variable (for example OPENAI_API_KEY). Use Replace to paste a value or reference. Saving does not test the key.</p></section><details><summary class="sm">Connection</summary><div class="group-fields">${fieldsHtml(['base_url','timeout','max_retries'])}</div></details>`;
  } else if (['user','notification'].includes(form.prefix)) {
    const effective=form.new?form.fields:form.prefix==='user'?resolvedUser(state.config,form.name):state.config.notification?.[form.name]||{};
    const selected=Object.keys(CHANNELS).filter(channel=>CHANNELS[channel].some(key=>filled(effective[key])));
    const active= form.prefix==='notification'?(selected[0]||'Email'):null;
    content=`${nameHtml}<div class="f"><span class="l">Channels</span><div class="row wr" id="channel-choices">${Object.keys(CHANNELS).map(channel=>form.prefix==='notification'?`<label class="opt sm"><input type="radio" name="shared-channel" data-channel="${channel}" ${channel===active?'checked':''}>${channel}</label>`:`<label class="opt sm"><input type="checkbox" data-channel="${channel}" ${selected.includes(channel)?'checked':''}>${channel}</label>`).join('')}</div></div>`;
    const channelFields={Telegram:['telegram_token','telegram_chat_id'],Email:['email','smtp_server','smtp_port','smtp_username','smtp_password','smtp_from'],Pushbullet:['pushbullet_token'],Pushover:['pushover_user_key','pushover_api_token'],ntfy:['ntfy_server','ntfy_topic']};
    content+=Object.entries(channelFields).map(([channel,keys])=>`<section class="sect" data-channel-fields="${channel}" ${(form.prefix==='notification'?channel!==active:!selected.includes(channel))?'hidden':''}><h2>${channel}</h2>${fieldsHtml(keys)}</section>`).join('');
    if(form.prefix==='user')content+=`<section class="sect"><h2>Schedule and shared settings</h2>${fieldsHtml(['remind','notify_with'])}<p class="hint">Leaving notify_with absent applies every enabled shared channel setting. An explicitly empty list applies none. Shared values overwrite the same user fields; for SMTP on this user only, exclude the shared email section.</p><button class="btn sm" id="user-smtp" type="button">Use SMTP on this user only</button></section>`;
    const more=schemaFor(form.prefix).filter(field=>field.advanced&& !['smtp_server','smtp_port','smtp_username','smtp_password','smtp_from','notify_with','remind','enabled'].includes(field.key));
    content+=`<details><summary class="sm">More options</summary><div class="group-fields">${fieldsHtml(more.map(field=>field.key))}</div></details>`;
    // Status remains accessible even before expanding the optional settings.
    content+=fieldsHtml(['enabled']);
  } else content=nameHtml+fieldsHtml(schemaFor(form.prefix).map(field=>field.key));
  return `<form id="section-form" class="form-content" autocomplete="off"><div class="body">${content}</div></form>${saveBarHtml()}`;
}
function mountForm(prefix,name,isNew = false,preset = {},standalone = true) {
  prepareForm(prefix,name,isNew,preset);
  const title=prefix==='item'?(isNew?'New search':'Edit · '+name):prefix==='monitor'?'Image matching and proxy':'Edit · '+name;
  const actions=!isNew&&prefix!=='monitor'?`<a class="btn q" href="#/settings/config?section=${encodeURIComponent(prefix+'.'+name)}">View in config.toml</a><button class="btn x" id="delete-section">Delete</button>`:'';
  if(standalone)$('#pane').innerHTML=pageHeader(title,'',actions)+formHtml();
  else $('#settings-form-host').innerHTML=(actions?`<div class="bar">${actions}</div>`:'')+formHtml();
  bindForm();
  $('#delete-section')?.addEventListener('click',()=>deleteSection(prefix,name));
  renderSidebar(); updateSaveBar();
}
function bindForm() {
  if(state.form.prefix==='user')for(const input of document.querySelectorAll('[data-channel]'))if(CHANNELS[input.dataset.channel].some(key=>filled(state.context.inherited.user?.[state.form.name]?.[key]))){input.disabled=true;input.closest('label').title='This channel is defined in an earlier config file. Change that source file to remove it.';}
  $('#section-name')?.addEventListener('input',event=>{state.form.newName=event.target.value;state.form.changes.__name=event.target.value;$('#section-hint').textContent=`Saved as [${state.form.prefix}.${event.target.value}].`;updateSaveBar();});
  for(const mode of document.querySelectorAll('[data-mode]')) {
    const wrapper=mode.closest('.field').querySelector('.field-value');
    const disable=()=>wrapper.querySelectorAll('input,select,button,textarea').forEach(control=>control.disabled=mode.value==='default');
    disable();
    mode.onchange=()=>{disable();setChange(mode.dataset.mode,mode.value==='default'?null:formValue(mode.dataset.mode));};
  }
  for(const input of document.querySelectorAll('[data-value]')) input.addEventListener('input',()=>{
    const key=input.dataset.value,field=schemaFor(state.form.prefix).find(field=>field.key===key);
    let value=input.value;
    if(value==='')value=['prompt','extra_prompt','rating_prompt'].includes(key)?'':null;
    else if(field.type==='boolean')value=value==='true';
    else if(field.type==='number')value=Number(value);
    else if(field.type==='numberlist') {value=value.split(',').map(Number);if(value.length===1)value=value[0];}
    else if(['keywords','antikeywords'].includes(key)&&value.includes('\n'))value=value.split('\n').map(s=>s.trim()).filter(Boolean);
    else if(key==='search_region')value=list(value);
    setChange(key,value);
  });
  for(const widget of document.querySelectorAll('[data-chips]')) bindChips(widget);
  for(const choices of document.querySelectorAll('[data-references]')) choices.onchange=()=>setChange(choices.dataset.references,[...choices.querySelectorAll('input:checked')].map(input=>input.value));
  for(const button of document.querySelectorAll('[data-replace]')) button.onclick=()=>{
    const key=button.dataset.replace; document.querySelector(`[data-secret="${key}"]`).hidden=true;
    const wrapper=document.querySelector(`[data-secret-input="${key}"]`);wrapper.hidden=false;wrapper.querySelector('input').focus();
  };
  for(const button of document.querySelectorAll('[data-secret-keep]')) button.onclick=()=>{
    const key=button.dataset.secretKeep; document.querySelector(`[data-secret="${key}"]`).hidden=false;
    const wrapper=document.querySelector(`[data-secret-input="${key}"]`);wrapper.hidden=true;wrapper.querySelector('input').value='';delete state.form.changes[key];updateSaveBar();
  };
  for(const input of document.querySelectorAll('[data-secret-input] input'))input.oninput=()=>{const key=input.closest('[data-secret-input]').dataset.secretInput;if(input.value)setChange(key,input.value);else{delete state.form.changes[key];updateSaveBar();}};
  for(const group of document.querySelectorAll('[data-rating]'))group.onclick=event=>{
    const button=event.target.closest('[data-score]');if(!button)return;
    group.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',b===button)); saveRating();
  };
  $('#different-rating')?.addEventListener('change',event=>{$('#first-rating-wrap').hidden=!event.target.checked;saveRating();});
  for(const group of document.querySelectorAll('[data-firstlater]'))group.onchange=()=>{
    const different=group.querySelector('[data-different]').checked;group.querySelector('[data-first-wrap]').hidden=!different;
    let values=different?[group.querySelector('[data-first]').value,group.querySelector('[data-later]').value]:[group.querySelector('[data-later]').value];
    if(group.dataset.firstlater==='date_listed')values=values.map(Number);
    setChange(group.dataset.firstlater,values.length===1?values[0]:values);
  };
  document.querySelectorAll('[name="where"]').forEach(radio=>radio.onchange=()=>{ $('#city-editor').hidden=radio.value!=='cities';$('#region-editor').hidden=radio.value!=='region';updateLocation();});
  $('#add-city')?.addEventListener('click',()=>{$('#city-rows').insertAdjacentHTML('beforeend',cityRow('','',''));bindCityRows();updateLocation();});
  bindCityRows();$('#region-editor')?.addEventListener('change',updateLocation);
  $('#provider-choice')?.addEventListener('change',event=>setChange('provider',event.target.value));
  document.querySelectorAll('[data-channel]').forEach(input=>input.onchange=()=>{
    if(state.form.prefix==='notification')document.querySelectorAll('[data-channel-fields]').forEach(section=>section.hidden=section.dataset.channelFields!==input.dataset.channel);
    else document.querySelector(`[data-channel-fields="${input.dataset.channel}"]`).hidden=!input.checked;
    if(!input.checked || state.form.prefix==='notification') {
      const removeChannels=state.form.prefix==='notification'?Object.keys(CHANNELS).filter(channel=>channel!==input.dataset.channel):[input.dataset.channel];
      for(const channel of removeChannels)for(const field of document.querySelector(`[data-channel-fields="${channel}"]`).querySelectorAll('[data-field]'))setChange(field.dataset.field,null);
      if(state.form.prefix==='user')excludeSharedChannels(removeChannels);
    }
    if(input.checked && state.form.prefix==='user'){state.form.changes.__channels=true;updateSaveBar();}
  });
  $('#user-smtp')?.addEventListener('click',()=>{if(excludeSharedChannels(['Email'])===false)return;toast('Shared email settings excluded. Fill in the SMTP fields for this user.');});
  $('#section-form').onsubmit=event=>{event.preventDefault();saveForm();};
  $('#form-cancel').onclick=async()=>{if(dirty()&&!await confirmAction('Discard draft?','Unsaved changes will be lost.','Discard'))return;const prefix=state.form.prefix,name=state.form.name,returnRoute=state.form.returnRoute;state.content=state.base;state.form=null;state.error='';state.conflict=null;if(prefix==='item'){await navigate(returnRoute||itemRoute(name));}else{state.route='#'+routeParts().path;history.replaceState(null,'',state.route);refreshData();render();}};
}
function bindChips(widget) {
  const key=widget.dataset.chips;
  let values=list(formValue(key));
  const redraw=()=>{const disabled=widget.querySelector('input')?.disabled;widget.outerHTML=chipHtml(key,values);const fresh=document.querySelector(`[data-chips="${key}"]`);bindChips(fresh);fresh.querySelectorAll('input,button').forEach(control=>control.disabled=disabled);};
  widget.querySelectorAll('[data-chip-remove]').forEach(button=>button.onclick=()=>{values.splice(Number(button.dataset.chipRemove),1);setChange(key,values);redraw();});
  const input=widget.querySelector('input');
  const append=(focus=true)=>{const value=input.value.trim();if(value){input.value='';values.push(value);setChange(key,values);redraw();if(focus)document.querySelector(`[data-chips="${key}"] input`).focus();}};
  input.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();append();}};
  input.onblur=()=>{if(input.value.trim())append(false);};
}
function saveRating() {
  const get=id=>Number(document.querySelector(`[data-rating="${id}"] [aria-pressed="true"]`).dataset.score);
  setChange('rating',$('#different-rating').checked?[get('first-rating'),get('rating')]:get('rating'));
}
function bindCityRows() {
  for(const row of document.querySelectorAll('.city-row')) {
    row.querySelectorAll('input').forEach(input=>input.oninput=updateLocation);
    row.querySelector('[data-remove-city]').onclick=()=>{row.remove();updateLocation();};
  }
}
function updateLocation() {
  const mode=document.querySelector('[name="where"]:checked').value;
  for(const key of ['search_region','search_city','radius','currency'])state.form.changes[key]=null;
  if(mode==='region')state.form.changes.search_region=[...$('#region-editor').querySelectorAll('input:checked')].map(input=>input.value);
  if(mode==='cities') {
    const rows=[...document.querySelectorAll('.city-row')].filter(row=>row.querySelector('[data-city]').value.trim());
    state.form.changes.search_city=rows.map(row=>row.querySelector('[data-city]').value.trim());
    const radius=rows.map(row=>row.querySelector('[data-radius]').value),currency=rows.map(row=>row.querySelector('[data-currency]').value.trim());
    if(radius.some(Boolean))state.form.changes.radius=radius.map(value=>value===''?'':Number(value));
    if(currency.some(Boolean))state.form.changes.currency=currency;
    if(own(state.form.fields,'city_name'))state.form.changes.city_name=null;
  }
  updateSaveBar();
}
function excludeSharedChannels(channels) {
  if(filled(state.context.inherited.user?.[state.form.name]?.notify_with)){toast('Earlier notify_with entries remain active. Change the source file to exclude them.');return false;}
  const selected=list(formValue('notify_with') ?? Object.keys(state.config.notification||{}));
  const remaining=selected.filter(name=>!channels.some(channel=>CHANNELS[channel].some(key=>filled(state.config.notification?.[name]?.[key]))));
  setChange('notify_with',remaining);
  const widget=document.querySelector('[data-chips="notify_with"]'); if(widget){widget.outerHTML=chipHtml('notify_with',remaining);bindChips(document.querySelector('[data-chips="notify_with"]'));}
}

function updateSaveBar() {
  const message=$('#save-message');if(!message)return;
  message.textContent=state.saving?'Validating and writing config.toml…':state.error||state.saved||(dirty()?'Unsaved changes':'No unsaved changes');
  message.className='message '+(state.error?'err':state.saved?'ok':dirty()?'warn':'d');
  $('#form-save').disabled=state.saving || (!dirty() && !state.error) || (!state.form && state.rawInvalid);
  $('#form-save').textContent=state.saving?'Saving…':state.form?.prefix==='item'?'Save search':'Save';
  $('#form-cancel').disabled=state.saving;
  document.querySelectorAll('#section-form input,#section-form select,#section-form textarea,#section-form button').forEach(control=>{if(state.saving){if(!own(control.dataset,'wasDisabled'))control.dataset.wasDisabled=String(control.disabled);control.disabled=true;}else if(own(control.dataset,'wasDisabled')){control.disabled=control.dataset.wasDisabled==='true';delete control.dataset.wasDisabled;}});
}
function fieldError(key,message) {
  const error=$('#error-'+key);if(error){error.textContent=message;error.hidden=false;}
  const field=$('#field-'+key)||document.querySelector(`[data-field="${key}"] input:not(:disabled),[data-field="${key}"] select:not(:disabled)` )||$('#section-name');if(field){field.setAttribute('aria-invalid','true');field.setAttribute('aria-describedby','error-'+key);field.classList.add('bad');field.focus();}
  state.error=message;updateSaveBar();
}
function sectionPath(prefix,name,key = '') {return prefix+(prefix==='monitor'?'':'.'+JSON.stringify(name))+(key?'.'+key:'');}
function candidateFromForm() {
  const form=state.form;const name=form.newName.trim();
  if(form.prefix!=='monitor' && (!name || (name!==form.name && !/^[A-Za-z0-9_]+$/.test(name)) || (form.new && !/^[A-Za-z0-9_]+$/.test(name))))throw Object.assign(new Error('Use letters, numbers and underscores for the name.'),{field:'name'});
  if(form.prefix!=='monitor' && (form.new || name!==form.name) && own(state.config[form.prefix],name))throw Object.assign(new Error(`A ${form.prefix} named ${name} already exists.`),{field:'name'});
  if(!form.new && name!==form.name && own(state.context.inherited[form.prefix],form.name))throw Object.assign(new Error('This section is also defined in an earlier file. Rename it in that source file.'),{field:'name'});
  const changes={...(form.new?form.fields:{}),...form.changes};delete changes.__name;delete changes.__channels;
  // A scalar currency is the loader's way to apply one currency to every city.
  if(Array.isArray(changes.currency)&&changes.currency.length===1)changes.currency=changes.currency[0];
  if(form.prefix==='ai' && (form.new || name!==form.name)){changes.provider ||= $('#provider-choice').value;if(form.new&&!filled(changes.api_key)&&changes.provider!=='ollama')changes.api_key='${'+changes.provider.toUpperCase()+'_API_KEY}';}
  if(form.prefix==='item' && !filled(changes.search_phrases ?? form.fields.search_phrases ?? state.config.item?.[form.name]?.search_phrases))throw Object.assign(new Error('Add at least one search phrase.'),{field:'search_phrases'});
  if(own(changes,'notify')&&Array.isArray(changes.notify)&&!changes.notify.length)throw Object.assign(new Error('An empty notify list falls back to every user. Use default, choose a user, or disable this search.'),{field:'notify'});
  if(own(changes,'radius') && Array.isArray(changes.radius) && changes.radius.some(value=>value===''))throw Object.assign(new Error('Fill in a radius for every city, or leave all radiuses blank.'),{field:'location'});
  if(own(changes,'currency') && Array.isArray(changes.currency) && changes.currency.some(value=>!value))throw Object.assign(new Error('Fill in a currency for every city, or leave all currencies blank.'),{field:'location'});
  const price=key=>String(own(changes,key)?changes[key]??'':form.fields[key]??'').match(/^(\d+)$/)?.[1];
  if(price('min_price') && price('max_price') && Number(price('min_price'))>Number(price('max_price')))throw Object.assign(new Error('Maximum price must be at least the minimum price.'),{field:'max_price'});
  let content=state.content;let renames={};
  if(!form.new && name!==form.name) {
    content=renameSection(content,form.prefix,form.name,name);renames[form.prefix+'.'+form.name]=form.prefix+'.'+name;
    const reference={user:'notify',ai:'ai',marketplace:'marketplace',region:'search_region',notification:'notify_with'}[form.prefix];
    if(reference)for(const prefix of ['item','marketplace','user'])for(const [section,fields] of Object.entries(state.local[prefix]||{}))if(own(fields,reference)){
      const value=fields[reference],renamed=Array.isArray(value)?value.map(entry=>entry===form.name?name:entry):value===form.name?name:value;
      content=edit(content,sectionPath(prefix,section,reference),renamed);
    }
  }
  for(const [key,value] of Object.entries(changes)) {
    if(value===null && (form.new || !own(form.fields,key)))continue;
    content=edit(content,sectionPath(form.prefix,name,key),value);
  }
  // A new empty section still needs one meaningful assignment for toml_edit to create its table.
  if(form.new && !Object.keys(changes).length)content=edit(content,sectionPath(form.prefix,name,'enabled'),true);
  return {content,renames,name};
}
async function validateDraft(content,renames = {}) {
  const data=await json('/api/config/validate',{method:'POST',body:JSON.stringify({content,renames})});
  if(!data.valid)throw Object.assign(new Error(data.error||'Configuration is invalid.'),{validation:true});
}
async function writeDraft(content,renames = {},mtime = state.mtime) {
  await validateDraft(content,renames);
  const response=await api('/api/config/file/primary',{method:'PUT',body:JSON.stringify({content,base_mtime:mtime,renames})});
  const data=await response.json();
  if(response.status===409){state.conflict={content,renames};renderConflict();throw new Error('The file changed on disk. Your draft is kept.');}
  if(!response.ok || !data.ok)throw new Error(data.error||data.detail||'Could not save config.toml.');
  await loadConfig();state.conflict=null;state.monitorIssue=null;updateStatus();
  return data;
}
async function saveForm() {
  if(state.saving)return;
  document.querySelectorAll('.ferr').forEach(el=>el.hidden=true);
  document.querySelectorAll('#section-form [aria-invalid="true"]').forEach(el=>{el.removeAttribute('aria-invalid');el.removeAttribute('aria-describedby');el.classList.remove('bad');});
  let candidate;
  try{candidate=candidateFromForm();}catch(error){fieldError(error.field||'name',error.message);return;}
  state.saving=true;state.error='';updateSaveBar();
  try{
    await writeDraft(candidate.content,candidate.renames);
    const form=state.form;
    state.form=null;
    if(form.prefix==='item')state.route=itemRoute(candidate.name)+'/edit';
    else if(form.prefix==='monitor')state.route='#/settings/more';
    else state.route='#/settings/'+({user:'notifications',notification:'notifications',ai:'ai',marketplace:'marketplace',region:'more'}[form.prefix])+'?edit='+encodeURIComponent(candidate.name)+(form.prefix==='notification'||form.prefix==='region'?'&type='+form.prefix:'');
    history.replaceState(null,'',state.route);state.saving=false;render();
    state.saved='Saved '+time(Date.now()/1000)+' · the monitor reloads changes at its next safe point and may restart searches.';updateSaveBar();
  }catch(error){state.error=error.message;state.saving=false;document.querySelectorAll('#section-form input,#section-form select,#section-form textarea,#section-form button').forEach(control=>control.disabled=false);for(const mode of document.querySelectorAll('[data-mode]'))if(mode.value==='default')mode.closest('.field').querySelectorAll('.field-value input,.field-value select,.field-value button,.field-value textarea').forEach(control=>control.disabled=true);updateSaveBar();}
}
function renderConflict() {
  if(!state.conflict)return;
  let host=$('#conflict-banner');
  if(!host){host=document.createElement('div');host.id='conflict-banner';host.className='config-notice';$('#pane').insertBefore(host,$('#pane').children[1]||null);}
  host.innerHTML='<div class="nt warn"><span class="gr">config.toml changed on disk. Your draft is kept.</span><button class="btn sm" id="compare-config">Compare</button><button class="btn sm" id="reapply-config">Reload and re-apply</button><button class="btn sm" id="overwrite-config">Overwrite…</button></div>';
  $('#compare-config').onclick=async()=>{
    const latest=await json('/api/config/file/primary');
    let draft=state.content;try{draft=state.form?candidateFromForm().content:draft;}catch{}
    try{const parsed=parse(draft);const mask=(node,path=[])=>{for(const [key,value] of Object.entries(node)){if(value&&typeof value==='object'&&!Array.isArray(value))mask(value,[...path,JSON.stringify(key)]);else if(/password|token|api_key|secret|username|pushover_user_key/i.test(key)&&value)draft=edit(draft,[...path,JSON.stringify(key)].join('.'),'<REDACTED>');}};mask(parsed);}catch{draft='Finish repairing the draft before comparing it. Secret values are hidden.';}
    const compare=(text,other)=>{const lines=other.split('\n');return text.split('\n').map((line,index)=>`<span ${line===lines[index]?'':'class="changed"'}>${esc(line)}\n</span>`).join('');};
    await confirmAction('Compare draft and current file',`<div class="compare"><div><p class="b">Your draft</p><pre>${compare(draft,latest.content)}</pre></div><div><p class="b">Current file</p><pre>${compare(latest.content,draft)}</pre></div></div>`,'Done','Close',true);
  };
  $('#reapply-config').onclick=async()=>{
    if(state.saving)return;
    if(!state.form&&!await confirmAction('Load the current file?', 'This replaces your raw TOML draft. Compare it first to keep any changes you need.','Load file'))return;
    state.saving=true;updateSaveBar();
    try{
      await loadConfig();state.conflict=null;host.remove();state.error='';state.saving=false;
      if(!state.form){render();return;}
      const form=state.form;form.fields=structuredClone(form.prefix==='monitor'?state.local.monitor||{}:state.local[form.prefix]?.[form.name]||{});
      $('#section-form').outerHTML=formHtml().replace(saveBarHtml(),'');bindForm();updateSaveBar();toast('Current file loaded. Your field edits are kept; review and save again.');
    }catch(error){state.saving=false;state.error=error.message;updateSaveBar();}
  };
  $('#overwrite-config').onclick=async()=>{
    if(state.saving)return;
    if(!await confirmAction('Overwrite the current file?', 'Changes made on disk since you opened this draft will be replaced.','Overwrite','Keep draft'))return;
    state.saving=true;updateSaveBar();state.editor?.setOption?.('readOnly',true);
    try{const candidate=state.form?candidateFromForm():{content:state.content,renames:{}};const latest=await json('/api/config/file/primary');await writeDraft(candidate.content,candidate.renames,latest.mtime);state.form=null;state.error='';render();toast('Saved. The monitor may restart searches.');}
    catch(error){state.error=error.message;if(!state.form)state.rawInvalid=Boolean(error.validation);}
    finally{state.saving=false;state.editor?.setOption?.('readOnly',false);updateSaveBar();}
  };
}
async function deleteSection(prefix,name) {
  if(state.saving)return;
  if(own(state.context.inherited[prefix],name)){toast('This section is defined in an earlier file. Disable it here, or remove it from that source file.');return;}
  if(['item','user','marketplace'].includes(prefix)&&Object.keys(state.config[prefix]||{}).length<=1){await confirmAction('Keep at least one '+({item:'search',user:'user',marketplace:'marketplace'}[prefix]),'Add another section first, or disable this one.','OK','Close');return;}
  if(!await confirmAction(`Delete ${name}?`,`Removes [${prefix}.${name}] from config.toml. Recorded activity stays.`,'Delete','Cancel'))return;
  state.saving=true;updateSaveBar();
  try{await writeDraft(edit(state.content,sectionPath(prefix,name),null));state.form=null;state.error='';state.route=prefix==='item'?'#/monitor/all':'#/settings/'+({user:'notifications',ai:'ai',notification:'notifications',region:'more',marketplace:'marketplace'}[prefix]);history.replaceState(null,'',state.route);render();}
  catch(error){toast(error.message);}
  finally{state.saving=false;updateSaveBar();}
}
function renderSettings() {
  const {parts,query}=routeParts();const section=parts[1]||'marketplace';
  if(section==='config'){renderConfig();return;}
  if(section==='marketplace'){
    const names=Object.keys(state.config.marketplace||{});const name=query.get('edit')||names[0]||'facebook';
    const isNew=query.has('new');
    $('#pane').innerHTML=pageHeader('Marketplace',`${Object.values(state.config.item||{}).filter(item=>!filled(item.search_city)&&!filled(item.search_region)).length} searches use the default location. Facebook accounts and defaults for saved searches`,`<a class="btn" href="#/settings/marketplace?new=1&edit=facebook_copy">+ Add marketplace</a>`)+`<div class="bar">${names.map(n=>`<a class="btn sm" href="#/settings/marketplace?edit=${encodeURIComponent(n)}">${esc(n)}</a>`).join('')}</div><div id="settings-form-host"></div>`;
    mountForm('marketplace',name,isNew,{},false);return;
  }
  if(section==='more'){
    if(query.get('type')==='region' || query.has('new')){mountForm('region',query.get('edit')||'my_region',query.has('new'));return;}
    $('#pane').innerHTML=pageHeader('Image matching and more','Automatic photo checks, network and locale options')+'<div id="settings-form-host"></div>';
    mountForm('monitor','',false,{},false);
    const extra=document.createElement('div');extra.className='body';
    extra.innerHTML=`<section class="sect"><h2>Regions</h2><p class="mu sm">Built in: ${BUILT_IN_REGIONS.join(' · ')}. Each expands to cities with radius and currency.</p><div>${Object.keys(state.config.region||{}).filter(name=>!BUILT_IN_REGIONS.includes(name)||own(state.local.region,name)).map(name=>`<a class="btn sm" href="#/settings/more?type=region&edit=${encodeURIComponent(name)}">${esc(name)}</a>`).join(' ')}</div><a class="btn sm" href="#/settings/more?new=1&type=region&edit=my_region">+ Add custom region</a></section><section class="sect"><h2>Languages</h2><p class="mu sm">A locale and dictionary are needed for non-English Facebook. ${Object.keys(state.config.translation||{}).length} language definitions loaded.</p><a class="btn sm" href="#/settings/config">Edit languages in config.toml</a></section>`;
    $('#settings-form-host').insertBefore(extra,$('#settings-form-host').lastChild);return;
  }
  const prefix=section==='ai'?'ai':query.get('type')==='notification'?'notification':'user';
  const titles={ai:'AI providers',notifications:'Notifications'};
  $('#pane').innerHTML=pageHeader(titles[section]||'Settings',section==='ai'?'Rate listings against each search’s description. Saving does not test a key.':'“Configured” means required fields are filled, not that delivery was tested.',`<a class="btn" href="#/settings/${section}?new=1&edit=${section==='ai'?'openai':'new_user'}">+ Add ${section==='ai'?'provider':'user'}</a>`)+`<div class="body"><div class="settings-list">${Object.entries(state.config[section==='ai'?'ai':'user']||{}).map(([name,config])=>{
    const channels=section==='ai'?null:userChannels(state.config,name,state.context.environment);
    const summary=section==='ai'?`${config.provider||name} · ${config.model||'provider default'} · ${config.api_key==='<REDACTED>'?'key saved (hidden)':typeof config.api_key==='string'&&config.api_key.startsWith('${')?'key from '+config.api_key.slice(2,-1):'key not configured'}`:channels.length?channels.join(' · ')+' · configured':'No channel set up';
    const failure=section==='notifications'?state.records.findLast(record=>record.levelno>=40&&record.message.endsWith(`Failed to push note to ${name}.`)):null;
    return `<div class="settings-row"><div class="row sb"><div><div class="m b">${esc(name)} ${(section==='ai'?config:resolvedUser(state.config,name)).enabled===false?'<span class="tag">disabled</span>':''}</div><p class="m xs ${channels&&!channels.length?'warn':'d'}">${esc(summary)}</p>${failure?`<p class="err xs">Last send failed ${time(failure.time)}</p>`:''}</div><a class="btn sm" href="#/settings/${section}?edit=${encodeURIComponent(name)}">Edit</a></div></div>${query.get('edit')===name&&prefix!=='notification'?'<div id="settings-form-host"></div>':''}`;
  }).join('')}</div>${section==='notifications'?`<section class="sect"><h2>Shared channel settings</h2><p class="hint">Gmail SMTP requires an app password. Delivery failures are shown against the user when the activity names one.</p><p class="hint">Applied to every user unless notify_with selects a different set. Shared values overwrite matching user fields.</p>${Object.keys(state.config.notification||{}).map(name=>`<div class="row sb"><span class="m b">${esc(name)}</span><a class="btn sm" href="#/settings/notifications?type=notification&edit=${encodeURIComponent(name)}">Edit</a></div>`).join('')}<a class="btn sm" href="#/settings/notifications?type=notification&new=1&edit=shared_email">+ Add shared settings</a></section>`:''}</div>`;
  if(query.has('new')||prefix==='notification'){
    const host=document.createElement('div');host.id='settings-form-host';$('#pane').appendChild(host);
  }
  if(query.has('edit'))mountForm(prefix,query.get('edit'),query.has('new'),{},false);
}
function renderConfig() {
  const sources=state.context.sources.map(source=>esc(source.path)+(source.editable?' (editable)':' (read-only)')).join(' · ');
  $('#pane').innerHTML=pageHeader('config.toml','TOML is the plain-text format the monitor reads. Saved changes may restart searches.','<button class="btn" id="discard-raw">Discard draft</button><button class="btn" id="validate-raw">Check for problems</button>')+`<p class="section-note m">${sources||esc(state.file?.path||'')}<br>Hidden values stay unchanged unless replaced. Environment references stay visible.</p><div id="editor-host"></div><form id="section-form"></form>${saveBarHtml()}`;
  const onChange=()=>{if(state.editorSetting)return;state.content=state.editor.getValue();state.error='';state.saved='';state.rawInvalid=false;updateSaveBar();clearTimeout(renderConfig.timer);renderConfig.timer=setTimeout(()=>checkRaw(),500);};
  if(window.CodeMirror){
    state.editor=CodeMirror($('#editor-host'),{mode:'toml',lineNumbers:true,lineWrapping:true,value:state.content,extraKeys:{'Ctrl-S':saveRaw,'Cmd-S':saveRaw}});state.editor.on('change',onChange);state.editor.getInputField().setAttribute('aria-label','Configuration TOML');
    const section=routeParts().query.get('section');if(section){const lines=state.content.split('\n');const line=lines.findIndex(text=>text.trim()==='['+section+']');if(line>=0){state.editor.setCursor(line,0);state.editor.scrollIntoView({line,ch:0},80);}}
  }else{
    const textarea=document.createElement('textarea');textarea.className='raw-editor';textarea.setAttribute('aria-label','Configuration TOML');textarea.value=state.content;$('#editor-host').appendChild(textarea);state.editor={getValue:()=>textarea.value};textarea.oninput=onChange;
  }
  $('#discard-raw').onclick=async()=>{if(!dirty()||await confirmAction('Discard draft?','Unsaved changes will be lost.','Discard')){await loadConfig();state.error='';state.conflict=null;renderConfig();}};
  $('#validate-raw').onclick=()=>checkRaw();$('#section-form').onsubmit=event=>{event.preventDefault();saveRaw();};
  $('#form-cancel').onclick=async()=>{if(!dirty()||await confirmAction('Discard draft?','Unsaved changes will be lost.','Discard')){state.content=state.base;state.error='';state.saved='';renderConfig();}};
  $('#form-save').onclick=event=>{event.preventDefault();saveRaw();};
  updateSaveBar();renderConflict();
}
async function checkRaw() {
  const checked=state.content;
  if(state.validationLine!=null)state.editor?.removeLineClass?.(state.validationLine,'background','validation-line');state.validationLine=null;
  try{await validateDraft(checked);if(checked!==state.content)return;state.error='';state.rawInvalid=false;state.saved='Valid with all loaded files';}
  catch(error){if(checked!==state.content)return;state.error=error.message;state.rawInvalid=Boolean(error.validation);state.saved='';const line=error.message.match(/line (\d+)/)?.[1];if(line&&state.editor?.addLineClass){state.validationLine=Number(line)-1;state.editor.addLineClass(state.validationLine,'background','validation-line');}}
  updateSaveBar();
}
async function saveRaw() {
  if(state.saving)return;
  state.saving=true;state.error='';updateSaveBar();state.editor?.setOption?.('readOnly',true);
  try{await writeDraft(state.content);state.saving=false;renderConfig();state.saved='Saved '+time(Date.now()/1000)+' · the monitor may restart searches.';updateSaveBar();}
  catch(error){state.saving=false;state.error=error.message;state.rawInvalid=Boolean(error.validation);updateSaveBar();state.editor?.setOption?.('readOnly',false);}
}
async function pollConfig() {
  if(state.pollBusy||state.saving||$('#login-dialog').open||!state.initialized)return;
  state.pollBusy=true;
  try{
    const data=await json('/api/config/files');const mtime=data.files[0].mtime;
    if(mtime!==state.mtime){
      const file=await json('/api/config/file/primary');
      if(state.saving)return;
      if(file.content===state.base){state.mtime=file.mtime;return;}
      if(dirty()){
        if(!state.conflict){try{state.conflict=state.form?candidateFromForm():{content:state.content,renames:{}};}catch{state.conflict={content:null,renames:{}};}renderConflict();}
      }else{await loadConfig();render();}
    }
  }catch(error){if(!$('#login-dialog').open)toast(error.message);}finally{state.pollBusy=false;}
}
function render() {
  $('#pane').onscroll=null;window.onscroll=null;state.editor=null;
  const {parts}=routeParts();
  if(parts[0]==='settings')renderSettings();
  else if(parts[1]==='new'){mountForm('item',state.newName||'new_search',true,state.newFields||{});state.newName=null;state.newFields=null;state.newReturn=null;}
  else if(parts[1]==='item'&&parts[3]==='edit')mountForm('item',decodeName(parts[2]));
  else if(parts[1]==='item')renderActivity(decodeName(parts[2]));
  else if(parts[1]==='all')renderActivity();
  else if(parts[1]==='matches')matchesView.render();
  else{
    const names=Object.keys(state.config.item||{});
    const sample=names.length===1&&names[0]==='example'&&list(state.config.item.example.search_phrases).join(',')==='gopro hero'&&Object.keys(state.config.item.example).every(key=>key==='search_phrases');
    if(sample&&!sessionStorage.getItem('aimm-setup-dismissed'))renderFirstRun();
    else{state.route=names.length?itemRoute(names[0]):'#/monitor/all';history.replaceState(null,'',state.route);renderActivity(names[0]||null);}
  }
  renderSidebar();renderConflict();
}
async function bootstrap() {
  matchesView ||= createMatchesView({state,json,pageHeader,exportCsv,toast,renderSidebar,searchSummary});
  $('#sidebar').onclick=event=>matchesView.sidebarClick(event);
  state.status=await json('/api/status');state.open=state.status.open;$('#app').hidden=false;
  const build=state.status.build;
  $('#build-version').textContent=build?.sha?build.sha.slice(0,7)+(build.dirty?' · modified':''):'Build unknown';
  $('#build-version').title=`Version ${build?.version||'unknown'} · Commit ${build?.sha||'unavailable'}${build?.dirty?' · uncommitted source changes at startup':''}`;
  if(!state.initialized){await loadConfig();state.initialized=true;render();await snapshot();}
  connectStream();updateStatus();
  matchesView.summary();
}
try{await initToml({module_or_path:new URL('./vendor/toml-edit-js/index_bg.wasm',import.meta.url)});await showLogin();}
catch(error){$('#app').hidden=false;$('#pane').innerHTML=pageHeader('Dashboard could not load')+`<div class="empty"><p class="err">${esc(error.message)}</p><button class="btn" id="retry-load">Reload</button></div>`;$('#retry-load').onclick=()=>location.reload();}
setInterval(updateStatus,3000);setInterval(pollConfig,5000);setInterval(pollSearchProgress,1500);
