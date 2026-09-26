import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {GameService} from '../server/service.mjs';
import {AuthoritativeGame} from '../server/authoritative-game.mjs';
import {WorldSettingsService} from '../server/world-settings.mjs';
import {loadCatalog} from '../server/catalog.mjs';

const catalog=loadCatalog(new URL('../',import.meta.url));
async function fixture(t,character={classId:'knight',name:'傳送測試',allocation:{str:2,con:6}}){
  const service=new GameService(':memory:',catalog);new WorldSettingsService(service);
  let now=0;const authority=new AuthoritativeGame(service,{clock:()=>now,autoTick:false});
  t.after(()=>{authority.close();service.close();});
  const user=await service.register('journey_qa','journey-test-password-2026',{initialGm:true}),lease=randomUUID();service.acquireLease(user,lease);
  const saved=()=>catalog.unwrap(service.bootstrap(user).values.lineage_idle_save_1);
  const body=(op,args={})=>({lease,op,slot:1,args,epoch:service.bootstrap(user).values.lineage_idle_save_1?saved().p._roleEpoch:undefined,revision:service.bootstrap(user).revision,requestId:randomUUID()});
  const send=(op,args={})=>authority.handle(user,body(op,args));
  send('create',character);
  const edit=(code,args)=>{const r=authority.runtimes.get(user.id);r.engine.run(code,args);authority.commit(user,r);};
  edit('player.lv=80;player.gold=5000000;calcStats();player.hp=player.mhp;player.mp=player.mmp;');
  const action=(name,params={})=>send('action',{name,params});
  const npc=(npcId,method,params=[])=>action('npc-command',{npcId,method,params,fields:{}});
  const kill=id=>edit(`mapState.mobs[0]={...DB.mobs[__args],id:__args,uid:'transition-boss',curHp:0,st:newMobStatus()};killMob(0);settleDeadMobs();`,id);
  return {service,authority,user,lease,saved,body,send,edit,action,npc,kill,advance:ms=>{now+=ms;authority.tick();},travel:mapId=>action('travel',{mapId}),reload:()=>{authority.drop(user.id);return send('state');}};
}

test('tower notice accepts both modes only at the entrance; stairs advance and reconnect preserves the climb',async t=>{
  const f=await fixture(t);
  assert.throws(()=>f.npc('_pride_entrance','startPrideClimb',[false]),e=>e.status===400);
  for(const ranked of [false,true]){
    f.travel('town_pride');const started=f.npc('_pride_entrance','startPrideClimb',[ranked]);
    assert.equal(started.game.status.map,'pride_f2');assert.equal(f.saved()._serverState.prideRanked,ranked);
    assert.throws(()=>f.npc('_pride_entrance','startPrideClimb',[false]),e=>e.status===400,'cannot restart from inside the tower');
    f.kill('pride_stairs');assert.equal(f.saved().ms.current,'pride_f3');
    const restored=f.reload();assert.equal(restored.game.status.map,'pride_f3');assert.equal(f.saved()._serverState.prideFloor,3);
    f.advance(1000);assert.equal(f.saved().ms.current,'pride_f3');
    f.action('return-town');assert.equal(f.saved().ms.current,'town_pride');assert.equal(f.saved()._serverState.prideClimb,false);
    if(ranked)assert.equal(f.saved().p.prideRank.last.floor,3);
  }
});

test('rift entry, withdrawal and reward are server owned and retries cannot consume twice',async t=>{
  const f=await fixture(t);f.travel('town_rift');
  f.npc('_rift_entrance','enterRift');assert.equal(f.saved().ms.current,'town_rift');
  f.edit("player.inv.push({id:'mat_crack_core',uid:'rift-cores',cnt:2,en:0});");
  const command=f.body('action',{name:'npc-command',params:{npcId:'_rift_entrance',method:'enterRift',params:[],fields:{}}});
  assert.equal(f.authority.handle(f.user,command).game.status.map,'rift_battle');assert.equal(f.authority.handle(f.user,command).replayed,true);
  assert.equal(f.saved().p.inv.find(i=>i.uid==='rift-cores').cnt,1);
  assert.equal(f.reload().game.status.map,'rift_battle');assert.equal(f.saved()._serverState.riftRun,true);
  f.action('journey',{operation:'rift-exit'});assert.equal(f.saved().ms.current,'town_rift');assert.ok(f.saved().p.riftRewardMs!=null);
  f.npc('_rift_entrance','enterRift');assert.equal(f.saved().ms.current,'town_rift','pending reward blocks another entry');
  const reward=f.body('action',{name:'npc-command',params:{npcId:'_rift_entrance',method:'claimRiftReward',params:[],fields:{}}});
  f.authority.handle(f.user,reward);const inventory=f.saved().p.inv;
  assert.equal(f.saved().p.riftRewardMs,null);assert.equal(f.authority.handle(f.user,reward).replayed,true);assert.deepEqual(f.saved().p.inv,inventory);
  f.npc('_rift_entrance','enterRift');assert.equal(f.saved().ms.current,'rift_battle');assert.ok(!f.saved().p.inv.some(i=>i.uid==='rift-cores'));
});

