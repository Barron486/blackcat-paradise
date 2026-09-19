import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {GameService} from '../server/service.mjs';
import {AuthoritativeGame} from '../server/authoritative-game.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {WorldSettingsService} from '../server/world-settings.mjs';
import {LootBroadcastService} from '../server/loot-broadcasts.mjs';
import {createApp} from '../server/index.mjs';
import {CloudClient} from '../cli/cloud-client.mjs';
import {RemoteGame} from '../cli/remote-game.mjs';
import {CommerceService} from '../server/commerce.mjs';
import {MarketService} from '../server/market.mjs';

const catalog=loadCatalog(new URL('../',import.meta.url)),password='server-authority-test-2026!';
async function fixture(t){
  const service=new GameService(':memory:',catalog);new WorldSettingsService(service);new LootBroadcastService(service);
  let now=0;const authority=new AuthoritativeGame(service,{clock:()=>now,idleMs:30000,autoTick:false});t.after(()=>{authority.close();service.close();});
  const gm=await service.register('authority_gm',password,{initialGm:true}),user=await service.register('authority_player',password),lease=randomUUID();service.acquireLease(user,lease);
  let result;
  const send=(op,args={},extra={})=>{const b={lease,op,args,...(op==='state'?{}:{slot:1,epoch:result?.game?.epoch,revision:service.bootstrap(user).revision,requestId:randomUUID()}),...extra};result=authority.handle(user,b);return result;};
  send('create',{classId:'knight',name:'伺服器騎士',allocation:{str:2,con:6}});
  return {service,authority,user,gm,lease,send,advance:ms=>now+=ms};
}
test('server clock owns combat: rapid polls and client ticks cannot mint rewards',async t=>{
  const {send,advance}=await fixture(t);
  send('action',{name:'travel',params:{mapId:'training'}});
  const before=send('state').game.status;
  assert.equal(send('state').game.battle,undefined,'CLI polling does not download unused animation history');
  const visual=send('state',{presentation:{stream:null,seq:0}}).game.battle;
  assert.ok(visual.stream&&visual.frames.length);
  assert.deepEqual(send('state',{presentation:{stream:visual.stream,seq:visual.seq}}).game.battle.frames,[]);
  for(let i=0;i<20;i++)assert.equal(send('state').game.status.ticks,before.ticks);
  assert.throws(()=>send('state',{}, {ticks:100000,elapsedMs:9999999}),e=>e.status===400);
  advance(10000);const after=send('state').game.status;
  assert.equal(after.ticks-before.ticks,100);assert.ok(after.gold>before.gold||after.exp>before.exp||after.level>before.level);
  const value=after.gold;for(let i=0;i<10;i++)assert.equal(send('state').game.status.gold,value);
  advance(60000);assert.equal(send('state').game.status.ticks,after.ticks,'disconnected time is not banked');
});

test('combat checkpoints do not invalidate player intents, but newer commands, external writes and future revisions do',async t=>{
  const {send,advance,authority,service,user,lease,gm}=await fixture(t);
  const initial=send('action',{name:'travel',params:{mapId:'training'}});
  const command={lease,op:'action',slot:1,epoch:initial.game.epoch,revision:initial.snapshot.revision,requestId:randomUUID(),args:{name:'settings',params:{values:{'set-hp-pot':'65'}}}};
  advance(1000);authority.tick();assert.ok(service.bootstrap(user).revision>command.revision);
  const applied=authority.handle(user,command);assert.equal(applied.game.view.p.config.setHpPot,'65');
  assert.equal(authority.handle(user,command).replayed,true,'lost-response retry must not reapply');
  assert.throws(()=>authority.handle(user,{...command,requestId:randomUUID()}),e=>e.status===409,'a different intent cannot reuse a revision before the previous command');
  assert.throws(()=>authority.handle(user,{...command,requestId:randomUUID(),revision:applied.snapshot.revision+100}),e=>e.status===409);
  assert.throws(()=>authority.handle(user,{...command,requestId:randomUUID(),revision:applied.snapshot.revision,epoch:'other-role'}),e=>e.status===409);
  const gmCommand={scope:'account',accountId:user.id,action:'kill',reason:'驗證外部寫入衝突'},preview=service.preview(gm,gmCommand);
  service.execute(gm,{...gmCommand,targetFingerprint:preview.targetFingerprint,requestId:randomUUID()});
  const stale={...command,requestId:randomUUID(),revision:applied.snapshot.revision};
  assert.throws(()=>authority.handle(user,stale),e=>e.status===409);
  advance(1000);authority.tick();
  assert.throws(()=>authority.handle(user,stale),e=>e.status===409,'reconciling an external write keeps the conflict barrier');
  assert.equal(send('state').game.status.gmDead,true);
});

