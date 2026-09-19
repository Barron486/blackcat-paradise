import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {HeadlessGame} from '../cli/engine.mjs';
const {JSDOM}=createRequire(new URL('../cli/package.json',import.meta.url))('jsdom');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function ui(t,{dropFirst=false}={}){
 const dom=new JSDOM('<!doctype html><html><head></head><body><span id="st-class"></span></body></html>',{url:'http://localhost/',runScripts:'outside-only'});t.after(()=>dom.window.close());
 const w=dom.window,requests=[],operations=new Map(),reconciled=[];let drop=dropFirst,adopted=false;w.state={running:true};w.player={cls:'elf',dead:false};
 const state={wallet:{diamonds:3500,renameCards:0,passwordCards:0},characters:[{slot:1,epoch:'epoch-one',name:'角色原名稱',level:1}],products:[{id:'rename_card',name:'更名卡',price:3000},{id:'password_card',name:'更改密碼卡',price:500},{id:'full_status',name:'全狀態',price:300,durationSeconds:3600}],history:[]};
 w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');this.dispatchEvent(new w.Event('close'));};
 w.setInterval=()=>1;
 const cloud=w.CloudStore={ready:true,lease:'test-lease',flush:async()=>{},reconcile:r=>reconciled.push(r),adoptNames:()=>{adopted=true;},request:async(path,body)=>{
  if(path==='/api/shop')return structuredClone(state);
  if(path==='/api/bootstrap')return {values:{}};
  requests.push({path,body});
  if(operations.has(body.requestId))return operations.get(body.requestId);
  if(path==='/api/shop/buy'){
    const product=state.products.find(p=>p.id===body.productId);state.wallet.diamonds-=product.price;
    if(product.id==='full_status'){const c=state.characters.find(c=>c.slot===body.slot);c.fullStatusExpiresAt=Math.max(Date.now(),c.fullStatusExpiresAt||0)+3600000;}else state.wallet[product.id==='rename_card'?'renameCards':'passwordCards']++;
  } else if(path==='/api/shop/rename'){state.wallet.renameCards--;state.characters[0].name=body.name;}
  const result={ok:true,wallet:structuredClone(state.wallet),snapshot:{values:{}},effects:[]};operations.set(body.requestId,result);
  if(drop){drop=false;throw new TypeError('連線中斷');}return result;
 }};
 w.eval(readFileSync(new URL('../online/shop.js',import.meta.url),'utf8'));
 const $=s=>w.document.querySelector(s);
 return {w,cloud,$,requests,operations,state,reconciled,get adopted(){return adopted;}};
}
test('shop presents exact prices and cancellation does not purchase',async t=>{
 const c=ui(t);await c.cloud.showShop();
 assert.equal(c.$('#diamond-balance').textContent,'3,500');
 assert.match(c.$('.diamond-products').textContent,/3,000 藍鑽/);assert.match(c.$('.diamond-products').textContent,/500 藍鑽/);
 c.$('[data-buy="rename_card"]').click();assert.ok(c.$('.diamond-confirm').open);
 c.$('.diamond-confirm [data-cancel]').click();await settle();assert.equal(c.requests.length,0);
 assert.equal(c.$('#diamond-rename button').disabled,true);
});
test('a lost purchase response retries the same transaction and consumes only 3000 diamonds',async t=>{
 const c=ui(t,{dropFirst:true});await c.cloud.showShop();
 for(let i=0;i<2;i++){c.$('[data-buy="rename_card"]').click();c.$('.diamond-confirm [data-confirm]').click();await settle();}
 assert.equal(c.requests.length,2);assert.equal(c.requests[0].body.requestId,c.requests[1].body.requestId);
 assert.equal(c.operations.size,1);assert.equal(c.state.wallet.diamonds,500);assert.equal(c.state.wallet.renameCards,1);
 assert.equal(c.$('[data-buy="rename_card"]').disabled,true);assert.equal(c.$('[data-buy="password_card"]').disabled,false);
});
test('rename card form sends the selected role identity and updates the live name',async t=>{
 const c=ui(t);c.state.wallet.renameCards=1;await c.cloud.showShop();
 c.$('#diamond-rename input').value='黑貓新名稱';c.$('#diamond-rename').dispatchEvent(new c.w.Event('submit',{cancelable:true}));
 c.$('.diamond-confirm [data-confirm]').click();await settle();
 assert.equal(c.requests[0].body.slot,1);assert.equal(c.requests[0].body.epoch,'epoch-one');assert.equal(c.requests[0].body.name,'黑貓新名稱');
 assert.equal(c.adopted,true);assert.equal(c.state.wallet.renameCards,0);assert.equal(c.$('#diamond-rename input').value,'');
});
test('full status shows 300 diamonds, selects the recipient, confirms once and reconciles immediately',async t=>{
 const c=ui(t);c.state.characters.push({slot:2,epoch:'epoch-two',name:'第二角色',level:5});await c.cloud.showShop();
 assert.match(c.$('.diamond-buff-product').textContent,/300 藍鑽.*1 小時/s);
 c.$('#diamond-buff-slot').value='2';c.$('[data-buy="full_status"]').click();assert.match(c.$('.diamond-confirm [data-detail]').textContent,/第二角色/);
 c.$('.diamond-confirm [data-cancel]').click();await settle();assert.equal(c.requests.length,0);
 c.$('[data-buy="full_status"]').click();c.$('.diamond-confirm [data-confirm]').click();await settle();
 assert.equal(c.requests.length,1);assert.equal(c.requests[0].body.slot,2);assert.equal(c.requests[0].body.epoch,'epoch-two');assert.equal(c.requests[0].body.lease,'test-lease');
 assert.equal(c.state.wallet.diamonds,3200);assert.equal(c.state.characters[0].fullStatusExpiresAt,undefined);assert.ok(c.state.characters[1].fullStatusExpiresAt>Date.now());
 assert.equal(c.reconciled.length,1);assert.equal(c.cloud.shopPending,false);assert.equal(c.w.state.running,true);assert.match(c.$('#diamond-buff-status').textContent,/剩餘/);assert.equal(c.$('#diamond-buff-slot').value,'2');
});

