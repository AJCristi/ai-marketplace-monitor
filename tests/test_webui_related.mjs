import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelatedView,relatedHtml} from '../src/ai_marketplace_monitor/webui/static/related.js';

const row={marketplace:'facebook',listing_id:'one',title:'This item',image:'https://scontent.fbcdn.net/one.jpg'};
const container=()=>({innerHTML:'',querySelectorAll:()=>[]});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const button=(refresh=false)=>({disabled:false,dataset:{findRelated:refresh?'refresh':''},hasAttribute:name=>name==='data-find-related'});
const click=(node,control)=>node.onclick({target:{closest:()=>control}});

test('manual model errors and automatic skips show the reason instead of a no-match result',()=>{
  for(const status of ['error','skipped']){
    const html=relatedHtml(row,{last_check:{status,reason:'Model rejected <image> inputs'}});
    assert.match(html,/Model rejected &lt;image&gt; inputs/);
    assert.ok(!html.includes('No connections flagged'));
    assert.match(html,/Recheck/);
    assert.ok(!html.includes('data-find-related disabled'));
  }
});

test('related evidence is escaped, unsafe links omitted and dismissal is distinct from listing dismissal',()=>{
  const html=relatedHtml(row,{related:[{pair_id:'test',decision:'matching_plate',review:'dismissed',other:{title:'<script>bad</script>',image:'javascript:bad',url:'javascript:bad'},evidence:['<img onerror=bad>']}]});
  assert.ok(!html.includes('<script>')&&!html.includes('javascript:'));
  assert.match(html,/&lt;img onerror=bad&gt;/);
  assert.match(html,/Restore connection/);
  assert.match(html,/Matching plate/);
});

test('manual find and fresh recheck use the same endpoint when automatic is off',async()=>{
  const calls=[],node=container();
  const view=createRelatedView({toast:()=>{},json:async(url,options)=>{calls.push({url,options});return {budget:{automatic:false,used_usd:0,limit_usd:1}};}});
  view.mount(node,row);await flush();
  await click(node,button());
  await click(node,button(true));
  assert.deepEqual(calls.filter(call=>call.options).map(call=>JSON.parse(call.options.body)),[{refresh:false},{refresh:true}]);
  assert.match(node.innerHTML,/Automatic checks off/);
});

test('duplicate manual clicks are blocked while the request is pending',async()=>{
  let finish;const calls=[],node=container();
  const view=createRelatedView({toast:()=>{},json:async(url,options)=>{calls.push({url,options});if(options)return new Promise(resolve=>{finish=resolve;});return {};}});
  view.mount(node,row);await flush();
  const first=click(node,button());await flush();await click(node,button());
  assert.equal(calls.filter(call=>call.options).length,1);
  finish({});await first;
});

test('late responses cannot replace the newly selected listing or a departed view',async()=>{
  let finish;const a=container(),b=container();
  const view=createRelatedView({toast:()=>{},json:async url=>url.includes('/one/')?new Promise(resolve=>{finish=resolve;}):{error:'Second listing'}});
  view.mount(a,row);view.mount(b,{...row,listing_id:'two'});await flush();
  finish({error:'Old listing'});await flush();
  assert.match(b.innerHTML,/Second listing/);assert.ok(!b.innerHTML.includes('Old listing'));
  view.mount(a,row);const before=a.innerHTML;view.unmount();finish({error:'Late'});await flush();
  assert.equal(a.innerHTML,before);
});

test('API failures remain visible and restore manual controls',async()=>{
  const node=container(),messages=[];
  const view=createRelatedView({toast:message=>messages.push(message),json:async(url,options)=>{if(options)throw Error('Daily budget reached');return {};}});
  view.mount(node,row);await flush();const control=button();await click(node,control);
  assert.match(node.innerHTML,/Daily budget reached/);assert.equal(control.disabled,false);
  assert.deepEqual(messages,['Daily budget reached']);
});

test('review writes identify the connection and preserve the chosen review state',async()=>{
  const calls=[],node=container();
  const view=createRelatedView({toast:()=>{},json:async(url,options)=>{calls.push({url,options});return {};}});
  view.mount(node,row);await flush();
  await click(node,{disabled:false,dataset:{pair:'abc',review:'confirmed'},hasAttribute:()=>false});
  const write=calls.find(call=>call.options);
  assert.equal(write.url,'/api/matches/facebook/one/related/abc');
  assert.equal(write.options.method,'PUT');assert.deepEqual(JSON.parse(write.options.body),{review:'confirmed'});
});


test('related photos use the archived snapshot and never render remote CDN sources',()=>{
  const snapshot={...row,photos:[{digest:'a'.repeat(64)}]};
  const html=relatedHtml(row,{related:[{pair_id:'test',source:snapshot,other:{...snapshot,listing_id:'two'}}]});
  assert.match(html,/src="\/api\/matches\/facebook\/one\/photos\/a{64}\.webp"/);
  assert.match(html,/src="\/api\/matches\/facebook\/two\/photos\/a{64}\.webp"/);
  assert.doesNotMatch(html,/fbcdn/);
});
