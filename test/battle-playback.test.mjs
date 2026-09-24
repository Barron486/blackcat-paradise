import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {BattleTimeline} from '../online/battle-timeline.js';
import {HeadlessGame} from '../server/game-engine.mjs';

const frame=(seq,extra={})=>({seq,tick:seq,map:'training',targetIdx:0,mobs:[],player:{hp:100},events:[],...extra});
const packet=(frames,stream='battle-1')=>({stream,seq:frames.at(-1)?.seq||0,frames});

test('server batches are played at their original tick spacing and duplicate packets never repeat hits',()=>{
  let time=0;const drawn=[],timeline=new BattleTimeline({now:()=>time,paint:(f,o)=>drawn.push({seq:f.seq,...o})});
  timeline.ingest(packet([frame(0)]));assert.equal(drawn[0].silent,true);
  time=1000;const batch=packet(Array.from({length:10},(_,i)=>frame(i+1)));
  timeline.ingest(batch);assert.deepEqual(drawn.map(f=>f.seq),[0],'initial batch waits for the jitter reserve');
  timeline.ingest(batch);assert.equal(drawn.length,1);
  timeline.ingest(packet([frame(0)]));assert.equal(drawn.length,1,'an old response cannot rewind the display');
  time=1399;timeline.pump();assert.equal(drawn.length,1);
  time=1400;timeline.pump();assert.equal(drawn.at(-1).seq,1);
  for(time=1500;time<=2300;time+=100)timeline.pump();
  assert.deepEqual(drawn.map(f=>f.seq),Array.from({length:11},(_,i)=>i));
  assert.deepEqual(timeline.cursor(),{stream:'battle-1',seq:10});
});

test('map changes, server restarts and background delays discard obsolete animation queues',()=>{
  let time=0;const drawn=[],timeline=new BattleTimeline({now:()=>time,paint:(f,o)=>drawn.push({map:f.map,seq:f.seq,...o})});
  timeline.ingest(packet([frame(0)]));time=1000;timeline.ingest(packet([frame(1),frame(2),frame(3)]));
  timeline.ingest(packet([frame(0,{map:'town'})],'battle-2'));
  time=5000;timeline.pump();assert.equal(drawn.at(-1).map,'town');assert.equal(timeline.queue.length,0);
  timeline.ingest(packet([frame(1,{map:'town'})],'battle-2'),{hidden:true});assert.equal(drawn.at(-1).silent,true);
  time=5100;timeline.ingest(packet([frame(2,{map:'town'}),frame(3,{map:'town'})],'battle-2'));
  time=10000;timeline.pump();assert.equal(drawn.at(-1).silent,false);assert.equal(timeline.queue.length,0);
  timeline.ingest(packet([frame(4,{map:'town'})],'battle-2'),{hidden:true});assert.equal(drawn.at(-1).silent,true);assert.equal(timeline.queue.length,0);
});

for(const {name,batch,arrivals} of [
  {name:'1s SSE with delivery jitter',batch:10,arrivals:[1000,2300,3000,4250,5000,6250]},
  {name:'2s polling fallback',batch:20,arrivals:[2000,4200,6000,8200,10000,12200]},
  {name:'3s slow foreground batches',batch:30,arrivals:[3000,6000,9000,12000]},
])test(`${name} preserves attack spacing across packet boundaries without burst-then-idle cycles`,()=>{
  let time=0,resets=0,seq=0;const drawn=[];
  const timeline=new BattleTimeline({now:()=>time,reset:()=>resets++,paint:(f,o)=>{if(!o.silent)drawn.push({seq:f.seq,time});}});
  timeline.ingest(packet([frame(0)]));const initialResets=resets;
  for(time=0;time<=arrivals.at(-1)+batch*100+1000;time+=50){
    if(arrivals.includes(time)){
      const next=packet(Array.from({length:batch},()=>frame(++seq,{events:[{type:'player',action:'attack'}]})));
      timeline.ingest(next);timeline.ingest(next);
    }
    timeline.pump();
  }
  assert.equal(resets,initialResets,'network jitter must not reset sprite state');
  assert.deepEqual(drawn.map(f=>f.seq),Array.from({length:seq},(_,i)=>i+1),'no dropped or repeated attacks');
  assert.ok(drawn.slice(1).every((f,i)=>f.time-drawn[i].time===100),'playback never speeds up or starves between packets');
  assert.equal(timeline.queue.length,0);
});

