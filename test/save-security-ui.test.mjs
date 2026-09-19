import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM,VirtualConsole} from '../cli/node_modules/jsdom/lib/api.js';
const source=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('rejected saves stop combat and retries, preserve the draft and offer a deliberate cloud reload',async t=>{
 const dom=new JSDOM('<body><script id="cloud-boot" type="application/json"></script></body>',{url:'http://localhost/',runScripts:'outside-only',virtualConsole:new VirtualConsole()});t.after(()=>dom.window.close());const w=dom.window,timers=[];
 w.document.getElementById('cloud-boot').textContent=JSON.stringify({values:{},revision:1,user:{username:'tester',role:'player'},serverTime:Date.now()});w.eval(source('online/bootstrap.js'));
 Object.assign(w,{player:{cls:'elf',name:'測試角色',gold:-1},state:{running:true},currentSlot:1,mapState:{current:'training'},DB:{maps:{training:{n:'新兵修練場'}}},_roleSaveAllowed:()=>true,_saveWrap:s=>s,saveStateJson:()=>JSON.stringify({p:w.player}),refreshGmBuffs:()=>{},startLootTicker:()=>{},startWorldChat:()=>({refresh:()=>{}})});
 w.setInterval=(fn,ms)=>{timers.push({fn,ms});return timers.length;};let attempts=0,stops=0;
 w.stopGameTimers=()=>{stops++;};w.CloudStore.request=async url=>{if(url==='/api/sync'){attempts++;throw Object.assign(new Error('雲端角色未被覆蓋'),{status:403,data:{saveRejected:true}});}return {};};
 w.eval(source('online/bridge.js').replace(/^import[^\n]*\n/gm,''));await settle();
 assert.equal(w.state.running,false);assert.equal(w.CloudStore.ready,false);assert.equal(stops,1);assert.equal(attempts,1);
 assert.ok(w.CloudStore.pending().lineage_idle_save_1);assert.equal(w.document.querySelector('#cloud-block button').textContent,'重新載入雲端存檔');
 await timers.find(t=>t.ms===3000).fn();assert.equal(attempts,1,'rejected payload is not sent repeatedly');
});
test('GM audit shows refusal reasons using text nodes without turning them into an automatic cheating verdict',async t=>{
 const dom=new JSDOM(source('online/gm.html'),{url:'http://localhost/gm',runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window;
 w.fetch=async url=>({ok:true,json:async()=>url==='/api/me'?{user:{id:'gm',username:'管理者',role:'gm'},csrf:'test'}:url==='/api/gm/players'?{players:[]}:url==='/api/gm/audit'?{entries:[]}:{entries:[{account:'<img src=x>',slotKey:'lineage_idle_save_2',code:'forged_gm_buff',at:Date.now()}]}});
 w.eval(source('online/gm.js'));await settle();w.document.querySelector('[data-view="audit"]').click();await settle();
 const list=w.document.getElementById('save-security-list');assert.match(list.textContent,/<img src=x> · 角色欄位 2/);assert.match(list.textContent,/修改 GM 增益/);assert.equal(list.querySelector('img'),null);
 assert.match(w.document.getElementById('view-audit').textContent,/不代表已確認作弊/);
});
