import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {GameService} from '../server/service.mjs';
import {CommerceService} from '../server/commerce.mjs';
import {createApp} from '../server/index.mjs';
import {CloudClient} from '../cli/cloud-client.mjs';
import {HeadlessGame} from '../cli/engine.mjs';
const {JSDOM}=createRequire(new URL('../cli/package.json',import.meta.url))('jsdom');
const source=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
const settle=()=>new Promise(r=>setImmediate(r));
const password='character-social-test-2026!',key='lineage_idle_save_1';
const catalog={version:'test',wrap:JSON.stringify,unwrap:JSON.parse,skills:{},items:{sword:{n:'測試劍',d:'測試武器',type:'wpn'},'PRIVATE-BAG':{n:'私人背包物品',type:'item'}},world:{maps:[{id:'training',name:'新兵修練場'}],drops:[],monsters:[]}};
const character=name=>({p:{cls:'elf',name,lv:1,hp:160,mhp:300,mp:60,mmp:90,alignmentValue:12345,eq:{wpn:{id:'sword',uid:'PRIVATE-UID',en:7,bless:true},shield:null},inv:[{id:'PRIVATE-BAG',cnt:99}],gold:1000,_roleEpoch:randomUUID()},ms:{current:'training'}});
function seed(service,user,doc=character('角色甲')){const lease=randomUUID();service.acquireLease(user,lease);service.sync(user,lease,0,{[key]:JSON.stringify(doc)},{slot:1});doc.p.lv=37;doc.p.gold=888888;service.db.prepare('UPDATE saves SET data=? WHERE account_id=?').run(JSON.stringify({[key]:JSON.stringify(doc)}),user.id);return {lease,doc};}
async function fixture(t,filename=':memory:'){
 const service=new GameService(filename,catalog),shop=new CommerceService(service);t.after(()=>{try{service.close();}catch{}});
 const gm=await service.register('private_keeper',password,{initialGm:true}),viewer=await service.register('private_viewer',password),target=await service.register('private_target',password);
 seed(service,viewer,character('查看者'));const seeded=seed(service,target);
 const credit=amount=>shop.grant(gm,{accountId:viewer.id,amount,reason:'測試卡片',requestId:randomUUID()});
 const request=()=>({productId:'spy_card',targetId:shop.state(viewer).spyTargets[0].id,requestId:randomUUID()});
 return {service,shop,gm,viewer,target,credit,request,...seeded};
}
test('chat snapshots the selected role ID, never exposes account names, and falls back safely for legacy messages',async t=>{
 const f=await fixture(t);const second=character('角色乙');f.service.sync(f.target,f.lease,1,{lineage_idle_save_2:JSON.stringify(second)},{slot:2});
 f.service.chat(f.target,'使用第二角色發言');let message=f.service.publicMessages()[0];assert.equal(message.displayName,'角色乙');assert.equal(Object.hasOwn(message,'username'),false);
 assert.equal(f.service.messages()[0].username,f.target.username,'private moderation keeps account identity');
 f.service.sync(f.target,f.lease,2,{}, {slot:1});assert.equal(f.service.publicMessages()[0].displayName,'角色乙','old messages retain the name at send time');
 f.service.db.prepare('INSERT INTO chat(account_id,text,created_at) VALUES(?,?,?)').run(f.target.id,'舊訊息',Date.now()+1);assert.equal(f.service.publicMessages().at(-1).displayName,'角色甲');
 assert.doesNotMatch(JSON.stringify(f.service.onlineSummary()),/private_target|accountId|PRIVATE|12345|888888/);
 f.service.acquireLease(f.gm,randomUUID());assert.ok(f.service.onlineSummary().list.some(p=>p.name==='角色選擇中'&&p.id===null));
});
test('spy costs exactly 300, reveals only requested game stats and equipment, and repeats the same snapshot without charging again',async t=>{
 const f=await fixture(t);f.credit(600);const request={...f.request(),price:0,accountId:f.target.id};
 const result=f.shop.buy(f.viewer,request);assert.equal(result.wallet.diamonds,300);assert.equal(result.report.name,'角色甲');assert.equal(result.report.level,37);assert.equal(result.report.hp,160);assert.equal(result.report.maxHp,300);assert.equal(result.report.mp,60);assert.equal(result.report.maxMp,90);assert.equal(result.report.alignment,12345);assert.equal(result.report.map,'新兵修練場');
 assert.equal(result.report.equipment.find(e=>e.slot==='wpn').item.name,'祝福的 +7 測試劍');assert.equal(result.report.equipment.find(e=>e.slot==='shield').item,null);
 assert.doesNotMatch(JSON.stringify(result.report),/private_target|PRIVATE|accountId|_roleEpoch|inventory|gold|password|csrf/);
 f.doc.p.hp=20;f.service.sync(f.target,f.lease,1,{[key]:JSON.stringify(f.doc)},{slot:1});const again=f.shop.buy(f.viewer,request);assert.equal(again.replayed,true);assert.equal(again.report.hp,160);assert.equal(again.wallet.diamonds,300);
 const newer=f.shop.buy(f.viewer,{...request,requestId:randomUUID()});assert.equal(newer.report.hp,20);assert.equal(newer.wallet.diamonds,0);assert.equal(f.shop.wallet(f.target.id).diamonds,0);assert.equal(f.shop.history(f.viewer.id).filter(r=>r.kind==='spy').length,2);
 assert.deepEqual([result.wallet.renameCards,result.wallet.passwordCards],[0,0]);
});
test('offline, own, changed roles, insufficient funds and failed writes never consume diamonds',async t=>{
 const f=await fixture(t),request=f.request();f.credit(299);assert.throws(()=>f.shop.buy(f.viewer,request),/藍鑽不足/);assert.equal(f.shop.wallet(f.viewer.id).diamonds,299);f.credit(301);
 const own=f.service.onlineSummary().list.find(p=>p.name==='查看者').id;assert.throws(()=>f.shop.buy(f.viewer,{...request,targetId:own}),/無法查看/);
 f.service.db.prepare('UPDATE leases SET expires_at=0 WHERE account_id=?').run(f.target.id);assert.throws(()=>f.shop.buy(f.viewer,request),/已離線/);assert.equal(f.shop.wallet(f.viewer.id).diamonds,600);
 f.service.acquireLease(f.target,f.lease);f.service.sync(f.target,f.lease,1,{lineage_idle_save_2:JSON.stringify(character('別的角色'))},{slot:2});assert.throws(()=>f.shop.buy(f.viewer,request),/切換角色/);assert.equal(f.shop.wallet(f.viewer.id).diamonds,600);
 const current=f.request();f.service.db.exec("CREATE TEMP TRIGGER reject_spy BEFORE INSERT ON wallet_ledger WHEN NEW.kind='spy' BEGIN SELECT RAISE(ABORT,'fixture reject'); END");assert.throws(()=>f.shop.buy(f.viewer,current),/fixture reject/);assert.equal(f.shop.wallet(f.viewer.id).diamonds,600);assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM commerce_operations WHERE request_id=?').get(current.requestId).n,0);
});
test('paid reports remain retryable after restart or target logout, with current wallet balance',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'spy-card-')),filename=path.join(dir,'game.db'),f=await fixture(t,filename);f.credit(300);const request=f.request(),first=f.shop.buy(f.viewer,request);f.service.close();
 const restored=new GameService(filename,catalog),shop=new CommerceService(restored);try{restored.db.prepare('UPDATE leases SET expires_at=0').run();shop.grant(f.gm,{accountId:f.viewer.id,amount:500,reason:'後續儲值',requestId:randomUUID()});const result=shop.buy(f.viewer,request);assert.deepEqual(result.report,first.report);assert.equal(result.replayed,true);assert.equal(result.wallet.diamonds,500);}finally{restored.close();rmSync(dir,{recursive:true,force:true});}
});
test('authenticated paid inspection checks CSRF and online lists do not reveal the report for free',async t=>{
 const app=createApp({database:':memory:',catalog,publicOrigin:'',publicAliases:[]});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>new Promise(r=>app.server.close(r)));
 const gm=await app.service.register('http_keeper',password,{initialGm:true}),target=await app.service.register('http_target',password);seed(app.service,target);
 const base='http://127.0.0.1:'+app.server.address().port,client=new CloudClient({baseUrl:base}),{user}=await client.register('http_viewer',password);app.commerce.grant(gm,{accountId:user.id,amount:300,reason:'測試儲值',requestId:randomUUID()});
 const online=await (await fetch(base+'/api/online',{headers:{Cookie:client.exportSession().cookie}})).json();assert.deepEqual(Object.keys(online.list[0]).sort(),['id','map','name']);
 const body={productId:'spy_card',targetId:online.list[0].id,requestId:randomUUID()},headers={Cookie:client.exportSession().cookie,Origin:base,'Content-Type':'application/json'};
 assert.equal((await fetch(base+'/api/shop/buy',{method:'POST',headers,body:JSON.stringify(body)})).status,403);assert.equal((await fetch(base+'/api/shop/buy',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)})).status,401);
 const response=await fetch(base+'/api/shop/buy',{method:'POST',headers:{...headers,'X-CSRF-Token':client.exportSession().csrf},body:JSON.stringify(body)});assert.equal(response.status,200);const result=await response.json();assert.equal(result.report.name,'角色甲');assert.equal(result.wallet.diamonds,0);await client.logout();
});
test('clickable NPC identity retains thank, taunt and private interactions after moving into unified chat',t=>{
 const g=new HeadlessGame();t.after(()=>g.close());g.create({classId:'elf',name:'互動旅人',allocation:{dex:8}});
 const id=g.run('_wcSpawnNpc()'),markup=g.run('_wcNameHtml(__args)',id);assert.match(markup,/<button/);assert.match(markup,/data-wc-npc-id/);
 const npc=g.window.document.getElementById('syslog-panel'),chat=g.window.document.createElement('section');chat.id='cloud-chat';g.window.document.body.append(chat);chat.append(npc);
 g.run('worldChannelNpcMenu(__args)',id);const menu=g.window.document.getElementById('world-channel-npc-menu');assert.equal(menu.parentElement,g.window.document.body);assert.match(menu.textContent,/嘲諷.*感謝.*私訊/);
 g.run('worldChannelThank(__args)',id);assert.equal(g.window.document.getElementById('world-channel-npc-menu'),null);assert.equal(g.run('_wcNpcs[__args].thanked',id),true);assert.ok(g.window.document.getElementById('world-log').children.length>=2);
 g.run('worldChannelNpcMenu(__args);worldChannelPrivateChat(__args);',id);assert.ok(g.window.document.getElementById('world-channel-private-dialog'));g.run('worldChannelPrivateClose()');assert.equal(g.window.document.getElementById('world-channel-private-overlay'),null);
});
