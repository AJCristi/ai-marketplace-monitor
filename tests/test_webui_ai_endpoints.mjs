import test from 'node:test';
import assert from 'node:assert/strict';
import {aiUsageText,bindEndpointForm,endpointFieldHtml,endpointPlaceholder,endpointStatusHtml,resetEndpointForm} from '../src/ai_marketplace_monitor/webui/static/ai-endpoints.js';

function fakeRoot({provider='openai',baseUrl='',model='gpt-4o'}={}){
  const select={innerHTML:'',onchange:null};
  const elements={
    '#ai-model-pick':{hidden:true,querySelector:()=>select},
    '#ai-model-status':{textContent:'',className:'hint'},
    '#field-model':{value:model,placeholder:'',events:[],dispatchEvent(event){this.events.push(event.type);}},
    '#field-base_url':{value:baseUrl,placeholder:''},
    '[data-fetch-models]':{disabled:false,onclick:null},
    '#provider-choice':{value:provider},
  };
  return {select,elements,querySelector:selector=>elements[selector]};
}

test('placeholders show each provider default, or what is required',()=>{
  assert.equal(endpointPlaceholder('base_url','openai'),'Default: https://api.openai.com/v1');
  assert.equal(endpointPlaceholder('model','gemini'),'Default: gemini-2.5-flash');
  assert.equal(endpointPlaceholder('model','ollama'),'Required, e.g. deepseek-r1:14b');
  assert.equal(endpointPlaceholder('base_url','cloudflare'),'Workers AI URL built from the account ID');
  assert.equal(endpointPlaceholder('model','custom'),'');
  const html=endpointFieldHtml({key:'model',id:'field-model',value:'"gpt"',provider:'openai'});
  assert.match(html,/value="&quot;gpt&quot;" placeholder="Default: gpt-4o"/);
  assert.match(html,/data-fetch-models/);
  assert.ok(!endpointFieldHtml({key:'base_url',id:'field-base_url',value:'',provider:'openai'}).includes('data-fetch-models'));
});

test('usage names marketplaces, searches and Clef comment duties',()=>{
  const config={marketplace:{facebook:{ai:['cloudflare','openai']}},item:{camera:{ai:'openai'},bike:{}},ai:{cloudflare:{comment_ai:'openai'},openai:{}}};
  assert.equal(aiUsageText(config,'openai'),'Used by marketplace facebook, search camera, comment AI for cloudflare');
  assert.match(aiUsageText(config,'unused'),/Not named by a marketplace or search/);
});

test('status distinguishes checked connections, fixed lists, errors and progress',()=>{
  assert.match(endpointStatusHtml({checked:true,models:['a','b']}),/class="ok">Connected · 2 models/);
  assert.match(endpointStatusHtml({checked:false,models:['clef','clef-flash']}),/clef, clef-flash · fixed list/);
  assert.match(endpointStatusHtml({error:'HTTP 401 <x>'}),/class="err">HTTP 401 &lt;x&gt;/);
  assert.match(endpointStatusHtml({busy:true}),/Checking/);
  assert.equal(endpointStatusHtml(undefined),'');
});

test('fetching models sends draft values and fills a picker that edits the model field',async()=>{
  const root=fakeRoot({provider:'ollama',baseUrl:'http://localhost:11434/v1',model:'llama3'});
  const requests=[],seen=[];
  const json=async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {models:['llama3','qwen<3>'],checked:true};};
  bindEndpointForm({root,json,form:{name:'local',fields:{},changes:{api_key:'${OLLAMA_KEY}'}},onModels:(name,result)=>seen.push([name,result.models.length])});
  await root.elements['[data-fetch-models]'].onclick();
  assert.deepEqual(requests,[{url:'/api/ai/models',body:{name:'local',provider:'ollama',base_url:'http://localhost:11434/v1',api_key:'${OLLAMA_KEY}'}}]);
  assert.equal(root.elements['#ai-model-pick'].hidden,false);
  assert.match(root.select.innerHTML,/Choose one of 2 models/);
  assert.match(root.select.innerHTML,/<option value="llama3" selected>/);
  assert.match(root.select.innerHTML,/qwen&lt;3&gt;/);
  assert.equal(root.elements['#ai-model-status'].textContent,'Connected · 2 models');
  assert.deepEqual(seen,[['local',2]]);
  root.select.onchange({target:{value:'qwen<3>'}});
  assert.equal(root.elements['#field-model'].value,'qwen<3>');
  assert.deepEqual(root.elements['#field-model'].events,['input']);
  assert.equal(root.elements['[data-fetch-models]'].disabled,false);
});

test('a saved key is never sent back and fetch errors stay visible',async()=>{
  const root=fakeRoot();
  const requests=[];
  const json=async(url,options)=>{requests.push(JSON.parse(options.body));throw new Error('openai did not list models: 401');};
  const seen=[];
  bindEndpointForm({root,json,form:{name:'openai',fields:{api_key:'<REDACTED>'},changes:{}},onModels:(name,result)=>seen.push(result)});
  await root.elements['[data-fetch-models]'].onclick();
  assert.ok(!('api_key' in requests[0]));
  assert.equal(root.elements['#ai-model-status'].textContent,'openai did not list models: 401');
  assert.equal(root.elements['#ai-model-status'].className,'hint err');
  assert.equal(root.elements['#ai-model-pick'].hidden,true);
  assert.deepEqual(seen,[{error:'openai did not list models: 401'}]);
});

test('changing provider refreshes placeholders and clears fetched models',()=>{
  const root=fakeRoot();
  root.elements['#ai-model-pick'].hidden=false;root.elements['#ai-model-status'].textContent='Connected · 9 models';
  resetEndpointForm(root,'deepseek');
  assert.equal(root.elements['#field-model'].placeholder,'Default: deepseek-chat');
  assert.equal(root.elements['#field-base_url'].placeholder,'Default: https://api.deepseek.com');
  assert.equal(root.elements['#ai-model-pick'].hidden,true);
  assert.equal(root.elements['#ai-model-status'].textContent,'');
});
