import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {GameService} from '../server/service.mjs';
import {WorldSettingsService} from '../server/world-settings.mjs';
import {LootBroadcastService} from '../server/loot-broadcasts.mjs';
import {createApp} from '../server/index.mjs';
import {CloudClient} from '../cli/cloud-client.mjs';
import {HeadlessGame} from '../cli/engine.mjs';
const {JSDOM}=createRequire(new URL('../cli/package.json',import.meta.url))('jsdom');
const source=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
const settle=()=>new Promise(r=>setImmediate(r));
const key='lineage_idle_save_1',password='loot-settings-test-2026!';
const dropKey=id=>JSON.stringify(['normal','測試怪',id]);
const catalog={version:'test',skills:{},wrap:JSON.stringify,unwrap:JSON.parse,items:{
 legend:{n:'傳說劍',type:'wpn',legend:true},relic:{n:'遺物盾',type:'arm',relic:true},rare:{n:'稀有戒指',type:'acc'},common:{n:'普通劍',type:'wpn'},potion:{n:'稀有藥水',type:'item',relic:true},arrow:{n:'稀有箭',type:'wpn',isArrow:true,legend:true}
},world:{maps:[{id:'training',name:'修練場'}],monsters:[{name:'測試怪'}],drops:['legend','relic','rare','common','potion','arrow'].map(itemId=>({key:dropKey(itemId),monster:'測試怪',source:'normal',itemId,baseRate:itemId==='common'?1:0.01}))}};
async function fixture(t){
 const service=new GameService(':memory:',catalog),world=new WorldSettingsService(service),loot=new LootBroadcastService(service);t.after(()=>service.close());
 const gm=await service.register('announcer_gm',password,{initialGm:true}),user=await service.register('announcer_player',password);
 const doc={p:{cls:'elf',name:'打寶旅人',lv:1,exp:0,inv:[],_roleEpoch:randomUUID()},ms:{current:'training'},ticks:0},lease=randomUUID();let revision=0,seq=0;
 service.acquireLease(user,lease);const save=()=>revision=service.sync(user,lease,revision,{[key]:JSON.stringify(doc)}).revision;save();
 const receipt=(itemId,at=Date.now())=>{doc.p._rareLootSeq=++seq;(doc.p._rareLootEvents??=[]).push({seq,itemId,monster:'測試怪',mapId:'training',quantity:1,at});};
 const update=body=>world.update(gm,{type:'broadcast',enabled:true,rarities:['legend','relic','rare'],revision:world.state().revision,requestId:randomUUID(),reason:'測試廣播',...body});
 return {service,world,loot,gm,user,doc,save,receipt,update};
}
test('equipment classification is consistent in drop lists, actual loot receipts and logs, without coloring consumables',t=>{
 const g=new HeadlessGame();t.after(()=>g.close());g.create({classId:'elf',name:'測試掉寶',allocation:{dex:8}});
 g.run(`DB.items.qa_low={n:'稀有測試戒',type:'acc'};DB.items.qa_common={n:'普通測試劍',type:'wpn'};DB.items.qa_material={n:'稀有素材',type:'item',relic:true};MOB_DROPS['哥布林'].push(['qa_low',0.01],['qa_common',1],['qa_material',0.0001]);gmWorldCatalogCache=null;gmLootSourcesCache=null;window.qaLogs=[];logSys=(html)=>qaLogs.push(html);`);
 let html=g.run("gmMonsterDropHtml('哥布林')");const dom=new JSDOM(html);t.after(()=>dom.window.close());
 assert.equal([...dom.window.document.querySelectorAll('.loot-name-rare')].some(e=>e.textContent==='稀有測試戒'),true);
 assert.equal([...dom.window.document.querySelectorAll('[class]')].some(e=>e.textContent==='稀有素材'),false);assert.doesNotMatch(html,/<b>.*%/);
 g.run(`_lootMobInfo={n:'哥布林'};gainItem('qa_low');gainItem('qa_material');gainItem('qa_common');_lootMobInfo=null;`);
 assert.match(g.run('qaLogs[0]'),/sys-drop-rare-rate/);assert.doesNotMatch(g.run('qaLogs[1]'),/sys-drop-/);assert.doesNotMatch(g.run('qaLogs[2]'),/sys-drop-/);
 const events=g.snapshot().p._rareLootEvents;assert.equal(events.length,1);assert.equal(events[0].itemId,'qa_low');assert.ok(Number.isSafeInteger(events[0].at));
 g.run(`gmSetWorld({revision:1,dropMultiplier:1000,showDropRates:true,drops:{}})`);assert.equal(g.run("gmLootRarity('qa_low','哥布林')"),'rare');
 g.run(`gmSetWorld({revision:2,drops:{[gmDropKey('normal','哥布林','qa_low')]:1}})`);assert.equal(g.run("gmLootRarity('qa_low','哥布林')"),'');
 for(const rate of [0,-1,NaN,Infinity,0.010001])assert.equal(GameLootRarity.classify(catalog.items.rare,rate),'');
 assert.equal(GameLootRarity.classify(catalog.items.rare,0.000001),'rare');assert.equal(GameLootRarity.classify(catalog.items.relic,0.0001),'relic');
});
test('server classifies from its own equipment and configured rate, preserves drop time and filters GM ranges',async t=>{
 const f=await fixture(t),at=Date.now()-30000;
 for(const id of Object.keys(catalog.items))f.receipt(id,at);f.save();
 assert.deepEqual(f.loot.list().events.map(e=>e.rarity),['legend','relic','rare']);assert.equal(f.loot.list().events[2].droppedAt,at);
 f.update({rarities:['rare']});f.receipt('legend');f.receipt('relic');f.receipt('rare');f.save();assert.deepEqual(f.loot.list().events.map(e=>e.rarity),['rare']);
 f.update({type:'drop',key:dropKey('common'),rate:0.0001});f.receipt('common');f.save();assert.equal(f.loot.list().events.at(-1).rarity,'rare');
 f.update({type:'drop',key:dropKey('rare'),rate:1});f.receipt('rare');f.save();assert.equal(f.loot.list().events.at(-1).itemName,'普通劍');
 f.save();assert.equal(f.loot.history().length,5);
});
test('disabled and excluded drops never replay, stale timestamps are suppressed on re-enable, old chat history remains',async t=>{
 const f=await fixture(t);f.receipt('legend');f.save();assert.equal(f.loot.history().length,1);
 f.update({enabled:false});f.receipt('rare');f.save();assert.equal(f.loot.list().enabled,false);assert.deepEqual(f.loot.list().events,[]);
 const duringOff=Date.now()-1000;f.update({enabled:true,rarities:['relic']});f.receipt('relic',duringOff);f.receipt('legend');f.receipt('relic');f.save();
 assert.deepEqual(f.loot.list().events.map(e=>e.rarity),['relic']);assert.equal(f.loot.history().length,2);f.save();assert.equal(f.loot.history().length,2);
 f.update({rarities:['legend','relic','rare']});f.save();assert.deepEqual(f.loot.list().events,[]);assert.equal(f.loot.history().length,2);
 f.receipt('rare',Date.now()+999999999);f.save();const event=f.loot.list().events[0];assert.ok(Math.abs(event.droppedAt-Date.now())<1000);
});
test('broadcast settings migrate old state, require GM and booleans, reject empty enabled ranges and support retry',async t=>{
 const f=await fixture(t);f.service.db.prepare('UPDATE world_settings SET data=? WHERE id=1').run(JSON.stringify({revision:0,goldMultiplier:7,drops:{},maps:{}}));
 assert.deepEqual(f.world.state().lootBroadcast.rarities,['legend','relic','rare']);assert.equal(f.world.state().goldMultiplier,7);
 for(const body of [{enabled:'yes'},{rarities:['item']},{rarities:[]},{rarities:null}])assert.throws(()=>f.update(body));
 const body={type:'broadcast',enabled:true,rarities:['relic','relic'],revision:0,requestId:randomUUID(),reason:'只播遺物'};
 assert.throws(()=>f.world.update(f.user,body),e=>e.status===403);const first=f.world.update(f.gm,body);assert.deepEqual(first.settings.lootBroadcast.rarities,['relic']);
 assert.equal(f.world.update(f.gm,body).replayed,true);assert.equal(f.world.history().length,1);assert.equal(f.world.state().goldMultiplier,7);
 const restored=new WorldSettingsService(f.service);assert.equal(restored.state().lootBroadcast.generation,1);f.update({enabled:false,rarities:[]});
});
test('same persisted announcement reaches a second player through ticker and chat endpoints without becoming player speech',async t=>{
 const app=createApp({database:':memory:',catalog,publicOrigin:'',publicAliases:[]});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>new Promise(r=>app.server.close(r)));
 const player=await app.service.register('loot_source',password),observer=await app.service.register('loot_observer',password),client=new CloudClient({baseUrl:'http://127.0.0.1:'+app.server.address().port});await client.login(observer.username,password);
 app.service.lootBroadcasts.record(player,{p:{_rareLootSeq:0}},{p:{name:'測試玩家',_roleEpoch:randomUUID(),_rareLootSeq:1,_rareLootEvents:[{seq:1,itemId:'rare',monster:'測試怪',mapId:'training',quantity:1,at:Date.now()-5000}]}});
 const base=client.baseUrl,headers={Cookie:client.exportSession().cookie};const ticker=await (await fetch(base+'/api/loot-broadcasts',{headers})).json(),chat=await (await fetch(base+'/api/world',{headers})).json();
 assert.deepEqual(chat.lootBroadcasts,ticker.events);assert.equal(chat.messages.length,0);assert.equal(app.service.messages().length,0);
 await client.logout();
});
function chatDom(t){const dom=new JSDOM('<body><div id="game-screen"><div id="col-center"></div></div><aside id="toolbar"><button data-chat></button><button data-online></button></aside>',{runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());const w=dom.window;w.eval(source('js/loot-rarity.js'));w.matchMedia=()=>({matches:false,addEventListener(){}});return w;}
const sample={id:1,name:'<img src=x>',itemName:'稀有戒指',rarity:'rare',mapName:'修練場',monster:'測試怪',quantity:1,at:1789779610000,droppedAt:1789779600000};
test('ticker and player chat show identical Taiwan drop timestamps, escape names and stop queued banners when GM changes policy',async t=>{
 const w=chatDom(t),timers=[];w.setInterval=(fn,ms)=>timers.push({fn,ms});w.requestAnimationFrame=fn=>fn();let response={enabled:true,generation:0,events:[sample,{...sample,id:2}],cursor:2};
 const cloud={boot:{},request:async path=>path==='/api/online'?{total:0,list:[]}:path==='/api/world'?{messages:[],lootBroadcasts:[sample]}:response};
 w.eval(source('online/loot-ticker.js').replace('export function','window.startLootTicker = function'));w.startLootTicker(cloud,()=>true);await timers.find(t=>t.ms===4000).fn();
 const banner=w.document.getElementById('loot-ticker'),text=banner.querySelector('.loot-ticker-text').textContent;assert.equal(banner.hidden,false);assert.match(text,/\[2026-09-19 09:00:00\]/);assert.match(text,/【極低掉率】/);assert.equal(banner.querySelector('img'),null);
 w.eval(source('online/world-chat.js').replace('export function','window.startWorldChat = function'));const chat=w.startWorldChat(cloud,w.document.getElementById('toolbar'));w.document.querySelector('[data-chat]').click();await settle();
 assert.equal(w.document.querySelector('.cloud-loot-message').textContent,'稀有掉落　'+text);await chat.refresh();assert.equal(w.document.querySelectorAll('.cloud-loot-message').length,1);
 response={enabled:false,generation:1,events:[],cursor:2};await timers.find(t=>t.ms===4000).fn();assert.equal(banner.hidden,true);
 response={enabled:true,generation:2,events:[],cursor:2};await timers.find(t=>t.ms===4000).fn();assert.equal(banner.hidden,true);
 response={enabled:true,generation:2,events:[{...sample,id:3,rarity:'relic'}],cursor:3};await timers.find(t=>t.ms===4000).fn();assert.equal(banner.hidden,false);assert.equal(banner.dataset.rarity,'relic');
});
test('GM form loads, submits selected categories, and renders the resulting broadcast audit',async t=>{
 const f=await fixture(t),dom=new JSDOM('<body><section id="view-world-settings"></section><section id="view-drops"></section>',{runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,errors=[];w.eval(source('online/world-admin.js'));
 w.initWorldAdmin({api:async(path,body)=>body?f.world.update(f.gm,body):f.world.admin(f.gm),notify:(message,error)=>{if(error)errors.push(message);}});
 w.document.dispatchEvent(new w.CustomEvent('gm:view-change',{detail:{view:'world-settings'}}));await settle();const $=s=>w.document.querySelector(s);
 assert.equal($('[name=loot-rarity][value=legend]').checked,true);$('[name=loot-rarity][value=rare]').checked=false;$('#world-broadcast-reason').value='傳說遺物廣播';
 $('#world-broadcast').onsubmit({preventDefault(){},submitter:$('#world-broadcast button')});await settle();assert.deepEqual(f.world.state().lootBroadcast.rarities,['legend','relic']);assert.match($('#world-history').textContent,/稀有掉落廣播.*開啟 · 傳說、遺物/);assert.deepEqual(errors,[]);
 $('#world-broadcast-enabled').checked=false;$('#world-broadcast').onsubmit({preventDefault(){},submitter:$('#world-broadcast button')});await settle();assert.equal(f.world.state().lootBroadcast.enabled,false);assert.equal($('#world-broadcast button').disabled,false);
});
