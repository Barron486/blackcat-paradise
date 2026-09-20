import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {GameService} from '../server/service.mjs';
import {AuthoritativeGame} from '../server/authoritative-game.mjs';
import {loadCatalog} from '../server/catalog.mjs';

const catalog=loadCatalog(new URL('../',import.meta.url));
const count=(doc,id)=>doc.p.inv.filter(i=>i.id===id).reduce((n,i)=>n+i.cnt,0);
async function fixture(t){
  const service=new GameService(':memory:',catalog),authority=new AuthoritativeGame(service,{clock:()=>0,autoTick:false});
  t.after(()=>{authority.close();service.close();});
  const user=await service.register('item_player','item-test-password!'),lease=randomUUID();service.acquireLease(user,lease);
  const created=authority.handle(user,{lease,op:'create',slot:1,revision:0,requestId:randomUUID(),args:{classId:'mage',name:'道具測試',allocation:{int:6,wis:6,con:4}}});
  const runtime=()=>authority.runtimes.get(user.id),read=()=>catalog.unwrap(service.bootstrap(user).values.lineage_idle_save_1);
  const setup=code=>{runtime().engine.run(code);authority.commit(user,runtime());};
  const body=(name,params)=>({lease,op:'action',slot:1,epoch:created.game.epoch,revision:service.bootstrap(user).revision,requestId:randomUUID(),args:{name,params}});
  const act=(name,params)=>authority.handle(user,body(name,params));
  const uid=id=>read().p.inv.find(i=>i.id===id)?.uid;
  return {service,authority,user,runtime,read,setup,body,act,uid};
}

test('all four locked chests consume exactly one core per box, keep their loot on retry and reconnect',async t=>{
  const f=await fixture(t);
  for(const id of ['item_osiris_box_basic','item_osiris_box_high','item_kukulkan_box_basic','item_kukulkan_box_high']){
    f.setup(`player.inv=[];gainItem('${id}',4);gainItem('mat_crack_core',5);`);
    const uid=f.uid(id),request=f.body('open-box',{uid,qty:3});
    assert.throws(()=>f.act('use',{uid}),/選擇開箱/);
    f.authority.handle(f.user,request);const result=f.read();
    assert.equal(count(result,id),1);assert.equal(count(result,'mat_crack_core'),2);
    const table=f.runtime().engine.run('BOX_LOOT_BY_ID[__args]',id),rewardIds=table.map(entry=>entry[0]);
    assert.equal(result.p.inv.filter(i=>rewardIds.includes(i.id)).reduce((n,i)=>n+i.cnt,0),3);
    assert.equal(f.authority.handle(f.user,request).replayed,true);assert.deepEqual(f.read(),result);
    f.authority.drop(f.user.id);f.authority.handle(f.user,{...f.body('unused',{}),op:'select'});
    assert.equal(count(f.read(),id),1);assert.equal(count(f.read(),'mat_crack_core'),2);
    assert.deepEqual(f.read().p.inv,result.p.inv);
  }
});

test('chest validation is atomic for missing cores, wrong items, stale stacks and forged rewards',async t=>{
  const f=await fixture(t);f.setup("player.inv=[];gainItem('item_osiris_box_basic',3);gainItem('mat_crack_core',1);");
  const uid=f.uid('item_osiris_box_basic'),before=f.read();
  for(const params of [{uid,qty:2},{uid,qty:4},{uid:'missing',qty:1},{uid:f.uid('mat_crack_core'),qty:1},{uid,qty:0},{uid,qty:1.5},{uid,qty:'1'},{uid,qty:1001},{uid,qty:1,reward:'wpn_dragonslayer'}]){
    assert.throws(()=>f.act('open-box',params));assert.deepEqual(f.read(),before);
  }
  for(const state of ['player.dead=true;','player.dead=false;player.buffs.sk_abs_barrier=10;']){
    f.setup(state);const blocked=f.read();assert.throws(()=>f.act('open-box',{uid,qty:1}),/狀態|死亡/);assert.deepEqual(f.read(),blocked);
  }
});

