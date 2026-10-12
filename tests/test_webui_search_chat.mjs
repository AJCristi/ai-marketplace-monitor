import test from 'node:test';
import assert from 'node:assert/strict';
import {createSearchChatView,hideSearchBlock,searchChatHtml} from '../src/ai_marketplace_monitor/webui/static/search-chat.js';

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
