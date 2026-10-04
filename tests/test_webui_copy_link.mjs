import test from 'node:test';
import assert from 'node:assert/strict';
import {createMatchesView} from '../src/ai_marketplace_monitor/webui/static/matches.js';

async function detailView(t, url, clipboard) {
  const elements=new Map(), messages=[];
  function element(id, attributes='') {
    const node={id,hidden:attributes.includes('hidden'),isConnected:true,disabled:false,
      addEventListener(){},focus(){this.focused=true;},select(){this.selected=true;}};
    Object.defineProperty(node,'innerHTML',{get(){return this.html||'';},set(html){
      this.html=html;
      for(const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g))elements.set(match[1],element(match[1],match[0]));
    }});
    return node;
  }
  elements.set('pane',element('pane'));
  const storage={getItem(){return null;},setItem(){},removeItem(){}};
  const globals={
    document:{querySelector:selector=>elements.get(selector.slice(1))||null,querySelectorAll:()=>[]},
    navigator:{clipboard},localStorage:storage,sessionStorage:storage,history:{replaceState(){}},setInterval:()=>0,
  };
  for(const [key,value] of Object.entries(globals)){
    const original=Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
    t.after(()=>{if(original)Object.defineProperty(globalThis,key,original);else delete globalThis[key];});
  }
  const row={key:'fb:1',item:'camera',url,title:'Camera',filed_under:[],notified_users:[],state:{filed_under:[]}};
  const view=createMatchesView({
    state:{route:'#/monitor/matches',config:{item:{camera:{}}},records:[],status:{}},
    json:async()=>({matches:[row],counts:{all:1},groups:[{item:'camera',count:1}]}),
    pageHeader:(_title,_description,actions)=>actions,exportCsv(){},toast:message=>messages.push(message),renderSidebar(){},searchSummary:()=>'',
  });
  view.render();
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(elements.get('match-detail').innerHTML,/Camera/);
  return {elements,messages};
}

test('copy link writes the selected URL and reports success after the clipboard resolves',async t=>{
  const url='https://www.facebook.com/marketplace/item/123/?ref=share&source=match', copied=[];
  let resolveCopy;
  const {elements,messages}=await detailView(t,url,{writeText:value=>{copied.push(value);return new Promise(resolve=>{resolveCopy=resolve;});}});
  const button=elements.get('copy-listing-link'), pending=button.onclick();
  assert.equal(button.disabled,true);
  assert.deepEqual(copied,[url]);
  assert.deepEqual(messages,[]);
  resolveCopy();await pending;
  assert.deepEqual(messages,['Listing link copied.']);
  assert.equal(button.disabled,false);
  assert.equal(elements.get('copy-link-fallback').hidden,true);
});

for(const [name,clipboard] of [
  ['clipboard permission denied',{writeText:async()=>{throw new Error('NotAllowedError');}}],
  ['clipboard unavailable on an HTTP console',undefined],
])test(`${name} reveals and selects the listing URL for manual copying`,async t=>{
  const url='https://www.facebook.com/marketplace/item/123/';
  const {elements,messages}=await detailView(t,url,clipboard);
  await elements.get('copy-listing-link').onclick();
  assert.equal(elements.get('copy-link-fallback').hidden,false);
  assert.equal(elements.get('listing-link').focused,true);
  assert.equal(elements.get('listing-link').selected,true);
  assert.ok(elements.get('match-detail').innerHTML.includes(`readonly value="${url}"`));
  assert.deepEqual(messages,['Could not copy automatically. Copy the selected listing link.']);
  assert.equal(elements.get('copy-listing-link').disabled,false);
});

for(const url of ['javascript:alert(1)','data:text/html,unsafe','not a URL',''])test(`unsafe or missing URL ${JSON.stringify(url)} has no copy control`,async t=>{
  const {elements}=await detailView(t,url,{writeText:()=>assert.fail('Unsafe link copied')});
  assert.equal(elements.has('copy-listing-link'),false);
  assert.equal(elements.has('listing-link'),false);
  assert.doesNotMatch(elements.get('match-detail').innerHTML,/Open on Facebook/);
});
