import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {GameService} from '../server/service.mjs';
import {CommerceService} from '../server/commerce.mjs';
import {MarketService,marketFee} from '../server/market.mjs';
import {applyEffect} from '../shared/gm-effects.js';
import {createApp} from '../server/index.mjs';
import {CloudClient} from '../cli/cloud-client.mjs';
const catalog={version:'test',skills:{},items:{sword:{n:'測試劍',type:'wpn'},potion:{n:'紅水',type:'consumable'},rare:{n:'唯一物品',maxHold:1},quest:{n:'任務',type:'quest'}},wrap:JSON.stringify,unwrap:JSON.parse};
const key='lineage_idle_save_1',password='market-test-2026!';
async function fixture(t,filename=':memory:'){
 const service=new GameService(filename,catalog),commerce=new CommerceService(service),market=new MarketService(service,commerce);
 t.after(()=>{try{service.close();}catch{}});
 const users=[];
 for(const [i,username]of ['seller','buyer','other'].entries()){
  const user=await service.register(username,password,{initialGm:i===0}),lease=randomUUID();
  const doc={p:{cls:'elf',name:username,lv:1,exp:0,gold:1000,_roleEpoch:randomUUID(),inv:[{id:'sword',uid:randomUUID(),cnt:1,en:7,bless:true,gw:['str1','hp60'],lock:false},{id:'potion',uid:randomUUID(),cnt:20}],eq:{}},ticks:0};
  service.acquireLease(user,lease);service.sync(user,lease,0,{[key]:JSON.stringify(doc)});users.push({...user,lease,doc});
 }
 const args=user=>({lease:user.lease,slot:1,epoch:user.doc.p._roleEpoch,revision:service.bootstrap(user).revision,requestId:randomUUID()});
 const get=user=>JSON.parse(service.bootstrap(user).values[key]).p;
 const list=(currency='diamonds',price=101,quantity=1)=>market.transact(users[0],'list',{...args(users[0]),uid:users[0].doc.p.inv[0].uid,currency,price,quantity});
 return {service,commerce,market,seller:users[0],buyer:users[1],other:users[2],args,get,list};
}
test('server escrows exact equipment, charges 20%, credits the shared diamond wallet and replays once',async t=>{
 const {service,commerce,market,seller,buyer,args,get,list}=await fixture(t);
 commerce.grant(seller,{accountId:buyer.id,amount:1000,reason:'測試儲值',requestId:randomUUID()});
 const before=structuredClone(get(seller)),listing=list(),request={...args(buyer),listingId:listing.listingId};
 assert.equal(get(seller).inv.length,1);
 const purchase=market.transact(buyer,'buy',request);assert.equal(purchase.fee,21);
 assert.equal(market.transact(buyer,'buy',request).replayed,true);
 assert.equal(commerce.wallet(buyer.id).diamonds,899);assert.equal(commerce.wallet(seller.id).diamonds,80);
 const delivered=get(buyer).inv.at(-1);assert.deepEqual(delivered.gw,before.inv[0].gw);assert.equal(delivered.en,7);assert.equal(delivered.bless,true);assert.equal(delivered.lock,true);
 assert.notEqual(delivered.uid,before.inv[0].uid);assert.equal(service.db.prepare("SELECT SUM(fee) n FROM market_events WHERE kind='buy'").get().n,21);
 assert.equal(get(buyer)._gmSeq,undefined);assert.ok(get(buyer)._marketSeq>0);
 assert.throws(()=>market.transact(buyer,'buy',{...request,listingId:'different'}),e=>e.status===409);
});
test('gold trades settle while seller is offline and proceeds can only be claimed once',async t=>{
 const {service,market,seller,buyer,args,get,list}=await fixture(t),listing=list('gold',500);
 service.db.prepare('DELETE FROM leases WHERE account_id=?').run(seller.id);
 market.transact(buyer,'buy',{...args(buyer),listingId:listing.listingId});
 assert.equal(get(buyer).gold,500);assert.equal(get(seller).gold,1000);assert.equal(market.gold(seller.id),400);
 service.acquireLease(seller,seller.lease);const request=args(seller);
 market.transact(seller,'claim-gold',request);market.transact(seller,'claim-gold',request);
 assert.equal(get(seller).gold,1400);assert.equal(market.gold(seller.id),0);
 assert.throws(()=>market.transact(seller,'claim-gold',args(seller)),e=>e.status===409);
});
test('stale saves cannot resurrect escrow; market effects preserve earned experience and are idempotent',async t=>{
 const {service,market,seller,args,get,list}=await fixture(t),before=service.bootstrap(seller),local=JSON.parse(before.values[key]);
 local.p.exp=42;local.p.gold+=19;const result=list('gold');
 assert.throws(()=>service.sync(seller,seller.lease,before.revision,{[key]:JSON.stringify(local)}),e=>e.status===409&&e.details.effects.length===1);
 assert.throws(()=>service.sync(seller,seller.lease,result.snapshot.revision,{[key]:JSON.stringify(local)}),e=>e.status===409&&e.details.effects.length===1);
 for(const e of result.effects)assert.equal(applyEffect(local,e),true);
 for(const e of result.effects)assert.equal(applyEffect(local,e),false);
 assert.equal(local.p.exp,42);assert.equal(local.p.gold,1019);assert.equal(local.p.inv.length,1);
 service.sync(seller,seller.lease,result.snapshot.revision,{[key]:JSON.stringify(local)});assert.equal(get(seller).exp,42);
 const forged=structuredClone(local);forged.p._marketSeq=99999;
 assert.throws(()=>service.sync(seller,seller.lease,args(seller).revision,{[key]:JSON.stringify(forged)}),e=>e.status===409);
});
test('only one buyer can complete a listing; failed purchases and cancellations roll back',async t=>{
 const {market,commerce,seller,buyer,other,args,get,list}=await fixture(t),listing=list('gold',200);
 assert.throws(()=>market.transact(seller,'buy',{...args(seller),listingId:listing.listingId}),e=>e.status===409);
 assert.throws(()=>market.transact(buyer,'cancel',{...args(buyer),listingId:listing.listingId}),e=>e.status===403);
 const results=await Promise.allSettled([buyer,other].map(async u=>market.transact(u,'buy',{...args(u),listingId:listing.listingId})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(get(buyer).gold+get(other).gold,1800);
 assert.equal(market.gold(seller.id),160);assert.equal(commerce.wallet(seller.id).diamonds,0);
});
test('partial stacks, cancellation and exact integer validations',async t=>{
 const {service,market,seller,args,get}=await fixture(t);
 const b={...args(seller),uid:seller.doc.p.inv[1].uid,currency:'gold',price:100,quantity:7};
 for(const price of [0,-1,0.5,Infinity,'100',2e9+1])assert.throws(()=>market.transact(seller,'list',{...b,price}));
 for(const quantity of [0,-1,21,1.5])assert.throws(()=>market.transact(seller,'list',{...b,quantity}));
 const listing=market.transact(seller,'list',b);assert.equal(get(seller).inv[1].cnt,13);
 const cancel={...args(seller),listingId:listing.listingId};market.transact(seller,'cancel',cancel);market.transact(seller,'cancel',cancel);
 assert.equal(get(seller).inv.filter(i=>i.id==='potion').reduce((n,i)=>n+i.cnt,0),20);
 assert.equal(get(seller).gold,1000);assert.equal(marketFee(5),1);assert.equal(marketFee(1),1);
});
test('new characters cannot forge market acknowledgments and deleted sellers can recover to a new character',async t=>{
 const {service,market,seller,args,get,list}=await fixture(t),listing=list('gold');
 const next=structuredClone(seller.doc);next.p._roleEpoch=randomUUID();next.p._marketSeq=999999;
 assert.throws(()=>service.sync(seller,seller.lease,args(seller).revision,{lineage_idle_save_2:JSON.stringify(next)}),e=>e.status===403);
 service.sync(seller,seller.lease,args(seller).revision,{[key]:null});
 delete next.p._marketSeq;next.p.inv=[];service.sync(seller,seller.lease,args(seller).revision,{[key]:JSON.stringify(next)});
 market.transact(seller,'cancel',{...args(seller),epoch:next.p._roleEpoch,listingId:listing.listingId});
 assert.equal(get(seller).inv.length,1);assert.equal(get(seller).inv[0].id,'sword');assert.equal(get(seller).inv[0].lock,true);
});
test('hold limits and stale transaction sequences roll back escrow and debit',async t=>{
 const {service,market,seller,buyer,args,get}=await fixture(t);
 const set=(u,fn)=>{const snapshot=service.bootstrap(u),doc=JSON.parse(snapshot.values[key]);fn(doc.p);service.sync(u,u.lease,snapshot.revision,{[key]:JSON.stringify(doc)});};
 set(seller,p=>p.inv.push({id:'rare',uid:'rare-one',cnt:1}));set(buyer,p=>p.inv.push({id:'rare',uid:'rare-two',cnt:1}));
 const listing=market.transact(seller,'list',{...args(seller),uid:'rare-one',quantity:1,currency:'gold',price:50});
 assert.throws(()=>market.transact(buyer,'buy',{...args(buyer),listingId:listing.listingId}),e=>e.status===409);
 assert.equal(get(buyer).gold,1000);assert.equal(market.view(seller).mine[0].status,'active');
});
test('locked, equipped, quest items, insufficient balance, stale revision and wrong lease are rejected',async t=>{
 const {service,market,seller,buyer,args,get,list}=await fixture(t);
 const listing=list('diamonds',50),request={...args(buyer),listingId:listing.listingId};
 assert.throws(()=>market.transact(buyer,'buy',request),e=>e.status===409);
 assert.equal(get(buyer).inv.length,2);assert.equal(market.view(seller).mine[0].status,'active');
 assert.throws(()=>market.transact(buyer,'buy',{...request,revision:0}),e=>e.status===409);
 assert.throws(()=>market.transact(buyer,'buy',{...request,lease:randomUUID()}),e=>e.status===423);
 assert.equal(market.tradable({eq:{}},{id:'quest',uid:'q',cnt:1}),false);
 assert.equal(market.tradable({eq:{}},{id:'sword',uid:'q',cnt:1,lock:true}),false);
 assert.equal(market.tradable({eq:{wpn:{uid:'q'}}},{id:'sword',uid:'q',cnt:1}),false);
});
test('listings, receipts and gold proceeds survive a database restart',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'blackcat-market-')),filename=path.join(dir,'game.sqlite');
 const f=await fixture(t,filename),listing=f.list('gold',100),request={...f.args(f.buyer),listingId:listing.listingId};f.market.transact(f.buyer,'buy',request);f.service.close();
 const service=new GameService(filename,catalog),commerce=new CommerceService(service),market=new MarketService(service,commerce);
 t.after(()=>{service.close();rmSync(dir,{recursive:true,force:true});});
 assert.equal(market.gold(f.seller.id),80);assert.equal(market.transact(f.buyer,'buy',request).replayed,true);assert.equal(market.view(f.seller).mine[0].status,'sold');
});
test('market HTTP endpoints require authentication and CSRF, and expose only safe listing fields',async t=>{
 const {server,service}=createApp({database:':memory:',catalog,publicOrigin:'',publicAliases:[]});
 server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const url=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(url+'/api/market')).status,401);
 await service.register('http_market',password,{initialGm:true});
 const login=await fetch(url+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:url},body:JSON.stringify({username:'http_market',password})});
 const cookie=login.headers.get('set-cookie').split(';')[0];
 assert.equal((await fetch(url+'/api/market/list',{method:'POST',headers:{'Content-Type':'application/json',Origin:url,Cookie:cookie},body:'{}'})).status,403);
 const response=await fetch(url+'/api/market',{headers:{Cookie:cookie}});assert.equal(response.status,200);assert.deepEqual((await response.json()).offers,[]);
});
