import test from 'node:test';
import assert from 'node:assert/strict';
import {groupMatches, mergeMatchRows, applyRecheckResult, recheckStatuses, priceDropped, priceDropText, matchDate, relativeDate, rowDate, ratingWord, dayGroupLabel, matchShortcut, keyDates, galleryHtml, createMatchesView} from '../src/ai_marketplace_monitor/webui/static/matches.js';

const row = (key,item,extra={})=>({key,item,marketplace:key.split(':')[0],listing_id:key.split(':')[1],title:'Listing',state:{filed_under:[],shortlisted:false,contacted:false,dismissed:false},notified_users:[],filed_under:[item],found_at:'2026-10-03T10:00:00',...extra});
test('manual filing counts once and a real target evaluation wins over a manual label',()=>{
  const rows=[row('fb:1','camera',{filed_under:['camera','gear']}),row('fb:1','gear',{score:4})];
  const groups=groupMatches(rows);
  assert.equal(groups.get('gear').length,1);
  assert.equal(groups.get('gear')[0].score,4);
  assert.equal(groups.get('gear')[0].filed_by_you,false);
  assert.equal(groupMatches(rows.slice(0,1),'search','gear').get('gear')[0].filed_by_you,true);
  assert.deepEqual([...groupMatches(rows,'date').keys()],['2026-10-03']);
});
test('re-check updates retain current row order while a job runs',()=>{
  const previous=[row('fb:1','camera'),row('fb:2','camera')];
  const incoming=[row('fb:2','camera',{score:5}),row('fb:1','camera',{score:2}),row('fb:3','gear')];
  const updated=mergeMatchRows(previous,incoming,true);
  assert.deepEqual(updated.map(row=>row.key),['fb:1','fb:2','fb:3']);
  assert.equal(updated[0].score,2);
  assert.deepEqual(mergeMatchRows(previous,incoming,false),incoming);
});
test('missing dates and prices are not invented',()=>{
  assert.equal(matchDate(null),'—');assert.equal(matchDate('invalid'),'—');
  assert.equal(priceDropped({price:'$360',current_price:'$320'}),true);
  assert.equal(priceDropped({price:'Ask seller',current_price:'$320'}),false);
  assert.equal(priceDropped({price:'$360',current_price:null}),false);
  assert.equal(priceDropped({price:'$100',current_price:'$80',recheck:{old_price:'$70'}}),false);
  assert.equal(priceDropped({price:'$100',current_price:'$80',recheck:{old_price:'$90'}}),true);
  assert.equal(priceDropped({price:'$100–$200',current_price:'$80'}),false);
  assert.equal(priceDropped({price:'PHP 300,000',current_price:'PHP225k'}),false);
  assert.equal(priceDropped({price:'$300,000',current_price:'$225 down payment'}),false);
  assert.equal(priceDropped({price:'$300',current_price:'$2,25'}),false);
  assert.equal(priceDropped({price:'PHP 300,000',current_price:'225,000 PHP'}),true);
});
test('live below-threshold results update even when the active rating filter hides them from the API',()=>{
  const rows=[row('fb:1','camera',{marketplace:'fb',listing_id:'1',score:5})];
  const changed=applyRecheckResult(rows,{marketplace:'fb',listing_id:'1',item:'camera',status:'below_threshold',score:2,price:'$100'});
  assert.equal(mergeMatchRows(changed,[],true)[0].score,2);
  assert.equal(changed[0].current_price,'$100');
  assert.equal(applyRecheckResult(rows,{marketplace:'fb',listing_id:'1',original_item:'camera',item:'other',status:'passed',score:3})[0].score,5);
});

