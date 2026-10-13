import test from 'node:test';
import assert from 'node:assert/strict';
import {createSearchChatView,hideSearchBlock,priceCheckHtml,searchChatHtml} from '../src/ai_marketplace_monitor/webui/static/search-chat.js';

const container=()=>({innerHTML:'',querySelector:()=>null});
const streamOf=chunks=>new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(new TextEncoder().encode(chunk));controller.close();}});
const settle=()=>new Promise(resolve=>setTimeout(resolve));

test('search blocks stay hidden, including while still streaming',()=>{
  assert.equal(hideSearchBlock('Done. **Ready**\n<search>{"max_price": 300}</search>'),'Done. Ready');
  assert.equal(hideSearchBlock('Done.\n<search>{"search_phr'),'Done.');
  assert.equal(hideSearchBlock('Which size?'),'Which size?');
});

test('chat markup offers web search only when the backend supports it',()=>{
  assert.ok(!searchChatHtml().includes('search-chat-web'));
  assert.ok(!searchChatHtml().includes('data-chat-starter'));
  const existing=searchChatHtml({isNew:false,backend:'<mimo>',canSearchWeb:true,webSearch:true});
  assert.match(existing,/id="search-chat-web" checked/);
  assert.match(existing,/&lt;mimo&gt; · not saved/);
  assert.match(existing,/data-chat-starter="Make it stricter"/);
  const replied=searchChatHtml({messages:[{role:'user',content:'bike'},{role:'assistant',content:'Done <search>{}</search>',applied:['Search phrases','Max price'],warning:'No fields changed'}]});
  assert.match(replied,/data-chat-reply>Done</);
  assert.match(replied,/Updated Search phrases, Max price/);
  assert.match(replied,/No fields changed/);
});

test('each turn sends the current fields and applies the returned ones',async()=>{
  const requests=[], applied=[], node=container();
  const responses=[
    new Response(JSON.stringify({backend:'anthropic',web_search:true})),
    new Response(streamOf(['{"text":"Done. <search>"}\n','{"text":"{}</search>"}\n','{"fields":{"max_price":"300"}}\n'])),
  ];
  const form={new:false,name:'camera'};
  const view=createSearchChatView({
    api:async(url,options={})=>{requests.push({url,body:options.body&&JSON.parse(options.body)});return responses.shift();},
    currentFields:()=>({description:'A camera'}),
    applyFields:fields=>{applied.push(fields);return ['Max price'];},
  });
  view.mount(node,form);await settle();
  assert.equal(requests[0].url,'/api/items/suggest?item=camera');
  assert.match(node.innerHTML,/search-chat-web/);
  node.onchange({target:{id:'search-chat-web',checked:true}});
  await view.send(' cheaper please ');
  assert.deepEqual(requests[1].body,{item:'camera',messages:[{role:'user',content:'cheaper please'}],fields:{description:'A camera'},web_search:true});
  assert.deepEqual(applied,[{max_price:'300'}]);
  assert.match(node.innerHTML,/data-chat-reply>Done\.</);
  assert.match(node.innerHTML,/Updated Max price/);
});

test('an unavailable AI is reported and a refused message is kept as the draft',async()=>{
  const node=container(), responses=[
    new Response(JSON.stringify({detail:'No enabled AI service is configured for this search.'}),{status:503}),
    new Response(JSON.stringify({detail:'mimo cannot chat. Use a chat-capable AI.'}),{status:503}),
  ];
  const view=createSearchChatView({api:async()=>responses.shift(),currentFields:()=>({}),applyFields:()=>[]});
  view.mount(node,{new:true,name:'new_search'});await settle();
  assert.match(node.innerHTML,/No enabled AI service/);
  await view.send('a bike');
  assert.match(node.innerHTML,/cannot chat/);
  assert.ok(!node.innerHTML.includes('chat-msg'));
  assert.match(node.innerHTML,/<textarea[^>]*>a bike<\/textarea>/);
});

const priceResult={count:12,excluded:2,unpriced:1,currency:'$',other_currencies:{'€':1},low:40,p25:120,median:180,p75:1260,high:600,examples:[{title:'<b>Hero 12</b>',price:'$180',location:'Houston',url:'https://www.facebook.com/marketplace/item/1/'},{title:'Bad link',price:'$90',url:'javascript:alert(1)'}],searched:{phrases:['gopro hero 12'],cities:['houston']},context:'<facebook_price_check>\nprices\n</facebook_price_check>'};

