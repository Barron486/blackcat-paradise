import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { GameService } from '../server/service.mjs';
import { loadCatalog } from '../server/catalog.mjs';
import { createApp } from '../server/index.mjs';
import { applyEffect, refreshGmBuffs } from '../shared/gm-effects.js';
import { databasePath, publicOriginFromEnv } from '../server/config.mjs';

const catalog=loadCatalog(new URL('../',import.meta.url));
const password='test-only-password-2026!';
const key='lineage_idle_save_1';
function character(name='冒險者',epoch=randomUUID()) {
  return {v:1,p:{cls:'knight',name,lv:1,inv:[],eq:{},skills:[],buffs:{},statuses:{poison:10},hp:50,mhp:100,mp:20,mmp:60,dead:false,_roleEpoch:epoch},ms:{current:'town_silver_knight',mobs:[]},ticks:0};
}
async function fixture(t){
  const service=new GameService(':memory:',catalog);t.after(()=>service.close());
  const gm=await service.register('gamemaster',password,{initialGm:true});
  const a=await service.register('playerone',password),b=await service.register('playertwo',password);
  const leaseA=randomUUID(),leaseB=randomUUID();service.acquireLease(a,leaseA);service.acquireLease(b,leaseB);
  service.sync(a,leaseA,0,{[key]:catalog.wrap(character('第一勇者'))},{slot:1,name:'第一勇者'});
  service.sync(b,leaseB,0,{[key]:catalog.wrap(character('第二勇者'))},{slot:1,name:'第二勇者'});
  return {service,gm,a,b,leaseA,leaseB};
}
function run(s,gm,body){const command={scope:'all',reason:'自動測試指令',...body};const p=s.preview(gm,command);return s.execute(gm,{...command,requestId:randomUUID(),targetFingerprint:p.targetFingerprint});}
const saved=(s,user)=>catalog.unwrap(s.bootstrap(user).values[key]);

test('upstream catalog and signed save round-trip',()=>{
  assert.equal(catalog.version,'v3.8.34');assert.ok(Object.keys(catalog.items).length>1500);
  const doc=character('中文角色');assert.deepEqual(catalog.unwrap(catalog.wrap(doc)),doc);
  assert.throws(()=>catalog.unwrap(catalog.wrap(doc).replace('中文角色','竄改角色')));
});
test('account hashes, case-insensitive login and one-time GM bootstrap',async t=>{
  const {service,a}=await fixture(t);
  const row=service.db.prepare('SELECT * FROM accounts WHERE id=?').get(a.id);assert.notEqual(row.password_hash,password);
  const session=await service.login('PLAYERONE',password);assert.equal(service.authenticate(session.session).id,a.id);
  await assert.rejects(service.login('playerone','wrong-password-value'),e=>e.status===401);
  await assert.rejects(service.register('anothergm',password,{initialGm:true}),e=>e.status===409);
  service.logout(session.session);assert.throws(()=>service.authenticate(session.session),e=>e.status===401);
});

test('open game tabs may sync with another valid same-account session CSRF, never other or revoked sessions',async t=>{
 const app=createApp({database:':memory:',catalog,publicOrigin:'',publicAliases:[]});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));});
 const account=await app.service.register('tab_sync',password,{initialGm:true});await app.service.register('other_tab',password);
 const older=await app.service.login('tab_sync',password),newer=await app.service.login('tab_sync',password),other=await app.service.login('other_tab',password);
 const base=`http://127.0.0.1:${app.server.address().port}`,lease=randomUUID();
 const post=(route,csrf,body)=>fetch(base+route,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:'idle_session='+newer.session,'X-CSRF-Token':csrf},body:JSON.stringify(body)});
 assert.equal((await post('/api/lease',older.csrf,{lease})).status,200);
 assert.equal((await post('/api/sync',older.csrf,{lease,revision:0,changes:{}})).status,200);
 assert.equal((await post('/api/sync',other.csrf,{lease,revision:0,changes:{}})).status,403);
 assert.equal((await post('/api/gm/role',older.csrf,{accountId:account.id,role:'player'})).status,403);
 app.service.logout(older.session);
 assert.equal((await post('/api/sync',older.csrf,{lease,revision:0,changes:{}})).status,403);
 assert.equal((await post('/api/sync',newer.csrf,{lease,revision:0,changes:{}})).status,200);
});
test('ordinary players cannot use any GM method',async t=>{
  const {service,a}=await fixture(t);
  for(const op of [()=>service.players(a),()=>service.preview(a,{action:'kill'}),()=>service.execute(a,{}),()=>service.audit(a),()=>service.setRole(a,a.id,'gm')])assert.throws(op,e=>e.status===403);
});

