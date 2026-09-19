import {BattleTimeline} from './battle-timeline.js';

const clone=value=>JSON.parse(JSON.stringify(value));
const visualKeys=['_yScat','_animSpawned','_animAct','_vfxHp','_face8Loaded','_face8','_rageFxActive'];
const petVisualKeys=['_animAct','_faceMobUid','_px','_py','_wt','_wx','_wy','_dir','_moving','_dirLoaded'];

export function startBattlePlayback({now}={}){
  let current=null,drawing=false;
  const draw=callback=>{
    if(!current||drawing)return callback();
    const p=player,ms=mapState,ticks=state.ticks;
    if(ms.current!==current.map)return callback();
    drawing=true;
    try{
      player={...p,...current.player,d:{...p.d,...current.player.d}};
      player.allies=(current.player.allies||[]).map(a=>a?{...(p.allies||[]).find(old=>old?._slot===a._slot),...a}:null);
      mapState={...ms,current:current.map,mobs:current.mobs,targetIdx:current.targetIdx};state.ticks=current.tick;
      return callback();
    }finally{
      // Facing and movement belong to the renderer and remain stable between packets.
      current.player._faceD=player._faceD;
      for(const a of current.player.allies||[])if(a)a._faceD=player.allies.find(old=>old?._slot===a._slot)?._faceD;
      player=p;mapState=ms;state.ticks=ticks;drawing=false;
    }
  };
  const reset=()=>{
    current=null;
    try{_vfxClearAll();_playerMorphRemove();_vfxPending=[];_mobRenderCache=null;}catch{}
  };
  const actor=ref=>ref?.player?player:(player.allies||[]).find(a=>a&&(ref?.slot!=null?a._slot===ref.slot:a.uid===ref?.uid))||player;
  function event(e,previous){
    const mob=current.mobs.find(m=>m&&m.uid===e.uid)||previous?.mobs.find(m=>m&&m.uid===e.uid);
    switch(e.type){
      case 'player':_playerMorphTrigger(e.action,e.skill);break;
      case 'mob':if(mob)_mobAnimTrigger(mob,e.action);break;
      case 'ally':_allySpriteTrigger(actor(e.actor),e.action,e.skill);break;
      case 'spell':if(mob)playSpellFx(e.spell,mob,actor(e.actor));break;
      case 'arrow':if(mob)playArrowFx(actor(e.actor),mob,e.delay||0);break;
      case 'self':playSelfFx(e.spell);break;
      case 'miss':if(mob)vfxMiss(mob);break;
      case 'player-hit':vfxPlayerHit(e.damage);break;
      case 'level':vfxLevelUp();break;
      case 'boss':if(mob)vfxBossEntrance(mob);break;
      case 'rare-drop':vfxRareDrop(e.name);break;
      case 'cast-shake':vfxCastShake();break;
      case 'projectile':if(mob)_vfxProjectile(_vfxSlotRect(mob.uid),e.element);break;
      case 'companion':{const pet=current.companions?.find(p=>p.uid===e.uid);if(pet)_petAnimAct(pet,e.action,e.faceUid);break;}
    }
  }
  function paint(frame,{silent}){
    const previous=current,old=new Map((previous?.mobs||[]).filter(Boolean).map(m=>[m.uid,m]));
    current=clone(frame);
    current.player._faceD=previous?.player._faceD;
    for(const a of current.player.allies||[])if(a)a._faceD=previous?.player.allies?.find(old=>old?._slot===a._slot)?._faceD;
    for(const pet of current.companions||[]){const before=previous?.companions?.find(p=>p.uid===pet.uid);if(before)for(const key of petVisualKeys)if(before[key]!==undefined)pet[key]=before[key];}
    for(const m of current.mobs)if(m){
      const before=old.get(m.uid);
      // Network timestamps and headless caches cannot be used as browser animation clocks.
      delete m._animAct;delete m._animSpawned;delete m._yScat;delete m._vfxHp;
      if(before){for(const key of visualKeys)if(before[key]!==undefined)m[key]=before[key];}
      else m._vfxHp=m.hp; // A newly spawned monster can already be hit in its first server frame.
      if(silent){m._vfxHp=m.curHp;m.justHit=false;m._spellHurt=false;m._vfxBig=false;}
    }
    const deaths=silent?[]:(frame.events||[]).filter(e=>e.type==='kill');
    const settled=current.mobs;
    // Keep the struck target on screen until spell/arrow and death effects have their anchor.
    // This also handles monsters spawned and killed within the very same server tick.
    if(deaths.length){current.mobs=settled.slice();for(const e of deaths){const index=Number.isInteger(e.index)?e.index:previous?.mobs.findIndex(m=>m?.uid===e.mob.uid);if(index>=0)current.mobs[index]=old.get(e.mob.uid)||{...e.mob,_dead:false,curHp:e.mob.hp,_vfxHp:e.mob.hp,justHit:false};}}
    draw(()=>{
      renderMobs();
      if(!silent)for(const e of frame.events||[])if(e.type!=='kill')event(e,previous);
      for(const e of deaths){const before=current.mobs.find(m=>m?.uid===e.mob.uid);if(before)vfxKill({...before,...e.mob,_vfxHp:before._vfxHp??before.curHp});}
    });
    current.mobs=settled;
    draw(()=>{
      if(deaths.length)renderMobs();
      _mobAnimApply();if(silent)_playerMorphApply();
    });
  }
  const timeline=new BattleTimeline({paint,reset,now});
  // All existing frame tickers continue to render locally, against presentation state only.
  for(const name of ['renderMobs','_renderMobsImpl','_mobAnimApply','_playerMorphApply','_allySpritesApply','_updateFreezeFx','_updateMobSkillFx']){
    const original=window[name];if(typeof original==='function')window[name]=function(...args){return draw(()=>original.apply(this,args));};
  }
  const petRender=window._petAnimApply;
  if(petRender)window._petAnimApply=function(){
    if(!current)return petRender();
    const pets=window.petsOutList,summons=window.summonRenderList,guards=window.guardRenderList;
    try{window.petsOutList=()=>current.companions||[];window.summonRenderList=window.guardRenderList=()=>[];return draw(()=>petRender());}
    finally{window.petsOutList=pets;window.summonRenderList=summons;window.guardRenderList=guards;}
  };
  const pump=()=>{if(!document.hidden)timeline.pump();};
  let timer=setInterval(pump,50);
  window.addEventListener('pagehide',()=>clearInterval(timer));
  window.addEventListener('pageshow',event=>{if(event.persisted){clearInterval(timer);timer=setInterval(pump,50);}});
  return {
    receive:(packet,options={})=>packet?.frames?.at(-1)?.map&&packet.frames.at(-1).map!==mapState.current?false:timeline.ingest(packet,{...options,hidden:document.hidden}),
    cursor:()=>timeline.cursor(),clear:()=>timeline.clear(),
    target:index=>current?.mobs[index]?.uid,
  };
}
