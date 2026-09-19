import test from 'node:test';
import assert from 'node:assert/strict';
import {HeadlessGame} from '../cli/engine.mjs';

const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(t){
 const game=new HeadlessGame();t.after(()=>game.close());game.create({classId:'elf',name:'販賣測試',allocation:{dex:8}});
 game.run(`DB.items.qa_unsellable={n:'<img src=x>任務物品',type:'quest',noSell:true,p:100};DB.items.qa_protected={n:'系統保護物品',type:'mat',noJunk:true,p:100};
  player.inv=__args;player.autoSellRules=null;player.autoSellGlobal=false;player.autoSellOn=true;getAutoSellRules();`,[
  {uid:'heal',id:'potion_heal',cnt:5},{uid:'heal-locked',id:'potion_heal',cnt:3,lock:true},
  {uid:'strong',id:'potion_strong',cnt:4},{uid:'blue',id:'potion_blue',cnt:2},
  {uid:'quest',id:'qa_unsellable',cnt:1},{uid:'protected',id:'qa_protected',cnt:1},
  {uid:'sword',id:'wpn_26',cnt:1,en:8,bless:true}
 ]);
 return {game,doc:game.window.document};
}
function check(doc,id){const input=doc.querySelector(`#as-item-list input[value="${id}"]`);assert.ok(input,id);input.click();}
function filter(game,doc,{q='',type='all',scope='held'}={}){
 doc.getElementById('as-item-search').value=q;doc.getElementById('as-item-type').value=type;doc.getElementById('as-item-scope').value=scope;game.run('refreshAutoSellItemOptions()');
}

test('bulk rule picker defaults to held item types, aggregates stacks and preserves selections across filters',t=>{
 const {game,doc}=fixture(t);game.run('openAutoSellRules()');
 assert.equal(doc.getElementById('as-item-scope').value,'held');assert.equal(doc.querySelectorAll('#as-item-list input').length,6);
 const heal=doc.querySelector('input[value="potion_heal"]').closest('label');assert.match(heal.textContent,/背包 8 個 · 鎖定 3 個/);
 assert.equal(doc.querySelector('#as-item-list img'),null);assert.match(doc.getElementById('as-item-list').textContent,/<img src=x>/);
 assert.equal(doc.getElementById('as-batch-sell').disabled,true);
 check(doc,'potion_heal');filter(game,doc,{q:'橙色'});game.run('selectAutoSellItems(true)');
 assert.match(doc.getElementById('as-selected-count').textContent,/已選 2 種（1 種在其他篩選中）/);
 filter(game,doc,{type:'wpn'});assert.equal(doc.querySelectorAll('#as-item-list input').length,1);game.run('selectAutoSellItems(true)');
 filter(game,doc,{q:'wpn_manadagger',scope:'all'});assert.equal(doc.querySelectorAll('#as-item-list input').length,1);assert.match(doc.getElementById('as-item-list').textContent,/尚未持有/);
 filter(game,doc,{q:'找不到的物品'});assert.match(doc.getElementById('as-item-list').textContent,/沒有符合搜尋/);assert.equal(doc.getElementById('as-select-visible').disabled,true);
 assert.match(doc.getElementById('as-selected-count').textContent,/已選 3 種/);game.run('selectAutoSellItems(false)');assert.equal(doc.getElementById('as-selected-count').textContent,'已選 0 種');
 filter(game,doc);assert.equal(doc.querySelectorAll('#as-item-list input:checked').length,0);
});