test('lost full-status response stays retryable at zero balance, charges once and resumes combat',async t=>{
 const c=ui(t,{dropFirst:true});c.state.wallet.diamonds=300;await c.cloud.showShop();
 c.$('[data-buy="full_status"]').click();c.$('.diamond-confirm [data-confirm]').click();await settle();
 assert.equal(c.state.wallet.diamonds,0);assert.equal(c.cloud.shopPending,true);assert.equal(c.w.state.running,false);assert.equal(c.$('[data-buff-retry]').hidden,false);
 await c.cloud.showShop();assert.equal(c.$('[data-buy="full_status"]').disabled,true);assert.equal(c.$('[data-buff-retry]').disabled,false);
 c.$('[data-buff-retry]').click();await settle();assert.equal(c.requests.length,2);assert.equal(c.requests[0].body.requestId,c.requests[1].body.requestId);
 assert.equal(c.operations.size,1);assert.equal(c.reconciled.length,1);assert.equal(c.state.wallet.diamonds,0);assert.equal(c.state.wallet.passwordCards,0);
 assert.equal(c.w.state.running,true);assert.equal(c.cloud.shopPending,false);assert.equal(c.$('[data-buff-retry]').hidden,true);
});

test('full status cannot be bought without a character or with fewer than 300 diamonds',async t=>{
 const c=ui(t);c.state.wallet.diamonds=299;await c.cloud.showShop();assert.equal(c.$('[data-buy="full_status"]').disabled,true);
 c.state.wallet.diamonds=300;c.state.characters=[];await c.cloud.showShop();assert.equal(c.$('[data-buy="full_status"]').disabled,true);assert.match(c.$('#diamond-buff-status').textContent,/請先建立角色/);
});

test('online upstream entry points cannot import a save or rename for free',async t=>{
 const game=new HeadlessGame();t.after(()=>game.close());game.create({classId:'elf',name:'雲端角色',allocation:{dex:8}});
 let opens=0,exports=0;game.window.CloudStore={showShop:()=>opens++,exportCharacterReport:async()=>exports++};
 assert.throws(()=>game.run('importSave(1)'),/不開放存檔匯入/);
 game.run('startEditName();confirmEditName();');assert.equal(opens,2);assert.equal(game.status().name,'雲端角色');
 await game.run('exportSave(1)');assert.equal(exports,1);
});
