import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {GameService} from '../server/service.mjs';
import {WorldSettingsService} from '../server/world-settings.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {HeadlessGame} from '../server/game-engine.mjs';
const catalog=loadCatalog(new URL('../',import.meta.url));
async function admin(t){const service=new GameService(':memory:',catalog),world=new WorldSettingsService(service),gm=await service.register('respawn_gm','isolated-respawn-password',{initialGm:true});t.after(()=>service.close());return {service,world,gm,update:body=>world.update(gm,{revision:world.state().revision,requestId:randomUUID(),reason:'重生間隔測試',...body})};}
function battle(t,monsters={},map='antaras_lair'){
 const game=new HeadlessGame();t.after(()=>game.close());game.create({classId:'knight',name:'重生測試',allocation:{str:2,con:6}});
 let now=Date.now(),revision=0;game.window.__testNow=now;game.run('Date.now=()=>window.__testNow;player.buffs.sk_abs_barrier=999999;Math.random=()=>0.5;window.__testUid=0;uid=()=>"respawn-"+(++window.__testUid);');
 const rules=value=>game.setWorldSettings({revision:++revision,monsters:value});rules(monsters);
 game.run("mapState.current=__args;mapState.mobs=[null,null,null,null,null];mapState.spawnAt=[null,null,null,null,null];",map);
 const step=ms=>{now+=ms;game.window.__testNow=now;game.step(ms/100,now);};
 const kill=i=>game.run('mapState.mobs[__args].curHp=0;killMob(__args);settleDeadMobs();',i);
 return {game,step,kill,rules,now:()=>now};
}

test('GM respawn settings validate atomic batches, persist and reset whole transformation families without changing stats',async t=>{
 const {world,gm,update}=await admin(t);
 const request={type:'monsters',ids:['antaras','sr_sessyoseki'],respawnSeconds:3600,values:{hp:12345},requestId:randomUUID(),revision:0};
 update(request);assert.equal(update(request).replayed,true);assert.equal(world.history().length,1);
 const s=world.state();for(const id of ['antaras','sr_tamamo','sr_kyuubi','sr_sessyoseki'])assert.equal(s.monsters[id].respawnSeconds,3600);
 assert.equal(s.monsters.sr_tamamo.values,undefined);assert.equal(s.monsters.sr_sessyoseki.values.hp,12345);
 for(const value of [0,-1,604801,1.5,'60',NaN,{},true]){assert.throws(()=>update({type:'monsters',ids:['antaras','orc'],respawnSeconds:value}),e=>e.status===400);assert.equal(world.state().revision,1);}
 assert.throws(()=>update({type:'monsters',ids:['antaras','unknown'],respawnSeconds:10}),e=>e.status===400);
 update({type:'monsters',ids:['antaras'],reset:true});assert.deepEqual(world.state().monsters.antaras,{respawnSeconds:3600});
 update({type:'monsters',ids:['sr_kyuubi'],respawnSeconds:null});assert.equal(world.state().monsters.sr_tamamo,undefined);assert.deepEqual(world.state().monsters.sr_sessyoseki,{values:{hp:12345}});
 const row=world.monsters.list(gm,new URLSearchParams('q=antaras&all=1')).rows.find(m=>m.id==='antaras');assert.equal(row.rule.respawnSeconds,3600);assert.ok(row.respawnFamily.includes('antaras'));
});

test('fixed BOSS cooldown starts at death, survives map switching and reload, and expires at the server deadline',t=>{
 const {game,step,kill,now}=battle(t,{antaras:{respawnSeconds:10}});game.run('spawnMob(1);');assert.ok(game.snapshot().ms.mobs[1]);kill(1);
 step(9900);assert.equal(game.snapshot().ms.mobs[1],null);assert.equal(game.run("gmRespawnRemaining('antaras')"),100);
 const values=game.save(),restored=new HeadlessGame({values});t.after(()=>restored.close());restored.window.__testNow=now();restored.run('Date.now=()=>window.__testNow;');restored.setWorldSettings({revision:1,monsters:{antaras:{respawnSeconds:10}}});restored.load(1);
 restored.run("setMapSelectors('town_talking');changeMap(true);setMapSelectors('antaras_lair');changeMap(true);spawnMob(1);");assert.equal(restored.snapshot().ms.mobs[1],null);
 restored.window.__testNow+=100;restored.step(1,restored.window.__testNow);assert.equal(restored.snapshot().ms.mobs[1]._gmMonsterId,'antaras');
 step(100);assert.equal(game.snapshot().ms.mobs[1]._gmMonsterId,'antaras');
});

