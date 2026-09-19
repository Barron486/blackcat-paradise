import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {GameService} from '../server/service.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {HeadlessGame} from '../cli/engine.mjs';
import {createApp} from '../server/index.mjs';
import {once} from 'node:events';
import {CloudClient} from '../cli/cloud-client.mjs';
const catalog=loadCatalog(new URL('../',import.meta.url)),key='lineage_idle_save_1';
async function fixture(t){
 const service=new GameService(':memory:',catalog),game=new HeadlessGame();t.after(()=>{game.close();service.close();});
 const gm=await service.register('guard_gm','guard-test-only-2026!',{initialGm:true}),user=await service.register('guard_player','guard-test-only-2026!'),lease=randomUUID();
 game.create({classId:'elf',name:'守護旅人',allocation:{dex:8}});service.acquireLease(user,lease);service.sync(user,lease,0,game.values(),{slot:1});
 const boot=()=>service.bootstrap(user),saved=()=>catalog.unwrap(boot().values[key]);
 const save=doc=>service.sync(user,lease,boot().revision,{[key]:catalog.wrap(doc)},{slot:1});
 const command=body=>{body={scope:'account',accountId:user.id,reason:'安全測試',...body};return service.execute(gm,{...body,requestId:randomUUID(),targetFingerprint:service.preview(gm,body).targetFingerprint});};
 return {service,game,user,gm,lease,boot,saved,save,command};
}
test('server rejects forged GM and market authority, leaves saves intact and records no submitted data',async t=>{
 const f=await fixture(t),before=f.boot();
 for(const [field,value,code]of [['_gmSeq',999,'forged_gm_sequence'],['_marketSeq',999,'forged_market_sequence'],['_gmDead',true,'forged_gm_death'],['_gmBuffs',{ids:['haste'],expiresAt:Date.now()+86400000},'forged_gm_buff']]){
  const doc=f.saved();doc.p[field]=value;assert.throws(()=>f.save(doc),e=>e.status===403&&e.details.saveRejected&&e.details.code===code);
 }
 assert.deepEqual(f.boot().values,before.values);assert.equal(f.boot().revision,before.revision);
 const events=f.service.saveGuard.history(f.gm);assert.equal(events.length,4);assert.ok(events.every(e=>Object.keys(e).sort().join(',')==='account,at,code,id,slotKey'));
 assert.throws(()=>f.service.saveGuard.history(f.user),e=>e.status===403);
});
test('client cannot clear GM death or extend a grant, while legitimate expiry and revival still work',async t=>{
 const f=await fixture(t);f.command({action:'buff_all',duration:600});
 let doc=f.saved();doc.p._gmBuffs.expiresAt+=86400000;assert.throws(()=>f.save(doc),e=>e.details.code==='forged_gm_buff');
 doc=f.saved();delete doc.p._gmBuffs;f.save(doc);assert.ok(f.saved().p._gmBuffs);
 f.command({action:'kill'});doc=f.saved();doc.p.dead=false;doc.p.hp=100;assert.throws(()=>f.save(doc),e=>e.details.code==='forged_gm_death');
 doc=f.saved();doc.p._gmDead=false;assert.throws(()=>f.save(doc),e=>e.details.code==='forged_gm_death');
 f.save(f.saved());f.command({action:'revive'});f.save(f.saved());assert.equal(f.saved().p.dead,false);
 const expiry=f.saved().p._gmBuffs.expiresAt;t.mock.method(Date,'now',()=>expiry+1);f.save(f.saved());assert.equal(f.saved().p._gmBuffs,undefined);
});
test('invalid numbers, unknown items, duplicated item IDs and impossible enchantments cannot overwrite cloud data',async t=>{
 const f=await fixture(t),before=f.boot();
 for(const mutate of [p=>p.gold=-1,p=>p.exp='999',p=>p.gold=Number.MAX_SAFE_INTEGER+1,p=>p.panacea.str=61,p=>p.inv[0].cnt=-10,p=>p.inv[0].id='invented_item',p=>p.eq.wpn.en=999,p=>p.inv.push({...p.inv[0]})]){
  const doc=f.saved();mutate(doc.p);assert.throws(()=>f.save(doc),e=>e.status===403&&e.details.saveRejected);
 }
 assert.deepEqual(f.boot().values,before.values);assert.equal(f.boot().revision,before.revision);
});
test('a rejected second character rolls back the entire batch but keeps a bounded audit event',async t=>{
 const f=await fixture(t),before=f.boot(),doc=f.saved();doc.p.exp=1;
 const other=structuredClone(doc);other.p._roleEpoch=randomUUID();other.p.exp=0;other.p._gmBuffs={ids:['haste'],expiresAt:Date.now()+60000};
 for(let i=0;i<3;i++)assert.throws(()=>f.service.sync(f.user,f.lease,before.revision,{[key]:catalog.wrap(doc),lineage_idle_save_2:catalog.wrap(other)}),e=>e.details.saveRejected);
 assert.deepEqual(f.boot().values,before.values);assert.equal(f.service.saveGuard.history(f.gm).length,1);
});
test('normal combat, consumption, equipment and valid GM item grants continue to sync',async t=>{
 const f=await fixture(t);f.game.action('travel',{mapId:'training'});f.game.step(300);f.save(f.game.snapshot());
 f.command({action:'grant_item',itemId:'wpn_dragonslayer',quantity:1,enchant:15,blessed:true});f.save(f.saved());
 assert.ok(f.saved().p.inv.some(i=>i.id==='wpn_dragonslayer'&&i.en===15));assert.equal(f.service.saveGuard.history(f.gm).length,0);
});
test('fresh character edits cannot smuggle equipment, permanent stats or learned skills',async t=>{
 const f=await fixture(t);
 for(const mutate of [p=>p.inv.push({id:'wpn_dragonslayer',uid:randomUUID(),cnt:1,en:0}),p=>p.eq.wpn.en=1,p=>p.skills.push('sk_heal'),p=>p.base.str=20,p=>p.alloc.str=10]){
  const doc=f.game.snapshot();doc.p._roleEpoch=randomUUID();mutate(doc.p);
  assert.throws(()=>f.service.sync(f.user,f.lease,f.boot().revision,{lineage_idle_save_2:catalog.wrap(doc)}),e=>e.details.saveRejected);
  assert.equal(f.boot().values.lineage_idle_save_2,undefined);
 }
});
test('all eight professions retain their real starting items and valid allocations',async t=>{
 const service=new GameService(':memory:',catalog);t.after(()=>service.close());const user=await service.register('eight_classes','guard-test-only-2026!'),lease=randomUUID();service.acquireLease(user,lease);let revision=0;
 for(const [index,[classId,base]]of Object.entries(catalog.creation).entries()){
  const game=new HeadlessGame();try{
   let remaining=base.pts;const allocation={};for(const stat of ['str','dex','con','int','wis','cha']){allocation[stat]=Math.min(20-base[stat],remaining);remaining-=allocation[stat];}
   assert.equal(remaining,0);
   const raw='m_'+({illusion:'illusionist',dragon:'Dknight'}[classId]||classId);
   game.run('selectClass(__args.raw);document.getElementById("creation-name").value=__args.name;for(const [stat,count] of Object.entries(__args.allocation))for(let i=0;i<count;i++)adjStat(stat,1);startGame();',{raw,name:'初始'+classId,allocation});
   const result=service.sync(user,lease,revision,{['lineage_idle_save_'+(index+1)]:catalog.wrap(game.snapshot())});revision=result.revision;
  }finally{game.close();}
 }
 assert.equal(Object.keys(service.bootstrap(user).values).length,8);
});
test('authenticated HTTP rejects edited snapshots even when the public save checksum is recomputed',async t=>{
 const app=createApp({database:':memory:',catalog,publicOrigin:'',publicAliases:[],aiOptions:{apiKey:''}});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));});
 const base=`http://127.0.0.1:${app.server.address().port}`,client=new CloudClient({baseUrl:base}),game=new HeadlessGame();t.after(()=>game.close());
 await client.register('http_guard','guard-test-only-2026!');const lease=randomUUID();await client.acquireLease(lease);game.create({classId:'elf',name:'HTTP角色',allocation:{dex:8}});
 await client.game({lease,op:'create',slot:1,revision:0,requestId:randomUUID(),args:{classId:'elf',name:'HTTP角色',allocation:{dex:8}}});const before=await client.bootstrap(),doc=catalog.unwrap(before.values[key]);doc.p.gold=-1000;
 await assert.rejects(client.sync({lease,revision:before.revision,changes:{[key]:catalog.wrap(doc)}}),e=>e.status===403&&e.data.saveRejected);
 assert.deepEqual((await client.bootstrap()).values,before.values);
 assert.equal((await fetch(base+'/api/gm/save-security',{headers:{Cookie:client.exportSession().cookie}})).status,403);
 await client.logout();
});