test('controlled transformation validates ring, level and weapon and charges a scroll only once',async t=>{
  const f=await fixture(t);f.setup("player.lv=50;player.inv=[];gainItem('scroll_poly',3);calcStats();");
  const uid=f.uid('scroll_poly');
  assert.throws(()=>f.act('polymorph',{uid,name:'哥布林'}),/控制戒指/);
  f.setup("gainItem('acc_117',1);");
  assert.throws(()=>f.act('use',{uid}),/選擇變身/);
  const before=f.read();
  for(const params of [{uid,name:'不存在'},{uid,name:'哥布林',duration:999999},{uid:f.uid('acc_117'),name:'哥布林'},{uid,name:'妖魔弓箭手'}]){assert.throws(()=>f.act('polymorph',params));assert.deepEqual(f.read(),before);}
  const request=f.body('polymorph',{uid,name:'哥布林'});f.authority.handle(f.user,request);
  assert.equal(f.read().p.poly.n,'哥布林');assert.equal(f.read().p.buffs.poly,1800);assert.equal(count(f.read(),'scroll_poly'),2);
  f.authority.handle(f.user,request);assert.equal(count(f.read(),'scroll_poly'),2);
  f.setup('player.lv=1;');assert.throws(()=>f.act('polymorph',{uid,name:'哥布林'}),/等級/);
  f.setup("player.lv=50;player.inv=player.inv.filter(i=>i.id!=='acc_117');");f.act('use',{uid});
  assert.equal(count(f.read(),'scroll_poly'),1);assert.equal(f.read().p.buffs.poly,1800);
});

test('soul orb preserves the other wand and restores the explicitly selected one',async t=>{
  const f=await fixture(t);f.setup("player.inv=[];gainItem('item_soul_orb',2);gainItem('wpn_powerless_baless',1);gainItem('wpn_powerless_baphomet',1);");
  const uid=f.uid('item_soul_orb');assert.throws(()=>f.act('use',{uid}),/選擇要恢復/);
  assert.throws(()=>f.act('soul-orb',{uid,wand:'wpn_dragonslayer'}));assert.equal(count(f.read(),'item_soul_orb'),2);
  const request=f.body('soul-orb',{uid,wand:'wpn_powerless_baless'});f.authority.handle(f.user,request);f.authority.handle(f.user,request);
  assert.equal(count(f.read(),'item_soul_orb'),1);assert.equal(count(f.read(),'wpn_baless'),1);assert.equal(count(f.read(),'wpn_powerless_baless'),0);assert.equal(count(f.read(),'wpn_powerless_baphomet'),1);
  f.act('soul-orb',{uid,wand:'wpn_powerless_baphomet'});assert.equal(count(f.read(),'wpn_baphomet_wand'),1);assert.equal(count(f.read(),'item_soul_orb'),0);
});

test('summon choice persists and refuses unqualified or ringless choices',async t=>{
  const f=await fixture(t);assert.throws(()=>f.act('summon-choice',{name:''}),/控制戒指/);
  f.setup("player.lv=60;player.eq.ring1={id:'acc_summon_ctrl',uid:uid(),cnt:1};calcStats();");
  const name=f.runtime().engine.run('SUMMON_TIERS.flatMap(t=>t.mobs).find(m=>_sumQualified(m.n)&&_sumCountFor(m.n)>0).n');
  f.act('summon-choice',{name});assert.equal(f.read().p.summonChoice,name);
  assert.throws(()=>f.act('summon-choice',{name:'不存在'}));assert.equal(f.read().p.summonChoice,name);
  f.act('summon-choice',{name:''});assert.equal(f.read().p.summonChoice,null);
});

test('doll merchant opening, exchanges and nondefault synthesis use authoritative menus',async t=>{
  const f=await fixture(t),town=f.runtime().engine.run("Object.entries(DB.towns).find(([id,t])=>t.npcs.some(n=>n.id==='npc_doll_merchant'))[0]");
  f.act('travel',{mapId:town});
  const command=(method,params=[])=>f.act('npc-command',{npcId:'npc_doll_merchant',method,params,fields:{}});
  f.setup("gainItem('doll_bag',3);gainItem('doll_box_high',2);");
  command('openDollBag',[null,true]);assert.equal(count(f.read(),'doll_bag'),0);assert.equal(f.read().p.dollSeq,3);
  command('openDollBox',[null,false]);assert.equal(count(f.read(),'doll_box_high'),1);assert.equal(f.read().p.dollSeq,4);
  f.setup("{const name=Object.keys(CARD_MOB_INFO)[0];cardAddScore(name,100);gainItem(cardId(name,2),3,true,true);gainItem(cardId(name,3),2,true,true);}");
  command('exchangeSilverForBags',[true]);assert.equal(count(f.read(),'doll_bag'),3);
  command('exchangeGoldForBoxes',[true]);assert.equal(count(f.read(),'doll_box_high'),3);
  f.setup("gainItem(DOLL_BY_TIER[2][0],4,true,true);player.dollPity={2:5};");
  command('dollSynth',[2,4]);assert.equal(f.read().p.dollPity[2],0,'four-item pity guarantees the selected tier upgrade');
  const before=f.read();assert.throws(()=>command('dollSynth',[9,2]));assert.deepEqual(f.read(),before);
  f.act('travel',{mapId:'training'});assert.throws(()=>command('openDollBag',[null,true]),/此地沒有/);
});
