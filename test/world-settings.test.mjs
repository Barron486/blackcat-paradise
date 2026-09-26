import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {GameService} from '../server/service.mjs';
import {WorldSettingsService} from '../server/world-settings.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {createApp} from '../server/index.mjs';
import {HeadlessGame} from '../cli/engine.mjs';
import {GameSync} from '../cli/sync.mjs';
import {applyEffect} from '../shared/gm-effects.js';
const password='world-settings-test-2026!';
const key='lineage_idle_save_1';
const dropKey=JSON.stringify(['normal','測試怪','potion']);
const catalog={version:'test',items:{potion:{n:'藥水'}},skills:{},wrap:JSON.stringify,unwrap:JSON.parse,world:{maps:[{id:'training',name:'訓練場'},{id:'zone_04',name:'艾爾摩'},{id:'town_elf',name:'妖精森林'}],monsters:[{name:'測試怪'}],drops:[{key:dropKey,source:'normal',monster:'測試怪',itemId:'potion',itemName:'藥水',baseRate:1}]}};
const doc=()=>({p:{cls:'elf',name:'測試妖精',lv:1,exp:0,gold:1000,inv:[],_roleEpoch:randomUUID()},ms:{current:'training'},ticks:0});
async function fixture(t,filename=':memory:'){
 const service=new GameService(filename,catalog),world=new WorldSettingsService(service);t.after(()=>service.close());
 const gm=await service.register('world_gm',password,{initialGm:true}),player=await service.register('world_player',password);return {service,world,gm,player};
}
function update(world,gm,body){return world.update(gm,{revision:world.state().revision,requestId:randomUUID(),reason:'測試世界設定',...body});}
function seed(service,user,character=doc()){const lease=randomUUID();service.acquireLease(user,lease);service.sync(user,lease,0,{[key]:JSON.stringify(character)},{slot:1});return lease;}
test('world settings are GM-only, range-checked, conflict-safe and idempotent',async t=>{
 const {service,world,gm,player}=await fixture(t);const global={type:'global',goldMultiplier:2,expMultiplier:3,dropMultiplier:4,showDropRates:true};
 assert.throws(()=>update(world,player,global),e=>e.status===403);
 for(const invalid of [-1,NaN,Infinity,1001,'2'])assert.throws(()=>update(world,gm,{...global,dropMultiplier:invalid}));
 const request={...global,revision:0,requestId:randomUUID(),reason:'雙倍活動'};world.update(gm,request);assert.equal(world.update(gm,request).replayed,true);assert.equal(world.history().length,1);
 assert.throws(()=>world.update(gm,{...request,requestId:randomUUID()}),e=>e.status===409);
 assert.throws(()=>world.update(gm,{...request,goldMultiplier:9}),e=>e.status===409);
 assert.equal(service.bootstrap(player).worldSettings.expMultiplier,3);
 service.db.prepare("UPDATE accounts SET role='player' WHERE id=?").run(gm.id);assert.throws(()=>world.update(gm,request),e=>e.status===403);
});
test('map entry guards preserve towns; drops support zero, 100 and restoring the original',async t=>{
 const {world,gm}=await fixture(t);
 assert.throws(()=>update(world,gm,{type:'map',mapId:'unknown',open:false,minLevel:1}));
 assert.throws(()=>update(world,gm,{type:'map',mapId:'town_elf',open:false,minLevel:1}));
 update(world,gm,{type:'map',mapId:'training',open:false,minLevel:30});
 for(const rate of [0,100,0.000001]){update(world,gm,{type:'drop',key:dropKey,rate});assert.equal(world.listDrops(gm,new URLSearchParams('q=藥水')).rows[0].rate,rate);}
 for(const rate of [-1,101,Infinity,'100'])assert.throws(()=>update(world,gm,{type:'drop',key:dropKey,rate}));
 update(world,gm,{type:'drop',key:dropKey,rate:null});assert.equal(world.listDrops(gm,new URLSearchParams()).rows[0].rate,1);
 assert.equal(world.listDrops(gm,new URLSearchParams('modified=1')).total,0);
});
test('siege availability defaults open and only GM can atomically configure all three castles',async t=>{
 const {world,gm,player}=await fixture(t);assert.deepEqual(world.state().siege,{kent:true,windwood:true,heine:true});
 const command={type:'siege',castles:{kent:true,windwood:false,heine:true}};
 assert.throws(()=>update(world,player,command),e=>e.status===403);
 for(const castles of [null,[],{kent:true},{kent:true,windwood:false,heine:'yes'},{kent:true,windwood:false,heine:true,forged:true}])assert.throws(()=>update(world,gm,{type:'siege',castles}));
 update(world,gm,command);assert.deepEqual(world.state().siege,command.castles);assert.equal(world.history()[0].command.type,'siege');
});
test('settings and audit survive closing and reopening the database',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'world-test-')),file=path.join(dir,'game.db');
 const service=new GameService(file,catalog),world=new WorldSettingsService(service);const gm=await service.register('persist_gm',password,{initialGm:true});
 update(world,gm,{type:'drop',key:dropKey,rate:75});update(world,gm,{type:'siege',castles:{kent:false,windwood:true,heine:false}});service.close();
 const reopened=new GameService(file,catalog),restored=new WorldSettingsService(reopened);assert.equal(restored.state().drops[dropKey],75);assert.deepEqual(restored.state().siege,{kent:false,windwood:true,heine:false});assert.equal(restored.history().length,2);reopened.close();rmSync(dir,{recursive:true});
});
test('teleport uses the active GM save, previews location, includes offline roles and replays safely',async t=>{
 const {service,world,gm,player}=await fixture(t);const gmDoc=doc();gmDoc.ms.current='zone_04';const gmLease=seed(service,gm,gmDoc);const lease=seed(service,player);
 const body={action:'teleport',scope:'all',reason:'集合活動'};
 const preview=service.preview(gm,body);assert.equal(preview.characterCount,2);assert.equal(preview.command.mapId,'zone_04');
 assert.throws(()=>service.preview(gm,{...body,mapId:'town_elf'}),e=>e.status===409);
 const request={...preview.command,targetFingerprint:preview.targetFingerprint,requestId:randomUUID()};const result=service.execute(gm,request);
 assert.equal(service.execute(gm,request).replayed,true);
 const saved=JSON.parse(service.bootstrap(player).values[key]);assert.equal(saved.ms.current,'zone_04');assert.equal(saved.p._gmTeleport.seq,result.seq);assert.equal(saved.p._gmTeleportApplied,undefined);
 assert.equal(service.effects(player,1)[0].mapId,'zone_04');
 const stale={...saved,p:{...saved.p}};delete stale.p._gmTeleport;
 stale.p.lv=2;stale.p.exp=12;
 service.sync(player,lease,2,{[key]:JSON.stringify(stale)});
 const recovered=JSON.parse(service.bootstrap(player).values[key]);assert.equal(recovered.p.lv,2);assert.equal(recovered.p.exp,12);assert.deepEqual(recovered.p._gmTeleport,saved.p._gmTeleport);
 service.db.prepare('UPDATE leases SET expires_at=0 WHERE account_id=?').run(gm.id);assert.throws(()=>service.preview(gm,body),e=>e.status===409);
});