test('all three Dantes gates consume the correct item once and remain entered after reconnect',async t=>{
  const f=await fixture(t);
  f.edit("player.inv.push({id:'item_dk_book',uid:'books',cnt:2,en:0},{id:'item_giltas_seal',uid:'seal',cnt:1,en:0});");
  for(const [map,cost]of [['dark_elf_sanctuary','item_dk_book'],['cursed_dark_elf_sanctuary','item_dk_book'],['collapsed_elder_council_hall','item_giltas_seal']]){
    f.travel('town_elder_council');const gold=f.saved().p.gold;
    f.npc('npc_dantes_lord','sanctuaryEnter',[map,cost]);assert.equal(f.saved().ms.current,map);assert.equal(f.saved().p.gold,gold);
    assert.equal(f.reload().game.status.map,map);f.advance(1000);assert.equal(f.saved().ms.current,map);
    f.action('return-town');assert.equal(f.saved().ms.current,'town_elder_council');
  }
  assert.ok(!f.saved().p.inv.some(i=>i.id==='item_dk_book'||i.id==='item_giltas_seal'));
  assert.throws(()=>f.npc('npc_dantes_lord','sanctuaryEnter',['dark_elf_sanctuary','potion_heal']),e=>e.status===400);
});

test('Antharas advances through all four areas and records the daily clear only after the final boss',async t=>{
  const f=await fixture(t);f.travel('town_witon');f.npc('npc_doruga_bell','antharasEnter');
  assert.equal(f.saved().ms.current,'antharas_nest_1');assert.equal(f.saved()._serverState.antharas,1);
  for(const [boss,next,phase]of [['ant_kama_flame_king','antharas_nest_2',2],['ant_kama_nan_king','antharas_nest_3',3],['ant_kama_king','antharas_lair',4]]){
    f.kill(boss);assert.equal(f.saved().ms.current,next);assert.equal(f.saved()._serverState.antharas,phase);
    assert.equal(f.reload().game.status.map,next);assert.ok(!f.saved().p.antharasClearDay);
  }
  f.kill('ant_antharas_eroded');
  f.edit("for(let i=0;i<5&&state.antharas&&mapState.mobs[0];i++){mapState.mobs[0].curHp=0;killMob(0);settleDeadMobs();}");
  assert.equal(f.saved().ms.current,'town_witon');assert.equal(f.saved()._serverState.antharas,0);
  assert.ok(f.saved().p.antharasClearDay);assert.throws(()=>f.npc('npc_doruga_bell','antharasEnter'),e=>e.status===400);
});

test('Riley aide exchanges materials and opens heirlooms on the server exactly once',async t=>{
  const f=await fixture(t);f.travel('town_witon');
  f.edit("player.inv.push({id:'mat_antharas_scale',uid:'riley-scales',cnt:10,en:0});");
  const exchange=f.body('action',{name:'npc-command',params:{npcId:'npc_riley_aide',method:'antPointsExchange',params:['mat_antharas_scale'],fields:{}}});
  const exchanged=f.authority.handle(f.user,exchange);
  assert.equal(exchanged.snapshot.values.lineage_idle_antharas_points,'10');
  assert.ok(!f.saved().p.inv.some(i=>i.uid==='riley-scales'));
  assert.equal(f.authority.handle(f.user,exchange).replayed,true);
  assert.equal(f.service.bootstrap(f.user).values.lineage_idle_antharas_points,'10');

  const before=f.saved(),open=f.body('action',{name:'npc-command',params:{npcId:'npc_riley_aide',method:'antHeirloomOpen',params:[],fields:{}}});
  const opened=f.authority.handle(f.user,open),after=f.saved();
  assert.equal(opened.snapshot.values.lineage_idle_antharas_points,'0');assert.equal(after.p.antHeirSeq,1);
  assert.ok(after.p.gold>before.p.gold||after.p.inv.length>before.p.inv.length);
  assert.equal(f.authority.handle(f.user,open).replayed,true);
  assert.equal(f.saved().p.antHeirSeq,1);assert.equal(f.service.bootstrap(f.user).values.lineage_idle_antharas_points,'0');

  f.travel('town_talking');
  assert.throws(()=>f.npc('npc_riley_aide','antPointsExchange',['mat_antharas_scale']),e=>e.status===400);
});

