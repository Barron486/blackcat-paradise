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
async function fixture(t){
  const service=new GameService(':memory:',catalog),authority=new AuthoritativeGame(service,{autoTick:false});
  const user=await service.register('client_qa','isolated-client-password-2026'),lease=randomUUID();service.acquireLease(user,lease);
  authority.handle(user,{lease,op:'create',slot:1,revision:0,requestId:randomUUID(),args:{classId:'mage',name:'伺服器角色',allocation:{int:6,wis:6,con:4}}});authority.drop(user.id);
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
  const npc=authority.runtimes.get(user.id).engine.catalog().towns.town_talking.npcs.find(n=>n.type==='shop');
  lose();await w.CloudStore.action('shop',{npcId:npc.id,itemId:'potion_heal',qty:1});
  const buys=requests.filter(r=>r.body?.args?.name==='shop');assert.equal(buys.length,2);assert.equal(buys[0].body.requestId,buys[1].body.requestId);
  await w.CloudStore.action('travel',{mapId:'training'});const before=requests.length;
  // Re-entering the selected character exercises the original loader's changeMap(true).
  engine.run('document.getElementById("game-screen").classList.add("hidden");');w.loadGame();await w.CloudStore.flush();
  assert.equal(engine.run('mapState.current'),'training');
  assert.ok(!requests.slice(before).some(r=>r.body?.args?.name==='travel'));
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