test('price card shows the typical range, safe links and its state',()=>{
  const done=priceCheckHtml({state:'done',result:priceResult});
  assert.match(done,/\$120–\$1,260<\/strong> typical · median \$180 · range \$40–\$600/);
  assert.match(done,/12 listings · 2 excluded by anti-keywords · 1 in € not counted\. Searched “gopro hero 12” in houston\./);
  assert.match(done,/<a href="https:\/\/www\.facebook\.com\/marketplace\/item\/1\/"[^>]*>&lt;b&gt;Hero 12&lt;\/b&gt;<\/a>/);
  assert.ok(!done.includes('javascript:'));
  assert.match(done,/data-price-apply/);
  assert.match(priceCheckHtml({state:'done',result:priceResult,applied:[]}),/Already set to the typical range/);
  assert.match(priceCheckHtml({state:'running'}),/data-price-stop/);
  assert.match(priceCheckHtml({state:'done',result:{...priceResult,count:0}}),/No priced listings found/);
  assert.match(searchChatHtml({priceCheck:{state:'running'}}),/data-price-check disabled/);
});

test('a price check polls to completion, applies the range on request and reaches the AI once',async()=>{
  const requests=[], applied=[], node=container();
  const responses=[
    new Response(JSON.stringify({backend:'mimo',web_search:false})),
    new Response(JSON.stringify({job_id:'job',state:'queued',result:null,error:''})),
    new Response(JSON.stringify({job_id:'job',state:'running',result:null,error:''})),
    new Response(JSON.stringify({job_id:'job',state:'done',result:priceResult,error:''})),
    new Response(streamOf(['{"text":"That looks right."}\n'])),
    new Response(streamOf(['{"text":"Sure."}\n'])),
  ];
  const view=createSearchChatView({
    api:async(url,options={})=>{requests.push({url,method:options.method||'GET',body:options.body&&JSON.parse(options.body)});return responses.shift();},
    currentFields:()=>({search_phrases:['gopro hero 12'],antikeywords:'case'}),
    applyFields:fields=>{applied.push(fields);return ['Min price','Max price'];},
    pollMs:0,
  });
  view.mount(node,{new:true,name:'new_search'});await settle();
  await view.checkPrices();
  assert.deepEqual(requests[1],{url:'/api/items/price-check',method:'POST',body:{item:'',search_phrases:['gopro hero 12'],antikeywords:['case']}});
  assert.deepEqual(requests.slice(2,4).map(request=>request.url),['/api/items/price-check/job','/api/items/price-check/job']);
  assert.match(node.innerHTML,/The AI sees these results with your next message/);
  node.onclick({target:{closest:()=>({disabled:false,dataset:{},hasAttribute:name=>name==='data-price-apply'})}});
  assert.deepEqual(applied,[{min_price:'120',max_price:'1260'}]);
  assert.match(node.innerHTML,/Updated Min price, Max price/);
  await view.send('is that fair?');
  assert.equal(requests[4].body.messages[0].content,'<facebook_price_check>\nprices\n</facebook_price_check>\n\nis that fair?');
  assert.match(node.innerHTML,/<p>is that fair\?<\/p>/);
  assert.match(node.innerHTML,/Shared with the AI\./);
  await view.send('thanks');
  assert.equal(requests[5].body.messages.at(-1).content,'thanks');
});

test('a price check needs search phrases and reports failures',async()=>{
  const node=container();
  const view=createSearchChatView({api:async()=>new Response(JSON.stringify({detail:'A price check is already running; wait for it to finish'}),{status:409}),currentFields:()=>({}),applyFields:()=>[],pollMs:0});
  view.mount(node,{new:true,name:'new_search'});await settle();
  await view.checkPrices();
  assert.match(node.innerHTML,/Add search phrases first/);
  const busy=createSearchChatView({api:async()=>new Response(JSON.stringify({detail:'A price check is already running; wait for it to finish'}),{status:409}),currentFields:()=>({search_phrases:['bike']}),applyFields:()=>[],pollMs:0});
  const other=container();busy.mount(other,{new:true,name:'x'});await settle();
  await busy.checkPrices();
  assert.match(other.innerHTML,/already running/);
});
