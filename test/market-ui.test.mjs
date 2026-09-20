import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {HeadlessGame} from '../cli/engine.mjs';
const {JSDOM}=createRequire(new URL('../cli/package.json',import.meta.url))('jsdom');
const settle=()=>new Promise(r=>setImmediate(r));
function ui(t,{dropFirst=false,failFlush=false,refreshFail=false,conflicts=0,rejectListing=false}={}){
 const dom=new JSDOM('<html><head></head><body><div id="game-screen"></div></body></html>',{url:'http://localhost/',runScripts:'outside-only'});t.after(()=>dom.window.close());
 const w=dom.window;w.setInterval=()=>1;w.player={cls:'elf',_roleEpoch:'test-epoch'};w.currentSlot=1;w.state={running:true};
 w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
 const transactions=[],receipts=new Map();let drop=dropFirst,reconciled=0,failRefresh=false;
 const info={offers:[{id:'offer-one',item:{id:'sword',uid:'escrow',cnt:1,en:7},name:'測試劍',description:'能力',seller:'玩家',currency:'diamonds',price:100,fee:20,net:80,status:'active'}],mine:[],total:1,wallet:{diamonds:1000},goldProceeds:0,characters:[{slot:1,epoch:'test-epoch',name:'買家',gold:1000,items:[{item:{id:'potion',uid:'own-potion',cnt:10},name:'紅水'}]}]};
 const cloud=w.CloudStore={lease:'test-lease',revision:1,flush:async()=>{if(failFlush)throw new Error('請先完成雲端同步');},reconcile:r=>{reconciled++;if(r.snapshot?.revision)cloud.revision=r.snapshot.revision;},request:async(path,body)=>{
  if(path==='/api/shop')return {wallet:info.wallet};
  if(path.startsWith('/api/market?')){if(failRefresh)throw new Error('讀取失敗');return structuredClone(info);}
  assert.equal(w.state.running,false);assert.equal(cloud.marketPending,true);transactions.push({path,body:structuredClone(body)});
  if(receipts.has(body.requestId))return receipts.get(body.requestId);
  if(conflicts-->0)throw Object.assign(new Error('角色資料已更新，請再試一次'),{status:409,data:{code:'market_revision_conflict',snapshot:{revision:cloud.revision+1,values:{}}}});
  if(rejectListing)throw Object.assign(new Error('物品已鎖定，請先解鎖'),{status:409});
  const listing=path==='/api/market/list';
  if(listing){info.mine=[{...info.offers[0],own:true,item:{...info.characters[0].items[0].item,cnt:body.quantity},name:'紅水',currency:body.currency,price:body.price}];info.characters[0].items[0].item.cnt-=body.quantity;}
  else {info.wallet.diamonds-=100;info.offers=[];info.total=0;}
  const result={ok:true,message:listing?'已上架，物品由交易所保管':'購買成功',wallet:info.wallet,snapshot:{values:{}},effects:[]};receipts.set(body.requestId,result);
  if(drop){drop=false;throw new Error('連線中斷');}if(refreshFail)failRefresh=true;return result;
 }};
 w.eval(readFileSync(new URL('../online/market.js',import.meta.url),'utf8'));
 return {w,cloud,$:q=>w.document.querySelector(q),info,transactions,receipts,get reconciled(){return reconciled;}};
}
test('market review can be cancelled and shows the two currencies and fee',async t=>{
 const c=ui(t);c.cloud.showMarket();await settle();
 assert.match(c.$('.market-policy').textContent,/20%/);assert.equal(c.$('.market-wallet').textContent.includes('1,000'),true);
 c.$('.market-offers button').click();assert.equal(c.$('.market-review').hidden,false);assert.equal(c.transactions.length,0);
 c.$('[data-cancel-review]').click();assert.equal(c.$('.market-review').hidden,true);assert.equal(c.transactions.length,0);assert.equal(c.w.state.running,true);
 assert.deepEqual([...c.$('.market-sell select[name=currency]').options].map(o=>o.text),['藍鑽','金幣']);
});

async function reviewListing(c){
 c.cloud.showMarket();await settle();c.$('[data-tab=sell]').click();await settle();
 c.$('.market-sell select[name=uid]').value='own-potion';c.$('.market-sell input[name=quantity]').value='2';c.$('.market-sell input[name=price]').value='100';
 c.$('.market-sell button[type=submit]').click();
}

test('listing review replaces the form, preserves edits on return and success shows the escrowed item',async t=>{
 const c=ui(t);await reviewListing(c);
 assert.equal(c.$('.market-review').hidden,false);assert.equal(c.$('[data-pane=sell]').hidden,true);
 assert.match(c.$('.market-review p').textContent,/紅水.*出售 2 件.*100 藍鑽.*80 藍鑽/);
 assert.equal(c.w.document.activeElement,c.$('[data-confirm]'));assert.equal(c.transactions.length,0);
 c.$('[data-cancel-review]').click();assert.equal(c.$('[data-pane=sell]').hidden,false);assert.equal(c.$('.market-sell input[name=price]').value,'100');
 c.$('.market-sell button[type=submit]').click();c.$('[data-confirm]').click();await settle();
 assert.equal(c.transactions.length,1);assert.equal(c.transactions[0].body.quantity,2);
 assert.equal(c.$('[data-pane=mine]').hidden,false);assert.match(c.$('.market-mine').textContent,/紅水 × 2/);
 assert.match(c.$('.market-notice').textContent,/已上架/);assert.equal(c.info.characters[0].items[0].item.cnt,8);
});

