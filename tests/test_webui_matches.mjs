import test from 'node:test';
import assert from 'node:assert/strict';
import {groupMatches, mergeMatchRows, applyRecheckResult, priceDropped, matchDate} from '../src/ai_marketplace_monitor/webui/static/matches.js';

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
});
test('live below-threshold results update even when the active rating filter hides them from the API',()=>{
  const rows=[row('fb:1','camera',{marketplace:'fb',listing_id:'1',score:5})];
  const changed=applyRecheckResult(rows,{marketplace:'fb',listing_id:'1',item:'camera',status:'below_threshold',score:2,price:'$100'});
  assert.equal(mergeMatchRows(changed,[],true)[0].score,2);
  assert.equal(changed[0].current_price,'$100');
  assert.equal(applyRecheckResult(rows,{marketplace:'fb',listing_id:'1',original_item:'camera',item:'other',status:'passed',score:3})[0].score,5);
});