function viewHarness(t,{route='#/monitor/matches',saved='',matches=[],groups,filteredGroups,respond,storageFails=false,storageReadOnly=false}={}) {
  const nodes=new Map(), controls=[], timers=new Map(), stored=new Map([['aimm-matches-view',saved]]), requests=[], exports=[];
  let timerId=0;
  const decode=value=>value.replaceAll('&amp;','&').replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>');
  const selects=(elements,selector)=>elements.filter(el=>{
    if(selector==='button'||selector==='img')return el.tag===selector;
    const attr=selector.match(/^\[([^=\]]+)(?:="([^"\]]*)")?\]$/);
    return attr&&el.hasAttribute(attr[1])&&(attr[2]===undefined||el.getAttribute(attr[1])===attr[2]);
  });
  function element(id='',attributes='',tag='div') {
    const attrs=new Map([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(match=>[match[1],decode(match[2])]));
    const el={id,tag,children:[],dataset:{},isConnected:true,scrollTop:0,hidden:/\bhidden\b/.test(attributes),disabled:/\bdisabled\b/.test(attributes),value:attrs.get('value')||'',textContent:'',
      querySelectorAll(selector){return selects(this.children,selector);},querySelector(selector){return selector==='ol'?{insertAdjacentHTML(){}}:this.querySelectorAll(selector)[0]||null;},
      contains(node){return this.children.includes(node);},insertAdjacentHTML(_position,html){this.innerHTML=(this.html||'')+html;},
      setAttribute(name,value){attrs.set(name,String(value));},getAttribute(name){return attrs.get(name)??null;},hasAttribute(name){return attrs.has(name);},addEventListener(name,fn){this['on'+name]=fn;},focus(){this.focused=true;document.activeElement=this;},scrollIntoView(){},
      get innerHTML(){return this.html||'';},set innerHTML(html){this.html=html;if(id==='pane'){nodes.clear();nodes.set('pane',this);controls.length=0;}
        for(const old of this.children){const position=controls.indexOf(old);if(position>=0)controls.splice(position,1);if(old.id&&nodes.get(old.id)===old)nodes.delete(old.id);}
        this.children=[];
        for(const match of html.matchAll(/<(form|p|button|input|select|textarea|a|h1|div|span|article|section|aside|details)\b([^>]*)>/g)){
          const attributes=match[2],childId=attributes.match(/\bid="([^"]+)"/)?.[1];
          if(!childId&&!/data-/.test(attributes))continue;
          const child=element(childId,attributes,match[1]);
          for(const match of attributes.matchAll(/data-([\w-]+)="([^"]*)"/g))child.dataset[match[1].replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=decode(match[2]);
          if(child.dataset.recheckGroup)nodes.set('recheck-group-'+child.dataset.recheckGroup,child);
          if(childId)nodes.set(childId,child);controls.push(child);this.children.push(child);
        }
      }};
    return el;
  }
  nodes.set('pane',element('pane'));
  const storage={getItem(key){if(storageFails)throw new Error('Storage blocked');return stored.get(key)||null;},setItem(key,value){if(storageFails||storageReadOnly)throw new Error('Storage full');stored.set(key,value);},removeItem(key){stored.delete(key);}};
  const globals={document:{activeElement:null,querySelector:selector=>selector.startsWith('#')?nodes.get(selector.slice(1))||null:selects(controls,selector)[0]||null,querySelectorAll:selector=>selects(controls,selector),getElementById:id=>nodes.get(id)},localStorage:storage,sessionStorage:{...storage,getItem:()=>null},history:{replaceState(){},pushState(){}},setInterval:()=>0,setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)};
  for(const [key,value] of Object.entries(globals)){const original=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});t.after(()=>{if(original)Object.defineProperty(globalThis,key,original);else delete globalThis[key];});}
  const state={route,config:{item:{camera:{},gear:{}}},records:[],status:{}};
  const view=createMatchesView({state,json:async (url,options)=>{requests.push(url);return respond?.(url,options)??(url.includes('/detail?')?matches.find(row=>url.includes('/'+row.listing_id+'/')&&new URL(url,'http://localhost').searchParams.get('item')===row.item):url.includes('/related')?{}:url.endsWith('/state')?JSON.parse(options.body):{matches,counts:{all:matches.length},groups:groups??[{item:'camera',count:matches.length}],filtered_groups:filteredGroups??[{item:'camera',count:matches.length}]});},pageHeader:(_title,_description,actions)=>actions,exportCsv:options=>exports.push(options),toast(){},renderSidebar(){},searchSummary:()=>''});
  return {state,view,stored,requests,exports,open:async(index=0)=>{selects(controls,'[data-open-match]')[index].onclick({preventDefault(){}});for(let i=0;i<6;i++)await Promise.resolve();},control:(selector)=>selects(controls,selector)[0],node:id=>nodes.get(id),filter:(name,value)=>{const control=controls.find(el=>el.dataset.matchFilter===name);control.value=value;control.onchange();},status:name=>controls.find(el=>el.dataset.matchStatus===name).onclick(),flush:async()=>{for(let i=0;i<6;i++)await Promise.resolve();},tick:async()=>{const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn());await Promise.resolve();}};
}

test('Matches restores saved filters and layout on return; explicit URLs replace saved preferences',async t=>{
  const h=viewHarness(t,{saved:'item=camera&status=shortlisted&min_score=4&q=lens&sort=price&group=date'});
  h.view.render();await h.flush();
  assert.match(h.requests.at(-1),/item=camera/);assert.match(h.requests.at(-1),/status=shortlisted/);
  assert.equal(h.node('matches-query').value,'lens');assert.match(h.state.route,/group=date/);
  h.filter('sort','score');h.filter('group','none');h.status('contacted');
  h.state.route='#/monitor/matches';h.view.render();await h.flush();
  assert.match(h.state.route,/sort=score/);assert.match(h.state.route,/group=none/);assert.match(h.state.route,/status=contacted/);
  h.state.route='#/monitor/matches?item=gear';h.view.render();await h.flush();
  assert.equal(h.state.route,'#/monitor/matches?item=gear');assert.equal(h.stored.get('aimm-matches-view'),'item=gear');
  h.state.route='#/monitor/matches?';h.view.render();await h.flush();
  assert.equal(h.stored.get('aimm-matches-view'),'');
});

test('historical searches remain selectable and last-seen sorting survives return',async t=>{
  const h=viewHarness(t,{saved:'item=removed_camera&sort=last_seen'});
  h.state.matchSummary={groups:[{item:'removed_camera',count:1}]};
  h.view.render();await h.flush();
  assert.match(h.state.route,/item=removed_camera/);
  assert.match(h.requests.at(-1),/sort=last_seen/);
  h.node('export-csv').onclick();
  assert.match(h.exports.at(-1).url,/item=removed_camera/);
  assert.match(h.exports.at(-1).url,/sort=last_seen/);
});