test('revision conflicts retry the same listing receipt with the new snapshot and lost responses cannot list twice',async t=>{
 const c=ui(t,{conflicts:1,dropFirst:true});await reviewListing(c);c.$('[data-confirm]').click();await settle();
 assert.equal(c.transactions.length,2);assert.equal(c.transactions[0].body.revision,1);assert.equal(c.transactions[1].body.revision,2);
 assert.equal(c.cloud.marketPending,true);c.$('[data-retry]').click();await settle();
 assert.equal(c.transactions.length,3);assert.equal(new Set(c.transactions.map(r=>r.body.requestId)).size,1);
 assert.equal(c.receipts.size,1);assert.equal(c.info.characters[0].items[0].item.cnt,8);assert.equal(c.$('[data-pane=mine]').hidden,false);
});

test('listing errors restore the filled form, remain visible and never retry item-validation failures',async t=>{
 const c=ui(t,{rejectListing:true});await reviewListing(c);c.$('[data-confirm]').click();await settle();
 assert.equal(c.transactions.length,1);assert.equal(c.receipts.size,0);assert.equal(c.cloud.marketPending,false);
 assert.equal(c.$('[data-pane=sell]').hidden,false);assert.equal(c.$('.market-sell input[name=price]').value,'100');
 assert.match(c.$('.market-notice').textContent,/已鎖定/);assert.equal(c.$('.market-notice').classList.contains('error'),true);
});

test('a committed listing remains visibly successful when the subsequent catalog refresh fails',async t=>{
 const c=ui(t,{refreshFail:true});await reviewListing(c);c.$('[data-confirm]').click();await settle();
 assert.match(c.$('.market-notice').textContent,/已上架.*清單更新失敗/);
 assert.equal(c.transactions.length,1);assert.equal(c.cloud.marketPending,false);assert.equal(c.$('[data-pane=mine]').hidden,false);
});
test('successful UI purchase pauses combat only during commit and applies authoritative effects',async t=>{
 const c=ui(t);c.cloud.showMarket();await settle();c.$('.market-offers button').click();c.$('[data-confirm]').click();await settle();
 assert.equal(c.transactions.length,1);assert.equal(c.transactions[0].body.epoch,'test-epoch');assert.equal(c.reconciled,1);
 assert.equal(c.w.state.running,true);assert.equal(c.cloud.marketPending,false);assert.equal(c.info.wallet.diamonds,900);
 assert.equal(c.$('.market-notice').textContent,'購買成功');
});
test('uncertain response keeps combat paused and retries the same receipt without charging twice',async t=>{
 const c=ui(t,{dropFirst:true});c.cloud.showMarket();await settle();c.$('.market-offers button').click();c.$('[data-confirm]').click();await settle();
 assert.equal(c.w.state.running,false);assert.equal(c.cloud.marketPending,true);assert.equal(c.$('[data-close]').disabled,true);
 const escape=new c.w.Event('cancel',{cancelable:true});c.$('#player-market').dispatchEvent(escape);assert.equal(escape.defaultPrevented,true);
 c.$('[data-retry]').click();await settle();assert.equal(c.transactions.length,2);assert.equal(c.transactions[0].body.requestId,c.transactions[1].body.requestId);
 assert.equal(c.receipts.size,1);assert.equal(c.info.wallet.diamonds,900);assert.equal(c.w.state.running,true);assert.equal(c.cloud.marketPending,false);
});
test('sync failure never posts a transaction and a post-purchase list failure never leaves combat frozen',async t=>{
 for(const options of [{failFlush:true},{refreshFail:true}]){
  const c=ui(t,options);c.cloud.showMarket();await settle();
  if(options.failFlush){assert.equal(c.transactions.length,0);assert.equal(c.w.state.running,true);continue;}
  c.$('.market-offers button').click();c.$('[data-confirm]').click();await settle();assert.equal(c.transactions.length,1);assert.equal(c.w.state.running,true);assert.equal(c.cloud.marketPending,false);
 }
});
test('online legacy diamond APIs cannot mint currency and Pandora uses the real marketplace',t=>{
 const g=new HeadlessGame();t.after(()=>g.close());g.create({classId:'elf',name:'統一貨幣',allocation:{dex:8}});
 let opens=0;g.window.CloudStore={diamonds:333,showMarket:()=>opens++};
 assert.equal(g.run('pandoraGetSharedDiamonds()'),333);
 assert.equal(g.run('pandoraAdjustSharedDiamonds(999999).ok'),false);assert.equal(g.run('pandoraRestoreSharedDiamonds(999999).ok'),false);
 g.run('openPandoraShortcut();interactNPC("npc_pandora","town_talking");');assert.equal(opens,2);
 assert.deepEqual(JSON.parse(g.run('JSON.stringify(getWanderingBuyersForTown("town_talking"))')),[]);
});