test('public presence and chat conceal GM roles while self and admin permissions remain available',async t=>{
  const app=createApp({database:':memory:',catalog,publicOrigin:'',publicAliases:[]});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));});
  const gm=await app.service.register('keeper',password,{initialGm:true}),player=await app.service.register('visitor',password);
  for(const user of [gm,player])app.service.acquireLease(user,randomUUID());
  app.service.chat(gm,'早安，一起冒險');
  const gmSession=await app.service.login(gm.username,password),playerSession=await app.service.login(player.username,password);
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const get=(route,session=playerSession)=>fetch(base+route,{headers:{Cookie:'idle_session='+session.session}});
  const presenceResponse=await get('/api/online');assert.equal(presenceResponse.status,200);
  const presence=await presenceResponse.json();assert.equal(presence.total,2);assert.equal(presence.players,2);assert.ok(presence.list.every(p=>p.name==='角色選擇中'),'unselected accounts do not expose login names');
  const worldResponse=await get('/api/world');assert.equal(worldResponse.status,200);
  const world=await worldResponse.json();assert.ok(world.online.every(p=>!Object.hasOwn(p,'username')));assert.equal(world.messages[0].displayName,'冒險者');assert.equal(Object.hasOwn(world.messages[0],'username'),false);assert.equal(world.messages[0].text,'早安，一起冒險');
  for(const row of [...presence.list,...world.online,...world.messages])for(const key of ['gm','role','isGm','isGM'])assert.equal(Object.hasOwn(row,key),false,`public ${key} must be absent`);
  const self=await(await get('/api/me',gmSession)).json();assert.equal(self.user.role,'gm');
  const boot=await(await get('/api/bootstrap',gmSession)).json();assert.equal(boot.user.role,'gm');
  assert.equal((await get('/api/gm/players')).status,403);
  const admin=await get('/api/gm/players',gmSession);assert.equal(admin.status,200);assert.equal((await admin.json()).players.find(p=>p.id===gm.id).role,'gm');
});
test('grant reaches every existing character, including offline accounts, once',async t=>{
  const {service,gm,a,b}=await fixture(t);
  service.db.prepare('UPDATE leases SET expires_at=0 WHERE account_id=?').run(b.id);
  const body={scope:'all',action:'grant_item',itemId:'wpn_dragonslayer',quantity:2,enchant:7,blessed:true,reason:'全服獎勵'};
  const preview=service.preview(gm,body);assert.equal(preview.characterCount,2);
  const request={...body,requestId:randomUUID(),targetFingerprint:preview.targetFingerprint};
  const result=service.execute(gm,request);assert.equal(result.accountCount,2);
  assert.equal(service.execute(gm,request).replayed,true);
  for(const user of [a,b]){const item=saved(service,user).p.inv[0];assert.equal(item.id,'wpn_dragonslayer');assert.equal(item.cnt,2);assert.equal(item.en,7);assert.equal(item.bless,true);assert.equal(item.lock,true);}
  assert.equal(service.audit(gm).length,1);
  assert.throws(()=>service.execute(gm,{...request,quantity:3}),e=>e.status===409);
});

