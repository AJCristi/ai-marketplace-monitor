import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import init, {parse,edit} from '../src/ai_marketplace_monitor/webui/static/vendor/toml-edit-js/shims.js';
import * as model from '../src/ai_marketplace_monitor/webui/static/console-model.js';
import {FORM_SCHEMAS,BUILT_IN_REGIONS} from '../src/ai_marketplace_monitor/webui/static/fields.js';

await init({module_or_path:await readFile(new URL('../src/ai_marketplace_monitor/webui/static/vendor/toml-edit-js/index_bg.wasm',import.meta.url))});
const source=await readFile(new URL('../src/ai_marketplace_monitor/webui/static/app.js',import.meta.url),'utf8');
function consoleUnderTest() {
  // Execute the production form functions with inert browser startup controls.
  // Network/bootstrap are excluded; edits still use the actual TOML WASM.
  // Clone values across the test VM boundary so WASM receives its own realm's objects.
  const controls=new Map();
  const control=selector=>{
    if(!controls.has(selector))controls.set(selector,{value:'openai',dataset:{},open:false,setAttribute(){},addEventListener(){},focus(){this.focused=true;},scrollIntoView(){},showModal(){this.open=true;},close(){this.open=false;}});
    return controls.get(selector);
  };
  const document={querySelector:control,querySelectorAll:()=>[],addEventListener(){},cookie:''};
  const sandbox={...model,parse,edit:(content,path,value)=>edit(content,path,structuredClone(value)),FORM_SCHEMAS,BUILT_IN_REGIONS,document,location:{hash:'#/monitor'},history:{replaceState(){}},window:{addEventListener(){}},localStorage:{getItem:()=>null},structuredClone,URLSearchParams,URL,console,setTimeout:()=>0,clearTimeout(){}};
  const context=vm.createContext(sandbox);
  vm.runInContext(source.slice(0,source.lastIndexOf('try{await initToml')).replace(/^import .*;\r?\n/gm,'')+'\nresult={state,prepareForm,candidateFromForm,fieldDefault,refreshData,locationHtml,renderFeed,acceptRecords,renderConflict,deleteSection,showLogin,bindChips,saveRaw,toggleSearch,renderActivity,exportCsv};',context);
  sandbox.result.control=control;
  sandbox.result.run=(code,values={})=>{Object.assign(sandbox,values);return vm.runInContext(code,context);};
  return sandbox.result;
}

test('notification form defaults include normalized shared values',()=>{
  const app=consoleUnderTest();
  app.state.context={inherited:{},notification_values:{gmail:{smtp_server:'smtp.example.com',rate_limit_enabled:false,global_rate_limit:10}}};
  app.state.content='[user.me]\nemail="me@example.com"\n[notification.gmail]\nsmtp_server="smtp.example.com"\n';
  app.refreshData();app.prepareForm('user','me');
  assert.equal(app.fieldDefault(app.state.form,'rate_limit_enabled'),false);
  assert.equal(app.fieldDefault(app.state.form,'global_rate_limit'),10);
});

test('one currency chip applies to every region city',()=>{
  const app=consoleUnderTest();app.state.content='';app.state.local={};app.state.config={};
  app.prepareForm('region','local',true,{search_city:['houston','austin'],currency:['USD']});
  const draft=app.candidateFromForm();
  assert.equal(parse(draft.content).region.local.currency,'USD');
});

test('Enter adds one chip even when replacing the focused input fires blur',()=>{
  const app=consoleUnderTest();app.state.context={inherited:{}};app.state.local={};
  app.prepareForm('region','local',true);
  const oldInput={value:'USD',focus(){}},freshInput={value:'',focus(){}};
  const fresh={dataset:{chips:'currency'},querySelector:()=>freshInput,querySelectorAll:()=>[]};
  app.run('document.querySelector=selector=>selector.endsWith(" input")?freshInput:fresh;', {fresh,freshInput});
  const widget={dataset:{chips:'currency'},querySelector:()=>oldInput,querySelectorAll:()=>[]};
  // Removing a focused DOM input dispatches blur before the replacement is bound.
  let removed=false;
  Object.defineProperty(widget,'outerHTML',{set(){if(!removed){removed=true;oldInput.onblur();}}});
  app.bindChips(widget);
  oldInput.onkeydown({key:'Enter',preventDefault(){}});
  assert.deepEqual(Array.from(app.state.form.changes.currency),['USD']);
});

