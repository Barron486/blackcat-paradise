import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {HeadlessGame} from '../server/game-engine.mjs';

const source=readFileSync(new URL('../js/09-vfx-render.js',import.meta.url),'utf8');

function animationBrowser(t){
  const dom=new JSDOM('<div id="battle-view" class="area-fit"><div id="mob-list"></div></div>',{
    url:'http://localhost/',runScripts:'outside-only',pretendToBeVisual:true,
  });
  t.after(()=>dom.window.close());
  const w=dom.window,frames=new Map();let clock=0,id=0;
  w.requestAnimationFrame=fn=>{frames.set(++id,fn);return id;};
  w.cancelAnimationFrame=id=>frames.delete(id);
  w.Date.now=()=>clock;
  vm.runInContext(source,dom.getInternalVMContext());
  w.eval(`
    var player={hp:100,dead:false,avatar:'fixture',d:{aspd:0.45,castLock:5},allies:[{_slot:1,curHp:100,avatar:'fixture',d:{aspd:0.45,castLock:5}}]};
    var mapState={mobs:[]}, catchingUp=false, fxUpdates=0;
    function catchupActive(){return catchingUp;}
    _updateFreezeFx=()=>{fxUpdates++;};_updateMobSkillFx=()=>{};
    _playerBattleForm=_actorBattleForm=()=>({key:'fixture',domKey:'fixture'});
    _playerMorphName=_actorMorphName=()=>null;
    _playerCastleCrownOn=()=>false;
    const seq=action=>Array.from({length:10},(_,i)=>({src:'http://localhost/'+action+'-'+i+'.png',naturalWidth:100}));
    _morphBattleCache.fixture={idle:seq('idle'),attack:seq('attack'),skill:seq('skill'),death:seq('death'),shadow:{},weapon:{}};
  `);
  return {w,frames,advance(ms){
    clock=ms;
    const pending=[...frames.values()];frames.clear();
    for(const fn of pending)fn(ms);
  }};
}

test('fast attacks and casts display all frames without speeding up idle or death',t=>{
  const {w,advance}=animationBrowser(t);
  advance(0);w._playerMorphTrigger('attack');w.eval('_allySpriteTrigger(player.allies[0], "attack")');
  const body=w.document.querySelector('#player-morph-sprite .pm-body');
  const ally=w.document.querySelector('.party-sprite .pm-body');
  const playerFrames=new Set(),allyFrames=new Set();
  for(let ms=0;ms<450;ms+=1000/60){advance(ms);playerFrames.add(body.src);allyFrames.add(ally.src);}
  const attacks=Array.from({length:10},(_,i)=>`http://localhost/attack-${i}.png`);
  assert.deepEqual([...playerFrames],attacks);assert.deepEqual([...allyFrames],attacks);
  advance(451);assert.match(body.src,/idle-/);assert.match(ally.src,/idle-/);
  assert.equal(w.eval('MOB_ANIM_FPS'),8);
  advance(500);const idle=body.src;advance(550);assert.equal(body.src,idle);
  const observer=new w.MutationObserver(()=>{});observer.observe(body,{attributes:true,attributeFilter:['src']});
  advance(560);assert.equal(observer.takeRecords().length,0,'unchanged frames do not write src');observer.disconnect();
  w._playerMorphTrigger('skill');const skills=new Set();
  for(let ms=560;ms<1060;ms+=1000/60){advance(ms);skills.add(body.src);}
  assert.deepEqual([...skills],Array.from({length:10},(_,i)=>`http://localhost/skill-${i}.png`));
  advance(1061);assert.match(body.src,/idle-/);
  w.eval('player.dead=true');advance(1100);advance(1200);assert.match(body.src,/death-0.png$/);
  advance(1225);assert.match(body.src,/death-1.png$/);
  advance(2400);assert.match(body.src,/death-9.png$/);
});

test('animation loop pauses in background and catch-up, resumes once and throttles persistent FX',t=>{
  const {w,frames,advance}=animationBrowser(t);
  assert.equal(frames.size,1);
  advance(0);advance(16);advance(124);assert.equal(w.fxUpdates,1);
  advance(125);assert.equal(w.fxUpdates,2);
  const hidden=value=>{Object.defineProperty(w.document,'hidden',{value,configurable:true});w.document.dispatchEvent(new w.Event('visibilitychange'));};
  hidden(true);assert.equal(frames.size,0);
  advance(1000);assert.equal(w.fxUpdates,2);
  hidden(false);hidden(false);assert.equal(frames.size,1);
  advance(1001);assert.equal(w.fxUpdates,3);
  w.catchingUp=true;advance(2000);assert.equal(w.fxUpdates,3);assert.equal(frames.size,1);
  w.catchingUp=false;advance(2016);assert.equal(w.fxUpdates,4);
  w.dispatchEvent(new w.Event('pagehide'));hidden(false);assert.equal(frames.size,0);
  w.dispatchEvent(new w.Event('pageshow'));w.dispatchEvent(new w.Event('pageshow'));assert.equal(frames.size,1);
  advance(3000);assert.equal(w.fxUpdates,5);
});

