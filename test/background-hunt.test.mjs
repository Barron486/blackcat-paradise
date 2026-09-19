import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GameService} from '../server/service.mjs';
import {AuthoritativeGame} from '../server/authoritative-game.mjs';
import {loadCatalog} from '../server/catalog.mjs';

const catalog=loadCatalog(new URL('../',import.meta.url));
async function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'blackcat-background-')),database=join(directory,'game.sqlite');
  let now=0;
  const f={lease:randomUUID()};
  const open=()=>{f.service=new GameService(database,catalog);f.authority=new AuthoritativeGame(f.service,{clock:()=>now,autoTick:false,idleMs:90000});};
  open();t.after(()=>{f.authority.close();f.service.close();rmSync(directory,{recursive:true,force:true});});
  f.user=await f.service.register('background_player','background-test-password-2026');f.service.acquireLease(f.user,f.lease);
  f.saved=(slot=1)=>catalog.unwrap(f.service.bootstrap(f.user).values['lineage_idle_save_'+slot]);
  f.session=()=>f.service.db.prepare('SELECT * FROM game_sessions WHERE account_id=?').get(f.user.id);
  f.send=(op,args={},extra={})=>{
    const slot=extra.slot??f.authority.runtimes.get(f.user.id)?.slot??1;
    const boot=f.service.bootstrap(f.user),raw=boot.values['lineage_idle_save_'+slot];
    return f.authority.handle(f.user,{lease:f.lease,op,slot,args,epoch:raw?catalog.unwrap(raw).p._roleEpoch:undefined,
      ...(op==='state'?{}:{revision:boot.revision,requestId:randomUUID()}),...extra});
  };
  f.advance=ms=>{now+=ms;};
  f.restart=()=>{f.authority.close();f.service.close();now=0;open();};
  f.send('create',{classId:'knight',name:'背景掛機騎士',allocation:{str:2,con:6}});
  const r=f.authority.runtimes.get(f.user.id);
  r.engine.run('player.lv=60;calcStats();player.hp=player.mhp;player.mp=player.mmp;');f.authority.commit(f.user,r);
  f.send('action',{name:'travel',params:{mapId:'training'}});
  return f;
}

test('server continues combat and rewards beyond 90 seconds with no browser, heartbeat or lease renewal',async t=>{
  const f=await fixture(t),r=f.authority.runtimes.get(f.user.id),before=f.saved(),seen=r.lastSeen;
  f.service.db.prepare('UPDATE leases SET expires_at=0 WHERE account_id=?').run(f.user.id);
  for(let i=0;i<36;i++){f.advance(5000);f.authority.tick();}
  const after=f.saved();
  assert.equal(after.ticks-before.ticks,1800);assert.equal(after.ms.current,'training');assert.equal(after.p.dead,false);
  assert.ok(after.p.gold>before.p.gold||after.p.exp>before.p.exp||after.p.lv>before.p.lv,'actual kills award progress in the saved character');
  assert.equal(f.authority.runtimes.get(f.user.id),r);assert.equal(r.lastSeen,seen);assert.equal(f.session().running,1);
  assert.equal(f.service.db.prepare('SELECT expires_at FROM leases WHERE account_id=?').get(f.user.id).expires_at,0,'background play must not claim a player is still connected');
  for(let i=0;i<5;i++)f.authority.tick();assert.equal(f.saved().ticks,after.ticks,'no extra rewards without elapsed server time');
  assert.equal(f.send('state').game.status.ticks,after.ticks);
});

test('SQLite checkpoint automatically resumes after restart without a connected client or downtime rewards',async t=>{
  const f=await fixture(t);f.advance(1200);f.authority.tick();const before=f.saved();
  f.restart();assert.equal(f.authority.runtimes.size,0);
  f.authority.tick();assert.equal(f.authority.runtimes.size,1);
  const restored=f.saved();assert.equal(restored.ticks,before.ticks);assert.equal(restored.p.hp,before.p.hp);assert.equal(restored.p.gold,before.p.gold);
  assert.deepEqual(restored.ms.mobs,before.ms.mobs);assert.equal(restored._serverState.pDmgTick,before._serverState.pDmgTick);
  f.advance(5000);f.authority.tick();assert.equal(f.saved().ticks,before.ticks+50);assert.equal(f.saved().ms.current,'training');
  f.authority.tick();assert.equal(f.saved().ticks,before.ticks+50);
});

