import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../server/index.mjs';
import {CloudClient} from '../cli/cloud-client.mjs';
import {HeadlessGame} from '../cli/engine.mjs';
import {RemoteGame} from '../cli/remote-game.mjs';
import {GameSync,saveChanges} from '../cli/sync.mjs';

const execute=promisify(execFile),entry=fileURLToPath(new URL('../cli/main.mjs',import.meta.url));
async function fixture(t){
  const app=createApp({database:':memory:',publicOrigin:''});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));});
  const baseUrl=`http://127.0.0.1:${app.server.address().port}`;
  return {...app,baseUrl,client:new CloudClient({baseUrl})};
}

test('cloud conflict retains earned XP and applies GM events once to every slot',async t=>{
  const {service,client}=await fixture(t);
  const {user}=await client.register('sync_play','test-passphrase-2026');
  const gm=await service.register('sync_gm','test-passphrase-2026',{initialGm:true});
  const lease=randomUUID();await client.acquireLease(lease);
  const engine=new RemoteGame({client,lease,snapshot:await client.bootstrap()});t.after(()=>engine.close());
  await engine.open({classId:'knight',name:'衝突測試',allocation:{str:4,con:4}});
  const sync=new GameSync({client,engine,lease,snapshot:engine.boot});
  await engine.action('travel',{mapId:'training'});
  // Advance only the server clock in this isolated fixture.
  service.authority.runtimes.get(user.id).anchor-=25000;
  await sync.flush();
  await engine.pause(true);
  const earned=engine.snapshot();assert.ok(earned.p.gold>1000);
  const count=(doc)=>(doc.p.inv.find(i=>i.id==='potion_heal')?.cnt||0);
  const beforeCount=count(earned);
  const cmd={action:'grant_item',scope:'account',accountId:user.id,reason:'隔離測試',itemId:'potion_heal',quantity:7,enchant:0};
  const run=command=>service.execute(gm,{...command,requestId:randomUUID(),targetFingerprint:service.preview(gm,command).targetFingerprint});
  run(cmd);
  await sync.flush();
  let snapshot=await client.bootstrap(),saved=service.catalog.unwrap(snapshot.values.lineage_idle_save_1);
  assert.equal(saved.p.lv,earned.p.lv);assert.equal(saved.p.exp,earned.p.exp);assert.equal(saved.p.gold,earned.p.gold);
  assert.equal(count(saved),beforeCount+7);
  await sync.flush();assert.equal(count(engine.snapshot()),beforeCount+7,'replayed sync does not duplicate grants');
  run({action:'kill',scope:'account',accountId:user.id,reason:'隔離測試'});
  await sync.flush();assert.equal(engine.status().gmDead,true);await assert.rejects(engine.action('revive'),/GM/);
  assert.equal(sync.checkpoint().synced,true);
  await client.acquireLease(randomUUID(),{takeover:true});
  await assert.rejects(sync.flush(),error=>error.status===423);
  assert.deepEqual(saveChanges({lineage_note:'a',unrelated:'x'},{lineage_deleted:'b'}),{lineage_note:'a',lineage_deleted:null});
});

test('CLI creates, starts, controls and cleanly stops a real cloud worker',async t=>{
  const {baseUrl,service}=await fixture(t),home=mkdtempSync(join(tmpdir(),'blackcat-cli-test-'));
  const env={...process.env,BLACKCAT_CLI_HOME:home};
  const cli=async(...args)=>{
    const {stdout}=await execute(process.execPath,[entry,...args],{env,windowsHide:true,timeout:55000,maxBuffer:2_000_000});
    return JSON.parse(stdout);
  };
  t.after(async()=>{try{await cli('stop','--all');}finally{rmSync(home,{recursive:true,force:true});}});
  const created=await cli('create','--profile','tester','--class','knight','--server',baseUrl);
  assert.equal(created.role,'player');assert.ok(!JSON.stringify(created).includes('password'));
  const started=await cli('start','--profile','tester','--duration','40');assert.equal(started.status,'playing');
  const repeat=await cli('start','--profile','tester');assert.equal(repeat.alreadyRunning,true);assert.equal(repeat.pid,started.pid);
  await delay(1600);
  await cli('pause','--profile','tester');
  const before=(await cli('status','--profile','tester','--json'))[0];
  const maps=await cli('inspect','maps','--profile','tester');assert.ok(maps.some(m=>m.id==='training'));
  await cli('target','training','--profile','tester');
  const inventory=await cli('inspect','inventory','--profile','tester');assert.ok(inventory.some(i=>i.id==='potion_heal'));
  await assert.rejects(cli('revive','--profile','tester'),/仍活著/);
  await cli('setting','set-hp-pot','70','--profile','tester');
  await cli('sync','--profile','tester');
  const cloudStatus=await cli('cloud','--profile','tester');
  assert.equal(cloudStatus.role,'player');assert.equal(cloudStatus.characters[0].classId,'knight');
  assert.ok(cloudStatus.online.some(p=>p.name===cloudStatus.characters[0].name&&p.id));
  assert.ok(cloudStatus.online.every(p=>!Object.hasOwn(p,'username')));
  const after=(await cli('status','--profile','tester','--json'))[0];
  assert.ok(after.character.ticks<=100,'1.6 seconds of wall time cannot advance hours of combat');
  assert.ok(before.character.ticks>0);
  await cli('resume','--profile','tester');await delay(500);
  const stopped=await cli('stop','--profile','tester');assert.equal(stopped.saved,true);assert.equal(stopped.status,'stopped');
  const profile=JSON.parse(readFileSync(join(home,'profiles','tester.json'),'utf8'));
  const client=new CloudClient({baseUrl});await client.login(profile.username,profile.password);
  const cloud=await client.bootstrap(),doc=service.catalog.unwrap(cloud.values.lineage_idle_save_1);
  assert.equal(doc.p.cls,'knight');assert.equal(doc.p.config.setHpPot,'70');assert.ok(doc.ticks>0);
  assert.equal(JSON.parse(readFileSync(join(home,'runtime','tester','checkpoint.json'),'utf8')).synced,true);
  await client.logout();
});
