import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import init, {parse, edit} from '../src/ai_marketplace_monitor/webui/static/vendor/toml-edit-js/shims.js';
import {mergeConfig,itemValue,resolvedUser,userChannels,mergeRecords,matchRecord,searchActivity,searchStatusLabel,safeUrl,renameSection,scheduleLabel} from '../src/ai_marketplace_monitor/webui/static/console-model.js';
await init({module_or_path:await readFile(new URL('../src/ai_marketplace_monitor/webui/static/vendor/toml-edit-js/index_bg.wasm',import.meta.url))});

test('real TOML edits preserve comments, hidden keys and explicit empty AI',()=>{
  const source='# Saved searches\n[item.camera] # keep section comment\nsearch_phrases = "camera" # keep phrase comment\nmax_price = 300 # keep budget comment\ncustom_unknown = "keep me"\nai = ["openai"]\n\n[user.me]\ntelegram_token = "<REDACTED>"\n';
  let draft=edit(source,'item.camera.max_price',325);
  draft=edit(draft,'item.camera.ai',[]);
  draft=renameSection(draft,'item','camera','camera_gear');
  const parsed=parse(draft);
  assert.equal(parsed.item.camera_gear.max_price,325);
  assert.deepEqual(parsed.item.camera_gear.ai,[]);
  assert.equal(parsed.item.camera_gear.custom_unknown,'keep me');
  assert.equal(parsed.user.me.telegram_token,'<REDACTED>');
  for(const comment of ['# Saved searches','# keep section comment','# keep phrase comment','# keep budget comment'])assert.ok(draft.includes(comment));
});

test('effective defaults concatenate lists without mutating source and empty AI disables',()=>{
  const base={marketplace:{facebook:{search_city:['houston'],rating:4}},item:{camera:{search_phrases:['camera']}},ai:{openai:{enabled:true}},user:{me:{}}};
  const local={item:{camera:{search_phrases:['lens'],ai:[]}}};
  const effective=mergeConfig(base,local);
  assert.deepEqual(effective.item.camera.search_phrases,['camera','lens']);
  assert.deepEqual(base.item.camera.search_phrases,['camera']);
  assert.deepEqual(itemValue(effective,'camera','ai'),[]);
  assert.equal(itemValue(effective,'camera','rating'),4);
  assert.deepEqual(itemValue(effective,'camera','notify'),['me']);
  assert.equal(scheduleLabel(effective,'camera'),'30m–1h, random');
});

test('notification settings use real shared precedence and explicit exclusion',()=>{
  const config={notification:{gmail:{smtp_password:'<REDACTED>'}},user:{me:{email:['me@example.com'],smtp_password:'${LOCAL_SMTP}'}}};
  assert.equal(resolvedUser(config,'me').smtp_password,'<REDACTED>');
  assert.deepEqual(userChannels(config,'me'),['Email']);
  config.user.me.notify_with=[];
  assert.deepEqual(userChannels(config,'me',{LOCAL_SMTP:false}),[]);
  assert.deepEqual(userChannels(config,'me',{LOCAL_SMTP:true}),['Email']);
});

test('activity replay deduplicates, sorts, caps and filters actual events',()=>{
  const row=(id,extra={},levelno=20)=>({id,extra,levelno,message:'Camera rated'});
  const records=mergeRecords([row(1),row(3)], [row(2),row(3,{item:'camera',kind:'ai_eval',score:4}),row(4)],3);
  assert.deepEqual(records.map(r=>r.id),[2,3,4]);
  assert.ok(matchRecord(records[1],{item:'camera',kind:'ai_eval',score:4,text:'CAMERA'}));
  assert.ok(!matchRecord(records[1],{level:'ERROR'}));
  assert.ok(!matchRecord(records[2],{score:4}));
  assert.equal(safeUrl('javascript:alert(1)'),null);
  assert.equal(safeUrl('https://facebook.com/marketplace/item/1'),'https://facebook.com/marketplace/item/1');
});

test('shared settings apply in order including loader defaults',()=>{
  const config={notification:{first:{smtp_server:'first'},second:{smtp_server:'second'}},notification_values:{first:{smtp_server:'first',retry_delay:60},second:{smtp_server:'second',retry_delay:60}},user:{me:{retry_delay:10}}};
  assert.equal(resolvedUser(config,'me').smtp_server,'second');
  assert.equal(resolvedUser(config,'me').retry_delay,60);
  config.notification_values.second.enabled=false;
  assert.equal(resolvedUser(config,'me').smtp_server,'first');
});

test('search activity follows the latest search boundary and requested searches',()=>{
  const event=(id,kind,item)=>({id,extra:{kind,item}});
  const records=[event(1,'search_started','camera'),event(2,'search_summary','camera'),event(3,'search_started','lens')];
  assert.deepEqual(searchActivity(records,['camera','lens','tripod']),{running:'lens',queued:[],started:0});
  assert.deepEqual(searchActivity(records,['camera','lens','tripod'],2),{running:'lens',queued:['camera','tripod'],started:1});
  assert.equal(searchActivity([...records,event(4,'search_summary','lens')],[]).running,null);
  assert.equal(searchActivity([...records,event(4,'browser_ready')],[]).running,null);
});

test('search status label counts the requested run, listings and the rating tail',()=>{
  const label=options=>searchStatusLabel({running:null,queued:[],started:0,requested:false,...options});
  assert.deepEqual(label({}),{main:'↻ Search all now',detail:''});
  assert.deepEqual(label({requested:true,queued:['a','b','c']}),{main:'Starting 3 searches…',detail:''});
  assert.deepEqual(label({running:'chair',requested:true,started:2,queued:['bike']}),{main:'Searching 2 of 3',detail:'· chair'});
  assert.deepEqual(label({running:'chair',progress:{item:'chair',done:7,total:24}}),{main:'Searching',detail:'· chair · 7/24'});
  assert.deepEqual(label({running:'chair',requested:true,started:2,queued:['bike'],progress:{item:'chair',done:24,total:24,rating:2,browsing:false}}),{main:'Searching 2 of 3',detail:'· chair · 24/24 · rating last 2'});
  assert.equal(label({running:'chair',progress:{item:'chair',done:12,total:12,rating:31,browsing:true}}).detail,'· chair · 12/12');
  assert.deepEqual(label({running:'chair',requested:true,started:0,queued:['a','b']}),{main:'Searching',detail:'· chair · 2 next'});
  assert.equal(label({running:'chair',progress:{item:'lens',done:1,total:5}}).detail,'· chair');
  assert.deepEqual(label({running:'chair',progress:{item:'chair',done:8,total:24,cancelling:true}}),{main:'Cancelling…',detail:'· chair'});
});
