import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../server/index.mjs';
import {ServerControl} from '../server/server-control.mjs';

const password='restart-local-test-2026!';
async function fixture(t,{restart=async()=>{},...options}={}){
  const app=createApp({database:':memory:',publicOrigin:'',publicAliases:[],aiOptions:{apiKey:''},restartOptions:{restart,...options}});app.authority.clock=()=>0;
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>new Promise(resolve=>app.server.close(resolve)));
  const gm=await app.service.register('restart_gm',password,{initialGm:true}),player=await app.service.register('restart_player',password);
  const body=()=>({requestId:randomUUID(),bootId:app.serverControl.bootId,reason:'操作卡頓排查',confirmation:'重啟伺服器'});
  return {...app,gm,player,body,base:'http://127.0.0.1:'+app.server.address().port};
}
test('GM restart validates confirmation, reason, boot identity and deduplicates concurrent/replayed requests',async t=>{
  const f=await fixture(t),c=f.serverControl,body=f.body();
  assert.throws(()=>c.request(f.player,body),e=>e.status===403);
  for(const change of [{requestId:'bad'},{confirmation:'重啟'},{reason:'a'},{reason:'x'.repeat(201)},{bootId:'old'}])assert.throws(()=>c.request(f.gm,{...body,...change}));
  const accepted=c.request(f.gm,body);assert.equal(accepted.status,'scheduled');assert.ok(accepted.scheduledAt>Date.now());
  assert.equal(c.request(f.gm,body).id,accepted.id);assert.equal(c.request(f.gm,body).replayed,true);
  assert.throws(()=>c.request(f.gm,{...body,reason:'different'}),e=>e.status===409);
  assert.throws(()=>c.request(f.gm,f.body()),e=>e.status===409);assert.match(c.announcement().text,/進度會先保存/);
  assert.equal(c.status(f.gm).history.length,1);assert.equal(c.status(f.gm).restartAvailable,true);
  f.service.db.prepare("UPDATE accounts SET role='player' WHERE id=?").run(f.gm.id);assert.throws(()=>c.request(f.gm,body),e=>e.status===403);
});
test('restart failures remain visible and allow retry; boot recovery completes only stopping requests',async t=>{
  let calls=0;const f=await fixture(t,{restart:async()=>{calls++;throw new Error('simulated checkpoint failure');}}),c=f.serverControl,body=f.body();
  c.request(f.gm,body);await c.run();assert.equal(calls,1);assert.equal(c.pending,null);assert.equal(c.status(f.gm).history[0].status,'failed');assert.equal(c.announcement(),null);assert.equal(c.request(f.gm,body).status,'failed');
  const next=f.body();c.request(f.gm,next);await c.run();assert.equal(calls,2);
  const pending=f.body();c.request(f.gm,pending);c.close();
  const recovered=new ServerControl(f.service,{authority:f.authority,battleFeed:{clients:new Map()},restart:async()=>{}});t.after(()=>recovered.close());
  assert.equal(recovered.status(f.gm).history[0].status,'interrupted');assert.notEqual(recovered.bootId,c.bootId);
  f.service.db.prepare("UPDATE server_restarts SET status='stopping' WHERE request_id=?").run(pending.requestId);recovered.close();
  const nextBoot=new ServerControl(f.service,{authority:f.authority,battleFeed:{clients:new Map()},restart:async()=>{}});t.after(()=>nextBoot.close());
  assert.equal(nextBoot.status(f.gm).history[0].status,'completed');assert.equal(nextBoot.request(f.gm,pending).replayed,true);
  assert.throws(()=>nextBoot.request(f.gm,{...f.body(),bootId:nextBoot.bootId}),e=>e.status===429);
});
test('HTTP status and restart require GM, same origin and CSRF; direct start cannot exit the process',async t=>{
  const f=await fixture(t),gm=await f.service.login(f.gm.username,password),player=await f.service.login(f.player.username,password);
  const headers=s=>({Cookie:'idle_session='+s.session,'Content-Type':'application/json',Origin:f.base,'X-CSRF-Token':s.csrf}),url=f.base+'/api/gm/server';
  assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{headers:headers(player)})).status,403);
  const status=await fetch(url,{headers:headers(gm)});assert.equal(status.headers.get('cache-control'),'no-store');const data=await status.json();assert.ok(data.memory.rssMB>0);assert.equal(data.history.length,0);
  for(const h of [headers(player),{...headers(gm),'X-CSRF-Token':'bad'},{...headers(gm),Origin:'https://evil.invalid'}])assert.equal((await fetch(url+'/restart',{method:'POST',headers:h,body:JSON.stringify(f.body())})).status,403);
  const disabled=await fixture(t,{restart:null});assert.equal(disabled.serverControl.status(disabled.gm).restartAvailable,false);assert.throws(()=>disabled.serverControl.request(disabled.gm,disabled.body()),e=>e.status===503);
  const response=await fetch(url+'/restart',{method:'POST',headers:headers(gm),body:JSON.stringify(f.body())});assert.equal(response.status,202);
  const broadcasts=await(await fetch(f.base+'/api/loot-broadcasts',{headers:headers(player)})).json();assert.match(broadcasts.announcement.text,/伺服器將於/);
});
test('checkpoint saves unsaved runtime changes, stops mutations and resumes normal service if saving fails',async t=>{
  const f=await fixture(t),lease=randomUUID();f.service.acquireLease(f.player,lease);
  f.authority.handle(f.player,{lease,op:'create',slot:1,args:{classId:'knight',name:'存檔測試',allocation:{str:2,con:6}},revision:0,requestId:randomUUID()});
  const r=f.authority.runtimes.get(f.player.id);r.engine.run('player.gold=876543;');
  const commit=f.authority.commit;f.authority.commit=()=>{throw new Error('disk failure');};
  await assert.rejects(f.shutdown(),/disk failure/);assert.equal(f.authority.suspended,false);assert.equal((await fetch(f.base+'/healthz')).status,200);
  f.authority.commit=commit;assert.equal(f.authority.checkpointAll(),1);
  const doc=f.service.catalog.unwrap(f.service.bootstrap(f.player).values.lineage_idle_save_1);assert.equal(doc.p.gold,876543);
  assert.throws(()=>f.authority.handle(f.player,{lease,op:'state'}),e=>e.status===503);
});
test('background combat skips unused full projections while retaining the regular status API',async t=>{
  const f=await fixture(t),lease=randomUUID();f.service.acquireLease(f.player,lease);
  f.authority.handle(f.player,{lease,op:'create',slot:1,args:{classId:'knight',name:'效能測試',allocation:{str:2,con:6}},revision:0,requestId:randomUUID()});
  const r=f.authority.runtimes.get(f.player.id),status=r.engine.status.bind(r.engine),before=status();let calls=0;
  r.engine.status=()=>{calls++;return status();};f.authority.clock=()=>1000;f.authority.tick();assert.equal(calls,0,'background save and step do not materialize full inventory projections');
  const after=r.engine.step(1);assert.equal(calls,1);assert.equal(after.name,before.name);assert.ok(after.ticks>before.ticks);assert.deepEqual(r.engine.presence(),{name:after.name,map:after.map,mapName:after.mapName});
});
test('real supervised restart preserves accounts, role progress, sessions and hanging automation; same receipt cannot restart twice',{timeout:55000},async t=>{
  const directory=mkdtempSync(path.join(tmpdir(),'blackcat-restart-'));
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const base='http://127.0.0.1:'+port,env={...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:directory,PUBLIC_ORIGIN:'',RAILWAY_ENVIRONMENT_ID:'',RAILWAY_PUBLIC_DOMAIN:'',OPENAI_API_KEY:'',AI_CHAT_API_KEY:''};
  const child=spawn(process.execPath,['server/start.mjs'],{cwd:new URL('../',import.meta.url),env,stdio:['ignore','pipe','pipe','ipc']});let logs='';child.stdout.on('data',v=>logs+=v);child.stderr.on('data',v=>logs+=v);
  t.after(async()=>{if(child.exitCode===null){const exited=once(child,'exit');child.send('shutdown');await exited;}assert.equal(path.dirname(directory),path.resolve(tmpdir()));assert.ok(path.basename(directory).startsWith('blackcat-restart-'));rmSync(directory,{recursive:true,force:true});});
  let cookie='',csrf='';const req=async(route,body)=>{const res=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(2500)});const data=await res.json();return {res,data};};
  async function until(fn,ms=10000){const end=Date.now()+ms;let last;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(error){last=error;}await delay(150);}throw new Error('Timed out: '+(last?.message||logs.slice(-1000)));}
  await until(async()=>(await req('/healthz')).res.ok);
  const auth=await req('/api/auth/setup',{username:'restart_process',password});assert.equal(auth.res.status,200);cookie=auth.res.headers.get('set-cookie').split(';')[0];csrf=auth.data.csrf;
  const lease=randomUUID();assert.equal((await req('/api/lease',{lease})).res.status,200);
  const created=await req('/api/game',{lease,op:'create',slot:1,args:{classId:'knight',name:'重啟留存角色',allocation:{str:2,con:6}},revision:0,requestId:randomUUID()});assert.equal(created.res.status,200);
  const g=created.data.game;
  const travel=await req('/api/game',{lease,op:'action',slot:1,epoch:g.epoch,revision:created.data.snapshot.revision,requestId:randomUUID(),args:{name:'travel',params:{mapId:'training'}}});assert.equal(travel.res.status,200);
  const initial=(await req('/api/gm/server')).data;assert.equal(initial.restartAvailable,true);
  const body={requestId:randomUUID(),bootId:initial.bootId,confirmation:'重啟伺服器',reason:'本機實際重啟驗證'};
  assert.equal((await req('/api/gm/server/restart',body)).res.status,202);
  const restarted=await until(async()=>{const {res,data}=await req('/api/gm/server');return res.ok&&data.bootId!==initial.bootId?data:null;},30000);
  assert.equal(restarted.history[0].status,'completed');assert.equal(restarted.pending,null);
  const restored=await until(async()=>{const {res,data}=await req('/api/game',{lease,op:'state'});return res.ok?data:null;});assert.equal(restored.game.status.name,'重啟留存角色');assert.equal(restored.game.epoch,g.epoch);assert.ok(restored.game.status.level>=g.status.level);assert.ok(restored.game.status.gold>=g.status.gold);
  await until(async()=>(await req('/api/gm/server')).data.game.running===1);
  const replay=await req('/api/gm/server/restart',body);assert.equal(replay.data.replayed,true);assert.equal(replay.data.status,'completed');
  assert.equal((await req('/api/gm/server/restart',{...body,bootId:restarted.bootId,requestId:randomUUID()})).res.status,429);
  assert.match(logs,/重新啟動遊戲服務/);assert.equal((logs.match(/重新啟動遊戲服務/g)||[]).length,1);
});