test('browser responses reuse the authoritative saved character and omit duplicate status and animation history',async t=>{
  const {send,advance}=await fixture(t);
  const compact=send('action',{name:'travel',params:{mapId:'training'}},{client:'browser'});
  const saved=catalog.unwrap(compact.snapshot.values.lineage_idle_save_1);
  assert.equal(compact.game.epoch,saved.p._roleEpoch);assert.equal(saved.ms.current,'training');
  assert.equal(compact.game.view,undefined);assert.equal(compact.game.status,undefined);assert.equal(compact.game.battle,undefined);
  advance(1000);
  const streamed=send('state',{presentation:{stream:null,seq:0}},{client:'browser'});
  assert.ok(streamed.game.battle.frames.length,'fallback animation polling remains available');
  const cli=send('state');assert.ok(cli.game.view&&cli.game.status,'legacy and CLI projections are unchanged');
  assert.throws(()=>send('state',null),e=>e.status===400);
  assert.throws(()=>send('state',{}, {client:'admin'}),e=>e.status===400);
});

test('scheduled combat yields between characters, never overlaps a cycle and stops cleanly',async t=>{
  const {service,authority,user,advance}=await fixture(t);
  const other=await service.register('responsive_other',password),lease=randomUUID();service.acquireLease(other,lease);
  authority.handle(other,{lease,op:'create',slot:1,revision:0,requestId:randomUUID(),args:{classId:'knight',name:'另一騎士',allocation:{str:2,con:6}}});
  const turns=[],original=authority.advance.bind(authority);
  authority.advance=(u,r)=>{turns.push(u.id);return original(u,r);};
  advance(1000);setImmediate(()=>turns.push('network'));
  await Promise.all([authority.tickResponsive(),authority.tickResponsive()]);
  assert.deepEqual(turns,[user.id,'network',other.id]);
  turns.length=0;advance(1000);const active=authority.tickResponsive();authority.close();await active;
  assert.deepEqual(turns,[user.id]);
  await authority.tickResponsive();assert.equal(turns.length,1);
});
test('purchase replay, malicious prices, arbitrary rewards, future revisions and prototype actions are rejected',async t=>{
  const {service,authority,user,lease,send}=await fixture(t);
  const initial=send('state'),npc=authority.runtimes.get(user.id).engine.catalog().towns[initial.game.status.map].npcs.find(n=>n.type==='shop');
  const buy={lease,op:'action',slot:1,epoch:initial.game.epoch,revision:initial.snapshot.revision,requestId:randomUUID(),args:{name:'shop',params:{npcId:npc.id,itemId:'potion_heal',qty:1}}};
  const once=authority.handle(user,buy);const twice=authority.handle(user,buy);assert.equal(twice.replayed,true);assert.equal(twice.game.status.gold,once.game.status.gold);
  assert.throws(()=>authority.handle(user,{...buy,args:{name:'shop',params:{...buy.args.params,qty:2}}}),e=>e.status===409);
  assert.throws(()=>send('action',{name:'sell',params:{uid:once.game.status.inventory[0].uid,qty:1,unitPrice:999999999}}),e=>e.status===400);
  assert.equal(service.bootstrap(user).revision,once.snapshot.revision);
  send('select',{}, {epoch:once.game.epoch});
  for(const name of ['gainItem','tick','__proto__','constructor']){
    assert.throws(()=>send('action',{name,params:{gold:999999}}),e=>e.status===400);
    send('select',{}, {epoch:once.game.epoch});
  }
});
test('GM effects survive later combat; reconnect preserves HP, death, encounter and slot identity',async t=>{
  const {send,advance,service,gm,user,authority}=await fixture(t);
  send('action',{name:'travel',params:{mapId:'training'}});advance(1000);const old=send('state');
  const command={scope:'account',accountId:user.id,action:'kill',reason:'測試伺服器死亡'},preview=service.preview(gm,command);
  service.execute(gm,{...command,targetFingerprint:preview.targetFingerprint,requestId:randomUUID()});
  advance(1000);let result=send('state');assert.equal(result.game.status.hp,0);assert.equal(result.game.status.dead,true);
  assert.throws(()=>send('action',{name:'revive',params:{}}),e=>e.status===400);
  result=send('select',{}, {epoch:old.game.epoch});assert.equal(result.game.status.dead,true);assert.equal(result.game.status.hp,0);
  authority.drop(user.id);result=send('select',{}, {epoch:old.game.epoch});assert.equal(result.game.status.hp,0);
  assert.throws(()=>send('create',{classId:'elf',name:'覆蓋',allocation:{dex:8}}),e=>e.status===409);
  assert.throws(()=>send('action',{name:'use',params:{uid:'fake'}},{slot:2}),e=>e.status===409);
});
test('server-created roles cannot inherit browser inventory or a deleted epoch',async t=>{
  const {send,service,user}=await fixture(t),old=send('state');
  send('leave');send('create',{classId:'elf',name:'第二角色',allocation:{dex:8}},{slot:2});
  const values=service.bootstrap(user).values,a=catalog.unwrap(values.lineage_idle_save_1),b=catalog.unwrap(values.lineage_idle_save_2);
  assert.equal(a.p.cls,'knight');assert.equal(b.p.cls,'elf');assert.notEqual(a.p._roleEpoch,b.p._roleEpoch);assert.equal(b.p.lv,1);
  send('delete',{name:a.p.name},{slot:1,epoch:a.p._roleEpoch});
  assert.throws(()=>send('select',{}, {slot:1,epoch:old.game.epoch}),e=>e.status===409);
  assert.throws(()=>send('create',{classId:'knight',name:'作弊',allocation:{str:2,con:6},gold:500000}),e=>e.status===400);
});
test('HTTP rejects all uploaded saves, warehouses and fake rewards, including GM uploads; remote CLI uses intents',async t=>{
  const app=createApp({database:':memory:',catalog,publicOrigin:'',publicAliases:[]});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));});
  const client=new CloudClient({baseUrl:`http://127.0.0.1:${app.server.address().port}`});await client.register('network_player',password);const lease=randomUUID();await client.acquireLease(lease);
  const snapshot=await client.bootstrap();assert.equal(snapshot.authoritative,true);
  for(const changes of [{},{lineage_idle_save_1:'forged'},{lineage_warehouse:'forged'}])await assert.rejects(client.sync({lease,revision:0,changes}),e=>e.status===403&&e.data.code==='SERVER_AUTHORITY_REQUIRED');
  assert.equal((await client.bootstrap()).revision,0);
  const remote=new RemoteGame({client,lease,snapshot});t.after(()=>remote.close());await remote.open({classId:'mage',name:'遠端法師',allocation:{int:6,wis:6,con:4}});
  const before=remote.snapshot().ticks;remote.step(36000);assert.equal(remote.snapshot().ticks,before);
  await remote.action('travel',{mapId:'training'});await remote.refresh();assert.equal(remote.status().map,'training');
  await remote.leave();await client.logout();
});