function battle(t){
  const engine=new HeadlessGame();t.after(()=>engine.close());
  engine.create({classId:'knight',name:'動畫測試',allocation:{str:2,con:6}});
  engine.action('travel',{mapId:'training'});
  engine.run(`
    backSlotsActive=()=>true;
    _showMobHp=true;_showMobStatus=true;
    mapState.mobs=Array.from({length:5},(_,i)=>({uid:'test-'+i,n:'哥布林',img:'assets/icons/monsters/哥布林.png',lv:1,hp:100,curHp:100,st:{},_yScat:10,_animSpawned:true}));
    _renderMobsImpl();
  `);
  return engine;
}

test('simultaneous HP, status and target updates preserve every monster and sprite node',t=>{
  const engine=battle(t),w=engine.window,list=w.document.getElementById('mob-list');
  const cards=[...list.children],bodies=cards.map(c=>c.querySelector('.mob-body'));
  const bars=cards.map(c=>c.querySelector('.mob-hp-fill'));
  bodies.forEach((b,i)=>{b.src=`http://localhost/playing-${i}.png`;});
  const observer=new w.MutationObserver(()=>{});observer.observe(list,{childList:true,subtree:true});
  engine.run(`mapState.mobs.forEach(m=>m.curHp=60);_renderMobsImpl();`);
  assert.equal(observer.takeRecords().length,0,'HP-only changes never replace DOM children');
  for(let i=0;i<5;i++){
    assert.equal(list.children[i],cards[i]);assert.equal(cards[i].querySelector('.mob-body'),bodies[i]);
    assert.equal(bodies[i].src,`http://localhost/playing-${i}.png`);assert.equal(bars[i].style.width,'60%');
  }
  engine.run(`mapState.targetIdx=1;mapState.mobs[0].st.freeze=5;mapState.mobs[0]._grace=true;mapState.mobs[0].hardSkin=7;mapState.mobs[0]._npcClanName='測試血盟';_renderMobsImpl();`);
  assert.ok(cards[1].classList.contains('active'));assert.ok(!cards[0].classList.contains('active'));
  assert.ok(cards[0].querySelector('.mob-badge-row').textContent.includes('席琳恩賜'));
  assert.ok(cards[0].querySelector('.mob-stat-row').textContent.includes('7'));
  assert.ok(cards[0].querySelector('.mob-name').textContent.includes('測試血盟'));
  assert.ok(bodies[0].classList.contains('grace-glow'));
  engine.run(`_showMobHp=false;_showMobStatus=false;_renderMobsImpl();`);
  assert.equal(list.querySelector('.mob-hp-bar'),null);assert.equal(cards[0].querySelector('.mob-badge-row').textContent,'');
  engine.run(`_showMobHp=true;mapState.mobs[0].curHp=-5;mapState.mobs[1].curHp=150;_renderMobsImpl();`);
  assert.equal(cards[0].querySelector('.mob-hp-fill').style.width,'0%');assert.equal(cards[1].querySelector('.mob-hp-fill').style.width,'100%');
  bodies.forEach((b,i)=>assert.equal(cards[i].querySelector('.mob-body'),b));
  observer.disconnect();
});

test('replacing or removing one monster keeps neighbours, while map and slot changes rebuild safely',t=>{
  const engine=battle(t),list=engine.window.document.getElementById('mob-list');
  const cards=[...list.children];
  engine.run(`mapState.mobs[0]={...mapState.mobs[0],uid:'new-mob'};mapState.mobs[1]=null;_renderMobsImpl();`);
  assert.notEqual(list.children[0],cards[0]);assert.equal(list.children[0].dataset.uid,'new-mob');
  assert.notEqual(list.children[1],cards[1]);assert.equal(list.children[1].dataset.uid,undefined);
  for(let i=2;i<5;i++)assert.equal(list.children[i],cards[i]);
  const before=list.children[0];engine.run(`mapState.mobs[0].n='骷髏';_renderMobsImpl();`);
  assert.notEqual(list.children[0],before,'changed appearance replaces its sprite');
  list.children[2].outerHTML='<div></div>';engine.run('_renderMobsImpl();');
  assert.equal(list.children[2].dataset.uid,'test-2','externally replaced cards are restored');
  engine.run(`mapState.current='another-map';_renderMobsImpl();`);assert.notEqual(list.children[3],cards[3]);
  engine.run(`backSlotsActive=()=>false;_renderMobsImpl();`);assert.equal(list.children.length,3);
});

test('clan crown changes and hurt/death presentation do not discard the surviving sprite layers',t=>{
  const engine=battle(t),list=engine.window.document.getElementById('mob-list');
  const card=list.children[0],images=[...card.querySelectorAll('.mob-img-inner img')];
  engine.run(`Object.assign(mapState.mobs[0],{_npcClanLeader:true,_npcClanConflict:true,_npcClanHasCastle:true,_pvpAvatar:'王子'});_renderMobsImpl();`);
  assert.ok(card.querySelector('.npc-clan-castle-crown'));
  engine.run(`mapState.mobs[0].curHp=50;mapState.mobs[0].justHit=true;_renderMobsImpl();`);
  assert.equal(engine.run('mapState.mobs[0].justHit'),false);
  engine.run(`mapState.mobs[0].curHp=0;mapState.mobs[0]._dead=true;_renderMobsImpl();`);
  assert.equal(card.querySelector('.npc-clan-castle-crown'),null);
  images.forEach(image=>assert.ok(image.isConnected));assert.equal(list.children[0],card);
});
