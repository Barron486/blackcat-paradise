import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createApp} from '../server/index.mjs';
import {gmCharacterReport} from '../server/gm-character.mjs';

async function fixture(t){
  const app=createApp({database:':memory:',publicOrigin:'',publicAliases:[],aiOptions:{apiKey:''}});app.authority.clock=()=>0;
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>new Promise(resolve=>app.server.close(resolve)));
  const password='gm-inspection-test-2026!',gm=await app.service.register('inspect_gm',password,{initialGm:true}),player=await app.service.register('inspect_player',password),lease=randomUUID();app.service.acquireLease(player,lease);
  for(const [slot,classId,allocation]of [[1,'elf',{dex:8}],[2,'mage',{int:6,wis:6,con:4}]]){
    app.authority.handle(player,{lease,op:'create',slot,args:{classId,name:'查核角色'+slot,allocation},revision:app.service.bootstrap(player).revision,requestId:randomUUID()});
  }
  const r=app.authority.runtimes.get(player.id);
  r.engine.run("player.lv=40;player.gold=123456;calcStats();_lzSet(whKey(),JSON.stringify({items:[{id:'potion_heal',uid:'warehouse-item',cnt:12}],gold:987}));petStoreAdd('貓');petRosterSave();");app.authority.commit(player,r);
  const read=slot=>gmCharacterReport(app.service,gm,player.id,slot);
  const write=(slot,mutate)=>{const row=app.service.bootstrap(player),key='lineage_idle_save_'+slot,doc=app.service.catalog.unwrap(row.values[key]);mutate(doc);row.values[key]=app.service.catalog.wrap(doc);app.service.db.prepare('UPDATE saves SET data=? WHERE account_id=?').run(JSON.stringify(row.values),player.id);};
  return {...app,gm,player,password,lease,r,read,write,base:'http://127.0.0.1:'+app.server.address().port};
}
test('GM reads every role and full game data without acquiring control, recalculating or modifying saves',async t=>{
  const f=await fixture(t),before=f.service.db.prepare('SELECT * FROM saves WHERE account_id=?').get(f.player.id),leaseBefore=f.service.db.prepare('SELECT * FROM leases WHERE account_id=?').get(f.player.id);
  const originalRun=f.r.engine.run;f.r.engine.run=()=>{throw new Error('inspection must not execute player engine');};
  const report=f.read(2);f.r.engine.run=originalRun;
  assert.equal(report.snapshot.p.lv,40);assert.equal(report.snapshot.p.gold,123456);assert.equal(report.snapshot.p.d.int,18);assert.equal(report.account.username,'inspect_player');assert.equal(report.slot,2);assert.equal(report.shared.lineage_idle_warehouse.gold,987);assert.equal(report.shared.lineage_idle_warehouse.items[0].cnt,12);assert.equal(report.shared.fb5_pet_roster.length,1);assert.equal(report.itemCatalog.potion_heal.name,'紅色藥水');assert.equal(report.checks.issueCount,0);
  assert.equal(f.read(1).snapshot.p.name,'查核角色1');assert.equal(report.serverAuthoritative,true);assert.equal(report.readOnly,true);
  assert.deepEqual(f.service.db.prepare('SELECT * FROM saves WHERE account_id=?').get(f.player.id),before);assert.deepEqual(f.service.db.prepare('SELECT * FROM leases WHERE account_id=?').get(f.player.id),leaseBefore);
  assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM wallets WHERE account_id=?').get(f.player.id).n,0,'inspection does not create a wallet');
  assert.ok(!JSON.stringify(report).includes(f.lease));assert.doesNotMatch(JSON.stringify(report),/password_hash|token_hash|"csrf"|"salt"/);
  f.service.db.prepare('UPDATE leases SET expires_at=0 WHERE account_id=?').run(f.player.id);assert.equal(f.read(2).account.online,false);assert.equal(f.read(2).snapshot.p.name,'查核角色2');
});
test('inspection flags invalid identity, progress, item quantity, enhancement and duplicate UID but accepts legal high bonuses',async t=>{
  const f=await fixture(t);f.write(2,doc=>{doc.p.d.str=150;doc.p.d.ac=-300;});assert.equal(f.read(2).checks.issueCount,0,'no arbitrary high-stat ban');
  f.write(2,doc=>{doc.p.lv=101;doc.p.gold=-5;doc.p._roleEpoch='forged';doc.p.inv.push({id:'wpn_11',uid:'same',cnt:1,en:999},{id:'potion_heal',uid:'same',cnt:-2},{id:'nonexistent',cnt:1});});
  const report=f.read(2),codes=report.checks.issues.map(i=>i.code);for(const code of ['invalid_level','invalid_number','character_identity','invalid_enchantment','duplicate_item','invalid_quantity','unknown_item'])assert.ok(codes.includes(code),code);
  assert.equal(report.snapshot.p.gold,-5,'report does not silently fix evidence');
});
test('inspection scopes security and GM history to the selected role, with account-wide rejected uploads',async t=>{
  const f=await fixture(t),insert=f.service.db.prepare('INSERT INTO save_security_events(account_id,slot_key,code,created_at) VALUES(?,?,?,?)');
  for(const [key,code]of [['all','SERVER_AUTHORITY_REQUIRED'],['lineage_idle_save_1','invalid_gold'],['lineage_idle_save_2','invalid_quantity']])insert.run(f.player.id,key,code,Date.now());
  const command={action:'grant_item',scope:'character',accountId:f.player.id,slot:2,itemId:'potion_heal',quantity:3,enchant:0,blessed:false,reason:'查核獎勵'};
  const preview=f.service.preview(f.gm,command);f.service.execute(f.gm,{...command,requestId:randomUUID(),targetFingerprint:preview.targetFingerprint});
  f.service.db.prepare('INSERT INTO gm_effects(account_id,revision,save_key,payload) VALUES(?,?,?,?)').run(f.player.id,1,'lineage_idle_save_1',JSON.stringify({action:'market',seq:1}));
  const report=f.read(2);assert.deepEqual(report.history.security.map(e=>e.code),['invalid_quantity','SERVER_AUTHORITY_REQUIRED']);assert.equal(report.history.commands.length,1);assert.equal(report.history.commands[0].command.reason,'查核獎勵');assert.equal(f.read(1).history.commands.length,0);
});
test('HTTP inspection is GM-only, honors revoked roles, validates slot and does not expose data publicly',async t=>{
  const f=await fixture(t),path=`/api/gm/character?accountId=${f.player.id}&slot=2`,gmSession=await f.service.login(f.gm.username,f.password),playerSession=await f.service.login(f.player.username,f.password),headers=s=>({Cookie:'idle_session='+s.session});
  assert.equal((await fetch(f.base+path)).status,401);assert.equal((await fetch(f.base+path,{headers:headers(playerSession)})).status,403);
  const response=await fetch(f.base+path,{headers:headers(gmSession)});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).snapshot.p.name,'查核角色2');
  assert.equal((await fetch(f.base+path.replace('slot=2','slot=9'),{headers:headers(gmSession)})).status,400);assert.equal((await fetch(f.base+path.replace('slot=2','slot=8'),{headers:headers(gmSession)})).status,404);
  f.service.db.prepare("UPDATE accounts SET role='player' WHERE id=?").run(f.gm.id);assert.equal((await fetch(f.base+path,{headers:headers(gmSession)})).status,403);
});
