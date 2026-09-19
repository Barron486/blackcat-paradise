import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {GameService} from '../server/service.mjs';
import {AuthoritativeGame} from '../server/authoritative-game.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {HeadlessGame} from '../cli/engine.mjs';
import {BattleTimeline} from '../online/battle-timeline.js';

const source=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
const catalog=loadCatalog(new URL('../',import.meta.url));
const settle=()=>new Promise(resolve=>setImmediate(resolve));
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
  w.startWorldChat=()=>({refresh:()=>{}});w.startLootTicker=()=>{};w.npcIntents=[];
  w.BattleTimeline=BattleTimeline;
  w.eval(source('online/battle-playback.js').replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,''));
  // No retry delay in a unit fixture; DOM and upstream game scripts are real.
  w.setTimeout=fn=>{queueMicrotask(fn);return 1;};
  w.eval(source('online/authoritative.js').replace(/^import[^\n]*\n/gm,''));await settle();
  w.loadGame();await w.CloudStore.flush();
  return {w,engine,service,user,authority,requests,lose:()=>{loseNext=true;}};
}
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