test('every hidden hunting map remains reachable by server teleport and cannot be selected directly',async t=>{
  const f=await fixture(t),pairs=Object.entries(f.authority.runtimes.get(f.user.id).engine.run('HIDDEN_AREA_PARENT'));
  f.edit("player.inv.push({id:'scroll_teleport',uid:'hidden-scrolls',cnt:20,en:0});");
  for(const [parent,hidden]of pairs){
    assert.throws(()=>f.travel(hidden),e=>e.status===400);f.travel(parent);
    const before=f.saved().p.inv.find(i=>i.uid==='hidden-scrolls').cnt;
    f.action('teleport');assert.equal(f.saved().ms.current,hidden);assert.equal(f.saved().p.inv.find(i=>i.uid==='hidden-scrolls').cnt,before-1);
    assert.equal(f.reload().game.status.map,hidden);f.action('return-town');
  }
});

test('world restrictions, location and literal menu validation still protect secondary entrances',async t=>{
  const f=await fixture(t);
  for(const [town,npc,method,params,target]of [
    ['town_pride','_pride_entrance','startPrideClimb',[false],'pride_f2'],
    ['town_rift','_rift_entrance','enterRift',[],'rift_battle'],
    ['town_witon','npc_doruga_bell','antharasEnter',[],'antharas_nest_1'],
    ['town_elder_council','npc_dantes_lord','sanctuaryEnter',['dark_elf_sanctuary','item_dk_book'],'dark_elf_sanctuary'],
  ]){
    f.travel(town);const before=f.saved();
    f.service.world.update(f.user,{type:'map',mapId:target,open:false,minLevel:1,revision:f.service.world.state().revision,requestId:randomUUID(),reason:'入口權限測試'});
    f.npc(npc,method,params);assert.equal(f.saved().ms.current,town);assert.deepEqual(f.saved().p.inv,before.p.inv);
    assert.equal(!!f.saved()._serverState.prideClimb,false);assert.equal(!!f.saved()._serverState.riftRun,false);
  }
  f.travel('town_pride');
  for(const [method,params]of [['startPrideClimb',['false']],['startPrideClimb',[false,99]],['enterPrideFloor',[100]],['enterRift',[]]])assert.throws(()=>f.npc('_pride_entrance',method,params),e=>e.status===400);
});

test('all open castle assaults, gate transitions and owned castle travel use server state',async t=>{
  const f=await fixture(t,{classId:'royal',name:'攻城入口測試',allocation:{str:7,con:1}});
  f.edit("{const el=document.createElement('input');el.id='clan-name-input';el.value='入口測試血盟';document.body.append(el);clanCreateFromInput();}");
  const castles=f.authority.runtimes.get(f.user.id).engine.run('SIEGE_CITY');
  for(const city of ['kent','windwood','heine']){
    f.npc('_clan_siege','startSiege',['',city]);assert.equal(f.saved().ms.current,castles[city].outer);assert.equal(f.saved().p.siege.active,true);
    assert.throws(()=>f.travel(castles[city].inner),e=>e.status===400,'cannot skip the castle gate');
    f.edit("handleSiegeKill({n:siegeCityCfg().gate,siegeEnemy:true});");assert.equal(f.saved().ms.current,castles[city].inner);
    assert.equal(f.reload().game.status.map,castles[city].inner);
    f.edit("handleSiegeKill({n:siegeCityCfg().tower,siegeEnemy:true});");assert.equal(f.saved().ms.current,castles[city].castle);
    f.travel('training');f.travel(castles[city].castle);assert.equal(f.saved().ms.current,castles[city].castle);
  }
});

test('GM can independently close each castle against new server-authoritative siege declarations',async t=>{
  const f=await fixture(t,{classId:'royal',name:'攻城開關測試',allocation:{str:7,con:1}});
  f.edit("{const el=document.createElement('input');el.id='clan-name-input';el.value='開關測試血盟';document.body.append(el);clanCreateFromInput();}");
  const castles=f.authority.runtimes.get(f.user.id).engine.run('SIEGE_CITY');
  for(const city of ['kent','windwood','heine']){
    const flags={kent:true,windwood:true,heine:true};flags[city]=false;
    f.service.world.update(f.user,{type:'siege',castles:flags,revision:f.service.world.state().revision,requestId:randomUUID(),reason:`關閉${city}測試`});
    assert.throws(()=>f.npc('_clan_siege','startSiege',['',city]),/GM 關閉攻城/);
    assert.equal(f.saved().p.siege.active,false);assert.notEqual(f.saved().ms.current,castles[city].outer);
    const openCity=city==='kent'?'windwood':'kent';
    f.npc('_clan_siege','startSiege',['',openCity]);assert.equal(f.saved().ms.current,castles[openCity].outer);
    f.edit("endSiege('lose');");
  }
});

