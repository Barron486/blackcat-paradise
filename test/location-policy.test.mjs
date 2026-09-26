import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {GameService} from '../server/service.mjs';
import {WorldSettingsService} from '../server/world-settings.mjs';
import {CommerceService} from '../server/commerce.mjs';
import {createApp} from '../server/index.mjs';
import {CloudClient} from '../cli/cloud-client.mjs';
const {JSDOM}=createRequire(new URL('../cli/package.json',import.meta.url))('jsdom');
const password='presence-policy-test-2026!',key='lineage_idle_save_1';
const catalog={version:'test',items:{},skills:{},wrap:JSON.stringify,unwrap:JSON.parse,world:{maps:[{id:'private-map',name:'隱密地圖'}],monsters:[],drops:[]}};
const doc=name=>({p:{name,cls:'elf',lv:1,inv:[],_roleEpoch:randomUUID()},ms:{current:'private-map'}});
function seed(service,user,name){const lease=randomUUID();service.acquireLease(user,lease);service.sync(user,lease,0,{[key]:JSON.stringify(doc(name))},{slot:1});return lease;}
async function fixture(t,file=':memory:'){
 const service=new GameService(file,catalog),world=new WorldSettingsService(service),shop=new CommerceService(service);t.after(()=>{try{service.close();}catch{}});
 const gm=await service.register('policy_gm',password,{initialGm:true}),a=await service.register('policy_a',password),b=await service.register('policy_b',password),c=await service.register('policy_c',password);
 const leases=new Map();for(const [user,name]of [[a,'甲'],[b,'乙'],[c,'丙']])leases.set(user.id,seed(service,user,name));
 const assign=(user,clanName)=>service.presence.assign(gm,{accountId:user.id,clanName,reason:'GM 指派測試',requestId:randomUUID(),revision:service.presence.admin(gm).revision});
 const setting=visible=>world.update(gm,{type:'presence',showPlayerLocations:visible,revision:world.state().revision,requestId:randomUUID(),reason:'位置公開測試'});
 return {service,world,shop,gm,a,b,c,leases,assign,setting};
}
const maps=(service,user)=>Object.fromEntries(service.onlineSummary(user).list.map(p=>[p.name,p.map]));
test('location policy defaults private, trusts only GM membership, and removes access on clan reassignment',async t=>{
 const f=await fixture(t);assert.equal(f.world.state().showPlayerLocations,false);assert.deepEqual(maps(f.service,f.a),{甲:'隱密地圖',乙:null,丙:null});assert.ok(Object.values(maps(f.service,f.gm)).every(Boolean));
 f.assign(f.a,'黑貓盟');f.assign(f.b,'黑貓盟');assert.deepEqual(maps(f.service,f.a),{甲:'隱密地圖',乙:'隱密地圖',丙:null});assert.equal(maps(f.service,f.b).甲,'隱密地圖');
 const cloud=f.service.bootstrap(f.c),fake=JSON.parse(cloud.values[key]);fake.p.clanId=f.service.db.prepare('SELECT clan_id FROM clan_members WHERE account_id=?').get(f.a.id).clan_id;
 f.service.sync(f.c,f.leases.get(f.c.id),cloud.revision,{[key]:JSON.stringify(fake),fb5_clan_state_v1:JSON.stringify({modes:{normal:{name:'黑貓盟',leaderId:f.a.id}}})},{slot:1});assert.equal(maps(f.service,f.c).甲,null,'client-side clan labels cannot grant access');
 f.assign(f.b,'別的盟');assert.equal(maps(f.service,f.a).乙,null);f.assign(f.b,'黑貓盟');f.assign(f.b,'');assert.equal(maps(f.service,f.a).乙,null);
 assert.ok(f.shop.state(f.a).spyTargets.every(p=>p.map===null),'shop choices obey the same restriction');
 f.setting(true);assert.ok(f.shop.state(f.a).spyTargets.every(p=>p.map==='隱密地圖'));f.setting(false);assert.equal(maps(f.service,f.a).乙,null);
 f.service.db.prepare("UPDATE accounts SET role='player' WHERE id=?").run(f.gm.id);assert.equal(maps(f.service,f.gm).甲,null,'revoked GM role cannot see locations through stale user object');
});
test('GM location and clan changes enforce roles, types, revision conflicts, idempotency and atomic rollback',async t=>{
 const f=await fixture(t),body={accountId:f.a.id,clanName:'黑貓盟',reason:'建立名冊',requestId:randomUUID(),revision:0};
 assert.throws(()=>f.service.presence.assign(f.a,body),e=>e.status===403);assert.throws(()=>f.world.update(f.a,{type:'presence',showPlayerLocations:true}),e=>e.status===403);
 for(const showPlayerLocations of [1,'true',null])assert.throws(()=>f.world.update(f.gm,{type:'presence',showPlayerLocations,reason:'測試格式',requestId:randomUUID()}));
 const result=f.service.presence.assign(f.gm,body);assert.equal(result.revision,1);assert.equal(f.service.presence.assign(f.gm,body).replayed,true);assert.equal(f.service.presence.admin(f.gm).history.length,1);
 assert.throws(()=>f.service.presence.assign(f.gm,{...body,clanName:'另一盟'}),e=>e.status===409);assert.throws(()=>f.service.presence.assign(f.gm,{...body,requestId:randomUUID()}),e=>e.status===409);
 f.service.db.exec("CREATE TEMP TRIGGER reject_clan_audit BEFORE INSERT ON location_clan_audit BEGIN SELECT RAISE(ABORT,'test rollback'); END");
 assert.throws(()=>f.assign(f.a,'失敗盟'),/test rollback/);assert.equal(f.service.presence.admin(f.gm).players.find(p=>p.id===f.a.id).clanName,'黑貓盟');assert.equal(f.service.db.prepare("SELECT 1 FROM clans WHERE name='失敗盟'").get(),undefined);
});
test('location settings and GM membership persist through restart and legacy world settings default safely',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'location-policy-')),file=path.join(dir,'game.db'),f=await fixture(t,file);f.assign(f.a,'黑貓盟');f.assign(f.b,'黑貓盟');f.setting(true);f.service.close();
 const restored=new GameService(file,catalog),world=new WorldSettingsService(restored);try{assert.equal(world.state().showPlayerLocations,true);assert.equal(restored.presence.admin(f.gm).history.length,2);assert.equal(maps(restored,f.a).乙,'隱密地圖');const legacy=world.state();delete legacy.showPlayerLocations;restored.db.prepare('UPDATE world_settings SET data=?').run(JSON.stringify(legacy));assert.equal(world.state().showPlayerLocations,false);assert.equal(maps(restored,f.a).乙,'隱密地圖');assert.equal(maps(restored,f.a).丙,null);}finally{restored.close();rmSync(dir,{recursive:true,force:true});}
});
test('online/world/shop HTTP responses enforce viewer identity and GM endpoints require CSRF',async t=>{
 const app=createApp({database:':memory:',catalog,publicOrigin:'',publicAliases:[]});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>new Promise(r=>{app.server.closeAllConnections();app.server.close(r);}));
 const gm=await app.service.register('http_gm',password,{initialGm:true}),other=await app.service.register('http_other',password);seed(app.service,other,'秘密角色');
 const base='http://127.0.0.1:'+app.server.address().port,client=new CloudClient({baseUrl:base}),{user}=await client.register('http_viewer',password),headers={Cookie:client.exportSession().cookie};
 for(const route of ['/api/online?role=gm','/api/world?accountId='+gm.id,'/api/shop']){const r=await fetch(base+route,{headers});assert.equal(r.status,200);assert.doesNotMatch(await r.text(),/隱密地圖|private-map/);}
 let body={accountId:user.id,clanName:'測試盟',reason:'HTTP 名冊測試',requestId:randomUUID(),revision:0};
 assert.equal((await fetch(base+'/api/gm/location-clans',{method:'POST',headers:{...headers,Origin:base,'Content-Type':'application/json','X-CSRF-Token':client.exportSession().csrf},body:JSON.stringify(body)})).status,403);
 const admin=new CloudClient({baseUrl:base});await admin.login(gm.username,password);const auth={Cookie:admin.exportSession().cookie,Origin:base,'Content-Type':'application/json'};
 assert.equal((await fetch(base+'/api/gm/location-clans',{method:'POST',headers:auth,body:JSON.stringify(body)})).status,403);
 auth['X-CSRF-Token']=admin.exportSession().csrf;assert.equal((await fetch(base+'/api/gm/location-clans',{method:'POST',headers:auth,body:JSON.stringify(body)})).status,200);
 body={...body,accountId:other.id,revision:1,requestId:randomUUID()};assert.equal((await fetch(base+'/api/gm/location-clans',{method:'POST',headers:auth,body:JSON.stringify(body)})).status,200);
 assert.match(await (await fetch(base+'/api/online',{headers})).text(),/隱密地圖/);
 await client.logout();await admin.logout();
});
test('GM UI changes location policy and manages memberships with auditable changes',async t=>{
 const f=await fixture(t),dom=new JSDOM('<body><section id="view-world-settings"></section><section id="view-drops"></section>',{runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,errors=[];
 w.eval(readFileSync(new URL('../online/world-admin.js',import.meta.url),'utf8'));w.initWorldAdmin({api:async(route,body)=>route==='/api/gm/location-clans'?f.service.presence.assign(f.gm,body):body?f.world.update(f.gm,body):f.world.admin(f.gm),notify:(m,error)=>{if(error)errors.push(m);}});
 w.document.dispatchEvent(new w.CustomEvent('gm:view-change',{detail:{view:'world-settings'}}));const settle=()=>new Promise(r=>setImmediate(r));await settle();const $=id=>w.document.getElementById(id),submit=id=>$(id).onsubmit({preventDefault(){},submitter:$(id).querySelector('button')});
 assert.equal($('world-locations-visible').checked,false);$('world-locations-visible').checked=true;$('world-presence-reason').value='公開活動';submit('world-presence');await settle();assert.equal(f.world.state().showPlayerLocations,true);assert.match($('world-history').textContent,/玩家位置權限.*向所有玩家公開/);
 assert.equal($('world-siege-kent').checked,true);assert.equal($('world-siege-windwood').checked,true);assert.equal($('world-siege-heine').checked,true);$('world-siege-windwood').checked=false;$('world-siege-reason').value='暫停風木活動';submit('world-siege');await settle();assert.deepEqual(f.world.state().siege,{kent:true,windwood:false,heine:true});assert.match($('world-history').textContent,/攻城管理.*風木：關/);
 $('world-clan-account').value=f.a.id;$('world-clan-account').onchange();$('world-clan-name').value='黑貓盟';$('world-clan-reason').value='盟主核准';submit('world-clan-form');await settle();assert.match($('world-clan-current').textContent,/黑貓盟/);assert.match($('world-clan-history').textContent,/無血盟 → 黑貓盟/);
 $('world-clan-name').value='';submit('world-clan-form');await settle();assert.match($('world-clan-current').textContent,/未加入/);assert.deepEqual(errors,[]);
});
