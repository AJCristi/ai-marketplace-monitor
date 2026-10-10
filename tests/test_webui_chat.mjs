import test from 'node:test';
import assert from 'node:assert/strict';
import {chatEvents,chatHtml,createChatView} from '../src/ai_marketplace_monitor/webui/static/chat.js';

const row={marketplace:'facebook',listing_id:'one',item:'camera',photos:[{digest:'a'},{digest:'b'}]};
const container=()=>({innerHTML:'',querySelector:()=>null});
const streamOf=chunks=>new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(new TextEncoder().encode(chunk));controller.close();}});
const collect=async body=>{const events=[];for await(const event of chatEvents(body))events.push(event);return events;};

test('stream events survive lines and characters split across chunks',async()=>{
  const bytes=new TextEncoder().encode('{"text":"€5"}\n{"text":" ok"}\n{"error":"down"}');
  const chunks=[bytes.slice(0,11),bytes.slice(11,20),bytes.slice(20)];
  const body=new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(chunk);controller.close();}});
  assert.deepEqual(await collect(body),[{text:'€5'},{text:' ok'},{error:'down'}]);
});

test('chat markup escapes messages and only offers photos when the match has them',()=>{
  const html=chatHtml(row,{messages:[{role:'user',content:'<b>hi</b>'},{role:'assistant',content:'**Fair** price'}]});
  assert.match(html,/&lt;b&gt;hi&lt;\/b&gt;/);
  assert.match(html,/data-chat-reply>Fair price</);
  assert.match(html,/Include photos \(2\)/);
  assert.ok(!chatHtml({...row,photos:[]}).includes('chat-photos'));
  assert.match(chatHtml(row),/data-chat-starter="Is the price fair\?"/);
  assert.match(chatHtml(row,{messages:[{role:'user',content:'q'},{role:'assistant',content:''}],busy:true}),/data-chat-stop/);
});

test('a streamed reply joins the history sent with the next question',async()=>{
  const requests=[],replies=[['{"text":"Looks "}\n','{"text":"fair."}\n'],['{"text":"Ask for receipts."}\n']];
  const node=container();
  const view=createChatView({api:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return new Response(streamOf(replies.shift()));}});
  view.mount(node,row);
  await view.send('Is the price fair?');
  assert.match(node.innerHTML,/Looks fair\./);
  await view.send('  What next?  ');
  assert.equal(requests[0].url,'/api/matches/facebook/one/chat');
  assert.deepEqual(requests[0].body,{item:'camera',messages:[{role:'user',content:'Is the price fair?'}],photos:false});
  assert.deepEqual(requests[1].body.messages,[{role:'user',content:'Is the price fair?'},{role:'assistant',content:'Looks fair.'},{role:'user',content:'What next?'}]);
  assert.match(node.innerHTML,/Ask for receipts\./);
});

test('a refused question is removed and kept as the draft; a broken stream keeps the partial answer',async()=>{
  const node=container(), responses=[
    new Response(JSON.stringify({detail:'No enabled AI service is configured for this search.'}),{status:503}),
    new Response(streamOf(['{"text":"Partly"}\n{"error":"fake failed to answer. See the log."}\n'])),
  ];
  const view=createChatView({api:async()=>responses.shift()});
  view.mount(node,row);
  await view.send('Any red flags?');
  assert.match(node.innerHTML,/No enabled AI service/);
  assert.ok(!node.innerHTML.includes('chat-msg'));
  assert.match(node.innerHTML,/<textarea[^>]*>Any red flags\?<\/textarea>/);
  await view.send('Any red flags?');
  assert.match(node.innerHTML,/Partly/);
  assert.match(node.innerHTML,/fake failed to answer/);
});

test('each match keeps its own conversation',async()=>{
  const node=container();
  const view=createChatView({api:async()=>new Response(streamOf(['{"text":"Yes"}\n']))});
  view.mount(node,row);
  await view.send('First?');
  view.mount(node,{...row,listing_id:'two'});
  assert.ok(!node.innerHTML.includes('First?'));
  view.mount(node,row);
  assert.match(node.innerHTML,/First\?/);
});