test('a real outage buffers again without fabricating attacks, and a blocked main thread does not burst queued frames',()=>{
  let time=0;const drawn=[],timeline=new BattleTimeline({now:()=>time,paint:(f,o)=>{if(!o.silent)drawn.push({seq:f.seq,time});}});
  timeline.ingest(packet([frame(0)]));
  time=1000;timeline.ingest(packet([frame(1),frame(2)]));
  for(time=1400;time<=1500;time+=100)timeline.pump();
  time=10000;timeline.pump();assert.equal(drawn.length,2,'no server data means no invented combat');
  timeline.ingest(packet([frame(3),frame(4),frame(5)]));assert.equal(drawn.length,2);
  time=10400;timeline.pump();assert.equal(drawn.at(-1).seq,3);
  time=12000;timeline.pump();assert.equal(drawn.at(-1).seq,4);
  time=12100;timeline.pump();assert.equal(drawn.at(-1).seq,5);
  assert.equal(timeline.queue.length,0);
});

test('only an excessive backlog is trimmed and its retained frames still use original tick spacing',()=>{
  let time=0;const drawn=[],timeline=new BattleTimeline({now:()=>time,paint:(f,o)=>{if(!o.silent)drawn.push({seq:f.seq,time});}});
  timeline.ingest(packet([frame(0)]));
  time=10000;timeline.ingest(packet(Array.from({length:90},(_,i)=>frame(i+1))));
  assert.equal(timeline.queue.length,30);
  for(time=10400;time<=13300;time+=100)timeline.pump();
  assert.deepEqual(drawn.map(f=>f.seq),Array.from({length:30},(_,i)=>i+61));
  assert.ok(drawn.slice(1).every((f,i)=>f.time-drawn[i].time===100));
});

test('server records attacks and deaths per tick, bounds retention and keeps presentation out of saves',()=>{
  const engine=new HeadlessGame();try{
    engine.create({classId:'knight',name:'動畫測試',allocation:{str:2,con:6}});
    engine.action('travel',{mapId:'training'});engine.step(65);
    const stream=engine.battle();assert.ok(stream.frames.length<=30);
    assert.ok(stream.frames.some(f=>f.events.some(e=>e.type==='player'&&e.action==='attack')));
    assert.ok(stream.frames.every(f=>!Object.hasOwn(f.player,'inv')&&!Object.hasOwn(f.player,'gold')));
    const last=stream.frames.at(-1);assert.deepEqual(engine.battle({stream:stream.stream,seq:last.seq}).frames,[]);
    engine.run(`if(!mapState.mobs[0])spawnMob(0);mapState.mobs[0].curHp=0;killMob(0);settleDeadMobs();`);engine.captureBattle();
    const deaths=engine.battle({stream:stream.stream,seq:last.seq}).frames.flatMap(f=>f.events).filter(e=>e.type==='kill');
    assert.equal(deaths.length,1);assert.ok(deaths[0].mob.uid);
    assert.ok(!JSON.stringify(engine.snapshot()).includes('battleStream'));
    engine.run('spawnMob(0);');const selected=engine.run('mapState.mobs[0].uid');
    engine.action('target',{uid:selected});assert.equal(engine.view().ms.targetIdx,0);
    engine.run('mapState.mobs[0]=null;spawnMob(0);');assert.throws(()=>engine.action('target',{uid:selected}),/目標已離場/);
    const old=engine.battle().stream;engine.action('return-town');assert.notEqual(engine.battle().stream,old);
  }finally{engine.close();}
});

