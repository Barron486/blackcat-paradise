import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {HeadlessGame} from '../cli/engine.mjs';
import {applyEffect,refreshGmBuffs} from '../shared/gm-effects.js';
const source=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const key=slot=>'lineage_idle_save_'+slot;
async function client(t){
 const game=new HeadlessGame();t.after(()=>game.close());game.create({classId:'elf',name:'第一角色',allocation:{dex:8}});
 const w=game.window,boot=w.document.createElement('script');boot.id='cloud-boot';boot.textContent=JSON.stringify({values:game.values(),revision:1,csrf:'test',serverTime:Date.now(),user:{username:'qa',role:'player'}});w.document.body.append(boot);
 w.eval(source('online/bootstrap.js'));const cloud=w.CloudStore,requests=[],timers=[];let conflict=null;
 cloud.request=async(url,body)=>{requests.push({url,body});if(url==='/api/sync'&&conflict){const data=conflict;conflict=null;throw Object.assign(new Error('conflict'),{status:409,data});}return url==='/api/online'?{total:1,list:[]}:{revision:cloud.revision+1,serverTime:Date.now()};};
 w.setInterval=(fn,ms)=>{timers.push({fn,ms});return timers.length;};
 w.applyEffect=applyEffect;w.refreshGmBuffs=refreshGmBuffs;w.startLootTicker=()=>{};w.startWorldChat=()=>({refresh:async()=>{}});
 w.eval(source('online/bridge.js').replace(/^import[^\n]*\n/gm,''));await settle();
 return {game,w,cloud,requests,timers,sync:()=>timers.find(t=>t.ms===3000).fn(),conflict:data=>{conflict=data;}};
}
function createSecond(game,slot,name='第二角色'){
 game.run('_loadSelectedSlot=__args;loadCreateSelected();',slot);
 game.run('document.getElementById("creation-name").value=__args;selectClass("m_knight");for(let i=0;i<4;i++){adjStat("str",1);adjStat("con",1);}startGame();',name);
}
test('returning to selection and waiting on an empty creation slot never copies the previous character',async t=>{
 const c=await client(t),first=c.game.decodeSave(c.cloud.get(key(1)));
 c.game.run('player.exp=123;returnToCharacterSelect();_loadSelectedSlot=2;loadCreateSelected();');
 await c.sync();c.timers.find(t=>t.ms===15000).fn();c.w.document.dispatchEvent(new c.w.Event('visibilitychange'));await settle();
 assert.equal(c.cloud.get(key(2))===null,true,'empty creation slot must stay empty across background saves');
 assert.equal(c.game.run('saveGame()'),false);assert.equal(c.game.decodeSave(c.cloud.get(key(1))).p.exp,123);
 assert.equal(Object.keys(c.requests.filter(r=>r.url==='/api/sync').at(-1).body.presence).length,0);
 c.game.run('backToMenu();');createSecond(c.game,2);await settle();await c.cloud.flush();
 const second=c.game.decodeSave(c.cloud.get(key(2)));assert.equal(second.p.name,'第二角色');assert.equal(second.p.cls,'knight');assert.equal(second.p.lv,1);assert.equal(second.p.exp,0);assert.equal(second.p.gold,1000);assert.notEqual(second.p._roleEpoch,first.p._roleEpoch);assert.equal(c.game.decodeSave(c.cloud.get(key(1))).p.name,'第一角色');
});
test('canceling creation, changing pages and loading another role preserves all original slots',async t=>{
 const c=await client(t);c.game.run('returnToCharacterSelect();');createSecond(c.game,2);await settle();await c.cloud.flush();
 const first=c.cloud.get(key(1)),second=c.cloud.get(key(2));
 c.game.run('returnToCharacterSelect();loadSetPage(2);_loadSelectedSlot=8;loadCreateSelected();');await c.sync();c.timers.find(t=>t.ms===15000).fn();
 c.game.run('backToMenu();loadSetPage(1);_loadSelectedSlot=1;loadEnterSelected();');await settle();await c.cloud.flush();
 assert.equal(c.cloud.get(key(8)),null);assert.equal(c.game.run('player.name'),'第一角色');assert.equal(c.game.decodeSave(c.cloud.get(key(1))).p._roleEpoch,c.game.decodeSave(first).p._roleEpoch);assert.equal(c.game.decodeSave(c.cloud.get(key(2))).p._roleEpoch,c.game.decodeSave(second).p._roleEpoch);
 c.game.run('state.running=false;player.exp=234;');await settle();await c.cloud.flush();assert.equal(c.game.decodeSave(c.cloud.get(key(1))).p.exp,234,'paused gameplay still saves');
});
test('a late GM revive during character selection updates the stored role without reviving or cloning the old runtime',async t=>{
 const c=await client(t);c.game.run('returnToCharacterSelect();');await settle();const saved=c.game.decodeSave(c.cloud.get(key(1))),effect={key:key(1),seq:1,action:'revive',epoch:saved.p._roleEpoch};
 c.conflict({snapshot:{values:{...c.cloud.boot.values,[key(1)]:c.game.encodeSave(saved)},revision:10,serverTime:Date.now()},effects:[effect]});await c.sync();
 assert.equal(c.game.run('state.running'),false);assert.equal(c.game.decodeSave(c.cloud.get(key(1))).p._gmSeq,1);
 c.game.run('_loadSelectedSlot=3;loadCreateSelected();');await c.sync();assert.equal(c.cloud.get(key(3)),null);
});