test('marketplace radius input serializes separate numeric radiuses',()=>{
  const app=consoleUnderTest();
  app.state.content='[marketplace.facebook]\nsearch_city=["houston","austin"]\n';
  app.state.local=parse(app.state.content);app.state.config=app.state.local;
  app.prepareForm('marketplace','facebook');
  app.run('result.bindForm=bindForm;');
  const radius=app.control('#radius');radius.dataset={value:'radius'};radius.value='10, 20';
  radius.addEventListener=(event,handler)=>{radius[event]=handler;};
  app.run('document.querySelectorAll=selector=>selector==="[data-value]"?[radius]:[];', {radius});
  // The inert controls are not part of the location editor in this form.
  app.run('bindCityRows=()=>{};');
  app.bindForm();radius.input();
  assert.deepEqual(Array.from(parse(app.candidateFromForm().content).marketplace.facebook.radius),[10,20]);
});

test('default location describes the marketplace instead of the current override',()=>{
  const app=consoleUnderTest();
  app.state.context={inherited:{},notification_values:{}};
  app.state.content='[marketplace.facebook]\nsearch_city="houston"\n[item.camera]\nsearch_city="austin"\n';
  app.refreshData();app.prepareForm('item','camera');
  assert.ok(app.locationHtml().includes('Use default — houston'));
});

test('skip link focuses the selected page without changing its route',()=>{
  const app=consoleUnderTest();app.state.route='#/settings/more';
  let prevented=false;
  app.control('.skip').onclick({preventDefault(){prevented=true;}});
  assert.ok(prevented);
  assert.equal(app.state.route,'#/settings/more');
  assert.equal(app.control('#pane').focused,true);
});

test('an authenticated reload reuses the valid session',async()=>{
  const app=consoleUnderTest();let bootstrapped=false;
  app.run('fetch=fetchStub;bootstrap=bootstrapStub;',{
    fetchStub:async path=>path==='/api/auth/info'?{json:async()=>({open:false,username_hint:'review'})}:{ok:true},
    bootstrapStub:async()=>{bootstrapped=true;},
  });
  await app.showLogin();
  assert.ok(bootstrapped);
  assert.equal(app.control('#login-dialog').open,false);
});

test('a failed raw validation keeps Save blocked while preserving the draft',async()=>{
  const app=consoleUnderTest();app.state.base='[user.me]\n';app.state.content='broken = [';
  app.run('writeDraft=async()=>{const error=new Error("Invalid TOML");error.validation=true;throw error;};');
  await app.saveRaw();
  assert.equal(app.state.content,'broken = [');
  assert.equal(app.control('#form-save').disabled,true);
});

test('replayed activity fills gaps in chronological order',()=>{
  const app=consoleUnderTest();
  const row=id=>({id,time:1,level:'INFO',levelno:20,message:'Event '+id});
  app.state.route='#/monitor/all';app.state.records=[row(2),row(3)];
  const feed=app.control('#feed');
  feed.innerHTML='<article data-record="3">Existing</article>';feed.querySelector=()=>({});
  feed.querySelectorAll=selector=>selector==='[data-record]'?[{dataset:{record:'3'}}]:[];
  feed.insertAdjacentHTML=(_,html)=>{feed.innerHTML=html+feed.innerHTML;};
  app.renderFeed();
  assert.ok(feed.innerHTML.indexOf('data-record="3"')<feed.innerHTML.indexOf('data-record="2"'));
  assert.ok(feed.innerHTML.includes('data-record="3"'));
});

test('older snapshot status cannot replace newer live credential status',()=>{
  const app=consoleUnderTest();
  const row=(id,status)=>({id,message:'Credentials',levelno:20,extra:{kind:'credentials_wait',status}});
  app.run('setTimeout=()=>0;clearTimeout=()=>{};');
  app.acceptRecords([row(3,'found')]);
  app.acceptRecords([row(2,'waiting')]);
  assert.equal(app.state.credentials,'found');
});