test('paste URL saves and opens a manual listing with general assessment and retry',async t=>{
  const manual={...row('facebook:222',''),marketplace:'facebook',listing_id:'222',source:'manual',evaluation_status:'error',assessment_reason:'AI unavailable',score:null,comment:null,title:'Pasted camera'};
  const requests=[];
  const h=viewHarness(t,{matches:[manual],respond:(url,options)=>{
    if(url==='/api/matches/manual'){requests.push(JSON.parse(options.body));return {existing:false,match:manual,job_id:'manual-job',queued:1};}
    if(url==='/api/matches/recheck/manual-job')return {job_id:'manual-job',state:'stopped',done:1,total:1,searches:[''],results:[{status:'error',reason:'AI unavailable'}]};
    if(url==='/api/matches/recheck'){requests.push(JSON.parse(options.body));return {job_id:'retry-job',queued:1};}
  }});
  h.view.render();await h.flush();
  assert.equal(h.node('add-listing-form').hidden,true);
  h.node('add-listing').onclick();
  assert.equal(h.node('add-listing-form').hidden,false);
  assert.equal(h.node('add-listing-url').focused,true);
  h.node('add-listing-url').value=' https://m.facebook.com/marketplace/item/222/?ref=test ';
  await h.node('add-listing-form').onsubmit({preventDefault(){}});await h.flush();
  assert.deepEqual(requests[0],{url:'https://m.facebook.com/marketplace/item/222/?ref=test'});
  assert.match(h.state.route,/matches\/facebook\/222\?.*match_item=/);
  assert.match(h.node('match-detail').innerHTML,/Added manually · general assessment/);
  assert.match(h.node('match-detail').innerHTML,/AI unavailable/);
  assert.match(h.node('match-detail').innerHTML,/Retry assessment/);
  assert.doesNotMatch(h.node('match-detail').innerHTML,/sends every listing|Original search removed/);
  assert.equal(h.node('recheck-one').disabled,false);
  await h.node('recheck-one').onclick();
  assert.deepEqual(requests[1].listings,[{marketplace:'facebook',listing_id:'222',original_item:''}]);
});

test('invalid pasted links stay in the form with an accessible error',async t=>{
  const h=viewHarness(t,{respond:(url)=>{if(url==='/api/matches/manual')throw new Error('Paste a direct Facebook Marketplace listing URL');}});
  h.view.render();await h.flush();h.node('add-listing').onclick();
  h.node('add-listing-url').value='https://example.com';
  await h.node('add-listing-form').onsubmit({preventDefault(){}});
  assert.equal(h.node('add-listing-error').getAttribute('role'),'alert');
  assert.match(h.node('add-listing-error').textContent,/direct Facebook/);
  assert.equal(h.node('add-listing-url').focused,true);
  assert.equal(h.node('add-listing-submit').disabled,false);
  assert.equal(h.state.route,'#/monitor/matches');
});

test('a successful re-check clears a previous failed evaluation only for its search',()=>{
  const rows=[row('fb:1','camera',{marketplace:'fb',listing_id:'1',evaluation_status:'below_threshold',score:2})];
  assert.equal(applyRecheckResult(rows,{marketplace:'fb',listing_id:'1',item:'camera',status:'passed',score:5})[0].evaluation_status,'passed');
  assert.equal(applyRecheckResult(rows,{marketplace:'fb',listing_id:'1',original_item:'camera',item:'other',status:'passed',score:5})[0].evaluation_status,'below_threshold');
  const target=row('fb:1','other',{marketplace:'fb',listing_id:'1',evaluation_status:'passed',score:4});
  const updated=applyRecheckResult([...rows,target],{marketplace:'fb',listing_id:'1',original_item:'camera',item:'other',status:'below_threshold',score:1});
  assert.equal(updated[0].score,2);
  assert.equal(updated[1].score,1);
  assert.equal(updated[1].evaluation_status,'below_threshold');
});

test('saved removed searches are discarded and unavailable storage does not block Matches',async t=>{
  await t.test('removed search and invalid values',async t=>{const h=viewHarness(t,{saved:'item=deleted&sort=price&group=date&cursor=old&status=invalid&min_score=0&include_dismissed=invalid'});h.view.render();await h.flush();assert.equal(h.state.route,'#/monitor/matches?sort=price&group=date');assert.equal(h.stored.get('aimm-matches-view'),'sort=price&group=date');});
  await t.test('storage unavailable',async t=>{const h=viewHarness(t,{storageFails:true});h.view.render();await h.flush();h.filter('min_score','5');await h.flush();assert.match(h.requests.at(-1),/min_score=5/);});
  await t.test('readable storage cannot restore filters while clearing',async t=>{const h=viewHarness(t,{saved:'status=shortlisted&q=camera',storageReadOnly:true});h.view.render();await h.flush();h.node('matches-clear').onclick();await h.flush();assert.equal(h.state.route,'#/monitor/matches');assert.equal(h.node('matches-query').value,'');assert.equal(h.node('matches-clear').hidden,true);assert.equal(new URL(h.requests.at(-1),'http://localhost').searchParams.get('status'),'new');});
});

test('Clear filters remains visible with results and preserves layout without reviving pending text',async t=>{
  const listing=row('fb:1','camera',{state:{filed_under:[]},notified_users:[]});
  const h=viewHarness(t,{route:'#/monitor/matches?status=shortlisted&item=camera&min_score=4&q=lens&sort=price&group=none&cursor=old',matches:[listing]});
  h.view.render();await h.flush();
  assert.match(h.node('matches-body').innerHTML,/matches-layout/);assert.equal(h.node('matches-clear').hidden,false);
  const input=h.node('matches-query');input.value='pending';input.oninput({target:input});h.node('matches-clear').onclick();await h.tick();
  assert.equal(h.state.route,'#/monitor/matches?sort=price&group=none');assert.equal(h.node('matches-query').value,'');assert.equal(h.node('matches-clear').hidden,true);
  assert.equal(h.node('matches-query').focused,true);
  assert.equal(h.stored.get('aimm-matches-view'),'sort=price&group=none');
});

