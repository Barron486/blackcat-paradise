import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {GameService} from '../server/service.mjs';
import {AuthoritativeGame} from '../server/authoritative-game.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {HeadlessGame} from '../cli/engine.mjs';
import {BattleTimeline} from '../online/battle-timeline.js';
import {npcIntents} from '../shared/game-intents.js';
import {JSDOM} from 'jsdom';

const source=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
const catalog=loadCatalog(new URL('../',import.meta.url));
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('browser transport aborts stalled reads, bounds network waits and clears its timeout',async t=>{
  const dom=new JSDOM('<script id="cloud-boot" type="application/json">{"values":{},"revision":0,"csrf":"test"}</script>',{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window;
  t.after(()=>w.close());
  let timer,cleared=0;
  w.setTimeout=(fn,ms)=>{assert.equal(ms,15000);timer=fn;return 1;};w.clearTimeout=()=>cleared++;
  w.fetch=async(url,{signal})=>new Promise((resolve,reject)=>{
    if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  });
  w.eval(source('online/bootstrap.js'));
  const controller=new w.AbortController(),cancelled=w.CloudStore.request('/api/game',{op:'state'},{signal:controller.signal});
  controller.abort();await assert.rejects(cancelled,e=>e.name==='AbortError');assert.equal(cleared,1);
  const timeout=w.CloudStore.request('/api/game',{op:'state'});timer();
  await assert.rejects(timeout,e=>e.name==='TimeoutError');assert.equal(cleared,2);
  w.fetch=async()=>({ok:true,json:async()=>({ok:true})});
  assert.equal((await w.CloudStore.request('/api/game',{op:'state'})).ok,true);assert.equal(cleared,3);
});
async function fixture(t,character={classId:'mage',name:'伺服器角色',allocation:{int:6,wis:6,con:4}}){
  const service=new GameService(':memory:',catalog),authority=new AuthoritativeGame(service,{autoTick:false});
  const user=await service.register('client_qa','isolated-client-password-2026'),lease=randomUUID();service.acquireLease(user,lease);
  authority.handle(user,{lease,op:'create',slot:1,revision:0,requestId:randomUUID(),args:character});authority.drop(user.id);
  const engine=new HeadlessGame(),w=engine.window,requests=[];t.after(()=>{engine.close();authority.close();service.close();});
  const boot=w.document.createElement('script');boot.id='cloud-boot';boot.textContent=JSON.stringify(service.bootstrap(user));w.document.body.append(boot);w.eval(source('online/bootstrap.js'));
  let loseNext=false;
  w.CloudStore.request=async(url,body)=>{
    requests.push({url,body:structuredClone(body)});
    if(url==='/api/lease')return service.acquireLease(user,body.lease,true);
    if(url==='/api/bootstrap')return service.bootstrap(user);
    if(url==='/api/game'){
      const result=authority.handle(user,body);
      if(loseNext&&body.op==='action'){loseNext=false;throw new Error('response lost');}return JSON.parse(JSON.stringify(result));
    }
    throw new Error('Unexpected route '+url);
  };
  w.startWorldChat=()=>({refresh:()=>{}});w.startLootTicker=()=>{};w.npcIntents=npcIntents;
  w.BattleTimeline=BattleTimeline;
  w.eval(source('online/battle-playback.js').replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,''));
  w.eval(source('online/battle-feed.js').replace(/^export /gm,''));
  // No retry delay in a unit fixture; DOM and upstream game scripts are real.
  w.setTimeout=fn=>{queueMicrotask(fn);return 1;};
  w.eval(source('online/authoritative.js').replace(/^import[^\n]*\n/gm,''));await settle();
  w.loadGame();await w.CloudStore.flush();
  return {w,engine,service,user,authority,requests,lose:()=>{loseNext=true;}};
}
test('harbour button starts the server voyage once and keeps island controls correct after polling and reloading',async t=>{
  const {w,engine,authority,user,requests,lose}=await fixture(t),r=authority.runtimes.get(user.id);
  r.engine.action('travel',{mapId:'town_heine'});r.engine.run('player.gold=200000;');authority.commit(user,r);
  await w.CloudStore.flush();w.interactNPC('npc_isba','town_heine');
  assert.match(w.document.getElementById('interaction-content').textContent,/前往遺忘之島/);
  lose();w.startOblivion();assert.equal(engine.run('player.gold'),200000,'browser does not deduct the fare locally');
  await w.CloudStore.flush();
  const commands=requests.filter(r=>r.body?.args?.params?.method==='startOblivion');assert.equal(commands.length,2);
  assert.equal(commands[0].body.requestId,commands[1].body.requestId);
  assert.equal(engine.run('mapState.current'),'oblivion_travel');assert.equal(engine.run('player.gold'),100000);assert.equal(engine.run('state.oblivion'),'travel');
  assert.equal(w.document.getElementById('pride-floor-indicator').textContent,'遺忘之島途中');
  assert.ok(w.document.getElementById('map-category').classList.contains('hidden'));
  await w.CloudStore.flush();assert.equal(engine.run('mapState.current'),'oblivion_travel');
  engine.run('document.getElementById("game-screen").classList.add("hidden");');w.loadGame();await w.CloudStore.flush();
  assert.equal(engine.run('state.oblivion'),'travel');assert.equal(engine.run('player.gold'),100000);
  w.returnToTown();await w.CloudStore.flush();assert.equal(engine.run('state.oblivion'),null);
  assert.equal(w.document.getElementById('map-category').classList.contains('hidden'),false);
});

test('web renderer never uploads tampered values or runs local combat; MP helpers survive snapshots',async t=>{
  const {w,engine,service,user,requests}=await fixture(t);
  engine.run('player.gold=99999999;player.lv=99;state.ticks=9999999;tick();');
  w.CloudStore.set('lineage_idle_save_1','forged');await w.CloudStore.flush();
  const p=catalog.unwrap(service.bootstrap(user).values.lineage_idle_save_1).p;
  assert.equal(p.gold,1000);assert.equal(p.lv,1);assert.equal(engine.run('player.gold'),1000);
  assert.equal(engine.run('typeof player.d.getMpCost'),'function');
  assert.ok(requests.every(r=>r.url!=='/api/sync'&&!r.body?.changes));
});
test('web retries one server-issued purchase and loading a battle never sends an implicit home teleport',async t=>{
  const {w,engine,authority,user,requests,lose}=await fixture(t);
  const server=authority.runtimes.get(user.id).engine,npc=server.catalog().towns.town_talking.npcs.find(n=>n.type==='shop');
  const beforeBuy=server.snapshot().p,price=server.shopInventory(npc.id).find(i=>i.id==='potion_heal').price;
  const count=p=>p.inv.filter(i=>i.id==='potion_heal').reduce((n,i)=>n+i.cnt,0);
  w.interactNPC(npc.id,'town_talking');
  w.document.getElementById('shop-qty-potion_heal').value='3';
  const buy=w.document.getElementById('shop-qty-potion_heal').parentElement.querySelector('button');
  lose();engine.run(buy.getAttribute('onclick'));await w.CloudStore.flush();
  const buys=requests.filter(r=>r.body?.args?.name==='shop');assert.equal(buys.length,2);assert.equal(buys[0].body.requestId,buys[1].body.requestId);
  assert.equal(buys[0].body.args.params.qty,3);
  assert.equal(server.snapshot().p.gold,beforeBuy.gold-price*3);assert.equal(count(server.snapshot().p),count(beforeBuy)+3);
  assert.equal(engine.run('player.gold'),beforeBuy.gold-price*3);
  await w.CloudStore.action('travel',{mapId:'training'});const before=requests.length;
  // Re-entering the selected character exercises the original loader's changeMap(true).
  engine.run('document.getElementById("game-screen").classList.add("hidden");');w.loadGame();await w.CloudStore.flush();
  assert.equal(engine.run('mapState.current'),'training');
  assert.ok(!requests.slice(before).some(r=>r.body?.args?.name==='travel'));
});

test('shop buttons buy arrow bundles and a single skillbook with server-calculated prices',async t=>{
  const {w,engine,authority,user,requests}=await fixture(t),r=authority.runtimes.get(user.id),server=r.engine;
  server.run('player.gold=1000000;');authority.commit(user,r);await w.CloudStore.flush();
  const npcs=server.catalog().towns.town_talking.npcs,npc=npcs.find(n=>n.type==='shop');
  w.interactNPC(npc.id,'town_talking');
  const count=id=>server.snapshot().p.inv.filter(i=>i.id===id).reduce((n,i)=>n+i.cnt,0);
  const arrowCount=count('wpn_5'),gold=server.snapshot().p.gold,price=server.shopInventory(npc.id).find(i=>i.id==='wpn_5').price;
  const qty=w.document.getElementById('shop-qty-wpn_5');qty.value='2';
  engine.run(qty.parentElement.querySelector('button').getAttribute('onclick'));await w.CloudStore.flush();
  assert.equal(count('wpn_5'),arrowCount+2000);assert.equal(server.snapshot().p.gold,gold-price*2);
  const merchant=npcs.find(n=>n.type==='skill'&&server.shopInventory(n.id).some(i=>server.catalog().items[i.id].type==='skillbk'));
  assert.ok(merchant,'a real skillbook merchant is available in the starting town');
  const book=server.shopInventory(merchant.id).find(i=>server.catalog().items[i.id].type==='skillbk');
  w.interactNPC(merchant.id,'town_talking');
  const button=[...w.document.querySelectorAll('#shop-items-list button')].find(b=>b.getAttribute('onclick')===`buyItem('${book.id}')`);
  assert.ok(button,'skillbooks have a single-purchase button without a quantity argument');
  const beforeBook=count(book.id),beforeGold=server.snapshot().p.gold;
  engine.run(button.getAttribute('onclick'));await w.CloudStore.flush();
  assert.equal(requests.filter(r=>r.body?.args?.name==='shop').at(-1).body.args.params.qty,1);
  assert.equal(count(book.id),beforeBook+1);assert.equal(server.snapshot().p.gold,beforeGold-book.price);
  assert.equal(engine.run('player.gold'),beforeGold-book.price);
});

test('invalid shop quantities never send a purchase or spend gold',async t=>{
  const {w,authority,user,requests}=await fixture(t),server=authority.runtimes.get(user.id).engine;
  const npc=server.catalog().towns.town_talking.npcs.find(n=>n.type==='shop');w.interactNPC(npc.id,'town_talking');
  const before=server.snapshot().p;
  for(const qty of ['', ' ', 'abc', '0', '-1', '1.5', '10001', NaN, Infinity, null, true, []]){
    w.buyItem('potion_heal',qty);
    assert.match(w.document.querySelector('.cloud-save').textContent,/請輸入 1～10000 的整數購買數量/);
  }
  await w.CloudStore.flush();
  assert.equal(requests.filter(r=>r.body?.args?.name==='shop').length,0);
  assert.equal(server.snapshot().p.gold,before.gold);assert.deepEqual(server.snapshot().p.inv,before.inv);
});

test('Elion buttons confirm paid element changes, refresh the menu and retry without a second fee',async t=>{
  const {w,engine,authority,user,requests,lose}=await fixture(t,{classId:'elf',name:'屬性測試妖精',allocation:{dex:8}}),r=authority.runtimes.get(user.id);
  r.engine.action('travel',{mapId:'town_elf'});r.engine.run('player.lv=30;player.gold=1000000;');authority.commit(user,r);await w.CloudStore.flush();
  w.interactNPC('npc_elion','town_elf');
  const panel=w.document.getElementById('interaction-content');
  const click=element=>engine.run([...panel.querySelectorAll('button')].find(b=>b.getAttribute('onclick')===`chooseElfElement('${element}')`).getAttribute('onclick'));
  let confirmation='';w.confirm=message=>{confirmation=message;return false;};
  click('wind');await w.CloudStore.flush();assert.equal(confirmation,'','initial selection is free');
  assert.equal(r.engine.snapshot().p.elfEle,'wind');assert.equal(r.engine.snapshot().p.gold,1000000);
  assert.match(panel.textContent,/目前屬性：風屬性/);
  const before=requests.filter(r=>r.body?.args?.name==='element').length;
  click('water');await w.CloudStore.flush();assert.match(confirmation,/500,000.*水/);
  assert.equal(requests.filter(r=>r.body?.args?.name==='element').length,before,'cancelling never sends the paid action');
  assert.equal(r.engine.snapshot().p.elfEle,'wind');
  w.confirm=()=>true;lose();click('water');await w.CloudStore.flush();
  const changes=requests.filter(r=>r.body?.args?.name==='element').slice(before);
  assert.equal(changes.length,2);assert.equal(changes[0].body.requestId,changes[1].body.requestId);
  assert.equal(r.engine.snapshot().p.elfEle,'water');assert.equal(r.engine.snapshot().p.gold,500000);
  assert.equal(engine.run('player.elfEle'),'water');assert.match(panel.textContent,/目前屬性：水屬性/);assert.match(panel.textContent,/目前持有 500,000/);
  assert.equal(panel.querySelector('[onclick="chooseElfElement(\'water\')"]').disabled,true);
  w.returnToCharacterSelect();await w.CloudStore.flush();w.loadGame();await w.CloudStore.flush();
  assert.equal(engine.run('player.elfEle'),'water');assert.equal(engine.run('player.gold'),500000);
});

test('an interaction interrupts a slow read-only poll without cancelling a write or publishing a cancellation error',async t=>{
  const {w,engine,requests}=await fixture(t),original=w.CloudStore.request;
  let waiting=false,aborted=false,releaseWrite;
  w.CloudStore.request=async(url,body,options={})=>{
    if(body?.op==='state'){
      waiting=true;
      return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{aborted=true;reject(options.signal.reason);},{once:true}));
    }
    const result=await original(url,body,options);
    if(body?.args?.name==='settings')await new Promise(resolve=>{releaseWrite=resolve;});
    return result;
  };
  const read=w.CloudStore.flush();await settle();assert.ok(waiting);
  const first=w.CloudStore.action('settings',{values:{'set-hp-pot':'65'}});await settle();
  assert.ok(aborted);assert.equal(typeof releaseWrite,'function','write starts before the stale poll completes');
  const count=requests.length;
  const second=w.CloudStore.action('settings',{values:{'set-hp-pot':'55'}});await settle();
  assert.equal(requests.length,count,'writes remain ordered and cannot cancel an in-flight purchase/action');
  w.CloudStore.request=original;releaseWrite();await Promise.all([read,first,second]);
  assert.equal(engine.run('player.config.setHpPot'),'55');
  assert.equal(w.document.querySelector('.cloud-save').classList.contains('cloud-error'),false);
});

test('editing auto-sell exceptions survives server updates and saves as a validated intent',async t=>{
  const {w,engine,service,user}=await fixture(t);
  w.openAutoSellRules();engine.run("player.autoSellRules.overrides.potion_heal='keep';");
  await w.CloudStore.flush();assert.equal(engine.run('player.autoSellRules.overrides.potion_heal'),'keep');
  w.saveAutoSellRules();await w.CloudStore.flush();
  assert.equal(catalog.unwrap(service.bootstrap(user).values.lineage_idle_save_1).p.autoSellRules.overrides.potion_heal,'keep');
});

test('three potion settings survive server polling, leaving and re-entering the character',async t=>{
  const {w,engine,service,user}=await fixture(t);
  const input=w.document.getElementById('set-hp-pot');input.value='65';input.dispatchEvent(new w.Event('change',{bubbles:true}));await w.CloudStore.flush();
  assert.equal(catalog.unwrap(service.bootstrap(user).values.lineage_idle_save_1).p.config.setHpPot,'65');
  w.returnToCharacterSelect();await w.CloudStore.flush();w.loadGame();await w.CloudStore.flush();
  assert.equal(engine.run('document.getElementById("set-hp-pot").value'),'65');
});
