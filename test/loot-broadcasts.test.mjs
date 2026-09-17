import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {GameService} from '../server/service.mjs';
import {LootBroadcastService} from '../server/loot-broadcasts.mjs';
import {createApp} from '../server/index.mjs';
import {HeadlessGame} from '../cli/engine.mjs';
import {CloudClient} from '../cli/cloud-client.mjs';

const key='lineage_idle_save_1',password='loot-broadcast-test-2026!';
const catalog={version:'test',wrap:JSON.stringify,unwrap:JSON.parse,skills:{},items:{
  sword:{n:'傳說之劍',type:'wpn',legend:true},relic:{n:'古代戒指',type:'acc',relic:true},
  normal:{n:'木棒',type:'wpn'},egg:{n:'遺物蛋',type:'item',relic:true},arrow:{n:'箭矢',type:'wpn',legend:true,isArrow:true}
},world:{maps:[{id:'training',name:'新兵修練場'}],monsters:[{name:'哥布林'}],drops:['sword','relic','normal','egg','arrow'].map(itemId=>({key:JSON.stringify(['normal','哥布林',itemId]),monster:'哥布林',itemId}))}};
const character=()=>({p:{cls:'elf',name:'掉寶玩家',lv:1,exp:0,gold:1000,inv:[],_roleEpoch:randomUUID()},ms:{current:'training'},ticks:0});
const receipt=(seq,itemId='sword')=>({seq,itemId,monster:'哥布林',mapId:'training',quantity:1});
async function fixture(t,filename=':memory:'){
  const service=new GameService(filename,catalog),broadcasts=new LootBroadcastService(service);
  t.after(()=>service.close());const user=await service.register('loot_player',password),lease=randomUUID(),doc=character();
  service.acquireLease(user,lease);service.sync(user,lease,0,{[key]:JSON.stringify(doc)},{slot:1});
  let revision=1;
  return {service,broadcasts,user,lease,doc,save(){const result=service.sync(user,lease,revision,{[key]:JSON.stringify(doc)},{slot:1});revision=result.revision;return result;}};
}
test('monster drop broadcasts use server names, include relic equipment, and do not repeat on sync or replay',async t=>{
  const f=await fixture(t);f.doc.p._rareLootSeq=2;f.doc.p._rareLootEvents=[{...receipt(1),itemName:'FORGED',rarity:'fake'},receipt(2,'relic')];f.save();
  const events=f.broadcasts.list().events;assert.equal(events.length,2);assert.equal(events[0].itemName,'傳說之劍');assert.equal(events[0].name,'掉寶玩家');assert.equal(events[1].rarity,'relic');
  f.save();assert.equal(f.broadcasts.list().events.length,2);
  f.doc.p._rareLootSeq=0;f.doc.p._rareLootEvents=[];f.save();f.doc.p._rareLootSeq=2;f.doc.p._rareLootEvents=[receipt(1),receipt(2,'relic')];f.save();assert.equal(f.broadcasts.list().events.length,2);
  assert.equal(f.service.bootstrap(f.user).lootBroadcastCursor,events[1].id);
  assert.equal(f.broadcasts.list(events[0].id).events.length,1);
});
test('rejects normal gear, consumables, arrows, unknown sources, invalid quantities and invented maps',async t=>{
  const f=await fixture(t);f.doc.p._rareLootEvents=[receipt(1,'normal'),receipt(2,'egg'),receipt(3,'arrow'),{...receipt(4),monster:'假的怪物'},{...receipt(5),mapId:'missing'},{...receipt(6),quantity:-2},receipt(7,'missing'),{...receipt(8),quantity:1001}];f.doc.p._rareLootSeq=8;f.save();assert.deepEqual(f.broadcasts.list().events,[]);
  f.doc.p._rareLootSeq=9;f.doc.p._rareLootEvents.push({...receipt(9),bless:true,quantity:2});f.save();assert.equal(f.broadcasts.list().events[0].itemName,'祝福的 傳說之劍');assert.equal(f.broadcasts.list().events[0].quantity,2);
});
test('existing inventory and character initialization never announce, and failed saves roll back broadcasts',async t=>{
  const f=await fixture(t);f.doc.p.inv.push({id:'sword',cnt:1});f.save();assert.equal(f.broadcasts.latestId(),0);
  f.doc.p._rareLootSeq=1;f.doc.p._rareLootEvents=[receipt(1)];
  assert.throws(()=>f.service.sync(f.user,f.lease,2,{[key]:JSON.stringify(f.doc),invalid:'x'}));assert.equal(f.broadcasts.latestId(),0);
  f.save();assert.equal(f.broadcasts.list().events.length,1);
  const other=await f.service.register('new_loot_player',password),doc=character(),lease=randomUUID();doc.p._rareLootSeq=1;doc.p._rareLootEvents=[receipt(1)];f.service.acquireLease(other,lease);f.service.sync(other,lease,0,{[key]:JSON.stringify(doc)});assert.equal(f.broadcasts.list().events.length,1);
});
test('cursor and broadcast history survive a restart',async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'loot-')),filename=path.join(dir,'game.db');
  const first=new GameService(filename,catalog),world=new LootBroadcastService(first);const user=await first.register('persistent_loot',password),doc=character();doc.p._rareLootSeq=1;doc.p._rareLootEvents=[receipt(1)];world.record(user,{p:{_rareLootSeq:0}},doc);first.close();
  const second=new GameService(filename,catalog),restored=new LootBroadcastService(second);
  try{restored.record(user,{p:{_rareLootSeq:0}},doc);assert.equal(restored.list().events.length,1);}finally{second.close();rmSync(dir,{recursive:true,force:true});}
});
test('real monster kills create receipts; ordinary gains, crafting-style gains and GM grants do not',t=>{
  const game=new HeadlessGame();t.after(()=>game.close());game.create({classId:'elf',name:'掉寶測試',allocation:{dex:8}});
  game.run(`gainItem('wpn_dragonslayer',1,true);gainItem('relic_goblin_blade',1,true);`);assert.equal(game.snapshot().p._rareLootSeq,undefined);
  game.run(`gmSetWorld({revision:1,dropMultiplier:1,drops:{[gmDropKey('normal','哥布林','relic_goblin_blade')]:100}});mapState.current='training';mapState.mobs[0]={...DB.mobs.goblin,curHp:0};killMob(0);`);
  const p=game.snapshot().p;assert.ok(p._rareLootSeq>=1);assert.ok(p._rareLootEvents.some(e=>e.itemId==='relic_goblin_blade'&&e.monster==='哥布林'&&e.mapId==='training'));
  const seq=p._rareLootSeq,before=p.inv.filter(i=>i.id==='wpn_dragonslayer').reduce((n,i)=>n+i.cnt,0);game.applyEffects([{seq:99,key,epoch:p._roleEpoch,action:'grant_item',item:{id:'wpn_dragonslayer',uid:'gm-loot-test',cnt:1,en:0,bless:false,anc:false,attr:false}}],Date.now());assert.equal(game.snapshot().p._rareLootSeq,seq);assert.equal(game.snapshot().p.inv.filter(i=>i.id==='wpn_dragonslayer').reduce((n,i)=>n+i.cnt,0),before+1);
  game.run(`for(let i=0;i<70;i++){_lootMobInfo={n:'哥布林'};gainItem('relic_goblin_blade',1,true);}_lootMobInfo=null;`);assert.equal(game.snapshot().p._rareLootEvents.length,64);
  assert.equal(game.decodeSave(game.encodeSave(game.snapshot())).p._rareLootSeq,seq+70);
});
test('broadcast endpoint requires authentication and a second account receives another player drop',async t=>{
  const {server,service}=createApp({database:':memory:',catalog,publicOrigin:'',publicAliases:[]});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));});const base='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(base+'/api/loot-broadcasts')).status,401);
  const player=await service.register('source_player',password),observer=await service.register('observer_player',password);const client=new CloudClient({baseUrl:base});await client.login(observer.username,password);
  const doc=character();doc.p._rareLootSeq=1;doc.p._rareLootEvents=[receipt(1)];service.lootBroadcasts.record(player,{p:{_rareLootSeq:0}},doc);
  const {cookie}=client.exportSession();const response=await fetch(base+'/api/loot-broadcasts?after=0',{headers:{Cookie:cookie}});assert.equal(response.status,200);const body=await response.json();assert.equal(body.events[0].name,'掉寶玩家');assert.equal(body.events[0].itemName,'傳說之劍');
  await client.logout();
});