test('text filters survive live-event debounce and cannot navigate back after leaving Matches',async t=>{
  const h=viewHarness(t);h.view.render();await h.flush();
  const input=h.node('matches-query');input.value='camera';input.oninput({target:input});h.view.onRecord({extra:{kind:'match_recorded'}});await h.tick();
  assert.match(h.state.route,/q=camera/);
  input.value='pending';input.oninput({target:input});h.state.route='#/monitor/all';await h.tick();assert.equal(h.state.route,'#/monitor/all');
  h.state.route='#/monitor/matches';h.view.render();await h.flush();assert.equal(h.node('matches-query').value,'camera');
});

test('Matches export includes current filters and pending text without pagination or display parameters',async t=>{
  const h=viewHarness(t,{route:'#/monitor/matches?item=camera&min_score=4&status=shortlisted&include_dismissed=true&q=old&sort=price&group=date&cursor=old&limit=1&since=yesterday'});
  h.view.render();await h.flush();const input=h.node('matches-query');input.value='new & lens';input.oninput({target:input});h.node('export-csv').onclick();await h.tick();
  assert.deepEqual(h.exports,[{url:'/api/matches.csv?item=camera&min_score=4&status=shortlisted&include_dismissed=true&q=new+%26+lens&sort=price',emptyMessage:'No matches for these filters to export.',filename:'matches.csv'}]);
  assert.equal(new URLSearchParams(h.state.route.split('?')[1]).get('q'),'new & lens');
  const requestCount=h.requests.length;h.node('export-csv').onclick();assert.equal(h.requests.length,requestCount);
});

test('price-drop filter is remembered, exported and cleared',async t=>{
  const h=viewHarness(t);h.view.render();await h.flush();
  h.filter('price_drop','true');await h.flush();
  assert.match(h.requests.at(-1),/price_drop=true/);assert.equal(h.node('matches-clear').hidden,false);
  h.state.route='#/monitor/matches';h.view.render();await h.flush();
  assert.match(h.state.route,/price_drop=true/);
  h.node('export-csv').onclick();assert.match(h.exports[0].url,/price_drop=true/);
  h.node('matches-clear').onclick();await h.flush();
  assert.equal(new URL(h.requests.at(-1),'http://localhost').searchParams.has('price_drop'),false);
});

test('Previous and Next follow group order, reveal hidden rows and stop at loaded boundaries',async t=>{
  const listing=(id,item,extra={})=>row('fb:'+id,item,{title:'Listing '+id,state:{filed_under:[]},notified_users:[],...extra});
  const h=viewHarness(t,{matches:[listing(1,'camera',{filed_under:['camera','gear']}),listing(2,'gear'),listing(3,'camera'),listing(4,'camera'),listing(5,'camera')]});
  h.view.render();await h.flush();
  await h.open();
  assert.equal(h.node('match-previous').disabled,true);
  assert.match(h.node('match-detail').innerHTML,/1 of 5 loaded/);
  for(const [position,id] of [[2,3],[3,4],[4,5],[5,2]]){
    h.node('match-next').onclick();await h.flush();
    assert.match(h.node('match-page-top').innerHTML,new RegExp(`Listing ${id}</h1>`));
    assert.ok(h.node('match-detail').innerHTML.includes(`${position} of 5 loaded`));
  }
  assert.equal(h.node('match-next').disabled,true);assert.equal(h.node('match-title').focused,true);
  h.node('match-previous').onclick();await h.flush();assert.match(h.node('match-page-top').innerHTML,/Listing 5<\/h1>/);
  h.node('match-back').onclick({preventDefault(){}});await h.flush();assert.match(h.node('matches-body').innerHTML,/matches-layout/);
});

test('gallery uses only local photo routes, wraps selection and omits controls for zero or one photo',()=>{
  const listing=row('fb:1','camera',{title:'<unsafe>',image:'https://scontent.fbcdn.net/one.jpg'});
  assert.match(galleryHtml(listing),/No photos saved/);
  assert.doesNotMatch(galleryHtml(listing),/fbcdn|data-photo-step/);
  listing.photos=[{digest:'a'.repeat(64)}];
  assert.match(galleryHtml(listing),/Photo 1 of 1 — &lt;unsafe&gt;/);
  assert.doesNotMatch(galleryHtml(listing),/data-photo-step|data-photo-index/);
  listing.photos.push({digest:'b'.repeat(64)});
  assert.match(galleryHtml(listing,-1),/Photo 2 of 2 —/);
  assert.match(galleryHtml(listing,2),/Photo 1 of 2 —/);
  assert.match(galleryHtml(listing),/src="\/api\/matches\/fb\/1\/photos\/a{64}\.webp"/);
  assert.doesNotMatch(galleryHtml({...listing,photos:[{digest:'../bad'}]}),/<img/);
});