test('progress recovery adds missing XP once to the latest save, isolates the slot and stops stale writers',async t=>{
  const {service,gm,a,b,leaseA}=await fixture(t),slot2='lineage_idle_save_2';
  const original=saved(service,a);original.p.lv=35;original.p.exp=10023661;original.p.gold=1234;original.p.bonus=0;
  const otherRole=character('保留角色');
  service.sync(a,leaseA,1,{[key]:catalog.wrap(original),[slot2]:catalog.wrap(otherRole)});
  const otherAccount=service.bootstrap(b);
  const delta=catalog.experience[35]-original.p.exp+Math.floor(catalog.experience[36]*0.16465);
  const body={action:'restore_progress',scope:'account',accountId:a.id,slot:1,experienceDelta:delta,reason:'修復已確認的升級進度'};
  const preview=service.preview(gm,body);assert.equal(preview.characterCount,1);
  // Progress earned after preview must also survive the atomic recovery.
  original.p.exp+=777;original.p.inv.push({id:'potion_heal',cnt:3});
  service.sync(a,leaseA,2,{[key]:catalog.wrap(original)});
  const before=service.bootstrap(a),request={...preview.command,targetFingerprint:preview.targetFingerprint,requestId:randomUUID()};
  const result=service.execute(gm,request),after=service.bootstrap(a),repaired=saved(service,a);
  assert.equal(repaired.p.lv,36);assert.equal(repaired.p.exp,Math.floor(catalog.experience[36]*0.16465)+777);
  assert.deepEqual(repaired,{...original,p:{...original.p,lv:36,exp:repaired.p.exp,_gmSeq:result.seq}});
  assert.equal(after.values[slot2],before.values[slot2]);assert.deepEqual(service.bootstrap(b).values,otherAccount.values);
  assert.throws(()=>service.sync(a,leaseA,before.revision,{[key]:catalog.wrap(original)}),e=>e.status===423);
  assert.equal(service.execute(gm,request).replayed,true);assert.equal(service.bootstrap(a).revision,after.revision);
  const nextLease=randomUUID();service.acquireLease(a,nextLease);const loaded=service.bootstrap(a);
  repaired.p.exp+=9;service.sync(a,nextLease,loaded.revision,{[key]:catalog.wrap(repaired)});
  assert.equal(saved(service,a).p.lv,36);assert.equal(saved(service,a).p.exp,repaired.p.exp);
});

test('progress recovery requires GM, one account and slot, positive safe XP, and the same character identity',async t=>{
  const {service,gm,a,leaseA}=await fixture(t);
  const body={action:'restore_progress',scope:'account',accountId:a.id,slot:1,experienceDelta:10,reason:'進度修復'};
  assert.throws(()=>service.preview(a,body),e=>e.status===403);
  for(const change of [{scope:'all'},{scope:'online'},{slot:0},{slot:9},{slot:1.5},{experienceDelta:-1},{experienceDelta:0},{experienceDelta:Infinity},{experienceDelta:Number.MAX_SAFE_INTEGER+1}]){
    assert.throws(()=>service.preview(gm,{...body,...change}),e=>e.status===400);
  }
  const preview=service.preview(gm,body);
  service.sync(a,leaseA,1,{[key]:null});
  service.sync(a,leaseA,2,{[key]:catalog.wrap(character('新角色'))});
  assert.throws(()=>service.execute(gm,{...body,targetFingerprint:preview.targetFingerprint,requestId:randomUUID()}),e=>e.status===409);
  assert.equal(saved(service,a).p.lv,1);assert.equal(service.audit(gm).length,0);
});

