import test from 'node:test';
import assert from 'node:assert/strict';
import {aiTestFormHtml,aiTestResultHtml,createAiTestView,decisionsHtml} from '../src/ai_marketplace_monitor/webui/static/ai-test.js';

const match={marketplace:'facebook',listing_id:'1',item:'camera',title:'<Canon>',photos:[{digest:'a'}]};
const clefTrace={
  backend:'clef',model:'clef-flash',rating:4,conclusion:'Good match',comment:'Worth a look.',comment_source:'openai',latency_ms:41,
  request:{model:'clef-flash',images:['<5-byte WebP>']},
  response:{answers:{
    rating:{type:'score',score:3.4,legend:{'3':'Good <match>','4':'Great deal'},probabilities:{'3':0.6,'4':0.4},confidence:0.7},
    scam_risk:{type:'noul',noul:0.03},
  },usage:{input_tokens:512,output_tokens:0}},
  steps:[{ms:0,message:'Built a request'},{ms:41,message:'clef-flash answered in 41 ms'}],
};

function fakePane(){
  const fields={'#ai-test-backend':{},'#ai-test-match':{},'#ai-test-photos':{}};
  const form={querySelector:selector=>fields[selector]};
  const pane={innerHTML:'',form,fields,querySelector:selector=>selector==='#ai-test-form'&&pane.innerHTML.includes('id="ai-test-form"')?form:null};
  return pane;
}

test('the form explains missing backends or matches and escapes match titles',()=>{
  assert.match(aiTestFormHtml({backends:[],matches:[match],selection:{},busy:false}),/No enabled AI sections/);
  assert.match(aiTestFormHtml({backends:['clef'],matches:[],selection:{},busy:false}),/No saved matches yet/);
  const html=aiTestFormHtml({backends:['clef','openai'],matches:[match],selection:{backend:'openai',photos:true},busy:true});
  assert.match(html,/&lt;Canon&gt; · camera · 1 photos/);
  assert.match(html,/<option value="openai" selected>/);
  assert.match(html,/id="ai-test-photos" checked/);
  assert.match(html,/disabled>Running…/);
});

test('decisions show each question type with probabilities and escaped legends',()=>{
  const html=decisionsHtml(clefTrace.response.answers);
  assert.match(html,/scam_risk<\/th><td>yes \/ no<\/td><td>.*3% yes/);
  assert.match(html,/level 3\.40 · 70% confident/);
  assert.match(html,/60% <span class="mu">Good &lt;match&gt;<\/span>/);
  assert.match(html,/style="width:40%"/);
});

test('a result shows the rating, comment source, tokens, steps and raw exchange',()=>{
  const html=aiTestResultHtml(clefTrace);
  assert.match(html,/★★★★☆<\/span> 4\/5 · Good match/);
  assert.match(html,/Worth a look\. <span class="xs d">from openai/);
  assert.match(html,/512 in · 0 out/);
  assert.match(html,/\+41 ms<\/span> clef-flash answered in 41 ms/);
  assert.match(html,/&lt;5-byte WebP&gt;/);
  assert.match(html,/<h2>Decisions<\/h2>/);
  const llm=aiTestResultHtml({backend:'openai',steps:[],response:'Rating 5: buy',error:'Failed <x>'});
  assert.match(llm,/role="alert">Failed &lt;x&gt;/);
  assert.ok(!llm.includes('<h2>Decisions</h2>'));
  assert.equal(aiTestResultHtml(null),'');
});

test('the view loads matches once, posts the selection and draws the trace',async()=>{
  const requests=[];
  let active=true;
  const json=async(url,options)=>{requests.push({url,body:options?.body&&JSON.parse(options.body)});return url.startsWith('/api/matches')?{matches:[match]}:clefTrace;};
  const view=createAiTestView({json,pageHeader:title=>`<h1>${title}</h1>`,isActive:()=>active});
  const pane=fakePane();
  await view.render(pane,['clef']);
  assert.match(pane.innerHTML,/id="ai-test-form"/);
  pane.fields['#ai-test-photos'].onchange({target:{checked:false}});
  await pane.form.onsubmit({preventDefault(){}});
  assert.deepEqual(requests.at(-1),{url:'/api/ai/test',body:{backend:'clef',marketplace:'facebook',listing_id:'1',item:'camera',photos:false}});
  assert.match(pane.innerHTML,/4\/5 · Good match/);
  await view.render(pane,['clef']);
  assert.equal(requests.filter(request=>request.url.startsWith('/api/matches')).length,1);
  active=false;pane.innerHTML='other page';
  await view.render(pane,['clef']);
  assert.equal(pane.innerHTML,'other page');
});

test('a failed request is shown without losing the form',async()=>{
  const json=async url=>{if(url.startsWith('/api/matches'))return {matches:[match]};throw new Error('AI section clef is not enabled.');};
  const view=createAiTestView({json,pageHeader:()=>'',isActive:()=>true});
  const pane=fakePane();
  await view.render(pane,['clef']);
  await pane.form.onsubmit({preventDefault(){}});
  assert.match(pane.innerHTML,/role="alert">AI section clef is not enabled\./);
  assert.match(pane.innerHTML,/id="ai-test-form"/);
});