test('old tabs keep saving levels after teleport while the server owns the command destination',async t=>{
 const {service,gm,player}=await fixture(t);const gmDoc=doc();gmDoc.ms.current='zone_04';seed(service,gm,gmDoc);const lease=seed(service,player);
 const before=service.bootstrap(player),old=JSON.parse(before.values[key]);old.p.lv=35;old.p.exp=100;
 service.sync(player,lease,before.revision,{[key]:JSON.stringify(old)});
 const preview=service.preview(gm,{action:'teleport',scope:'account',accountId:player.id,reason:'舊視窗相容測試'});
 const result=service.execute(gm,{...preview.command,requestId:randomUUID(),targetFingerprint:preview.targetFingerprint});
 old.p.lv=36;old.p.exp=75;old.p.gold=2345;
 let conflict;try{service.sync(player,lease,2,{[key]:JSON.stringify(old)});}catch(e){conflict=e;}
 assert.equal(conflict.status,409);old.p._gmSeq=result.seq;
 // The old applyEffect knows the sequence but has no teleport branch.
 let revision=conflict.details.snapshot.revision;
 revision=service.sync(player,lease,revision,{[key]:JSON.stringify(old)}).revision;
 old.p.lv=37;old.p.exp=10;old.p.inv.push({id:'potion',cnt:3});
 revision=service.sync(player,lease,revision,{[key]:JSON.stringify(old)}).revision;
 let saved=JSON.parse(service.bootstrap(player).values[key]);
 assert.equal(saved.p.lv,37);assert.equal(saved.p.exp,10);assert.equal(saved.p.gold,2345);assert.equal(saved.p.inv[0].cnt,3);
 assert.equal(saved.p._gmTeleport.mapId,'zone_04');assert.equal(saved.p._gmTeleport.seq,result.seq);
 old.p._gmTeleport={seq:99999,mapId:'town_elf',mapName:'forged'};
 service.sync(player,lease,revision,{[key]:JSON.stringify(old)});
 saved=JSON.parse(service.bootstrap(player).values[key]);assert.equal(saved.p._gmTeleport.mapId,'zone_04');assert.equal(saved.p._gmTeleport.seq,result.seq);
});
test('GM movement between preview and execution cancels the whole teleport',async t=>{
 const {service,gm,player}=await fixture(t);const lease=seed(service,gm);seed(service,player);
 const preview=service.preview(gm,{action:'teleport',scope:'all',reason:'集合測試'});const saved=JSON.parse(service.bootstrap(gm).values[key]);saved.ms.current='zone_04';service.sync(gm,lease,1,{[key]:JSON.stringify(saved)},{slot:1});
 assert.throws(()=>service.execute(gm,{...preview.command,targetFingerprint:preview.targetFingerprint,requestId:randomUUID()}),e=>e.status===409);
 assert.equal(service.bootstrap(player).revision,1);
});
let realCatalog;
function real(){return realCatalog ||= loadCatalog(new URL('../',import.meta.url));}
function game(t){const g=new HeadlessGame();t.after(()=>g.close());g.create({classId:'elf',name:'世界測試妖精',allocation:{dex:8}});return g;}
test('server and game enumerate the same monster rules, cards and special materials',t=>{
 const g=game(t),a=real().world,b=JSON.parse(g.run('JSON.stringify(gmBuildWorldCatalog())'));
 assert.deepEqual(a.drops,b.drops);assert.ok(a.drops.length>8000);assert.ok(a.monsters.length>500);
 for(const source of ['normal','darkWeapon','darkCrystal','dragon','warrior','memory','trial50','mastery','panacea','card1','card2','card3','sherine','stoneSilent','stoneField','ore','holy','area','egg'])assert.ok(a.drops.some(r=>r.source===source),source);
});
test('real kill processing applies experience and gold multipliers, including zero',t=>{
 const g=game(t);
 const kill=(mult)=>g.run(`(()=>{gmSetWorld({revision:gmWorld.revision+1,expMultiplier:__args,goldMultiplier:__args,dropMultiplier:0});player.lv=20;player.exp=0;player.gold=0;Math.random=()=>0.5;mapState.current='training';const template=DB.mobs[DB.maps.training[0]];mapState.mobs[0]={...template,n:'倍率測試怪',exp:100,goldMin:100,goldMax:100,curHp:0,hp:1};killMob(0);return {exp:player.exp,gold:player.gold};})()`,mult);
 const one=kill(1),three=kill(3),zero=kill(0);assert.ok(one.exp>0&&one.gold>0);assert.equal(three.exp,one.exp*3);assert.equal(three.gold,one.gold*3);assert.equal(zero.exp,0);assert.equal(zero.gold,0);
});
test('real table rolls obey overrides at 0% and 100% without multiplying GM grants',t=>{
 const g=game(t),row=real().world.drops.find(r=>r.source==='normal'&&r.monster==='哥布林'&&!r.condition);assert.ok(row);
 const count=(rate)=>g.run(`(()=>{gmSetWorld({revision:gmWorld.revision+1,dropMultiplier:1,drops:{[__args.key]:__args.rate}});player.inv=[];Math.random=()=>0.5;mapState.current='training';mapState.mobs[0]={...Object.values(DB.mobs).find(m=>m.n===__args.name),curHp:0};killMob(0);return player.inv.filter(i=>i.id===__args.item).reduce((n,i)=>n+(i.cnt||0),0);})()`,{key:row.key,rate,name:row.monster,item:row.itemId});
 assert.equal(count(0),0);assert.ok(count(100)>=1);
 g.setWorldSettings({...realDefaults(),revision:100,dropMultiplier:0});const p=g.run('player');applyEffect({p},{seq:1,epoch:p._roleEpoch||p.enSeed,action:'grant_item',item:{id:row.itemId,cnt:5,en:0,bless:false}});assert.ok(p.inv.some(i=>i.id===row.itemId&&i.cnt>=5));
});
function realDefaults(){return {goldMultiplier:1,expMultiplier:1,dropMultiplier:1,showDropRates:false,maps:{},drops:{}};}
test('real map entry blocks direct and forced movement and charges no entry cost when closed',t=>{
 const g=game(t);g.setWorldSettings({...realDefaults(),revision:1,maps:{zone_04:{open:false,minLevel:1},oblivion_travel:{open:false,minLevel:1},dark_elf_sanctuary:{open:false,minLevel:1},training:{open:true,minLevel:30}}});
 assert.throws(()=>g.action('travel',{mapId:'zone_04'}));
 assert.equal(g.run("setMapSelectors('zone_04');changeMap(true);mapState.current==='zone_04'"),false);
 assert.equal(g.run("gmMapAllowed('training',false)"),false);
 const gold=g.status().gold;g.run('player.gold=100000;startOblivion();');assert.equal(g.status().gold,100000);
 assert.equal(g.run("sanctuaryEnter('dark_elf_sanctuary','missing');mapState.current==='dark_elf_sanctuary'"),false);
 assert.equal(g.run("gmMapAllowed('town_elf',false)"),true);
});
test('live and offline teleport apply once, bypass entry level, preserve identity and survive a later effect',t=>{
 const g=game(t),epoch=g.run('player._roleEpoch||player.enSeed');g.setWorldSettings({...realDefaults(),revision:1,maps:{zone_04:{open:false,minLevel:100}}});
 const effect={seq:10,epoch,action:'teleport',mapId:'zone_04',mapName:'艾爾摩激戰地'};g.applyEffects([effect]);assert.equal(g.status().map,'zone_04');assert.equal(g.run('player._gmTeleportApplied'),10);
 g.action('travel',{mapId:'town_elf'});g.applyEffects([effect]);assert.equal(g.status().map,'town_elf');
 const saved=g.snapshot();applyEffect(saved,{...effect,seq:11});applyEffect(saved,{seq:12,epoch,action:'revive'});const offline=new HeadlessGame({values:{[key]:g.encodeSave(saved)}});t.after(()=>offline.close());offline.load();assert.equal(offline.status().map,'zone_04');assert.equal(offline.run('player._gmTeleportApplied'),11);assert.equal(offline.status().name,'世界測試妖精');
});
test('display toggle hides probabilities and exclusive pools preserve their one-item limit',t=>{
 const g=game(t);assert.ok(!g.run("gmMonsterDropHtml('哥布林')").includes('%'));
 g.setWorldSettings({...realDefaults(),revision:1,showDropRates:true});assert.ok(g.run("gmMonsterDropHtml('哥布林')").includes('%'));
 assert.equal(g.run("Math.random=()=>0.8;gmChooseDrop('test','怪',[['a',100],['b',100]],1)"),'b');
 g.setWorldSettings({...realDefaults(),revision:2,dropMultiplier:0});assert.equal(g.run("gmChooseDrop('test','怪',[['a',100],['b',100]],1)"),null);
});
test('CLI sync receives new world settings and merges a live teleport without losing earned progress',async t=>{
 const service=new GameService(':memory:',real()),world=new WorldSettingsService(service);t.after(()=>service.close());
 const gm=await service.register('sync_gm',password,{initialGm:true}),player=await service.register('sync_player',password);
 const g=game(t),lease=randomUUID();service.acquireLease(player,lease);service.sync(player,lease,0,g.values(),{slot:1});
 const gmDoc=g.snapshot();gmDoc.p._roleEpoch=randomUUID();gmDoc.ms.current='zone_04';const gmLease=randomUUID();service.acquireLease(gm,gmLease);service.sync(gm,gmLease,0,{[key]:real().wrap(gmDoc)},{slot:1});
 const sync=new GameSync({engine:g,lease,snapshot:service.bootstrap(player),client:{sync:async b=>{try{return service.sync(player,b.lease,b.revision,b.changes,b.presence);}catch(e){e.data=e.details;throw e;}}}});
 update(world,gm,{type:'global',goldMultiplier:2,expMultiplier:3,dropMultiplier:4,showDropRates:true});await sync.flush();assert.equal(g.run('gmWorld.dropMultiplier'),4);
 const preview=service.preview(gm,{action:'teleport',scope:'account',accountId:player.id,reason:'同步集合測試'});service.execute(gm,{...preview.command,requestId:randomUUID(),targetFingerprint:preview.targetFingerprint});
 g.run('player.gold+=321;');const expected=g.status().gold;await sync.flush();
 assert.equal(g.status().map,'zone_04');assert.equal(g.status().gold,expected);const saved=real().unwrap(service.bootstrap(player).values[key]);assert.equal(saved.ms.current,'zone_04');assert.equal(saved.p._gmTeleportApplied,saved.p._gmTeleport.seq);
});
test('HTTP world settings require session, GM role and CSRF; bootstrap and sync share the settings',async t=>{
 const app=createApp({database:':memory:',catalog,publicOrigin:'',publicAliases:[]});await app.service.register('http_gm',password,{initialGm:true});await app.service.register('http_player',password);
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>app.server.close());const origin='http://127.0.0.1:'+app.server.address().port;
 const login=async username=>{const r=await fetch(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username,password})});return {cookie:r.headers.get('set-cookie').split(';')[0],...await r.json()};};
 assert.equal((await fetch(origin+'/api/world-settings')).status,401);
 const gm=await login('http_gm'),player=await login('http_player');assert.equal((await fetch(origin+'/api/gm/world-settings',{headers:{cookie:player.cookie}})).status,403);
 const body={type:'global',goldMultiplier:2,expMultiplier:2,dropMultiplier:2,showDropRates:true,revision:0,requestId:randomUUID(),reason:'HTTP 測試'};
 assert.equal((await fetch(origin+'/api/gm/world-settings',{method:'POST',headers:{cookie:gm.cookie,origin,'content-type':'application/json'},body:JSON.stringify(body)})).status,403);
 const r=await fetch(origin+'/api/gm/world-settings',{method:'POST',headers:{cookie:gm.cookie,origin,'content-type':'application/json','x-csrf-token':gm.csrf},body:JSON.stringify(body)});assert.equal(r.status,200);
 const boot=await (await fetch(origin+'/api/bootstrap',{headers:{cookie:player.cookie}})).json();assert.equal(boot.worldSettings.goldMultiplier,2);
});
