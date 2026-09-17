import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { applyEffect, refreshGmBuffs } from '../shared/gm-effects.js';

// Exercise the real bridge's revive and conflict paths without the full renderer.
function client() {
  const nodes=new Map(),timers=[];
  class Element {
    constructor(){this.children=[];this.selectors=new Map();this.classes=new Set();this.classList={add:k=>this.classes.add(k),remove:k=>this.classes.delete(k),toggle:(k,on)=>on?this.classes.add(k):this.classes.delete(k)};}
    set id(value){this._id=value;nodes.set(value,this);} get id(){return this._id;}
    append(...children){this.children.push(...children);} replaceChildren(...children){this.children=[...children];}
    querySelector(selector){if(!this.selectors.has(selector))this.selectors.set(selector,new Element());return this.selectors.get(selector);}
    remove(){nodes.delete(this.id);}
  }
  const values={},dirty={};let conflict=null;
  const cloud={boot:{user:{role:'gm',username:'qa'},serverTime:Date.now()},revision:1,lease:'test-lease',ready:false,
    get:k=>values[k]??null,set(k,v){values[k]=v;dirty[k]=v;},pending:()=>({...dirty}),
    ack(sent,revision){for(const k of Object.keys(sent))if(dirty[k]===sent[k])delete dirty[k];this.revision=revision;},
    rebase(snapshot){Object.assign(values,snapshot.values,dirty);this.revision=snapshot.revision;},
    async request(url){
      if(url==='/api/sync'&&conflict){const data=conflict;conflict=null;throw Object.assign(new Error('conflict'),{status:409,data});}
      return {revision:this.revision+1,serverTime:Date.now()};
    },
  };
  const player={cls:'knight',name:'test',_roleEpoch:'epoch',lv:1,hp:100,mhp:100,mp:30,mmp:30,inv:[],buffs:{},statuses:{},dead:false};
  const context=vm.createContext({
    console,Date,JSON,Math,applyEffect,refreshGmBuffs,CloudStore:cloud,player,state:{running:true},currentSlot:1,mapState:{current:'town'},DB:{maps:{town:{n:'town'}}},
    document:{body:new Element(),hidden:false,createElement:()=>new Element(),createTextNode:s=>s,getElementById:id=>nodes.get(id)||null,addEventListener(){}},
    location:{},setInterval:(fn,ms)=>timers.push({fn,ms}),addEventListener(){},_roleSaveAllowed:()=>true,_saveWrap:s=>s,_saveUnwrap:s=>({ok:true,payload:s}),
    calcStats(){},renderTabs(){},renderMobs(){},logSys(){},saveGame(){},startGame(){},loadGame(){},
    revive(){player.dead=false;player.hp=100;},
    reviveInPlace(){if(!player.dead||!player.canRevive)return;player.dead=false;player.hp=50;},
    saveStateJson:()=>JSON.stringify({p:player}),
  });
  context.window=context;
  for(const id of ['btn-revive','btn-revive-inplace']){const element=new Element();element.id=id;}
  const source=readFileSync(new URL('../online/bridge.js',import.meta.url),'utf8').replace(/^import[^\n]*\n/gm,'');
  vm.runInContext(readFileSync(new URL('../online/loot-ticker.js',import.meta.url),'utf8').replace('export function','function'),context);
  vm.runInContext(readFileSync(new URL('../online/world-chat.js',import.meta.url),'utf8').replace('export function','function'),context);
  vm.runInContext(source,context);
  return {context,player,cloud,nodes,timers,setConflict:data=>{conflict=data;}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('manual revival keeps upstream eligibility checks and resumes GM-stopped combat',async()=>{
  const {context,player}=client();await settle();
  player.dead=true;player._gmDead=true;context.state.running=false;
  context.reviveInPlace();assert.equal(player.dead,true);assert.equal(player._gmDead,true);
  player.canRevive=true;context.reviveInPlace();assert.equal(player.dead,false);assert.equal(player._gmDead,false);assert.equal(context.state.running,true);
  player.dead=true;player._gmDead=true;context.state.running=false;
  context.revive();assert.equal(player.hp,100);assert.equal(player._gmDead,false);assert.equal(context.state.running,true);
});
test('live GM kill and revive survive stale-save reconciliation and restore the controls',async()=>{
  const c=client();await settle();
  const key='lineage_idle_save_1',sync=c.timers.find(t=>t.ms===3000).fn;
  async function deliver(effect){
    const doc=JSON.parse(c.cloud.get(key));applyEffect(doc,effect);
    c.setConflict({snapshot:{values:{[key]:JSON.stringify(doc)},revision:c.cloud.revision+1,serverTime:Date.now()},effects:[{key,...effect}]});
    await sync();
  }
  c.player.exp=123;
  await deliver({seq:1,action:'kill',epoch:'epoch'});
  assert.equal(c.player.dead,true);assert.equal(c.context.state.running,false);assert.equal(c.nodes.get('btn-revive').classes.has('hidden'),false);
  await deliver({seq:2,action:'revive',epoch:'epoch'});
  assert.equal(c.player.dead,false);assert.equal(c.player.hp,100);assert.equal(c.context.state.running,true);assert.equal(c.nodes.get('btn-revive').classes.has('hidden'),true);
  assert.equal(c.player.exp,123);assert.equal(c.player._gmSeq,2);
});

test('server rename wins over a stale local name while earned progression is preserved',async()=>{
 const c=client();await settle();const key='lineage_idle_save_1',sync=c.timers.find(t=>t.ms===3000).fn;
 c.player.exp=321;const doc=JSON.parse(c.cloud.get(key));doc.p.name='消耗卡片後名稱';
 c.setConflict({snapshot:{values:{[key]:JSON.stringify(doc)},revision:c.cloud.revision+1,serverTime:Date.now()},effects:[],nameConflict:true});
 await sync();assert.equal(c.player.name,'消耗卡片後名稱');assert.equal(c.player.exp,321);
 assert.equal(JSON.parse(c.cloud.get(key)).p.name,'消耗卡片後名稱');
});