test('browser preserves animation state, paints fatal damage before removing the mob and never changes canonical stats',()=>{
  const dom=new JSDOM('<div id="mob-list"></div>',{runScripts:'outside-only'}),w=dom.window;let time=0,pump;
  w.BattleTimeline=BattleTimeline;w.setInterval=fn=>{pump=fn;return 1;};w.clearInterval=()=>{};
  w.eval(`var player={hp:100,gold:777,lv:5,allies:[],d:{}},mapState={current:'training',mobs:[],targetIdx:0},state={ticks:99};
    var painted=[],visuals=[],events=[],_vfxPending=[],_mobRenderCache=null;
    function renderMobs(){painted.push(mapState.mobs.map(m=>m&&m.curHp));visuals.push(mapState.mobs.map(m=>m&&{y:m._yScat,act:m._animAct,spawned:m._animSpawned}));for(const m of mapState.mobs)if(m){m._yScat??=17;m._animSpawned=true;m._vfxHp=m.curHp;}}
    function _renderMobsImpl(){renderMobs();}function _mobAnimApply(){}function _playerMorphApply(){}function _allySpritesApply(){}function _updateFreezeFx(){}function _updateMobSkillFx(){}
    function _vfxClearAll(){}function _playerMorphRemove(){}
    function _mobAnimTrigger(m,k){m._animAct={k,t:123};}function _playerMorphTrigger(k){events.push(k);}
    function vfxKill(m){events.push({kill:m.uid,previous:m._vfxHp,hp:m.curHp,painted:painted.at(-1)});}
  `);
  const source=readFileSync(new URL('../online/battle-playback.js',import.meta.url),'utf8').replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'');w.eval(source);
  // JSDOM defaults to a background document unless visual mode is enabled.
  Object.defineProperty(w.document,'hidden',{value:false,configurable:true});
  const playback=w.startBattlePlayback({now:()=>time});
  const mob={uid:'mob-1',n:'哥布林',hp:100,curHp:100};
  playback.receive(packet([frame(0,{mobs:[mob]})]));
  time=1000;playback.receive(packet([frame(1,{mobs:[{...mob,curHp:80}],events:[{type:'player',action:'attack'},{type:'mob',uid:mob.uid,action:'attack'}]}),frame(2,{mobs:[{...mob,curHp:60}]})]));
  time=1400;pump();
  assert.equal(playback.target(0),'mob-1');assert.deepEqual([...w.events],['attack']);
  time=1500;pump();
  assert.deepEqual([...w.painted.at(-1)],[60]);
  assert.equal(w.visuals.at(-1)[0].y,17);assert.equal(w.visuals.at(-1)[0].spawned,true);assert.equal(w.visuals.at(-1)[0].act.t,123);
  const saved=w.eval('JSON.stringify({player,mapState,state})');
  time=1600;playback.receive(packet([frame(3,{mobs:[null],events:[{type:'kill',mob:{...mob,curHp:-10}}]})]));
  const kill=w.events.find(e=>e.kill);assert.equal(kill.previous,60);assert.deepEqual([...kill.painted],[60]);assert.equal(kill.hp,-10);
  assert.equal(w.eval('JSON.stringify({player,mapState,state})'),saved);
  assert.equal(w.eval('player.gold'),777);assert.equal(w.eval('state.ticks'),99);
  time=1700;playback.receive(packet([frame(4,{mobs:[null],events:[{type:'kill',index:0,mob:{...mob,uid:'instant-kill',curHp:-50}}]})]));
  const instant=w.events.find(e=>e.kill==='instant-kill');assert.equal(instant.previous,100);assert.deepEqual([...instant.painted],[100]);assert.deepEqual([...w.painted.at(-1)],[null]);
  dom.window.close();
});

test('player, mercenary and companion facing and movement survive every received frame',()=>{
  const dom=new JSDOM('',{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;let time=0;
  w.BattleTimeline=BattleTimeline;w.setInterval=()=>1;w.clearInterval=()=>{};
  w.eval(`var player={hp:100,allies:[{_slot:2,name:'隊員'}],d:{}},mapState={current:'training',mobs:[]},state={ticks:0};
    var faceChecks=[],petChecks=[],_vfxPending=[],_mobRenderCache=null;
    function renderMobs(){}function _mobAnimApply(){}function _vfxClearAll(){}function _playerMorphRemove(){}
    function _playerMorphApply(){faceChecks.push(player._faceD);player._faceD=7;}
    function _allySpritesApply(){faceChecks.push(player.allies[0]._faceD);player.allies[0]._faceD=5;}
    function petsOutList(){return [];}function summonRenderList(){return [];}function guardRenderList(){return [];}
    function _petAnimAct(p,action,faceUid){p._animAct={k:action,t:123};p._faceMobUid=faceUid;}
    function _petAnimApply(){const p=petsOutList()[0];petChecks.push({x:p._px,t:p._animAct?.t,face:p._faceMobUid});p._px=0.3;}
  `);
  w.eval(readFileSync(new URL('../online/battle-playback.js',import.meta.url),'utf8').replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,''));
  const playback=w.startBattlePlayback({now:()=>time}),extra={player:{hp:100,allies:[{_slot:2,curHp:50}]},companions:[{uid:'pet-1',form:'狼',hp:30}]};
  playback.receive(packet([frame(0,extra)]));w._allySpritesApply();w._petAnimApply();
  time=100;playback.receive(packet([frame(1,{...extra,events:[{type:'companion',uid:'pet-1',action:'attack',faceUid:'mob-1'}]})]));
  w._playerMorphApply();w._allySpritesApply();w._petAnimApply();
  time=200;playback.receive(packet([frame(2,extra)]));w._petAnimApply();
  assert.deepEqual([...w.faceChecks],[undefined,undefined,7,5]);
  assert.equal(w.petChecks.at(-1).x,0.3);assert.equal(w.petChecks.at(-1).t,123);assert.equal(w.petChecks.at(-1).face,'mob-1');
  assert.equal(w.petsOutList().length,0);assert.equal(w.eval('player._faceD'),undefined);dom.window.close();
});
