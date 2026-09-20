import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {GameService} from '../server/service.mjs';
import {AuthoritativeGame} from '../server/authoritative-game.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {HeadlessGame} from '../cli/engine.mjs';
import {BattleTimeline} from '../online/battle-timeline.js';
import {npcIntents,townEntrances,journeyDefaults} from '../shared/game-intents.js';
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
async function fixture(t,character={classId:'mage',name:'伺服器角色',allocation:{int:6,wis:6,con:4}},companions=[]){
  const service=new GameService(':memory:',catalog),authority=new AuthoritativeGame(service,{autoTick:false});
  const user=await service.register('client_qa','isolated-client-password-2026'),lease=randomUUID();service.acquireLease(user,lease);
  authority.handle(user,{lease,op:'create',slot:1,revision:0,requestId:randomUUID(),args:character});
  for(const [index,companion]of companions.entries()){
    authority.handle(user,{lease,op:'create',slot:index+2,revision:service.bootstrap(user).revision,requestId:randomUUID(),args:companion});
    const r=authority.runtimes.get(user.id);r.engine.run("player.lv=40;player.skills=['sk_lightarrow','sk_heal1','sk_shield','sk_mana_drain'];calcStats();");authority.commit(user,r);
  }
  if(companions.length)authority.handle(user,{lease,op:'select',slot:1,revision:service.bootstrap(user).revision,epoch:catalog.unwrap(service.bootstrap(user).values.lineage_idle_save_1).p._roleEpoch,requestId:randomUUID()});
  authority.drop(user.id);
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
  w.startWorldChat=()=>({refresh:()=>{}});w.startLootTicker=()=>{};w.npcIntents=npcIntents;w.townEntrances=townEntrances;w.journeyDefaults=journeyDefaults;
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

async function squadFixture(t){
  const f=await fixture(t,undefined,[{classId:'mage',name:'隊員法師',allocation:{int:6,wis:6,con:4}},{classId:'mage',name:'另一位法師',allocation:{int:6,wis:6,con:4}}]);
  for(const slot of [2,3])await f.w.CloudStore.action('mercenary',{operation:'toggle',slot});
  f.w.renderSquadPanel();f.w.switchSquadTab('skill');
  f.saved=()=>catalog.unwrap(f.service.bootstrap(f.user).values.lineage_idle_save_1).p;
  f.control=(slot,setting)=>f.w.document.querySelector(`[data-ally-slot="${slot}"][data-ally-setting="${setting}"]`);
  f.edit=(slot,setting,value)=>{
    const el=f.control(slot,setting);assert.ok(el,`missing real squad control: ${setting}`);
    el.value=String(value);f.engine.run(`{const el=document.querySelector(__args);(function(){${el.getAttribute(el.type==='number'?'oninput':'onchange')}}).call(el);}`,`[data-ally-slot="${slot}"][data-ally-setting="${setting}"]`);
  };
  return f;
}

test('squad potion input immediately persists per teammate across polls, reconnect and rehire',async t=>{
  const f=await squadFixture(t),{w,authority,user,lose,requests}=f;
  const originalOther=f.saved().allies.find(a=>a._slot==='3'),identity=f.saved().allies.find(a=>a._slot==='2').enSeed;
  lose();f.edit(2,'potion',73);await w.CloudStore.flush();
  assert.equal(f.saved().allies.find(a=>a._slot==='2')._potHpPct,73);assert.equal(f.saved().mercPrefs[identity]._potHpPct,73);
  assert.equal(f.saved().allies.find(a=>a._slot==='3')._potHpPct,originalOther._potHpPct);
  const edits=requests.filter(r=>r.body?.args?.name==='mercenary-settings');assert.equal(edits.length,2);assert.equal(edits[0].body.requestId,edits[1].body.requestId);
  await w.CloudStore.flush();assert.equal(f.control(2,'potion').value,'73');
  w.returnToCharacterSelect();await w.CloudStore.flush();authority.drop(user.id);w.loadGame();await w.CloudStore.flush();
  assert.equal(f.control(2,'potion').value,'73');
  await w.CloudStore.action('mercenary',{operation:'refresh',slot:2});
  await w.CloudStore.action('mercenary',{operation:'dismiss',slot:2});await w.CloudStore.action('mercenary',{operation:'toggle',slot:2});
  assert.equal(f.saved().allies.find(a=>a._slot==='2')._potHpPct,73);assert.equal(f.control(2,'potion').value,'73');
  const server=authority.runtimes.get(user.id).engine;
  const healed=server.run(`(()=>{const ally=_findAlly(2);ally.curHp=Math.floor(ally.mhp/2);ally._potCd=0;const hp=ally.curHp,count=player.inv.find(i=>i.id==='potion_heal').cnt;allyTryPotion(ally);return {beforeHp:hp,afterHp:ally.curHp,consumed:count-player.inv.find(i=>i.id==='potion_heal').cnt};})()`);
  assert.ok(healed.afterHp>healed.beforeHp,'persisted threshold is used by server potion logic');assert.equal(healed.consumed,1);
  authority.commit(user,authority.runtimes.get(user.id));await w.CloudStore.flush();
  f.edit(2,'potion',0);await w.CloudStore.flush();assert.equal(f.saved().mercPrefs[identity]._potHpPct,0,'zero disables potions and is saved');
});

test('squad skills, HP/MP thresholds and auto buffs save through the actual controls',async t=>{
  const f=await squadFixture(t),{w}=f,identity=f.saved().allies.find(a=>a._slot==='2').enSeed;
  for(const [setting,value]of [['attack','sk_lightarrow'],['heal','sk_heal1'],['convert','sk_mana_drain'],['heal-hp',64],['hp-skill',29],['cast-mp',18]])f.edit(2,setting,value);
  w.setAllyAutoBuff('2','sk_shield',true);await w.CloudStore.flush();
  const pref=f.saved().mercPrefs[identity];
  for(const [field,value]of Object.entries({_atkSkill:'sk_lightarrow',_healSkill:'sk_heal1',_convertSkill:'sk_mana_drain',_healHpPct:64,_hpSkillPct:29,_castMpPct:18}))assert.equal(pref[field],value);
  assert.equal(pref._autoBuff.sk_shield,true);assert.equal(f.control(2,'auto-buff').checked,true);
  w.setAllyAutoBuff('2','sk_shield',false);f.edit(2,'attack','');await w.CloudStore.flush();
  assert.equal(f.saved().mercPrefs[identity]._autoBuff.sk_shield,false);assert.equal(f.saved().mercPrefs[identity]._atkSkill,'');
});

test('a slow squad save never overwrites a later numeric edit or replaces the focused input',async t=>{
  const f=await squadFixture(t),{w}=f,original=w.CloudStore.request;
  let release,first=true;
  w.CloudStore.request=async(url,body,options)=>{
    const result=await original(url,body,options);
    if(first&&body?.args?.name==='mercenary-settings'){first=false;await new Promise(resolve=>{release=resolve;});}
    return result;
  };
  const input=f.control(2,'potion');input.focus();f.edit(2,'potion',4);await settle();
  f.edit(2,'potion',48);input.blur();w.renderSquadPanel();
  assert.equal(f.control(2,'potion'),input);assert.equal(input.value,'48');assert.equal(typeof release,'function');
  release();await w.CloudStore.flush();assert.equal(input.value,'48');assert.equal(f.saved().allies.find(a=>a._slot==='2')._potHpPct,48);
  assert.equal(w.CloudStore.squadEditing('2'),false);
});

test('server rejects forged squad values, unknown skills, nonmembers and replaced identities',async t=>{
  const f=await squadFixture(t),{w}=f,identity=f.saved().allies.find(a=>a._slot==='2').enSeed;
  const original=f.saved().allies.find(a=>a._slot==='2');
  for(const overrides of [{value:-1},{value:101},{value:1.5},{value:'80'},{slot:8},{slot:1},{identity:'replaced-role'},{setting:'gold',value:999999},{value:80,gold:999999},{setting:'attack',value:'sk_hell_fire'},{setting:'heal',value:'sk_lightarrow'},{setting:'auto-buff',skillId:'sk_lightarrow',value:true},{setting:'auto-buff',skillId:'sk_shield',value:'true'}]){
    await assert.rejects(w.CloudStore.action('mercenary-settings',{slot:2,identity,setting:'potion',value:80,...overrides}),e=>e.status===400);
  }
  await w.CloudStore.flush();assert.equal(f.saved().allies.find(a=>a._slot==='2')._potHpPct,original._potHpPct);
  assert.equal(w.CloudStore.squadEditing('2'),false);
});

const clickNpcButton=(w,method)=>{
  const button=[...w.document.querySelectorAll('#interaction-content button[onclick]')].find(el=>el.getAttribute('onclick').startsWith(method+'('));
  assert.ok(button,'visible menu contains '+method);assert.equal(button.disabled,false);w.eval(button.getAttribute('onclick'));
};

test('tower notice ignores the last NPC and enters through the real button with synchronized floor and mode',async t=>{
  const {w,engine,authority,user,requests}=await fixture(t);
  await w.CloudStore.action('travel',{mapId:'town_pride'});w.interactNPC('npc_bamut','town_pride');
  w.openTownFloatWindow('傲慢之塔','排名挑戰',w.renderPrideEntrance);clickNpcButton(w,'startPrideClimb');
  await w.CloudStore.flush();assert.equal(engine.status().map,'pride_f2');
  assert.equal(requests.filter(r=>r.body?.args?.name==='npc-command').at(-1).body.args.params.npcId,'_pride_entrance');
  assert.equal(engine.run('state.prideClimb'),true);assert.equal(engine.run('state.prideFloor'),2);
  assert.match(w.document.getElementById('pride-floor-indicator')?.textContent||w.document.getElementById('adventure-controls').textContent,/2/);
  const r=authority.runtimes.get(user.id);r.engine.run("mapState.mobs[0]={...DB.mobs.pride_stairs,uid:'stairs',curHp:0,st:newMobStatus()};killMob(0);settleDeadMobs();");authority.commit(user,r);
  await w.CloudStore.flush();assert.equal(engine.status().map,'pride_f3');assert.equal(engine.run('state.prideFloor'),3);
  authority.drop(user.id);await w.CloudStore.flush();assert.equal(engine.status().map,'pride_f3');
  w.returnToTown();await w.CloudStore.flush();assert.equal(engine.run('state.prideClimb'),false);
});

test('rift notice, return button and reward menu stay in sync without local mutation or duplicated fees',async t=>{
  const {w,engine,authority,user,lose}=await fixture(t);await w.CloudStore.action('travel',{mapId:'town_rift'});
  const r=authority.runtimes.get(user.id);r.engine.run("player.inv.push({id:'mat_crack_core',uid:'browser-cores',cnt:2,en:0});");authority.commit(user,r);await w.CloudStore.flush();
  w.openTownFloatWindow('時空裂痕','進入',w.renderRiftEntrance);lose();clickNpcButton(w,'enterRift');await w.CloudStore.flush();
  assert.equal(engine.status().map,'rift_battle');assert.equal(engine.run('state.riftRun'),true);
  assert.equal(engine.status().inventory.find(i=>i.uid==='browser-cores').cnt,1);
  w.riftEvacuate();await w.CloudStore.flush();assert.equal(engine.status().map,'town_rift');assert.equal(engine.run('state.riftRun'),false);
  w.openTownFloatWindow('時空裂痕','進入',w.renderRiftEntrance);assert.match(w.document.getElementById('interaction-content').textContent,/可領取/);
  clickNpcButton(w,'claimRiftReward');await w.CloudStore.flush();assert.match(w.document.getElementById('interaction-content').textContent,/領取獎勵（無）/);
});

test('Antharas NPC button and stage display remain authoritative after polling and reconnect',async t=>{
  const {w,engine,authority,user}=await fixture(t);await w.CloudStore.action('travel',{mapId:'town_witon'});
  w.interactNPC('npc_doruga_bell','town_witon');clickNpcButton(w,'antharasEnter');await w.CloudStore.flush();
  assert.equal(engine.status().map,'antharas_nest_1');assert.equal(engine.run('state.antharas'),1);
  assert.equal(w.document.getElementById('map-category').classList.contains('hidden'),true);
  assert.equal(w.document.getElementById('btn-teleport').classList.contains('hidden'),true);
  authority.drop(user.id);await w.CloudStore.flush();assert.equal(engine.status().map,'antharas_nest_1');assert.equal(engine.run('state.antharas'),1);
  w.returnToTown();await w.CloudStore.flush();assert.equal(engine.run('state.antharas'),0);
  assert.equal(w.document.getElementById('map-category').classList.contains('hidden'),false);
});

test('arena challenge and result buttons use server combat and retain the return flow after death',async t=>{
  const {w,engine,authority,user}=await fixture(t,undefined,[{classId:'knight',name:'競技對手',allocation:{str:2,con:6}}]);
  await w.CloudStore.action('travel',{mapId:'town_gludin'});w.interactNPC('npc_arena','town_gludin');
  clickNpcButton(w,'pvpChallengeSlot');await w.CloudStore.flush();
  assert.equal(engine.status().map,'arena_pvp');assert.equal(engine.run('pvpArenaActive()'),true);
  const r=authority.runtimes.get(user.id);r.engine.run('killPlayer();');r.engine.step(0);authority.commit(user,r);
  await w.CloudStore.flush();assert.equal(engine.run('pvpArenaActive()'),false);assert.equal(engine.status().dead,true);
  assert.ok(w.document.getElementById('pvp-result-modal'));w.pvpResultReturn();await w.CloudStore.flush();
  assert.equal(engine.status().map,'town_gludin');assert.equal(engine.status().dead,false);assert.equal(w.document.getElementById('pvp-result-modal'),null);
});

test('guild equipment buttons transfer and return items once, update both characters and survive reconnect',async t=>{
  const {w,engine,authority,service,user,lose,requests}=await fixture(t,undefined,[{classId:'knight',name:'換裝隊員',allocation:{str:2,con:6}}]);
  const r=authority.runtimes.get(user.id);r.engine.run("player.inv.push({id:'wpn_2',uid:'guild-mace',cnt:2,en:3});");authority.commit(user,r);
  await w.CloudStore.action('mercenary',{operation:'toggle',slot:2});
  const town=engine.status().map,npc=engine.run('DB.towns[mapState.current].npcs.find(n=>n.type===\'ally\').id');
  w.interactNPC(npc,town);w.openAllyEquipmentManager(2);
  const read=slot=>catalog.unwrap(service.bootstrap(user).values['lineage_idle_save_'+slot]).p;
  const prior=read(2).eq.wpn,leaderWeapon=read(1).eq.wpn;
  lose();clickNpcButton(w,'allyEquipItem');assert.equal(read(1).inv.find(i=>i.uid==='guild-mace').cnt,2);
  await w.CloudStore.flush();
  assert.equal(read(2).eq.wpn.id,'wpn_2');assert.equal(read(2).eq.wpn.en,3);assert.equal(read(1).inv.find(i=>i.uid==='guild-mace').cnt,1);
  assert.deepEqual(read(1).eq.wpn,leaderWeapon);assert.equal(read(1).allies[0].eq.wpn.id,'wpn_2');
  if(prior)assert.ok(read(1).inv.some(i=>i.id===prior.id&&i.en===prior.en));
  assert.match(w.document.getElementById('interaction-content').textContent,/釘錘/);
  const actions=requests.filter(r=>r.body?.args?.name==='mercenary-equipment');assert.equal(actions.length,2);assert.equal(actions[0].body.requestId,actions[1].body.requestId);
  authority.drop(user.id);await w.CloudStore.flush();assert.equal(read(2).eq.wpn.id,'wpn_2');assert.equal(engine.run('player.allies[0].eq.wpn.id'),'wpn_2');
  w.allyUnequipItem(2,'wpn');await w.CloudStore.flush();assert.equal(read(2).eq.wpn,null);assert.equal(read(1).inv.filter(i=>i.id==='wpn_2'&&i.en===3).reduce((n,i)=>n+i.cnt,0),2);
});

test('guild rejects forged equipment, stale members, forbidden classes and cursed swaps without moving inventory',async t=>{
  const {w,authority,service,user}=await fixture(t,undefined,[{classId:'knight',name:'換裝限制',allocation:{str:2,con:6}}]);
  await w.CloudStore.action('mercenary',{operation:'toggle',slot:2});
  const r=authority.runtimes.get(user.id);r.engine.run("player.inv.push({id:'wpn_2',uid:'valid-mace',cnt:1,en:0},{id:'wpn_29',uid:'elf-only-bow',cnt:1,en:0});");authority.commit(user,r);await w.CloudStore.flush();
  const read=slot=>catalog.unwrap(service.bootstrap(user).values['lineage_idle_save_'+slot]).p;
  const identity=read(2).enSeed,base={operation:'equip',slot:2,identity,uid:'valid-mace'},before=[read(1).inv,read(2).eq];
  for(const change of [{uid:'unknown'},{uid:'elf-only-bow'},{identity:'replaced-role'},{slot:1},{slot:8},{gearSlot:'wpn'}])await assert.rejects(w.CloudStore.action('mercenary-equipment',{...base,...change}),e=>e.status===400);
  assert.deepEqual([read(1).inv,read(2).eq],before);
  await w.CloudStore.action('travel',{mapId:'training'});await assert.rejects(w.CloudStore.action('mercenary-equipment',base),e=>e.status===400);w.returnToTown();await w.CloudStore.flush();
  const active=authority.runtimes.get(user.id);active.engine.run("{const d=JSON.parse(_saveUnwrap(_lzGet('lineage_idle_save_2')).payload);d.p.eq.wpn={id:'wpn_1',uid:'cursed-axe',cnt:1,en:0,bless:'cursed'};_lzSet('lineage_idle_save_2',_saveWrap(JSON.stringify(d)));refreshAllyOnce(2);}");authority.commit(user,active);await w.CloudStore.flush();
  const cursed=[read(1).inv,read(2).eq];
  await assert.rejects(w.CloudStore.action('mercenary-equipment',base),e=>e.status===400);
  await assert.rejects(w.CloudStore.action('mercenary-equipment',{operation:'unequip',slot:2,identity,gearSlot:'wpn'}),e=>e.status===400);
  assert.deepEqual([read(1).inv,read(2).eq],cursed);
});
