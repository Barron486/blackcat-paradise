import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {GameService} from '../server/service.mjs';
import {WorldSettingsService} from '../server/world-settings.mjs';
import {KillBroadcastService} from '../server/kill-broadcasts.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {HeadlessGame} from '../server/game-engine.mjs';
import {AuthoritativeGame} from '../server/authoritative-game.mjs';
import {createApp} from '../server/index.mjs';
import {once} from 'node:events';
import {CloudClient} from '../cli/cloud-client.mjs';
const catalog=loadCatalog(new URL('../',import.meta.url));
async function fixture(t){const service=new GameService(':memory:',catalog),world=new WorldSettingsService(service),kills=new KillBroadcastService(service);t.after(()=>service.close());const gm=await service.register('monster_gm','monster-test-2026!',{initialGm:true}),user=await service.register('monster_player','monster-test-2026!');return {service,world,kills,gm,user,update:body=>world.update(gm,{revision:world.state().revision,requestId:randomUUID(),reason:'怪物管理驗證',...body})};}
test('complete monster catalog, GM authorization, atomic batch edits, limits, revisions, replay and reset',async t=>{
 const {world,gm,user,update}=await fixture(t),before=world.monsters.list(gm,new URLSearchParams('all=1'));assert.equal(before.total,511);assert.equal(before.rows.length,511);assert.ok(before.rows.every(m=>m.data&&m.fields.length&&m.effective));
 assert.throws(()=>world.monsters.list(user,new URLSearchParams()),e=>e.status===403);
 assert.throws(()=>world.update(user,{}),e=>e.status===403);
 const request={type:'monsters',ids:['orc','goblin'],strength:2,values:{hp:222,ac:-20,exp:123,goldMin:0,goldMax:0},broadcast:true,revision:0,requestId:randomUUID(),reason:'批次測試'};
 world.update(gm,request);assert.equal(world.update(gm,request).replayed,true);assert.equal(world.history().length,1);assert.equal(world.state().monsters.orc.values.hp,222);
 assert.throws(()=>world.update(gm,{...request,requestId:randomUUID()}),e=>e.status===409);
 for(const values of [{hp:-1},{hp:'99'},{hp:1.5},{goldMin:100,goldMax:10},{'__proto__.polluted':1},{'mag.nonexistent':3}]){assert.throws(()=>update({type:'monsters',ids:['orc','goblin'],values}),e=>e.status===400);assert.equal(world.state().revision,1);}
 for(const strength of [0,21,NaN,'2'])assert.throws(()=>update({type:'monster-strength',strength}));
 update({type:'monster-strength',strength:3});const row=world.monsters.list(gm,new URLSearchParams('q=orc&all=1')).rows.find(m=>m.id==='orc');assert.equal(row.effective.hp,1332);assert.equal(row.effective.exp,123);assert.equal(row.effective.ac,-20);
 update({type:'monsters',ids:['orc','goblin'],reset:true});assert.deepEqual(world.state().monsters,{});assert.deepEqual(world.state().killBroadcast.monsters,['goblin','orc']);
});
test('actual spawn paths apply HP and damage once without altering base data or reward values',t=>{
 const game=new HeadlessGame();t.after(()=>game.close());game.create({classId:'knight',name:'怪物測試',allocation:{str:2,con:6}});
 game.setWorldSettings({revision:1,monsterStrength:2,monsters:{orc:{values:{goldMin:0,goldMax:0}}}});
 game.run("applySherineBuff=function(){};applySherineGrace=function(){};Math.random=()=>0.5;mapState.current='training';mapState.mobs=[];spawnMob(0);");
 const check=()=>{const pair=JSON.parse(game.run('JSON.stringify({mob:mapState.mobs[0],base:DB.mobs[mapState.mobs[0]._gmMonsterId]})'));assert.equal(pair.mob.hp,pair.base.hp*2);assert.equal(pair.mob.curHp,pair.mob.hp);assert.equal(pair.mob.dmg[1],pair.base.dmg[1]*2);assert.equal(pair.mob.exp,pair.base.exp);return pair;};
 check();const saved=game.snapshot(),hp=saved.ms.mobs[0].hp;game.setWorldSettings({revision:2,monsterStrength:3});assert.equal(game.snapshot().ms.mobs[0].hp,hp);game.adopt(saved);assert.equal(game.snapshot().ms.mobs[0].hp,hp);
 game.setWorldSettings({revision:3,monsterStrength:2});
 game.run("mapState.current='king_baranka_room';mapState.mobs=[];spawnMob(1);mapState.mobs[0]=mapState.mobs[1];");check();
 game.run("mapState.current='antharas_lair';mapState.mobs=[];spawnMob(1);mapState.mobs[0]=mapState.mobs[1];");check();game.run('doMobTransform(0);');check();
 game.run("mapState.current='rift_battle';mapState.mobs=[];state.riftStartMs=Date.now();spawnMob(0);");check();
 game.run("mapState.current='training';mapState.mobs[0]={...DB.mobs.orc};gmApplyMonsterStats(mapState.mobs[0],'orc');");assert.deepEqual(JSON.parse(game.run('JSON.stringify(monsterGoldRange(mapState.mobs[0]))')),{min:0,max:0});
});
test('kill notifications originate from authoritative kills, include character identity and time, and do not replay',async t=>{
 const {service,world,kills,gm,user,update}=await fixture(t),authority=new AuthoritativeGame(service,{clock:()=>0,autoTick:false});t.after(()=>authority.close());
 update({type:'kill-broadcast',enabled:true,monsters:['orc','sr_tamamo','sr_kyuubi','sr_sessyoseki']});
 const lease=randomUUID();service.acquireLease(user,lease);authority.handle(user,{op:'create',slot:1,lease,revision:0,requestId:randomUUID(),args:{classId:'knight',name:'角色而非帳號',allocation:{str:2,con:6}}});
 const r=authority.runtimes.get(user.id),commit=()=>service.transaction(()=>authority.commit(user,r));
 r.engine.run("mapState.current='training';mapState.mobs[0]={...DB.mobs.orc,curHp:0,uid:'kill-fixture',st:newMobStatus()};gmApplyMonsterStats(mapState.mobs[0],'orc');killMob(0);");commit();assert.equal(kills.history().length,1);const event=kills.history()[0];assert.equal(event.name,'角色而非帳號');assert.equal(event.monsterId,'orc');assert.ok(event.killedAt>0);assert.match(GameLootRarity.message(event),/角色而非帳號.*擊敗了/);
 commit();assert.equal(kills.history().length,1);
 r.engine.run("mapState.mobs[0]={...DB.mobs.sr_tamamo,curHp:0,uid:'transform-fixture',st:newMobStatus()};gmApplyMonsterStats(mapState.mobs[0],'sr_tamamo');killMob(0);");commit();assert.equal(kills.history().length,1);
 r.engine.run('mapState.mobs[0].curHp=0;killMob(0);');commit();assert.equal(kills.history().length,1);r.engine.run('mapState.mobs[0].curHp=0;killMob(0);');commit();assert.equal(kills.history().length,2);assert.equal(kills.history()[1].monsterId,'sr_sessyoseki');
 update({type:'kill-broadcast',enabled:false,monsters:['orc']});assert.deepEqual(kills.list(0).events,[]);update({type:'kill-broadcast',enabled:true,monsters:['orc']});assert.deepEqual(kills.list(0).events,[]);assert.equal(kills.history().length,2);
});
test('announcements validate duration and text, preserve expiration on retry, replace and clear with audit',async t=>{
 const {world,update}=await fixture(t);
 for(const values of [{text:''},{text:'a'.repeat(301)},{seconds:9},{seconds:604801},{seconds:20.5},{pinned:'yes'}])assert.throws(()=>update({type:'announcement',text:'活動開始',seconds:30,pinned:true,...values}),e=>e.status===400);
 const request={type:'announcement',text:'活動開始 <img src=x>',seconds:60,pinned:true,requestId:randomUUID(),revision:0};const a=update(request).settings.announcement;assert.equal(a.expiresAt-a.startedAt,60000);assert.equal(update(request).replayed,true);assert.deepEqual(world.state().announcement,a);
 update({type:'announcement',text:'第二則',seconds:10,pinned:false});assert.equal(world.state().announcement.text,'第二則');update({type:'announcement-clear'});assert.equal(world.state().announcement,null);assert.equal(world.history().length,3);
});
test('GM UI searches, selects multiple monsters, submits only checked fields and publishes literal text safely',async t=>{
 const f=await fixture(t),dom=new JSDOM('<section id="view-monsters"></section><section id="view-announcements"></section>',{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window;t.after(()=>w.close());
 w.HTMLElement.prototype.scrollIntoView=function(){};w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
 const errors=[];w.eval(readFileSync(new URL('../online/monsters-admin.js',import.meta.url),'utf8'));w.initMonsterAdmin({api:async(url,body)=>body?f.world.update(f.gm,body):f.world.monsters.list(f.gm,new URLSearchParams('all=1')),notify:(msg,error)=>{if(error)errors.push(msg);}});
 const settle=()=>new Promise(resolve=>setImmediate(resolve)),$=id=>w.document.getElementById(id);
 w.document.dispatchEvent(new w.CustomEvent('gm:view-change',{detail:{view:'monsters'}}));await settle();assert.match($('monster-summary').textContent,/511/);
 $('monster-search').value='goblin';$('monster-search').dispatchEvent(new w.Event('input'));$('monster-select-filtered').click();$('monster-edit-selected').click();
 const count=$('monster-list').children.length;assert.ok(count>1);const hp=w.document.querySelector('[data-value="hp"]');hp.value='345';hp.dispatchEvent(new w.Event('input'));$('monster-edit-reason').value='批次驗證';$('monster-edit-form').requestSubmit();assert.equal($('monster-confirm').open,true);$('monster-confirm-save').click();await settle();assert.equal(Object.keys(f.world.state().monsters).length,count);assert.ok(Object.values(f.world.state().monsters).every(m=>m.values.hp===345&&Object.keys(m.values).length===1));
 $('announcement-text').value='<img src=x onerror=alert(1)> 開始';$('announcement-text').dispatchEvent(new w.Event('input'));assert.equal($('announcement-preview').children.length,0);$('announcement-reason').value='活動通知';$('announcement-form').requestSubmit();$('monster-confirm-save').click();await settle();assert.equal(f.world.state().announcement.pinned,true);assert.equal(f.world.state().announcement.text,$('announcement-text').value);assert.deepEqual(errors,[]);
});
test('HTTP endpoints protect monster editing and only deliver announcements while active',async t=>{
 const app=createApp({database:':memory:',publicOrigin:'',aiOptions:{apiKey:''}});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>{app.server.closeAllConnections();app.server.close();});
 const gm=await app.service.register('http_gm','monster-http-test!',{initialGm:true});await app.service.register('http_player','monster-http-test!');
 const baseUrl='http://127.0.0.1:'+app.server.address().port,admin=new CloudClient({baseUrl}),player=new CloudClient({baseUrl});await admin.login('http_gm','monster-http-test!');await player.login('http_player','monster-http-test!');
 const get=async(client,path)=>fetch(baseUrl+path,{headers:{cookie:client.exportSession().cookie}});
 assert.equal((await get(player,'/api/gm/monsters')).status,403);assert.equal((await (await get(admin,'/api/gm/monsters?all=1')).json()).total,511);
 app.service.world.update(gm,{type:'announcement',text:'正在測試',seconds:10,pinned:true,revision:0,requestId:randomUUID(),reason:'端點測試'});
 assert.equal((await (await get(player,'/api/loot-broadcasts')).json()).announcement.text,'正在測試');
 const state=app.service.world.state();state.announcement.expiresAt=Date.now()-1;app.service.db.prepare('UPDATE world_settings SET data=? WHERE id=1').run(JSON.stringify(state));assert.equal((await (await get(player,'/api/loot-broadcasts')).json()).announcement,null);
 const html=await (await get(admin,'/gm')).text();assert.match(html,/monsters-admin.js\?v=/);assert.match(html,/view-announcements/);
});
test('pinned notices and kill ticker coexist, render text safely, expire, and clear independently of loot',async t=>{
 const dom=new JSDOM('<div id="game-screen"><div id="col-center"></div></div>',{url:'http://localhost/',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;t.after(()=>w.close());
 const intervals=new Map();w.setInterval=(fn,ms)=>{intervals.set(ms,fn);return ms;};w.requestAnimationFrame=fn=>{fn();return 1;};w.matchMedia=()=>({matches:false,addEventListener(){}});
 for(const file of ['js/loot-rarity.js','online/loot-ticker.js'])w.eval(readFileSync(new URL('../'+file,import.meta.url),'utf8').replace(/^export /gm,''));
 let now=1000,response={enabled:false,generation:1,events:[],cursor:0,kills:{enabled:true,generation:1,events:[{kind:'kill',id:1,name:'角色',monster:'頭目',mapName:'戰場',at:1000,killedAt:1000}],cursor:1},announcement:{id:'pinned',text:'<img src=x> 公告',pinned:true,expiresAt:11000}};
 w.startLootTicker({boot:{worldSettings:{}},serverNow:()=>now,request:async()=>response},()=>true);await intervals.get(4000)();
 const notice=w.document.getElementById('gm-announcement'),ticker=w.document.getElementById('loot-ticker');assert.equal(notice.hidden,false);assert.equal(notice.querySelector('img'),null);assert.equal(notice.dataset.pinned,'true');assert.equal(ticker.hidden,false);assert.match(ticker.textContent,/討伐捷報.*角色.*頭目/);
 response={...response,generation:2,kills:{...response.kills,events:[]}};await intervals.get(4000)();assert.equal(ticker.hidden,false,'disabling loot cannot suppress kill broadcast');
 now=11001;intervals.get(1000)();assert.equal(notice.hidden,true);assert.equal(ticker.hidden,false);
 response={...response,announcement:{id:'scroll',text:'跑馬燈',pinned:false,expiresAt:20000},kills:{enabled:false,generation:2,events:[],cursor:1}};await intervals.get(4000)();assert.equal(ticker.hidden,true);assert.equal(notice.hidden,false);assert.match(notice.querySelector('span').style.animation,/infinite/);
});
