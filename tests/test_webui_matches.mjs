import test from 'node:test';
import assert from 'node:assert/strict';
import {groupMatches, mergeMatchRows, applyRecheckResult, priceDropped, matchDate, galleryHtml, createMatchesView} from '../src/ai_marketplace_monitor/webui/static/matches.js';

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
        for(const match of html.matchAll(/<(button|input|select|a|h1|div|span|article|section|aside|details)\b([^>]*)>/g)){
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
  await t.test('readable storage cannot restore filters while clearing',async t=>{const h=viewHarness(t,{saved:'status=shortlisted&q=camera',storageReadOnly:true});h.view.render();await h.flush();h.node('matches-clear').onclick();await h.flush();assert.equal(h.state.route,'#/monitor/matches');assert.equal(h.node('matches-query').value,'');assert.equal(h.node('matches-clear').hidden,true);assert.equal(new URL(h.requests.at(-1),'http://localhost').searchParams.has('status'),false);});
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
  assert.match(h.node('matches-body').innerHTML,/1 matches/);
  assert.match(h.node('matches-body').innerHTML,/↻ Re-check 1</);
  assert.equal(h.state.matchSummary.groups[0].count,9);
  h.node('recheck-group-camera').onclick();
  const params=new URL(h.requests.at(-1),'http://localhost').searchParams;
  assert.deepEqual(Object.fromEntries(params),{item:'camera',min_score:'4',status:'shortlisted',include_dismissed:'true',price_drop:'true',q:'lens',sort:'newest',limit:'25'});
  await h.flush();
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
  h.control('[data-expand]').onclick();assert.equal(document.querySelectorAll('[data-open-match]').length,6);
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
