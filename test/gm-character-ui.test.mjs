import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){
 const dom=new JSDOM('<!doctype html><body></body>',{url:'http://localhost/gm',runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window;
 w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');this.dispatchEvent(new w.Event('close'));};
 const report={account:{username:'player',online:false,activeSlot:1,clanName:''},snapshot:{p:{name:'<img src=x onerror=alert(1)>',cls:'elf',lv:38,exp:12,hp:80,mhp:100,mp:20,mmp:30,gold:123,base:{dex:18},alloc:{dex:2},panacea:{dex:1},d:{dex:30,ac:-100},eq:{wpn:{id:'sword',uid:'equipped',cnt:1,en:7}},inv:Array.from({length:52},(_,i)=>({id:'potion',uid:'uid-'+i,cnt:2})),skills:['skill'],config:{potion:55}},ms:{current:'town'}},shared:{lineage_idle_warehouse:{items:[{id:'sword',uid:'stored',cnt:1}],gold:99}},warehouseKey:'lineage_idle_warehouse',itemCatalog:{sword:{name:'測試劍',maxEnchant:15},potion:{name:'紅色藥水',maxEnchant:0}},skills:{skill:'治癒術'},wallet:{diamonds:300},checks:{issueCount:1,issues:[{code:'duplicate_item',path:'p.inv[0].uid',message:'重複識別碼'}],notice:'需查核，不代表作弊'},history:{security:[{code:'SERVER_AUTHORITY_REQUIRED',slotKey:'all',at:1}],commands:[],ledger:[],market:[]},slot:1,revision:7,savedAt:1,checkedAt:2,serverAuthoritative:true};
 const requests=[];let responder=async()=>structuredClone(report);
 w.eval(readFileSync(new URL('../online/character-admin.js',import.meta.url),'utf8'));w.initCharacterAdmin({api:async url=>{requests.push(url);return responder(url);},notify:()=>{}});
 const player={id:'account-id',characters:[{slot:1,name:'角色甲'},{slot:2,name:'角色乙'}]},$=q=>w.document.querySelector(q);
 return {w,report,player,$,requests,setResponder:fn=>responder=fn};
}
test('GM character viewer renders stats safely, filters and paginates possessions and exposes scoped history',async t=>{
 const f=fixture(t);f.w.openGmCharacter(f.player,1);await settle();assert.match(f.requests[0],/accountId=account-id&slot=1/);assert.match(f.$('[data-content]').textContent,/敏捷.*18.*2.*1.*30/);assert.equal(f.$('[data-content] img'),null);
 f.$('[data-character-tab=items]').click();assert.equal(f.$('.character-items').children.length,50);
 const next=[...f.w.document.querySelectorAll('.character-pagination button')].find(b=>b.textContent==='下一頁');next.click();assert.equal(f.$('.character-items').children.length,4);
 const search=f.$('[aria-label="搜尋角色物品"]');search.value='stored';search.dispatchEvent(new f.w.Event('input'));assert.equal(f.$('.character-items').children.length,1);assert.match(f.$('.character-items').textContent,/共用倉庫.*stored/);
 f.$('[data-character-tab=audit]').click();assert.match(f.$('[data-content]').textContent,/1 項待查核.*重複識別碼.*拒絕本機存檔上傳/s);
 f.$('[data-character-tab=raw]').click();assert.equal(f.$('[data-content] textarea'),null);assert.match(f.$('[data-content]').textContent,/無法匯入/);
});
test('switching role discards slow stale responses and refresh failures do not retain another role report',async t=>{
 const f=fixture(t);let resolveOld;f.setResponder(()=>new Promise(resolve=>resolveOld=resolve));f.w.openGmCharacter(f.player,1);
 f.setResponder(async()=>({...structuredClone(f.report),slot:2,snapshot:{p:{...f.report.snapshot.p,name:'角色乙'}}}));const select=f.$('[data-slot]');select.value='2';select.dispatchEvent(new f.w.Event('change'));await settle();
 resolveOld(f.report);await settle();assert.match(f.$('[data-message]').textContent,/角色乙/);assert.doesNotMatch(f.$('[data-message]').textContent,/<img/);
 f.setResponder(async()=>{throw new Error('GM 權限已取消');});f.$('[data-refresh]').click();await settle();assert.equal(f.$('[data-content]').textContent,'');assert.equal(f.$('[data-export]').disabled,true);assert.match(f.$('[data-message]').textContent,/GM 權限已取消/);
});
test('export contains the inspected snapshot and performs no server mutation',async t=>{
 const f=fixture(t);let exported,download;
 f.w.Blob=class{constructor(parts){exported=JSON.parse(parts.join(''));}};f.w.URL.createObjectURL=()=> 'blob:test-report';f.w.URL.revokeObjectURL=()=>{};
 f.w.HTMLAnchorElement.prototype.click=function(){download=this.download;};
 f.w.openGmCharacter(f.player,1);await settle();f.$('[data-export]').click();
 assert.equal(exported.snapshot.p.d.dex,30);assert.equal(exported.slot,1);assert.match(download,/gm-character-player-slot1/);assert.equal(f.requests.length,1);
});