test('market escrow, paid buffs and GM rewards reconcile with a running server encounter',async t=>{
  const {service,authority,user,gm,lease,send,advance}=await fixture(t);
  const commerce=new CommerceService(service),market=new MarketService(service,commerce);
  let result=send('state');const uid=result.game.status.inventory.find(i=>i.id==='potion_heal').uid;
  const count=r=>r.game.status.inventory.filter(i=>i.id==='potion_heal').reduce((n,i)=>n+i.cnt,0),before=count(result);
  const args=()=>({slot:1,epoch:result.game.epoch,revision:service.bootstrap(user).revision,lease,requestId:randomUUID()});
  const listing=market.transact(user,'list',{...args(),uid,currency:'gold',price:100,quantity:1});
  advance(1000);result=send('state');assert.equal(count(result),before-1,'combat cannot resurrect escrow');
  market.transact(user,'cancel',{...args(),listingId:listing.listingId});
  commerce.grant(gm,{accountId:user.id,amount:300,reason:'整合測試',requestId:randomUUID()});
  commerce.buy(user,{...args(),productId:'full_status'});
  advance(1000);result=send('state');assert.equal(count(result),before);assert.ok(result.game.view.p._shopBuffs.expiresAt>Date.now());assert.equal(commerce.wallet(user.id).diamonds,0);
  const command={scope:'account',accountId:user.id,action:'grant_item',itemId:'potion_heal',quantity:7,enchant:0,reason:'整合測試'},preview=service.preview(gm,command);
  service.execute(gm,{...command,targetFingerprint:preview.targetFingerprint,requestId:randomUUID()});
  advance(1000);result=send('state');assert.equal(count(result),before+7);
  assert.equal(service.lootBroadcasts.history().length,0,'GM and trading deliveries do not announce as combat drops');
  assert.equal(authority.runtimes.get(user.id).revision,result.snapshot.revision);
});