test('delete blocks another mutation until the write completes',async()=>{
  const app=consoleUnderTest();app.state.content='[item.camera]\nsearch_phrases="camera"\n';
  app.state.context={inherited:{}};app.state.config={item:{camera:{},other:{}}};
  let complete;
  app.run('confirmAction=async()=>true;writeDraft=write;render=()=>{};', {write:()=>new Promise(resolve=>{complete=resolve;})});
  const deletion=app.deleteSection('item','camera');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(app.state.saving,true);
  complete();await deletion;
  assert.equal(app.state.saving,false);
});

test('overwrite blocks another mutation until the write completes',async()=>{
  const app=consoleUnderTest();app.state.conflict={};app.state.route='#/settings/config';
  let complete;
  app.run('confirmAction=async()=>true;json=async()=>({mtime:1});writeDraft=write;render=()=>{};toast=()=>{};updateSaveBar=()=>{};',{write:()=>new Promise(resolve=>{complete=resolve;})});
  app.renderConflict();
  const overwrite=app.control('#overwrite-config').onclick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(app.state.saving,true);
  complete();await overwrite;
  assert.equal(app.state.saving,false);
});

test('pause and resume persist an inherited search override through the validated save path',async()=>{
  const app=consoleUnderTest(), name='camera.gear';
  const original='# Keep this comment\n[user.me]\ntelegram_token="<REDACTED>"\n';
  app.state.base=app.state.content=original;app.state.mtime=7;
  app.state.context.inherited={item:{[name]:{search_phrases:['camera']}}};app.refreshData();
  const writes=[], validations=[];
  app.run('json=validate;api=save;loadConfig=reload;render=()=>{};updateStatus=()=>{};',{
    validate:async(path,options)=>{assert.equal(path,'/api/config/validate');validations.push(JSON.parse(options.body));return {valid:true};},
    save:async(path,options)=>{assert.equal(path,'/api/config/file/primary');assert.equal(options.method,'PUT');writes.push(JSON.parse(options.body));return {ok:true,json:async()=>({ok:true})};},
    reload:async()=>{app.state.base=app.state.content=writes.at(-1).content;app.refreshData();},
  });
  await app.toggleSearch(name);
  assert.equal(parse(writes[0].content).item[name].enabled,false);
  assert.equal(writes[0].base_mtime,7);
  assert.equal(validations[0].content,writes[0].content);
  assert.ok(writes[0].content.includes('# Keep this comment'));
  assert.equal(parse(writes[0].content).user.me.telegram_token,'<REDACTED>');
  assert.deepEqual(Object.keys(parse(writes[0].content).item[name]),['enabled']);
  assert.equal(app.control('#toggle-search').textContent,'Resume search');
  await app.toggleSearch(name);
  assert.equal(parse(writes[1].content).item[name].enabled,true);
  assert.equal(app.control('#toggle-search').textContent,'Pause search');
});

test('search toggle blocks duplicate saves and leaves unsaved edits alone',async()=>{
  const app=consoleUnderTest();app.state.base=app.state.content='[item.camera]\nsearch_phrases="camera"\n';app.refreshData();
  let complete,writes=0;
  app.run('writeDraft=write;render=()=>{};', {write:()=>{writes++;return new Promise(resolve=>{complete=resolve;});}});
  const pause=app.toggleSearch('camera');
  assert.equal(app.state.saving,true);assert.equal(app.control('#toggle-search').disabled,true);
  await app.toggleSearch('camera');assert.equal(writes,1);
  complete();await pause;
  assert.equal(app.state.saving,false);assert.equal(app.control('#toggle-search').disabled,false);
  app.state.content='[item.camera]\nsearch_phrases="new draft"\n';
  await app.toggleSearch('camera');assert.equal(writes,1);
  assert.equal(parse(app.state.content).item.camera.search_phrases,'new draft');
});