test('arena NPC teleports to a server duel, preserves its benched party on reload and settles without farming rewards',async t=>{
  const f=await fixture(t),second=f.authority.handle(f.user,{...f.body('create',{classId:'knight',name:'決鬥對手',allocation:{str:2,con:6}}),slot:2,epoch:undefined});
  f.send('select');f.action('mercenary',{operation:'toggle',slot:2});
  const town=f.authority.runtimes.get(f.user.id).engine.run("Object.entries(DB.towns).find(([id,t])=>t.npcs.some(n=>n.id==='npc_arena'))[0]");
  assert.throws(()=>f.action('arena',{slot:2}),e=>e.status===400);f.travel(town);
  assert.throws(()=>f.action('arena',{slot:1}),e=>e.status===400);
  assert.throws(()=>f.action('arena',{card:'forged-card'}),e=>e.status===400);
  const start=f.body('action',{name:'arena',params:{slot:2}});f.authority.handle(f.user,start);
  assert.equal(f.authority.handle(f.user,start).replayed,true);assert.equal(f.saved().ms.current,'arena_pvp');
  assert.equal(f.saved().p.allies.length,0);assert.equal(f.saved()._serverPvp.bench.length,1);
  f.reload();assert.equal(f.authority.runtimes.get(f.user.id).engine.run('pvpArenaActive()'),true);
  const before=f.saved();f.edit('mapState.mobs[0].curHp=0;killMob(0);settleDeadMobs();');
  assert.equal(f.saved().p.gold,before.p.gold);assert.equal(f.saved().p.exp,before.p.exp);
  assert.deepEqual(f.saved().p.inv,before.p.inv);assert.equal(f.saved().p.allies.length,1);assert.equal(f.saved().p.pvpArena.wins,1);
  f.reload();assert.equal(f.saved()._serverPvp.result.win,true);
  f.action('arena-result',{operation:'continue'});assert.equal(f.saved()._serverPvp.result,null);
  f.action('arena',{slot:2});f.edit('killPlayer();');f.advance(1000);
  assert.equal(f.saved().p.pvpArena.losses,1);assert.equal(f.saved().p.dead,true);
  f.reload();assert.equal(f.saved()._serverPvp.result.win,false);
  f.action('arena-result',{operation:'continue'});assert.equal(f.saved().p.dead,false);
  const card=f.authority.runtimes.get(f.user.id).engine.run('pvpCardEncode(pvpCardFromSlot(2))');
  f.action('arena',{card});f.action('return-town');assert.equal(f.saved().p.pvpArena.losses,2);
  f.action('arena-result',{operation:'return'});assert.equal(f.saved().ms.current,town);assert.equal(f.saved().p.allies.length,1);
  assert.throws(()=>f.action('arena-result',{operation:'continue'}),e=>e.status===400);
  assert.equal(catalog.unwrap(f.service.bootstrap(f.user).values.lineage_idle_save_2).p._roleEpoch,second.game.epoch);
});

test('all six key rooms consume admission once, survive reconnect and return after their required bosses',async t=>{
  const f=await fixture(t),rooms=f.authority.runtimes.get(f.user.id).engine.run('KING_ROOMS');
  for(const [map,room]of Object.entries(rooms)){
    const key=room.key||'item_king_key';
    f.edit("player.inv=player.inv.filter(i=>i.id!==__args);player.inv.push({id:__args,uid:'room-key',cnt:1,en:0});",key);
    f.travel(map);assert.equal(f.saved().ms.current,map);assert.ok(!f.saved().p.inv.some(i=>i.id===key));
    assert.equal(f.reload().game.status.map,map);
    f.edit(`mapState.mobs=__args.map((id,i)=>({...DB.mobs[id],uid:'room-boss-'+i,curHp:DB.mobs[id].hp,st:newMobStatus()}));`,room.bosses||[room.boss]);
    f.edit(`for(let pass=0;pass<10&&KING_ROOMS[mapState.current];pass++){const index=mapState.mobs.findIndex(m=>m&&!m._dead);if(index<0)break;mapState.mobs[index].curHp=0;killMob(index);settleDeadMobs();}`);
    assert.ok(f.saved().ms.current.startsWith('town_'),map+' returns after the final required boss');
  }
});

test('learned teleport magic reaches the hidden destination without a scroll',async t=>{
  const f=await fixture(t,{classId:'mage',name:'傳送術測試',allocation:{int:6,wis:6,con:4}});
  f.travel('zone_37');f.edit("player.skills.push('sk_teleport');player.inv=player.inv.filter(i=>i.id!=='scroll_teleport');calcStats();player.mp=player.mmp;");
  const before=f.saved().p.mp;f.action('teleport');assert.equal(f.saved().ms.current,'hidden_lab_nolife');assert.ok(f.saved().p.mp<before);
});