test('progress recovery uses the game XP curve and restores earned level 50 attribute points',async t=>{
  const {service,gm,a,leaseA}=await fixture(t),doc=saved(service,a);
  doc.p.lv=49;doc.p.exp=catalog.experience[49]-1;doc.p.bonus=0;
  service.sync(a,leaseA,1,{[key]:catalog.wrap(doc)});
  run(service,gm,{action:'restore_progress',scope:'account',accountId:a.id,slot:1,experienceDelta:catalog.experience[50]+5});
  const p=saved(service,a).p;assert.equal(p.lv,51);assert.equal(p.exp,4);assert.equal(p.bonus,2);
});
test('all positive buffs have a server wall-clock expiry and clear correctly',async t=>{
  const {service,gm,a}=await fixture(t);run(service,gm,{action:'buff_all',duration:3600});
  const p=saved(service,a).p;assert.ok(Object.keys(p.buffs).length>30);assert.equal(p.buffs.haste,3600);
  refreshGmBuffs(p,p._gmBuffs.expiresAt+1);assert.equal(p.buffs.haste,0);assert.equal(p._gmBuffs,undefined);
  run(service,gm,{action:'clear_buffs'});assert.equal(saved(service,a).p.buffs.haste,0);
});
test('kill, offline persistence and revive keep game state coherent',async t=>{
  const {service,gm,a,b}=await fixture(t);run(service,gm,{action:'kill'});
  for(const user of [a,b]){assert.equal(saved(service,user).p.hp,0);assert.equal(saved(service,user).p._gmDead,true);}
  run(service,gm,{action:'revive',scope:'account',accountId:a.id});
  const p=saved(service,a).p;assert.equal(p.hp,100);assert.equal(p.mp,60);assert.equal(p.dead,false);assert.equal(p.statuses.poison,0);
  assert.equal(saved(service,b).p.dead,true);
});
test('stale client cannot overwrite a GM update; reconciliation preserves unsaved progress',async t=>{
  const {service,gm,a,leaseA}=await fixture(t);
  const before=service.bootstrap(a),live=catalog.unwrap(before.values[key]);live.p.exp=77;
  run(service,gm,{action:'grant_item',itemId:'potion_heal',quantity:5,enchant:0});
  let conflict;try{service.sync(a,leaseA,before.revision,{[key]:catalog.wrap(live)});}catch(e){conflict=e;}
  assert.equal(conflict.status,409);assert.equal(conflict.details.effects.length,1);
  const effect=conflict.details.effects[0];assert.equal(applyEffect(live,effect),true);assert.equal(applyEffect(live,effect),false);
  service.sync(a,leaseA,conflict.details.snapshot.revision,{[key]:catalog.wrap(live)});
  assert.equal(saved(service,a).p.exp,77);assert.equal(saved(service,a).p.inv[0].cnt,5);
  const removed=structuredClone(live);removed.p._gmSeq=0;
  assert.throws(()=>service.sync(a,leaseA,service.bootstrap(a).revision,{[key]:catalog.wrap(removed)}),e=>e.status===409);
});
test('online scope affects only the selected live slot, all scope includes all slots',async t=>{
  const {service,gm,a,b,leaseA}=await fixture(t);
  const slot2='lineage_idle_save_2';service.sync(a,leaseA,1,{[slot2]:catalog.wrap(character('替代角色'))},{slot:1});
  service.db.prepare('UPDATE leases SET expires_at=0 WHERE account_id=?').run(b.id);
  const result=run(service,gm,{action:'kill',scope:'online'});assert.equal(result.characterCount,1);
  assert.equal(saved(service,a).p.dead,true);assert.equal(saved(service,b).p.dead,false);
  assert.equal(catalog.unwrap(service.bootstrap(a).values[slot2]).p.dead,false);
});
test('batch failures roll back all players and the audit record',async t=>{
  const {service,gm,a,b,leaseB}=await fixture(t);
  const limited=Object.entries(catalog.items).find(([,i])=>i.maxHold);
  assert.ok(limited);const [id,definition]=limited;
  const doc=saved(service,b);doc.p.inv=[{id,cnt:definition.maxHold,en:0}];service.sync(b,leaseB,1,{[key]:catalog.wrap(doc)});
  const before=service.bootstrap(a);assert.throws(()=>run(service,gm,{action:'grant_item',itemId:id,quantity:1,enchant:0}),e=>e.status===409);
  assert.equal(service.bootstrap(a).revision,before.revision);assert.equal(saved(service,a).p.inv.length,0);assert.equal(service.audit(gm).length,0);
});
test('invalid quantities, items and durations are rejected without changes',async t=>{
  const {service,gm,a}=await fixture(t);const before=service.bootstrap(a).revision;
  for(const body of [{action:'grant_item',itemId:'fake',quantity:1,enchant:0},{action:'grant_item',itemId:'potion_heal',quantity:-5,enchant:0},{action:'grant_item',itemId:'potion_heal',quantity:1,enchant:5},{action:'buff_all',duration:Infinity}])assert.throws(()=>run(service,gm,body));
  assert.equal(service.bootstrap(a).revision,before);
});
test('item grants follow upstream enchant, relic and independent wish-ring rules',async t=>{
  const {service,gm,a}=await fixture(t);
  run(service,gm,{action:'grant_item',itemId:'wpn_dragonslayer',quantity:1,enchant:15});
  assert.equal(saved(service,a).p.inv[0].en,15);
  for(const body of [
    {itemId:'wpn_dragonslayer',quantity:1,enchant:16},
    {itemId:'pet_arm_leather',quantity:1,enchant:6},
    {itemId:'relic_genie_wishes',quantity:1,enchant:0,blessed:true},
    {itemId:'potion_heal',quantity:1,enchant:0,blessed:true},
  ]) assert.throws(()=>run(service,gm,{action:'grant_item',...body}),e=>e.status===400);
  run(service,gm,{action:'grant_item',itemId:'relic_genie_wishes',quantity:3,enchant:0});
  const rings=saved(service,a).p.inv.filter(i=>i.id==='relic_genie_wishes');
  assert.equal(rings.length,3);assert.equal(new Set(rings.map(i=>i.uid)).size,3);
  for(const ring of rings){assert.equal(ring.cnt,1);assert.equal(new Set(ring.gw).size,3);}
});
test('Railway configuration requires persistent storage and validates public origins',()=>{
  assert.equal(publicOriginFromEnv({RAILWAY_PUBLIC_DOMAIN:'idle-test.up.railway.app'}),'https://idle-test.up.railway.app');
  assert.equal(publicOriginFromEnv({PUBLIC_ORIGIN:'https://game.example.com/'}),'https://game.example.com');
  assert.throws(()=>publicOriginFromEnv({PUBLIC_ORIGIN:'https://game.example.com/path'}));
  assert.throws(()=>databasePath({RAILWAY_ENVIRONMENT_ID:'test'}));
  const mount=path.resolve('test-volume');
  assert.equal(databasePath({RAILWAY_ENVIRONMENT_ID:'test',RAILWAY_VOLUME_MOUNT_PATH:mount}),path.join(mount,'game.sqlite'));
  assert.throws(()=>databasePath({RAILWAY_ENVIRONMENT_ID:'test',RAILWAY_VOLUME_MOUNT_PATH:mount,DATA_DIR:path.resolve('other-volume')}));
});
test('Railway HTTPS proxy: verified aliases, same-origin requests, secure cookies and closed remote setup',async t=>{
  const {server,service}=createApp({database:':memory:',catalog,publicOrigin:'https://game.example.com',publicAliases:['https://game.up.railway.app']});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin=`http://127.0.0.1:${server.address().port}`;
  // Use raw HTTP so tests control Host; fetch normalizes forbidden headers.
  const request=(route,headers,body)=>new Promise((resolve,reject)=>{
    const req=http.request(origin+route,{method:body?'POST':'GET',headers},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(Buffer.concat(chunks))}));
    });req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
  assert.equal((await request('/healthz',{Host:'healthcheck.railway.app'})).status,200);
  assert.equal((await request('/api/auth/config',{Host:'healthcheck.railway.app'})).status,403);
  const headers={Host:'game.example.com','X-Forwarded-For':'203.0.113.5',Origin:'https://game.example.com','Content-Type':'application/json'};
  assert.equal((await request('/api/auth/config',headers)).data.setupAvailable,false);
  assert.equal((await request('/api/auth/setup',headers,{username:'evilgm',password})).status,403);
  await service.register('proxyuser',password);
  const login=await request('/api/auth/login',headers,{username:'proxyuser',password});
  assert.equal(login.status,200);assert.match(login.headers['set-cookie'][0],/; Secure/);
  const aliasHeaders={...headers,Host:'game.up.railway.app',Origin:'https://game.up.railway.app'};
  assert.equal((await request('/api/auth/login',aliasHeaders,{username:'proxyuser',password})).status,200);
  assert.equal((await request('/api/auth/login',{...aliasHeaders,Origin:'https://game.example.com'},{username:'proxyuser',password})).status,403);
  assert.equal((await request('/api/auth/config',{Host:'attacker.example'})).status,403);
});
test('role changes take effect on existing sessions, last GM is protected',async t=>{
  const {service,gm,a}=await fixture(t);const session=await service.login(a.username,password);
  assert.throws(()=>service.setRole(gm,gm.id,'player'),e=>e.status===409);
  service.setRole(gm,a.id,'gm');const promoted=service.authenticate(session.session);assert.equal(promoted.role,'gm');
  service.setRole(gm,a.id,'player');assert.throws(()=>service.gm(promoted),e=>e.status===403);
});
test('leases prevent second-window writes and account data is isolated',async t=>{
  const {service,a,b,leaseA}=await fixture(t);const newLease=randomUUID();
  assert.throws(()=>service.acquireLease(a,newLease),e=>e.status===423);
  service.acquireLease(a,newLease,true);
  assert.throws(()=>service.sync(a,leaseA,1,{}),e=>e.status===423);
  service.sync(a,newLease,1,{fb5_test:'first-player-only'});
  assert.equal(service.bootstrap(b).values.fb5_test,undefined);
});
test('target changes after preview require another review',async t=>{
  const {service,gm,a,leaseA}=await fixture(t);const body={scope:'all',action:'kill',reason:'測試預覽'};
  const preview=service.preview(gm,body);service.sync(a,leaseA,1,{lineage_idle_save_2:catalog.wrap(character())});
  assert.throws(()=>service.execute(gm,{...body,requestId:randomUUID(),targetFingerprint:preview.targetFingerprint}),e=>e.status===409);
});
test('cloud state and offline GM changes survive server restart',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'idle-gm-test-')),file=path.join(dir,'game.sqlite');
  let service=new GameService(file,catalog);
  try{
    const gm=await service.register('gmadmin',password,{initialGm:true}),a=await service.register('player',password);const lease=randomUUID();
    service.acquireLease(a,lease);service.sync(a,lease,0,{[key]:catalog.wrap(character())});run(service,gm,{action:'kill'});
    service.close();service=new GameService(file,catalog);assert.equal(saved(service,a).p.dead,true);assert.equal(service.audit(gm).length,1);
  }finally{service.close();rmSync(dir,{recursive:true,force:true});}
});
test('console GM promotion and backup use the configured persistent database',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'idle-console-test-')),file=path.join(dir,'game.sqlite'),copy=path.join(dir,'backup.sqlite');
  const service=new GameService(file,catalog);let restored;
  try {
    const account=await service.register('owneraccount',password);
    const env={...process.env,DATA_DIR:dir,RAILWAY_ENVIRONMENT_ID:''};
    const promote=spawnSync(process.execPath,[fileURLToPath(new URL('../server/promote-gm.mjs',import.meta.url)),account.username],{env,encoding:'utf8'});
    assert.equal(promote.status,0,promote.stderr);assert.equal(service.db.prepare('SELECT role FROM accounts WHERE id=?').get(account.id).role,'gm');
    const backup=spawnSync(process.execPath,[fileURLToPath(new URL('../server/backup.mjs',import.meta.url)),copy],{env,encoding:'utf8'});
    assert.equal(backup.status,0,backup.stderr);restored=new GameService(copy,catalog);assert.equal(restored.hasGm(),true);
    const login=await restored.login(account.username,password);assert.equal(login.user.role,'gm');
  } finally { restored?.close();service.close();rmSync(dir,{recursive:true,force:true}); }
});
test('HTTP integration: login, static assets, CSRF, GM API and real multiplayer chat',async t=>{
  const {server}=createApp({database:':memory:',catalog});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin=`http://127.0.0.1:${server.address().port}`;
  async function request(route,body,identity={},extra={}){
    const response=await fetch(origin+route,{method:body===undefined?'GET':'POST',redirect:'manual',headers:{...(body!==undefined?{'Content-Type':'application/json',Origin:origin}:{}),...(identity.cookie?{Cookie:identity.cookie}:{}),...(identity.csrf?{'X-CSRF-Token':identity.csrf}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
    return response;
  }
  const loginPage=await request('/login');assert.equal(loginPage.status,200);assert.match(await loginPage.text(),/登入遊戲/);
  assert.equal((await request('/online/admin.css')).status,200);assert.equal((await request('/server/index.mjs')).status,404);assert.equal((await request('/data/game.sqlite')).status,404);
  assert.equal((await request('/')).status,302);assert.equal((await request('/api/gm/players')).status,401);
  const setup=await request('/api/auth/setup',{username:'administrator',password});assert.equal(setup.status,200);
  const gm={cookie:setup.headers.get('set-cookie').split(';')[0],csrf:(await setup.json()).csrf};assert.match(setup.headers.get('set-cookie'),/HttpOnly/);
  const reg=await request('/api/auth/register',{username:'player',password,role:'gm'});const data=await reg.json();assert.equal(data.user.role,'player');
  const player={cookie:reg.headers.get('set-cookie').split(';')[0],csrf:data.csrf};
  assert.equal((await request('/api/gm/players',undefined,player)).status,403);
  assert.equal((await request('/api/gm/execute',{},gm,{'X-CSRF-Token':'bad'})).status,403);
  assert.equal((await request('/api/chat',{text:'hello'},player,{Origin:'https://attacker.example'})).status,403);
  assert.equal((await request('/api/auth/setup',{username:'evilgm',password})).status,403);
  const game=await request('/',undefined,player);assert.equal(game.status,200);const html=await game.text();assert.match(html,/cloud-boot/);assert.match(html,/online\/bridge.js/);
  assert.equal((await request('/gm',undefined,gm)).status,200);
  const items=await(await request('/api/gm/catalog?q='+encodeURIComponent('屠龍劍'),undefined,gm)).json();assert.ok(items.items.some(i=>i.id==='wpn_dragonslayer'));
  await request('/api/chat',{text:'真人世界頻道測試 <script>alert(1)</script>'},player);
  const world=await(await request('/api/world',undefined,gm)).json();assert.equal(world.messages[0].displayName,'冒險者');assert.equal(Object.hasOwn(world.messages[0],'username'),false);assert.match(world.messages[0].text,/真人世界頻道/);
  assert.equal((await request('/api/chat',{text:'重複發言'},player)).status,429);
});
