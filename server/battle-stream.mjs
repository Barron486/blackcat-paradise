import {randomUUID} from 'node:crypto';

// A bounded, read-only recording of already settled combat. It never advances the game.
export class BattleStream {
  constructor(){this.stream=randomUUID();this.seq=0;this.frames=[];this.events=[];this.map=null;}
  event(type,data){if(this.events.length<80)this.events.push({type,...JSON.parse(JSON.stringify(data))});}
  capture(frame){
    if(this.map!==frame.map){this.stream=randomUUID();this.seq=0;this.frames=[];this.map=frame.map;}
    const value=JSON.parse(JSON.stringify(frame));
    this.frames.push({...value,seq:++this.seq,events:this.events.splice(0)});
    if(this.frames.length>30)this.frames.splice(0,this.frames.length-30);
  }
  packet(cursor){
    const after=cursor?.stream===this.stream&&Number.isSafeInteger(cursor.seq)&&cursor.seq>=0&&cursor.seq<=this.seq?cursor.seq:0;
    return {stream:this.stream,seq:this.seq,frames:this.frames.filter(f=>f.seq>after)};
  }
}

export function installBattleRecording(engine){
  const stream=engine.battleStream=new BattleStream(),w=engine.window;
  w.__battleEvent=(type,data)=>stream.event(type,data);
  w.__battleFrame=frame=>stream.capture(frame);
  engine.run(`
    const battleActor = actor => actor && actor !== player ? {slot:actor._slot,uid:actor.uid} : {player:true};
    _playerMorphTrigger = (action,skill) => window.__battleEvent('player',{action,skill});
    _mobAnimTrigger = (mob,action) => { if(mob)window.__battleEvent('mob',{uid:mob.uid,action}); };
    _allySpriteTrigger = (ally,action,skill) => window.__battleEvent('ally',{actor:battleActor(ally),action,skill});
    playSpellFx = (spell,mob,caster) => { if(mob)window.__battleEvent('spell',{spell,uid:mob.uid,actor:battleActor(caster)}); };
    playArrowFx = (caster,mob,delay=0) => { if(mob)window.__battleEvent('arrow',{uid:mob.uid,actor:battleActor(caster),delay}); };
    playSelfFx = spell => window.__battleEvent('self',{spell});
    vfxKill = mob => { if(mob)window.__battleEvent('kill',{mob,index:mapState.mobs.indexOf(mob)}); };
    vfxMiss = mob => { if(mob)window.__battleEvent('miss',{uid:mob.uid}); };
    vfxPlayerHit = damage => window.__battleEvent('player-hit',{damage});
    vfxLevelUp = () => window.__battleEvent('level',{});
    vfxBossEntrance = mob => { if(mob)window.__battleEvent('boss',{uid:mob.uid}); };
    vfxRareDrop = name => window.__battleEvent('rare-drop',{name});
    vfxCastShake = () => window.__battleEvent('cast-shake',{});
    _petAnimAct = (pet,action,faceUid) => { if(pet)window.__battleEvent('companion',{uid:pet.uid,action,faceUid}); };
    _vfxSlotRect = uid => ({uid});
    _vfxProjectile = (rect,element) => { if(rect?.uid)window.__battleEvent('projectile',{uid:rect.uid,element}); };
    window.__captureBattle = () => {
      if(!player.cls)return;
      const pick = actor => Object.fromEntries(['hp','mhp','mp','mmp','lv','dead','curHp','_downed','_slot','uid','buffs','statuses','poly','_setPoly','_faceTgtUid','avatar','cls','d','eq'].filter(k=>actor[k]!==undefined).map(k=>[k,actor[k]]));
      const companions=[...petsOutList(),...summonRenderList(),...guardRenderList()].map(p=>Object.fromEntries(['uid','form','formGfx','hp','_downed','_diedAt','_faceMobUid'].filter(k=>p[k]!==undefined).map(k=>[k,p[k]])));
      window.__battleFrame({tick:state.ticks,map:mapState.current,targetIdx:mapState.targetIdx,mobs:mapState.mobs,companions,player:{...pick(player),allies:(player.allies||[]).map(a=>a?pick(a):null)}});
      for(const mob of mapState.mobs)if(mob){mob.justHit=false;mob._spellHurt=false;mob._vfxBig=false;}
    };
  `);
}