test('changing an active cooldown shortens, extends and restores the original wait without replacing a live boss',t=>{
 const {game,step,kill,rules}=battle(t,{antaras:{respawnSeconds:600}});game.run('spawnMob(1);');const uid=game.snapshot().ms.mobs[1].uid;
 rules({antaras:{respawnSeconds:1}});assert.equal(game.snapshot().ms.mobs[1].uid,uid);kill(1);step(900);assert.equal(game.snapshot().ms.mobs[1],null);step(100);assert.ok(game.snapshot().ms.mobs[1]);
 kill(1);rules({antaras:{respawnSeconds:10}});step(5000);assert.equal(game.snapshot().ms.mobs[1],null);rules({antaras:{respawnSeconds:2}});step(100);assert.ok(game.snapshot().ms.mobs[1]);
 kill(1);rules({antaras:{respawnSeconds:600}});step(1000);rules({});step(3900);assert.equal(game.snapshot().ms.mobs[1],null);step(100);assert.ok(game.snapshot().ms.mobs[1]);
});

test('wild and rift selection exclude cooling monsters while other monsters keep spawning',t=>{
 const {game,kill,step}=battle(t,{antaras:{respawnSeconds:60},orc:{respawnSeconds:30}},'training');
 game.run("DB.maps.training=['orc','antaras'];mapState.forceBoss=true;spawnMob(0);");assert.equal(game.snapshot().ms.mobs[0]._gmMonsterId,'antaras');kill(0);
 game.run('mapState.forceBoss=true;spawnMob(0);');assert.equal(game.snapshot().ms.mobs[0]._gmMonsterId,'orc');kill(0);
 game.run("player.tracking={mob:'orc',map:'training',until:Date.now()+600000};mapState.forceBoss=true;spawnMob(0);");assert.equal(game.snapshot().ms.mobs[0],null);
 game.run("mapState.current='rift_battle';for(let i=0;i<20;i++){const id=pickRiftMob(true,1,100,3600);if(id==='antaras')throw new Error('cooling dragon selected');}");
 step(30000);game.run("mapState.current='training';mapState.mobs=[null,null,null,null,null];mapState.forceBoss=true;spawnMob(0);");assert.equal(game.snapshot().ms.mobs[0]._gmMonsterId,'orc');
});

test('multi-stage bosses finish transforming before starting one shared cooldown',t=>{
 const {game}=battle(t,{sr_tamamo:{respawnSeconds:60},sr_kyuubi:{respawnSeconds:60},sr_sessyoseki:{respawnSeconds:60}},'training');
 game.run("mapState.mobs[0]={...DB.mobs.sr_tamamo,curHp:0,uid:'chain',st:newMobStatus()};gmApplyMonsterStats(mapState.mobs[0],'sr_tamamo');mapState.mobs[0].curHp=0;killMob(0);");
 assert.equal(game.snapshot().ms.mobs[0]._gmMonsterId,'sr_kyuubi');assert.equal(game.run("gmRespawnRemaining('sr_tamamo')"),0);
 game.run('mapState.mobs[0].curHp=0;killMob(0);');assert.equal(game.snapshot().ms.mobs[0]._gmMonsterId,'sr_sessyoseki');assert.equal(game.run("gmRespawnRemaining('sr_tamamo')"),0);
 game.run('mapState.mobs[0].curHp=0;killMob(0);settleDeadMobs();');assert.equal(game.run("gmRespawnRemaining('sr_tamamo')"),60000);assert.equal(game.run("gmRespawnRemaining('sr_sessyoseki')"),60000);
});

test('king room waits for its configured interval and consumes exactly one key on respawn',t=>{
 const {game,step,kill}=battle(t,{de_king_baranka:{respawnSeconds:12}},'king_baranka_room');game.run("player.inv.push({id:'item_king_key',uid:'key',cnt:3});spawnMob(1);spawnMob(0);");kill(1);
 const count=()=>game.run("player.inv.find(i=>i.uid==='key').cnt");step(11900);assert.equal(count(),3);assert.ok(game.snapshot().ms.mobs.every(m=>!m));step(100);
 assert.equal(count(),2);assert.equal(game.snapshot().ms.mobs[1]._gmMonsterId,'de_king_baranka');step(1000);assert.equal(count(),2);
});