test('failed toggle restores the draft and allows retry without changing enabled state',async()=>{
  const app=consoleUnderTest();const original='[item.camera]\nsearch_phrases="camera"\nenabled=false\n';
  app.state.base=app.state.content=original;app.refreshData();
  app.run('writeDraft=async()=>{throw new Error("Could not save");};');
  await app.toggleSearch('camera');
  assert.equal(app.state.content,original);assert.equal(app.state.config.item.camera.enabled,false);
  assert.equal(app.state.saving,false);assert.equal(app.control('#toggle-search').disabled,false);
  assert.equal(app.control('#toggle-search').textContent,'Resume search');
  assert.equal(app.control('#toast').textContent,'Could not save');
});

test('stale toggle preserves its intended change for the existing conflict controls',async()=>{
  const app=consoleUnderTest();app.state.base=app.state.content='[item.camera]\nsearch_phrases="camera"\n';app.refreshData();
  app.run('json=async()=>({valid:true});api=async()=>({status:409,json:async()=>({})});');
  await app.toggleSearch('camera');
  assert.equal(parse(app.state.conflict.content).item.camera.enabled,false);
  assert.equal(app.state.content,app.state.conflict.content);
  assert.notEqual(app.state.content,app.state.base);
  assert.notEqual(app.state.config.item.camera.enabled,false);
  assert.equal(app.state.saving,false);
  assert.equal(typeof app.control('#compare-config').onclick,'function');
  await app.toggleSearch('camera');
  assert.equal(app.control('#toast').textContent,'Save or discard your pending changes first.');
});

test('saved search header wires pause and resume to the current search',async()=>{
  const app=consoleUnderTest();app.state.config={item:{camera:{search_phrases:['camera']}}};
  app.state.route='#/monitor/item/camera';let toggled;
  app.run('renderFeed=()=>{};toggleSearch=toggle;', {toggle:name=>{toggled=name;}});
  app.control('#toggle-search').addEventListener=(event,handler)=>{app.control('#toggle-search')[event]=handler;};
  app.renderActivity('camera');
  assert.match(app.control('#pane').innerHTML,/id="toggle-search"[^>]*>Pause search/);
  await app.control('#toggle-search').click();assert.equal(toggled,'camera');
  app.state.config.item.camera.enabled=false;app.renderActivity('camera');
  assert.match(app.control('#pane').innerHTML,/id="toggle-search"[^>]*>Resume search/);
});

test('View matches scopes results to the saved search with a safely encoded name',()=>{
  const app=consoleUnderTest(),name='camera & lens/#?';app.state.config={item:{[name]:{search_phrases:['camera']}}};
  app.run('renderFeed=()=>{};');app.renderActivity(name);
  assert.ok(app.control('#pane').innerHTML.includes(`href="#/monitor/matches?item=${encodeURIComponent(name)}">View matches</a>`));
});

test('CSV downloads use the requested collection and preserve the default notified export',async()=>{
  const app=consoleUnderTest(),paths=[],downloads=[];
  app.run('api=request;URL={createObjectURL:()=>"blob:export",revokeObjectURL(){}};document.createElement=()=>({click(){download(this.download);}});',{
    request:async path=>{paths.push(path);return {ok:true,headers:{get:()=>null},blob:async()=>({text:async()=> 'title\r\nCamera\r\n'})};},
    download:name=>downloads.push(name),
  });
  await app.exportCsv({url:'/api/matches.csv?status=shortlisted',filename:'matches.csv'});
  await app.exportCsv();
  assert.deepEqual(paths,['/api/matches.csv?status=shortlisted','/api/found.csv']);
  assert.deepEqual(downloads,['matches.csv','notified-listings.csv']);
  assert.equal(app.control('#export-csv').disabled,false);
});

test('empty and failed Matches exports show useful feedback and restore the button',async()=>{
  const app=consoleUnderTest();
  app.run('api=async()=>({ok:true,blob:async()=>({text:async()=>"title\\r\\n"})});');
  await app.exportCsv({url:'/api/matches.csv',emptyMessage:'No matches for these filters to export.'});
  assert.equal(app.control('#toast').textContent,'No matches for these filters to export.');
  assert.equal(app.control('#export-csv').disabled,false);
  app.run('api=async()=>({ok:false});');
  await app.exportCsv({url:'/api/matches.csv'});
  assert.equal(app.control('#toast').textContent,'Export failed. Try again.');
  assert.equal(app.control('#export-csv').disabled,false);
});
