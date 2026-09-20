import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {GameService} from '../server/service.mjs';
import {AuthoritativeGame} from '../server/authoritative-game.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {HeadlessGame} from '../server/game-engine.mjs';

test('black market opens without moving, charges server prices once, and rejects changed/sold offers',async t=>{
  const service=new GameService(':memory:',loadCatalog(new URL('../',import.meta.url))),authority=new AuthoritativeGame(service,{clock:()=>0,autoTick:false});t.after(()=>{authority.close();service.close();});
  const user=await service.register('pandora_player','pandora-test-2026!'),lease=randomUUID();service.acquireLease(user,lease);
  const created=authority.handle(user,{lease,op:'create',slot:1,revision:0,requestId:randomUUID(),args:{classId:'knight',name:'黑市測試',allocation:{str:2,con:6}}});
  const body=params=>({lease,op:'action',slot:1,epoch:created.game.epoch,revision:service.bootstrap(user).revision,requestId:randomUUID(),args:{name:'black-market',params}});
  const runtime=()=>authority.runtimes.get(user.id),read=()=>service.catalog.unwrap(service.bootstrap(user).values.lineage_idle_save_1);
  const beforeMap=created.game.status.map;
  authority.handle(user,body({operation:'view'}));assert.equal(read().ms.current,beforeMap);assert.equal(read().p.pandoraMarket2.slots.length,24);
  const original=structuredClone(read().p.pandoraMarket2.slots);authority.handle(user,body({operation:'view'}));assert.deepEqual(read().p.pandoraMarket2.slots,original,'opening does not reroll stock');
  runtime().engine.run("player.gold=1000;player.pandoraMarket2.slots[0]={id:'wpn_1',price:123,weight:100,bless:true,setTick:0,sold:false};");authority.commit(user,runtime());
  const offer=JSON.stringify(['wpn_1',123,true,0]),buy=body({operation:'buy',index:0,offer});
  assert.throws(()=>authority.handle(user,body({operation:'buy',index:0,offer:JSON.stringify(['wpn_1',1,true,0])})),/商品已售出或輪換/);assert.equal(read().p.gold,1000);
  assert.throws(()=>authority.handle(user,body({operation:'buy',index:24,offer})),/數量/);
  assert.throws(()=>authority.handle(user,body({operation:'buy',index:0,offer,price:1})),/不允許/);
  const result=authority.handle(user,buy);assert.equal(result.game.status.gold,877);assert.equal(read().p.pandoraMarket2.slots[0].sold,true);assert.ok(read().p.inv.some(i=>i.id==='wpn_1'&&i.bless));
  const inventory=structuredClone(read().p.inv);assert.equal(authority.handle(user,buy).replayed,true);assert.equal(read().p.gold,877);assert.deepEqual(read().p.inv,inventory);
  assert.throws(()=>authority.handle(user,body({operation:'buy',index:0,offer})),/商品已售出或輪換/);assert.equal(read().p.gold,877);
  runtime().engine.run("player.pandoraMarket2.slots[1]={id:'wpn_1',price:9999,weight:100,bless:false,setTick:0,sold:false};");authority.commit(user,runtime());
  assert.throws(()=>authority.handle(user,body({operation:'buy',index:1,offer:JSON.stringify(['wpn_1',9999,false,0])})),/金幣不足/);assert.equal(read().p.gold,877);
});

test('black market and exchange shortcuts are independent; card clicks retain the displayed offer after a newer snapshot',async t=>{
  const game=new HeadlessGame();t.after(()=>game.close());game.create({classId:'knight',name:'入口測試',allocation:{str:2,con:6}});
  game.run("refreshPandoraMarket(false);player.gold=1000;player.pandoraMarket2.slots[0]={id:'wpn_1',price:123,weight:100,bless:true,setTick:0,sold:false};document.getElementById('game-screen').classList.remove('hidden');");
  const actions=[];let exchange=0;
  game.window.CloudStore={showMarket:()=>exchange++,action:async(name,params)=>{actions.push({name,params});}};
  game.run(readFileSync(new URL('../online/pandora-market.js',import.meta.url),'utf8').replace('export function','function'));
  game.run('openPandoraShortcut();openPandoraBlackMarket();');await new Promise(r=>setImmediate(r));
  assert.equal(exchange,1);assert.equal(actions[0].params.operation,'view');const panel=game.window.document.getElementById('town-interaction-container');assert.equal(panel.classList.contains('hidden'),false);assert.equal(panel.parentElement,game.window.document.body);
  const cards=panel.querySelectorAll('.pandora-market-card');assert.equal(cards.length,24);assert.equal(panel.querySelector('.pandora-buy-box'),null,'unsupported local-only mutations are not offered');
  assert.equal(game.window.document.getElementById('btn-pandora-shortcut').nextElementSibling.id,'btn-pandora-blackmarket');
  game.run("player.pandoraMarket2.slots[0]={id:'wpn_2',price:999,bless:false,setTick:6000,sold:false};");cards[0].querySelector('button').click();await new Promise(r=>setImmediate(r));
  assert.equal(actions.at(-1).name,'black-market');assert.deepEqual(structuredClone(actions.at(-1).params),{operation:'buy',index:0,offer:JSON.stringify(['wpn_1',123,true,0])});
});
