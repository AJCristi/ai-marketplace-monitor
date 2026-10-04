import test from 'node:test';
import assert from 'node:assert/strict';
import {groupMatches, mergeMatchRows, applyRecheckResult, priceDropped, matchDate, createMatchesView} from '../src/ai_marketplace_monitor/webui/static/matches.js';

const row = (key,item,extra={})=>({key,item,filed_under:[item],found_at:'2026-10-03T10:00:00',...extra});
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
});
test('live below-threshold results update even when the active rating filter hides them from the API',()=>{
  const rows=[row('fb:1','camera',{marketplace:'fb',listing_id:'1',score:5})];
  const changed=applyRecheckResult(rows,{marketplace:'fb',listing_id:'1',item:'camera',status:'below_threshold',score:2,price:'$100'});
  assert.equal(mergeMatchRows(changed,[],true)[0].score,2);
  assert.equal(changed[0].current_price,'$100');
  assert.equal(applyRecheckResult(rows,{marketplace:'fb',listing_id:'1',original_item:'camera',item:'other',status:'passed',score:3})[0].score,5);
});

function viewHarness(t,{route='#/monitor/matches',saved='',matches=[],storageFails=false,storageReadOnly=false}={}) {
  const nodes=new Map(), controls=[], timers=new Map(), stored=new Map([['aimm-matches-view',saved]]), requests=[], exports=[];
  let timerId=0;
  const decode=value=>value.replaceAll('&amp;','&').replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>');
  function element(id='',attributes='') {
    return {id,dataset:{},hidden:/\bhidden\b/.test(attributes),disabled:/\bdisabled\b/.test(attributes),value:decode(attributes.match(/value="([^"]*)"/)?.[1]||''),textContent:'',
      setAttribute(){},hasAttribute(){return false;},addEventListener(name,fn){this['on'+name]=fn;},focus(){this.focused=true;},scrollIntoView(){},
      get innerHTML(){return this.html||'';},set innerHTML(html){this.html=html;if(id==='pane'){nodes.clear();nodes.set('pane',this);controls.length=0;}
        for(const match of html.matchAll(/<(?:button|input|select|div|span|aside)\b([^>]*)>/g)){
          const attributes=match[1], childId=attributes.match(/\bid="([^"]+)"/)?.[1], filter=attributes.match(/data-match-filter="([^"]+)"/)?.[1], status=attributes.match(/data-match-status="([^"]+)"/)?.[1];
          if(!childId&&!filter&&!status)continue;const child=element(childId,attributes);
          if(childId)nodes.set(childId,child);if(filter)child.dataset.matchFilter=filter;if(status)child.dataset.matchStatus=status;if(filter||status)controls.push(child);
        }
      }};
  }
  nodes.set('pane',element('pane'));
  const storage={getItem(key){if(storageFails)throw new Error('Storage blocked');return stored.get(key)||null;},setItem(key,value){if(storageFails||storageReadOnly)throw new Error('Storage full');stored.set(key,value);},removeItem(key){stored.delete(key);}};
  const globals={document:{querySelector:selector=>nodes.get(selector.slice(1))||null,querySelectorAll:selector=>selector==='[data-match-filter]'?controls.filter(el=>el.dataset.matchFilter):selector==='[data-match-status]'?controls.filter(el=>el.dataset.matchStatus):[],getElementById:id=>nodes.get(id)},localStorage:storage,sessionStorage:{...storage,getItem:()=>null},history:{replaceState(){}},setInterval:()=>0,setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)};
  for(const [key,value] of Object.entries(globals)){const original=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});t.after(()=>{if(original)Object.defineProperty(globalThis,key,original);else delete globalThis[key];});}
  const state={route,config:{item:{camera:{},gear:{}}},records:[],status:{}};
  const view=createMatchesView({state,json:async url=>{requests.push(url);return {matches,counts:{all:matches.length},groups:[{item:'camera',count:matches.length}]};},pageHeader:(_title,_description,actions)=>actions,exportCsv:options=>exports.push(options),toast(){},renderSidebar(){},searchSummary:()=>''});
  return {state,view,stored,requests,exports,node:id=>nodes.get(id),filter:(name,value)=>{const control=controls.find(el=>el.dataset.matchFilter===name);control.value=value;control.onchange();},status:name=>controls.find(el=>el.dataset.matchStatus===name).onclick(),flush:async()=>{await Promise.resolve();},tick:async()=>{const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn());await Promise.resolve();}};
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
  assert.equal(h.node('match-previous').disabled,true);
  assert.match(h.node('match-detail').innerHTML,/1 of 5 loaded/);
  for(const [position,id] of [[2,3],[3,4],[4,5],[5,2]]){
    h.node('match-next').onclick();
    assert.match(h.node('match-detail').innerHTML,new RegExp(`<h2>Listing ${id}</h2>`));
    assert.ok(h.node('match-detail').innerHTML.includes(`${position} of 5 loaded`));
  }
  assert.equal(h.node('match-next').disabled,true);assert.equal(h.node('match-detail').focused,true);
  assert.match(h.node('matches-body').innerHTML,/data-match-row="3"/);
  h.node('match-previous').onclick();assert.match(h.node('match-detail').innerHTML,/<h2>Listing 5<\/h2>/);
});

test('arrow keys navigate match details while preserving field editing and modifier shortcuts',async t=>{
  const h=viewHarness(t,{matches:[row('fb:1','camera',{title:'First',state:{filed_under:[]},notified_users:[]}),row('fb:2','camera',{title:'Second',state:{filed_under:[]},notified_users:[]})]});
  h.view.render();await h.flush();
  const key=(key,editing=false,extra={})=>{let prevented=false;h.node('matches-body').onkeydown({key,target:{closest:selector=>selector.startsWith('input')?editing:true},preventDefault(){prevented=true;},...extra});return prevented;};
  assert.equal(key('ArrowRight',true),false);assert.equal(key('ArrowRight',false,{ctrlKey:true}),false);
  assert.match(h.node('match-detail').innerHTML,/<h2>First<\/h2>/);
  assert.equal(key('ArrowRight'),true);assert.match(h.node('match-detail').innerHTML,/<h2>Second<\/h2>/);
  assert.equal(h.node('matches-announcement').textContent,'Second. Match 2 of 2 loaded.');
  assert.equal(key('ArrowLeft'),true);assert.match(h.node('match-detail').innerHTML,/<h2>First<\/h2>/);
});

test('seller assessment appears separately with escaped reasons and safe profile links',async t=>{
  const listing=row('fb:1','camera',{score:5,conclusion:'Great deal',state:{filed_under:[]},notified_users:[],seller_assessment:{status:'caution',reasons:['Low seller rating','<img src=x onerror=alert(1)>'],profile_url:'https://www.facebook.com/marketplace/profile/123/',checked_at:'2026-10-04T01:00:00Z'}});
  const h=viewHarness(t,{matches:[listing]});h.view.render();await h.flush();
  assert.match(h.node('matches-body').innerHTML,/Seller: Caution/);
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