test('dual BOSS room waits for both deaths and entry during cooldown never causes duplicate key charges',t=>{
 const {game,step,kill}=battle(t,{thebes_horus:{respawnSeconds:12},thebes_anubis:{respawnSeconds:20}},'thebes_temple');game.run("player.inv.push({id:'item_thebes_altar_key',uid:'key',cnt:3});spawnMob(0);spawnMob(1);");kill(0);
 step(1000);assert.ok(game.snapshot().ms.mobs[1]);kill(1);const count=()=>game.run("player.inv.find(i=>i.uid==='key').cnt");step(19900);assert.equal(count(),3);assert.ok(game.snapshot().ms.mobs.every(m=>!m));step(100);assert.equal(count(),2);assert.ok(game.snapshot().ms.mobs[0]&&game.snapshot().ms.mobs[1]);
 kill(0);kill(1);game.run("setMapSelectors('town_talking');changeMap(true);setMapSelectors('thebes_temple');changeMap(true);");assert.equal(game.snapshot().ms._gmRoomEntryPending,true);const entryCount=count();step(19900);assert.equal(count(),entryCount);assert.ok(game.snapshot().ms.mobs.every(m=>!m));step(100);assert.ok(game.snapshot().ms.mobs[0]&&game.snapshot().ms.mobs[1]);assert.equal(count(),entryCount);
});

test('sanctuary room charges its respawn item only after the configured cooldown',t=>{
 const {game,step,kill}=battle(t,{sanct_giltas:{respawnSeconds:12}},'cursed_dark_elf_sanctuary');game.run("player.inv.push({id:'item_dk_book',uid:'book',cnt:3});mapState._sanctBossSpawned=true;spawnMob(1);");kill(1);
 const count=()=>game.run("player.inv.find(i=>i.uid==='book').cnt");step(11900);assert.equal(count(),3);step(100);assert.equal(count(),2);assert.equal(game.snapshot().ms.mobs[1]._gmMonsterId,'sanct_giltas');
});

test('GM form supports time units, batch selection, explicit default reset and rejects invalid intervals',async t=>{
 const f=await admin(t),dom=new JSDOM('<section id="view-monsters"></section><section id="view-announcements"></section>',{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window;t.after(()=>w.close());
 w.HTMLElement.prototype.scrollIntoView=function(){};w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
 const commands=[],errors=[];w.eval(readFileSync(new URL('../online/monsters-admin.js',import.meta.url),'utf8'));w.initMonsterAdmin({api:async(url,body)=>{if(body){commands.push(body);return f.world.update(f.gm,body);}return f.world.monsters.list(f.gm,new URLSearchParams('all=1'));},notify:(msg,error)=>{if(error)errors.push(msg);}});
 const settle=()=>new Promise(r=>setImmediate(r)),$=id=>w.document.getElementById(id),input=(id,value)=>{$(id).value=value;$(id).dispatchEvent(new w.Event('input'));};
 w.document.dispatchEvent(new w.CustomEvent('gm:view-change',{detail:{view:'monsters'}}));await settle();
 input('monster-search','goblin');$('monster-select-filtered').click();$('monster-edit-selected').click();const count=$('monster-list').children.length;assert.ok(count>1);
 input('monster-respawn-value','2');input('monster-respawn-unit','3600');$('monster-edit-reason').value='頭目間隔調整';$('monster-edit-form').requestSubmit();assert.match($('monster-confirm-detail').textContent,/2 小時/);$('monster-confirm-save').click();await settle();
 assert.equal(commands[0].respawnSeconds,7200);assert.equal(commands[0].ids.length,count);assert.deepEqual(Object.keys(commands[0].values),[]);assert.ok(Object.values(f.world.state().monsters).every(m=>m.respawnSeconds===7200));
 input('monster-respawn-value','200');input('monster-respawn-unit','3600');$('monster-edit-form').requestSubmit();assert.equal($('monster-confirm').open,false);assert.match(errors.at(-1),/1 秒～7 天/);
 input('monster-respawn-mode','default');assert.equal($('monster-respawn-value').disabled,true);$('monster-edit-form').requestSubmit();$('monster-confirm-save').click();await settle();assert.equal(commands[1].respawnSeconds,null);assert.deepEqual(f.world.state().monsters,{});
});

test('unconfigured king rooms retain the original tick-based five-second respawn',t=>{
 const {game,kill}=battle(t,{},'king_baranka_room');game.run("player.inv.push({id:'item_king_key',uid:'key',cnt:3});spawnMob(1);");kill(1);
 game.step(49);assert.ok(game.snapshot().ms.mobs.every(m=>!m));game.step(1);assert.equal(game.snapshot().ms.mobs[1]._gmMonsterId,'de_king_baranka');assert.equal(game.run("player.inv.find(i=>i.uid==='key').cnt"),2);
});