test('reconnecting with a new control lease retains one battle clock and rejects the old browser',async t=>{
  const f=await fixture(t),old=f.lease,r=f.authority.runtimes.get(f.user.id);
  f.advance(5000);f.authority.tick();const before=f.saved();
  f.service.db.prepare('UPDATE leases SET expires_at=0 WHERE account_id=?').run(f.user.id);
  f.lease=randomUUID();f.service.acquireLease(f.user,f.lease);f.authority.tick();
  assert.equal(f.authority.runtimes.get(f.user.id),r);assert.equal(f.send('state').game.status.ticks,before.ticks);
  assert.deepEqual(f.saved().ms.mobs,before.ms.mobs);
  assert.throws(()=>f.send('state',{}, {lease:old}),e=>e.status===423);
  f.advance(1000);f.authority.tick();assert.equal(f.send('state').game.status.ticks,before.ticks+10);
  assert.equal(f.authority.runtimes.size,1);assert.equal(f.service.db.prepare('SELECT COUNT(*) AS count FROM game_sessions').get().count,1);
});

test('pause survives eviction and restart; resume continues; leave permanently ends the background session',async t=>{
  const f=await fixture(t);f.advance(1000);f.send('pause');const stopped=f.saved().ticks;
  assert.equal(f.session().running,0);assert.equal(f.session().paused,1);
  f.advance(180000);f.authority.tick();assert.equal(f.authority.runtimes.size,0);assert.equal(f.saved().ticks,stopped);
  f.restart();f.authority.tick();assert.equal(f.authority.runtimes.size,0);assert.equal(f.send('state').game.paused,true);
  f.send('resume');f.advance(1000);f.authority.tick();assert.equal(f.saved().ticks,stopped+10);
  f.send('leave');assert.equal(f.session(),undefined);const left=f.saved().ticks;
  f.advance(180000);f.authority.tick();assert.equal(f.saved().ticks,left);
  f.restart();f.authority.tick();assert.equal(f.send('state').game,null);assert.equal(f.saved().ticks,left);
});

test('only the selected slot continues; death is preserved and a dead character earns nothing',async t=>{
  const f=await fixture(t);f.advance(1000);f.authority.tick();const first=f.saved();
  f.send('create',{classId:'mage',name:'第二個角色',allocation:{int:6,wis:6,con:4}},{slot:2});
  assert.equal(f.session().slot,2);assert.equal(f.authority.runtimes.size,1);
  f.advance(5000);f.authority.tick();assert.equal(f.saved(1).ticks,first.ticks);
  const r=f.authority.runtimes.get(f.user.id);r.engine.run('player.dead=true;player.hp=0;');f.authority.commit(f.user,r);
  const dead=f.saved(2);assert.equal(f.session().running,0);
  f.advance(180000);f.authority.tick();assert.equal(f.authority.runtimes.size,0);
  f.restart();f.authority.tick();assert.equal(f.authority.runtimes.size,0);
  const reconnected=f.send('state');assert.equal(reconnected.game.slot,2);assert.equal(reconnected.game.status.dead,true);assert.equal(reconnected.game.status.hp,0);
  assert.equal(reconnected.game.status.ticks,dead.ticks);assert.equal(reconnected.game.status.gold,dead.p.gold);
});

test('revoked leases and replaced character identities cannot resume an old background session',async t=>{
  const f=await fixture(t),before=f.saved();
  f.service.db.prepare('DELETE FROM leases WHERE account_id=?').run(f.user.id);
  f.advance(1000);f.authority.tick();assert.equal(f.session(),undefined);assert.equal(f.saved().ticks,before.ticks);
  f.service.acquireLease(f.user,f.lease);f.send('select');
  const r=f.authority.runtimes.get(f.user.id),values=f.service.bootstrap(f.user).values,doc=f.saved();
  doc.p._roleEpoch=randomUUID();values.lineage_idle_save_1=r.engine.encodeSave(doc);
  f.service.db.prepare('UPDATE saves SET data=?,revision=revision+1 WHERE account_id=?').run(JSON.stringify(values),f.user.id);
  f.restart();f.authority.tick();assert.equal(f.authority.runtimes.size,0);assert.equal(f.session(),undefined);
  assert.equal(f.send('state').game,null);assert.equal(f.saved().p._roleEpoch,doc.p._roleEpoch);
});

test('an unacknowledged purchase remains idempotent after automatic server recovery',async t=>{
  const f=await fixture(t);f.send('action',{name:'return-town',params:{}});
  const initial=f.send('state'),npc=f.authority.runtimes.get(f.user.id).engine.catalog().towns[initial.game.status.map].npcs.find(n=>n.type==='shop');
  const body={lease:f.lease,op:'action',slot:1,epoch:initial.game.epoch,revision:initial.snapshot.revision,requestId:randomUUID(),args:{name:'shop',params:{npcId:npc.id,itemId:'potion_heal',qty:1}}};
  const bought=f.authority.handle(f.user,body);f.restart();f.authority.tick();
  const retried=f.authority.handle(f.user,body);assert.equal(retried.replayed,true);assert.equal(retried.game.status.gold,bought.game.status.gold);
  const count=result=>result.game.status.inventory.filter(i=>i.id==='potion_heal').reduce((n,i)=>n+i.cnt,0);
  assert.equal(count(retried),count(bought));
});