test('reconnecting preserves attack cooldown, damage and the current encounter',async t=>{
  const {send,advance,authority,user}=await fixture(t);
  send('action',{name:'travel',params:{mapId:'training'}});advance(1200);const before=send('state');
  const saved=authority.runtimes.get(user.id).engine.snapshot();send('leave');
  const after=send('select',{}, {epoch:before.game.epoch});
  assert.equal(after.game.view.p.hp,saved.p.hp);assert.equal(after.game.view.p.mp,saved.p.mp);
  assert.equal(after.game.view.ms.current,saved.ms.current);assert.deepEqual(after.game.view.ms.mobs,saved.ms.mobs);
  assert.equal(authority.runtimes.get(user.id).engine.snapshot()._serverState.pDmgTick,saved._serverState.pDmgTick);
  for(let i=0;i<4;i++){send('leave');send('select',{}, {epoch:before.game.epoch});}
  assert.equal(send('state').game.status.ticks,before.game.status.ticks);
});

test('auto-sell validates real rule shapes and cannot carry hidden player fields',async t=>{
  const {send,authority,user}=await fixture(t);
  const rules=JSON.parse(JSON.stringify(authority.runtimes.get(user.id).engine.run('getAutoSellRules()')));
  rules.misc.pot={on:true,keep:10};rules.overrides.potion_heal='keep';
  const result=send('action',{name:'auto-sell',params:{rules,enabled:true,global:true}});
  assert.deepEqual(result.game.view.p.autoSellRules.misc.pot,{on:true,keep:10});assert.equal(result.game.view.p.autoSellRules.overrides.potion_heal,'keep');
  assert.throws(()=>send('action',{name:'auto-sell',params:{rules:{...rules,gold:99999},enabled:true,global:false}}),e=>e.status===400);
  assert.equal(send('state').game.status.gold,1000);
});

test('all eight character classes are server-created with their correct class mapping',async t=>{
  const {send,authority,user}=await fixture(t),classes=authority.runtimes.get(user.id).engine.catalog().classes;
  for(const [index,classId]of ['royal','mage','elf','dark','illusion','dragon','warrior'].entries()){
    const base=classes[classId],allocation={};let points=base.pts;
    for(const stat of ['str','dex','con','int','wis','cha']){allocation[stat]=Math.min(points,20-base[stat]);points-=allocation[stat];}
    const result=send('create',{classId,name:'測試'+classId,allocation},{slot:index+2});assert.equal(result.game.status.classId,classId);assert.equal(result.game.status.level,1);
  }
});

test('server logs preserve rarity colour but strip executable markup',async t=>{
  const {authority,user}=await fixture(t),engine=authority.runtimes.get(user.id).engine;
  engine.run('logSys(__args);','<span class="loot-legendary" style="color:#ffd700" onclick="steal()">傳說裝備</span><img src="x" onerror="steal()"><a href="javascript:steal()">名稱</a>');
  const log=engine.logs.at(-1);assert.ok(log.html.includes('loot-legendary'));assert.ok(log.html.includes('color:'));
  assert.ok(!/onclick|onerror|href|<img|<a\b/.test(log.html));assert.equal(log.message,'傳說裝備名稱');
});