test('batch edits preserve form filters and selection, pause background sales, and cancel restores original rules',t=>{
 const {game,doc}=fixture(t),before=game.snapshot();game.run('openAutoSellRules()');
 const rulesBefore=plain(game.run('getAutoSellRules()'));
 doc.getElementById('as-delay').value='123';doc.getElementById('as-global').checked=true;
 doc.getElementById('as-e-wpn').checked=true;doc.getElementById('as-em-wpn').value='3';
 filter(game,doc,{q:'藥水'});check(doc,'potion_heal');check(doc,'potion_strong');game.run('setAutoSellOverride("sell")');
 assert.deepEqual(plain(game.run('getAutoSellRules().overrides')),{potion_heal:'sell',potion_strong:'sell'});
 assert.equal(doc.getElementById('as-delay').value,'123');assert.equal(doc.getElementById('as-global').checked,true);assert.equal(doc.getElementById('as-em-wpn').value,'3');assert.equal(doc.getElementById('as-item-search').value,'藥水');
 assert.equal(doc.getElementById('as-selected-count').textContent,'已選 0 種');assert.match(doc.getElementById('as-override-feedback').textContent,/已將 2 種/);
 check(doc,'potion_blue');game.run('deleteAutoSellOverride("potion_strong")');assert.equal(doc.querySelector('input[value="potion_blue"]').checked,true);
 game.run('setAutoSellOverride("keep"); autoSellJunk();');assert.deepEqual(game.snapshot().p.inv,before.p.inv);assert.equal(game.snapshot().p.gold,before.p.gold);
 game.run('closeAutoSellRules()');assert.deepEqual(plain(game.run('getAutoSellRules()')),rulesBefore);assert.equal(game.run('player.autoSellGlobal'),false);
 game.run('openAutoSellRules()');assert.equal(doc.getElementById('as-selected-count').textContent,'已選 0 種');assert.equal(doc.getElementById('as-item-search').value,'');
});

test('saved bulk rules sell selected unlocked stacks after the grace period and survive reload',t=>{
 const {game,doc}=fixture(t);game.run('openAutoSellRules()');
 for(const id of ['potion_heal','potion_strong','qa_unsellable','qa_protected'])check(doc,id);
 game.run('setAutoSellOverride("sell")');
 assert.deepEqual(plain(game.run('getAutoSellRules().overrides')),{potion_heal:'sell',potion_strong:'sell'});assert.match(doc.getElementById('as-override-feedback').textContent,/2 種不可自動販賣/);
 assert.equal(doc.getElementById('as-batch-sell').disabled,true);assert.equal(doc.getElementById('as-batch-keep').disabled,false);
 game.run('selectAutoSellItems(false)');check(doc,'potion_blue');game.run('setAutoSellOverride("keep");previewAutoSellRules()');
 assert.match(doc.getElementById('autosell-preview-modal').textContent,/紅色藥水 \(5\) × 5/);assert.match(doc.getElementById('autosell-preview-modal').textContent,/橙色藥水 \(4\) × 4/);assert.doesNotMatch(doc.getElementById('autosell-preview-modal').textContent,/藍色藥水/);
 const gold=game.run('player.gold'),proceeds=game.run('getSellPrice(player.inv.find(i=>i.uid==="heal"))*5+getSellPrice(player.inv.find(i=>i.uid==="strong"))*4');
 game.run('closeAutoSellPreview();saveAutoSellRules();autoSellJunk()');assert.equal(game.run('player.gold'),gold);assert.equal(game.snapshot().p.inv.length,7);
 game.run('player.inv.forEach(i=>{if(i.junk)i.junkSince=Date.now()-61000});autoSellJunk()');
 assert.equal(game.run('player.gold'),gold+proceeds);assert.deepEqual(game.snapshot().p.inv.map(i=>i.uid).sort(),['blue','heal-locked','protected','quest','sword']);
 const loaded=new HeadlessGame({values:game.save()});t.after(()=>loaded.close());loaded.load();
 assert.deepEqual(plain(loaded.run('getAutoSellRules().overrides')),{potion_heal:'sell',potion_strong:'sell',potion_blue:'keep'});
});

test('empty backpacks can configure future items without creating rules from empty selections',t=>{
 const {game,doc}=fixture(t);game.run('player.inv=[];openAutoSellRules()');
 assert.match(doc.getElementById('as-item-list').textContent,/背包目前沒有物品/);assert.equal(doc.getElementById('as-select-visible').disabled,true);
 game.run('setAutoSellOverride("sell")');assert.deepEqual(plain(game.run('getAutoSellRules().overrides')),{});
 filter(game,doc,{q:'wpn_manadagger',scope:'all'});check(doc,'wpn_manadagger');game.run('setAutoSellOverride("keep")');
 assert.deepEqual(plain(game.run('getAutoSellRules().overrides')),{wpn_manadagger:'keep'});assert.equal(doc.getElementById('as-item-scope').value,'all');assert.equal(doc.getElementById('as-item-search').value,'wpn_manadagger');
});