test('seller assessment appears separately with escaped reasons and safe profile links',async t=>{
  const listing=row('fb:1','camera',{score:5,conclusion:'Great deal',state:{filed_under:[]},notified_users:[],seller_assessment:{status:'caution',reasons:['Low seller rating','<img src=x onerror=alert(1)>'],profile_url:'https://www.facebook.com/marketplace/profile/123/',checked_at:'2026-10-04T01:00:00Z'}});
  const h=viewHarness(t,{matches:[listing]});h.view.render();await h.flush();
  assert.match(h.node('matches-body').innerHTML,/Seller: Caution/);
  await h.open();
  let detail=h.node('match-detail').innerHTML;
  assert.match(detail,/5\/5/);assert.match(detail,/Great deal/);assert.match(detail,/Low seller rating/);
  assert.match(detail,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.doesNotMatch(detail,/<img src=x/);
  assert.match(detail,/href="https:\/\/www.facebook.com\/marketplace\/profile\/123\/"/);
  assert.match(detail,/Checked/);
  listing.seller_assessment.profile_url='javascript:alert(1)';h.view.render();await h.flush();
  assert.doesNotMatch(h.node('match-detail').innerHTML,/href="javascript:/);
  delete listing.seller_assessment;h.view.render();await h.flush();
  detail=h.node('match-detail').innerHTML;
  assert.match(detail,/Seller: Unknown/);assert.match(detail,/Re-check this listing/);
});

test('History remains interactive after Related listings is mounted',async t=>{
  const listing=row('fb:1','camera',{marketplace:'fb',listing_id:'1',state:{filed_under:[]},notified_users:[]});
  const h=viewHarness(t,{matches:[listing],respond:url=>url.includes('/history?')?{events:[]}:undefined});
  h.view.render();await h.flush();
  await h.open();
  assert.ok(h.node('related-listings'));
  const history=h.node('match-history');
  assert.equal(typeof history.ontoggle,'function');
  history.open=true;history.ontoggle();await h.flush();
  assert.ok(h.requests.includes('/api/matches/fb/1/history?cursor=0'));
  assert.equal(h.node('match-history-body').textContent,'No history recorded yet.');
});

test('group counts and re-check scope honor all filters without changing sidebar totals',async t=>{
  const listing=row('fb:1','camera',{state:{filed_under:[]},notified_users:[]});
  const h=viewHarness(t,{route:'#/monitor/matches?item=camera&min_score=4&status=shortlisted&include_dismissed=true&price_drop=true&q=lens&sort=price&group=search&cursor=old',matches:[listing],groups:[{item:'camera',count:9}],filteredGroups:[{item:'camera',count:1}]});
  h.view.render();await h.flush();
  assert.match(h.node('matches-body').innerHTML,/1 match</);
  assert.match(h.node('matches-body').innerHTML,/↻ Re-check 1</);
  assert.equal(h.state.matchSummary.groups[0].count,9);
  h.node('recheck-group-camera').onclick();
  const params=new URL(h.requests.at(-1),'http://localhost').searchParams;
  assert.deepEqual(Object.fromEntries(params),{item:'camera',min_score:'4',status:'shortlisted',include_dismissed:'true',price_drop:'true',q:'lens',sort:'newest',limit:'25'});
  await h.flush();
});

test('manually added listings get their own category that filters by source',async t=>{
  const manual=row('fb:2','',{source:'manual'});
  const h=viewHarness(t,{route:'#/monitor/matches?item=camera&status=all',matches:[manual],groups:[{item:'camera',count:3},{item:'',count:1}]});
  h.view.render();await h.flush();
  const category=h.control('[data-match-source="manual"]');
  assert.equal(category.getAttribute('aria-pressed'),'false');
  category.onclick();await h.flush();
  const params=new URL(h.requests.at(-1),'http://localhost').searchParams;
  assert.equal(params.get('source'),'manual');assert.equal(params.get('item'),null);
  assert.equal(h.state.route,'#/monitor/matches?status=all&source=manual');
  assert.match(h.node('match-chips').innerHTML,/Category: Manually added/);
  assert.equal(h.control('[data-match-source="manual"]').getAttribute('aria-pressed'),'true');
  h.control('[data-match-category="camera"]').onclick();await h.flush();
  assert.equal(h.state.route,'#/monitor/matches?status=all&item=camera');
});

test('AI emphasis markers are removed while comments remain escaped plain text',async t=>{
  const listing=row('fb:1','camera',{score:4,comment:'**Good value** with <img src=x> and 2 * 3',state:{filed_under:[]},notified_users:[]});
  const h=viewHarness(t,{matches:[listing]});h.view.render();await h.flush();
  const list=h.node('matches-body').innerHTML;await h.open();
  for(const html of [list,h.node('match-detail').innerHTML]){
    assert.match(html,/Good value with &lt;img src=x&gt; and 2 \* 3/);
    assert.doesNotMatch(html,/\*\*Good value\*\*|<img src=x>/);
  }
});


test('gallery keyboard focus changes photos without changing the listing and Back restores view and scroll',async t=>{
  const listing=row('fb:1','camera',{photos:[{digest:'a'.repeat(64)},{digest:'b'.repeat(64)}]});
  const h=viewHarness(t,{matches:[listing],route:'#/monitor/matches?item=camera&sort=price&group=date'});
  h.view.render();await h.flush();h.node('pane').scrollTop=240;await h.open();
  assert.equal(h.node('matches-body').onkeydown,undefined);
  const key=(key,extra={})=>{let prevented=false;h.node('match-gallery').onkeydown({key,preventDefault(){prevented=true;},...extra});return prevented;};
  assert.equal(key('ArrowRight',{ctrlKey:true}),false);
  assert.equal(key('ArrowLeft'),true);
  assert.match(h.node('match-gallery').innerHTML,/Photo 2 of 2 —/);
  assert.equal(key('ArrowRight'),true);
  assert.match(h.node('match-gallery').innerHTML,/Photo 1 of 2 —/);
  assert.match(h.state.route,/matches\/fb\/1\?/);
  h.node('match-back').onclick({preventDefault(){}});await h.flush();
  assert.equal(h.state.route,'#/monitor/matches?item=camera&sort=price&group=date');
  assert.equal(h.node('pane').scrollTop,240);
});

test('row dismissal stays reversible even after the API hides it, and duplicate state clicks make one request',async t=>{
  const listing=row('fb:1','camera');let finish;
  const h=viewHarness(t,{matches:[listing],respond:(url,options)=>{
    if(url.endsWith('/state'))return new Promise(resolve=>{finish=()=>resolve(JSON.parse(options.body));});
    if(url.startsWith('/api/matches?'))return {matches:listing.state.dismissed?[]:[listing],counts:{all:listing.state.dismissed?0:1},groups:[{item:'camera',count:1}],filtered_groups:[{item:'camera',count:1}]};
  }});
  h.view.render();await h.flush();
  h.control('[data-row-state="dismissed"]').onclick();await h.flush();
  assert.match(h.node('matches-body').innerHTML,/Dismissed Listing/);
  h.control('[data-undo-row]').onclick();await h.flush();
  assert.equal(h.requests.filter(url=>url.endsWith('/state')).length,1);
  finish();await h.flush();
  assert.ok(h.control('[data-undo-row]'));
  h.control('[data-undo-row]').onclick();await h.flush();finish();await h.flush();
  assert.equal(listing.state.dismissed,false);
  assert.match(h.node('matches-body').innerHTML,/data-open-match/);
});


test('detail return retains loaded pages and their next cursor',async t=>{
  const matches=Array.from({length:6},(_,index)=>row('fb:'+(index+1),'camera'));
  const h=viewHarness(t,{matches,respond:url=>{
    if(!url.startsWith('/api/matches?'))return;
    const cursor=new URL(url,'http://localhost').searchParams.get('cursor');
    return {matches:cursor==='second'?matches.slice(3):cursor==='third'?[]:matches.slice(0,3),next_cursor:cursor==='second'?'third':cursor==='third'?null:'second',counts:{all:6},groups:[{item:'camera',count:6}],filtered_groups:[{item:'camera',count:6}]};
  }});
  h.view.render();await h.flush();h.node('matches-more').onclick();await h.flush();
  assert.equal(document.querySelectorAll('[data-open-match]').length,6);
  await h.open(5);h.node('match-back').onclick({preventDefault(){}});await h.flush();
  assert.equal(document.querySelectorAll('[data-open-match]').length,6);
  h.node('matches-more').onclick();await h.flush();assert.match(h.requests.at(-1),/cursor=third/);
});

test('a direct detail link works when the active list filter hides its match',async t=>{
  const listing=row('fb:1','camera',{score:4});
  const h=viewHarness(t,{route:'#/monitor/matches/fb/1?min_score=5&match_item=camera',matches:[listing],respond:url=>url.startsWith('/api/matches?')?{matches:[],counts:{all:1},groups:[{item:'camera',count:1}],filtered_groups:[]}:undefined});
  h.view.render();await h.flush();
  assert.ok(h.node('match-title'));assert.match(h.node('match-detail').innerHTML,/Outside the loaded matches/);
  assert.equal(h.node('match-previous').disabled,true);assert.equal(h.node('match-next').disabled,true);
});


test('background photo refresh preserves the current list scroll',async t=>{
  const h=viewHarness(t,{matches:[row('fb:1','camera')]});h.view.render();await h.flush();
  h.node('pane').scrollTop=260;h.view.onRecord({extra:{kind:'match_photo_saved'}});await h.tick();await h.flush();
  assert.equal(h.node('pane').scrollTop,260);
});

test('re-check status marks the next listing of a running job and queues the rest',()=>{
  const listing=id=>({marketplace:'fb',listing_id:id,original_item:'camera'});
  const statuses=recheckStatuses([
    {state:'running',done:1,listings:[listing('1'),listing('2'),listing('3')]},
    {state:'queued',done:0,listings:[listing('3'),listing('4')]},
    {state:'done',done:1,listings:[listing('5')]},
  ]);
  assert.deepEqual([...statuses],[['fb:2','checking'],['fb:3','queued'],['fb:4','queued']]);
});

test('dates name what happened, read relative when recent and keep the full timestamp',()=>{
  const now=new Date(2026,9,3,14,52);
  const at=(...parts)=>new Date(2026,...parts).toISOString();
  assert.equal(relativeDate(at(9,3,14,36),now),'16 min ago');
  assert.match(relativeDate(at(9,3,9,5),now),/^today /);
  assert.match(relativeDate(at(9,2,20,15),now),/^yesterday /);
  assert.doesNotMatch(relativeDate(at(8,30,9,12),now),/today|yesterday|ago/);
  assert.match(relativeDate(new Date(2025,0,5).toISOString(),now),/2025/);
  assert.equal(relativeDate('invalid',now),'');
  const listing=row('fb:1','camera',{found_at:at(9,1,18,40),last_seen:at(9,3,13,58)});
  assert.match(rowDate(listing,'').label,/^Found /);assert.match(rowDate(listing,'').full,/^Found .*2026/);
  assert.match(rowDate(listing,'last_seen').label,/^Seen /);
  assert.match(rowDate({...listing,source:'manual'},'').label,/^Added /);
  assert.equal(rowDate({...listing,found_at:null},'').label,'Date unknown');
  assert.match(dayGroupLabel('2026-10-03',now),/^Today · /);assert.match(dayGroupLabel('2026-10-02',now),/^Yesterday · /);
});

test('ratings read as monotonic words and price drops show the amount and share',()=>{
  assert.deepEqual([1,2,3,4,5,null].map(ratingWord),['Poor','Unclear','Fair','Good','Great deal','Not rated']);
  assert.equal(priceDropText({price:'$360',current_price:'$320'}),'−$40 (−11%)');
  assert.equal(priceDropText({price:'PHP275,000',current_price:'PHP250,000'}),'−PHP25,000 (−9%)');
  assert.equal(priceDropText({price:'Ask seller',current_price:'$320'}),'');
});

test('rows show at most two exception badges and never badge an unknown seller',async t=>{
  const listing=row('fb:1','camera',{score:2,price:'$360',current_price:'$320',evaluation_status:'below_threshold',recheck:{status:'below_threshold',old_score:4,checked_item:'camera'},seller_assessment:{status:'caution'},state:{filed_under:[]},notified_users:[]});
  const unknown=row('fb:2','camera',{score:4,state:{filed_under:[]},notified_users:[]});
  const h=viewHarness(t,{matches:[listing,unknown]});h.view.render();await h.flush();
  const html=h.node('matches-body').innerHTML;
  assert.equal((html.match(/class="match-badge/g)||[]).length,2);
  assert.match(html,/Rating Good → Unclear/);assert.match(html,/−\$40 \(−11%\)/);assert.doesNotMatch(html,/Seller: Caution|Seller: Unknown/);
  assert.match(html,/Unclear/);assert.match(html,/aria-label="AI rating 4 of 5"/);
  assert.doesNotMatch(html,/data-expand|Show \d+ more/);
});

test('category buttons filter by saved search and mark the active one',async t=>{
  const h=viewHarness(t,{matches:[row('fb:1','camera')],groups:[{item:'camera',count:3},{item:'gear',count:2}]});
  h.view.render();await h.flush();
  const gear=h.control('[data-match-category="gear"]');
  assert.equal(h.control('[data-match-category=""]').getAttribute('aria-pressed'),'true');
  gear.onclick();await h.flush();
  assert.match(h.requests.at(-1),/item=gear/);
  assert.equal(h.control('[data-match-category="gear"]').getAttribute('aria-pressed'),'true');
});

test('single-key shortcuts ignore typing, modifiers and dialogs',()=>{
  const key=(key,extra={})=>matchShortcut({key,target:{closest:selector=>extra.inField&&selector.includes('input')?{}:null},...extra});
  assert.deepEqual(['j','k','o','u','Escape','s','e','c','v','z','?','/'].map(name=>key(name)),['next','previous','open','back','back','shortlisted','dismissed','contacted','facebook','undo','help','search']);
  assert.equal(key('s',{inField:true}),null);
  assert.equal(key('s',{ctrlKey:true}),null);assert.equal(key('j',{metaKey:true}),null);
  assert.equal(key('x'),'select');assert.equal(key('q'),null);assert.equal(key('J'),null);
});

test('Matches opens on New, offers Show all when caught up and Mark all seen can be undone',async t=>{
  const h=viewHarness(t,{matches:[]});h.view.render();await h.flush();
  const request=()=>new URL(h.requests.at(-1),'http://localhost').searchParams;
  assert.equal(request().get('status'),'new');
  assert.equal(h.control('[data-match-status="new"]').getAttribute('aria-pressed'),'true');
  assert.match(h.node('matches-body').innerHTML,/You’re all caught up/);
  h.node('matches-show-all').onclick();await h.flush();
  assert.equal(request().get('status'),'all');
  const found=row('fb:1','camera',{state:{filed_under:[]},notified_users:[]});
  const q=viewHarness(t,{matches:[found]});q.view.render();await q.flush();
  assert.match(q.node('matches-body').innerHTML,/Mark all seen/);
  q.node('matches-mark-seen').onclick();await q.flush();
  const seen=q.stored.get('aimm-matches-seen');
  assert.ok(seen);assert.equal(new URL(q.requests.at(-1),'http://localhost').searchParams.get('since'),seen);
  assert.equal(q.view.onKey({key:'z',target:null,preventDefault(){}}),undefined);await q.flush();
  assert.equal(q.stored.has('aimm-matches-seen'),false);
  assert.equal(new URL(q.requests.at(-1),'http://localhost').searchParams.has('since'),false);
});

test('keyboard triage moves through rows, decides, advances and undoes',async t=>{
  const listings=[1,2,3].map(id=>row('fb:'+id,'camera',{title:'Listing '+id,state:{filed_under:[],shortlisted:false,contacted:false,dismissed:false},notified_users:[]}));
  const puts=[];
  const h=viewHarness(t,{matches:listings,respond:(url,options)=>{if(url.endsWith('/state')){puts.push([url,JSON.parse(options.body)]);return JSON.parse(options.body);}}});
  h.view.render();await h.flush();
  let prevented=0;const press=key=>{h.view.onKey({key,target:null,preventDefault(){prevented++;}});return h.flush();};
  await press('j');await press('j');await press('k');
  assert.equal(prevented,3);
  await press('s');
  assert.deepEqual(puts.at(-1),['/api/matches/fb/1/state',{shortlisted:true}]);
  assert.match(h.node('matches-body').innerHTML,/match-row on" data-match-row="1"/);
  await press('z');
  assert.deepEqual(puts.at(-1),['/api/matches/fb/1/state',{shortlisted:false}]);
  await press('e');
  assert.deepEqual(puts.at(-1),['/api/matches/fb/2/state',{dismissed:true}]);
  assert.match(h.node('matches-body').innerHTML,/Dismissed Listing 2/);
  h.stored.set('aimm-shortcuts','off');const before=puts.length;await press('s');assert.equal(puts.length,before);
});

test('key dates list labelled events newest first and skip missing ones',()=>{
  const html=keyDates({found_at:'2026-10-01T18:40:00',last_seen:'2026-10-03T13:58:00',seen_count:6,notified_users:['me'],recheck:{at:'invalid',status:'passed'}});
  assert.ok(html.indexOf('Last seen by a search')<html.indexOf('Found'));
  assert.match(html,/6 sightings/);assert.match(html,/sent to me/);assert.doesNotMatch(html,/Re-checked/);
  assert.match(keyDates({source:'manual',found_at:'2026-10-02T20:15:00',notified_users:[]}),/Added by you[\s\S]*no notification sent/);
  assert.match(keyDates({notified_users:[]}),/No dates recorded/);
});

test('detail page leads with price, decisions and the seller description, folding rare sections',async t=>{
  const listing=row('fb:1','camera',{score:4,price:'$360',current_price:'$320',description:'Light wear\non the seat',url:'https://www.facebook.com/marketplace/item/1/',state:{filed_under:[],shortlisted:false,contacted:false,dismissed:false},notified_users:['me'],seller_assessment:{status:'established',reasons:['Joined 2014']}});
  const h=viewHarness(t,{matches:[listing]});h.view.render();await h.flush();await h.open();
  const detail=h.node('match-detail').innerHTML, top=h.node('match-page-top').innerHTML;
  assert.match(top,/−\$40 \(−11%\)/);assert.match(top,/Found /);
  assert.ok(detail.indexOf('data-state="shortlisted"')<detail.indexOf('Seller’s description'));
  assert.match(detail,/Light wear\non the seat/);
  assert.match(detail,/<details id="match-history" data-section="history">/);
  assert.match(detail,/data-section="recheck">/);assert.doesNotMatch(detail,/data-section="recheck" open/);
  assert.match(detail,/Seller: Established/);assert.match(detail,/aria-keyshortcuts="v"/);
});

test('applied filters appear as removable chips and price drop is a checkbox',async t=>{
  const h=viewHarness(t,{route:'#/monitor/matches?item=camera&min_score=4&price_drop=true&q=lens'});h.view.render();await h.flush();
  const chips=h.node('match-chips').innerHTML;
  assert.match(chips,/Category: camera/);assert.match(chips,/Good or better/);assert.match(chips,/Price dropped/);assert.match(chips,/Contains “lens”/);
  assert.equal(h.node('match-chips-row').hidden,false);
  h.control('[data-remove-filter="min_score"]').onclick();await h.flush();
  const params=new URL(h.requests.at(-1),'http://localhost').searchParams;
  assert.equal(params.has('min_score'),false);assert.equal(params.get('item'),'camera');
  assert.doesNotMatch(h.node('match-chips').innerHTML,/Good or better/);
});

test('bulk selection supports ranges, updates each listing once and can be undone',async t=>{
  const listings=[1,2,3,4].map(id=>row('fb:'+id,'camera',{title:'Listing '+id,state:{filed_under:[],shortlisted:false,contacted:false,dismissed:false},notified_users:[]}));
  const puts=[];
  const h=viewHarness(t,{matches:listings,respond:(url,options)=>{if(url.endsWith('/state')){puts.push([url,JSON.parse(options.body)]);return JSON.parse(options.body);}}});
  h.view.render();await h.flush();
  const box=id=>document.querySelectorAll('[data-select-match]').find(el=>el.dataset.selectMatch===JSON.stringify(['fb:'+id,'camera']));
  const click=(id,shiftKey)=>{const el=box(id);el.checked=true;el.onclick({shiftKey});};
  click(1,false);await h.flush();
  click(3,true);await h.flush();
  assert.match(h.node('matches-body').innerHTML,/3 selected/);
  await h.control('[data-bulk="dismissed"]').onclick();await h.flush();
  assert.deepEqual(puts.map(([url,body])=>[url.split('/')[4],body]),[['1',{dismissed:true}],['2',{dismissed:true}],['3',{dismissed:true}]]);
  assert.doesNotMatch(h.node('matches-body').innerHTML,/selected</);
  await h.view.onKey({key:'z',target:null,preventDefault(){}});await h.flush();
  assert.deepEqual(puts.slice(3).map(([,body])=>body),[{dismissed:false},{dismissed:false},{dismissed:false}]);
});

test('new matches arriving mid-triage wait behind a Show button',async t=>{
  const h=viewHarness(t,{matches:[row('fb:1','camera')]});h.view.render();await h.flush();
  const before=h.requests.filter(url=>url.includes('status=new')).length;
  h.view.onRecord({extra:{kind:'match_recorded'}});h.view.onRecord({extra:{kind:'match_recorded'}});await h.tick();
  assert.match(h.node('matches-arrivals').innerHTML,/2 new matches · Show/);
  assert.equal(h.requests.filter(url=>url.includes('status=new')).length,before);
  h.node('matches-arrivals-show').onclick();await h.flush();
  assert.equal(h.node('matches-arrivals').innerHTML,'');
});

test('private notes save after typing and report the result',async t=>{
  const listing=row('fb:1','camera',{state:{filed_under:[],shortlisted:false,contacted:false,dismissed:false,note:'Old'},notified_users:[]});
  const puts=[];
  const h=viewHarness(t,{matches:[listing],respond:(url,options)=>{if(url.endsWith('/state')){puts.push(JSON.parse(options.body));return {...listing.state,...JSON.parse(options.body)};}}});
  h.view.render();await h.flush();await h.open();
  const note=h.node('match-note');note.value='Messaged Sat';note.oninput();await h.tick();await h.flush();
  assert.deepEqual(puts,[{note:'Messaged Sat'}]);
  assert.equal(h.node('match-note-status').textContent,'Saved.');
});
