import {ApiError} from './service.mjs';
import '../js/monster-rules.js';
const check=(ok,message)=>{if(!ok)throw new ApiError(400,message);};
const strength=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0.1&&value<=20;
export class MonsterSettings {
  constructor(world){this.world=world;this.rows=world.catalog.creatures||[];this.byId=new Map(this.rows.map(m=>[m.id,m]));this.respawnFamilies=GameMonsterRules.respawnFamilies(Object.fromEntries(this.rows.map(m=>[m.id,m.data])));}
  list(user,params){
    this.world.service.gm(user);const state=this.world.state(),q=(params.get('q')||'').trim().toLowerCase().slice(0,100);
    const rows=this.rows.filter(m=>(!q||(m.id+' '+m.name+' '+m.data.race).toLowerCase().includes(q))&&(!params.get('boss')||m.boss)&&(!params.get('modified')||state.monsters[m.id])&&(!params.get('map')||m.maps.some(map=>map.id===params.get('map'))));
    const size=params.get('all')==='1'?Math.max(1,rows.length):40,totalPages=Math.max(1,Math.ceil(rows.length/size)),page=Math.max(1,Math.min(totalPages,Math.floor(Number(params.get('page'))||1)));
    return {revision:state.revision,strength:state.monsterStrength,broadcast:state.killBroadcast,announcement:state.announcement,total:rows.length,totalPages,page,ids:rows.map(m=>m.id),maps:this.world.catalog.maps,
      rows:rows.slice((page-1)*size,page*size).map(m=>({...m,respawnFamily:this.respawnFamilies[m.id],rule:state.monsters[m.id]||{},effective:GameMonsterRules.apply(m.data,state.monsters[m.id],state.monsterStrength),fields:GameMonsterRules.fields(m.data),broadcast:state.killBroadcast.monsters.includes(m.id)}))};
  }
  command(body){
    if(body.type==='monster-strength'){check(strength(body.strength),'強度倍率須為 0.1～20');return {strength:body.strength};}
    if(body.type==='kill-broadcast'){
      check(typeof body.enabled==='boolean','擊殺廣播開關不正確');
      check(Array.isArray(body.monsters)&&body.monsters.length<=this.rows.length&&body.monsters.every(id=>this.byId.has(id)),'廣播怪物清單不正確');
      return {enabled:body.enabled,monsters:[...new Set(body.monsters)].sort()};
    }
    check(Array.isArray(body.ids)&&body.ids.length>0&&body.ids.length<=this.rows.length&&body.ids.every(id=>this.byId.has(id)),'請選擇有效的怪物');
    const command={ids:[...new Set(body.ids)].sort()};
    if(body.reset!==undefined){check(body.reset===true,'重設設定不正確');command.reset=true;}
    if(body.strength!==undefined){check(body.strength===null||strength(body.strength),'個別強度倍率須為 0.1～20');command.strength=body.strength;}
    if(body.broadcast!==undefined){check(typeof body.broadcast==='boolean','擊殺廣播須為勾選值');command.broadcast=body.broadcast;}
    if(body.respawnSeconds!==undefined){check(body.respawnSeconds===null||Number.isInteger(body.respawnSeconds)&&body.respawnSeconds>=1&&body.respawnSeconds<=604800,'重生間隔須為 1 秒～7 天的整數秒數，或恢復原本規則');command.respawnSeconds=body.respawnSeconds;}
    if(body.values!==undefined){
      check(body.values&&typeof body.values==='object'&&!Array.isArray(body.values)&&Object.keys(body.values).length<=150,'怪物能力欄位不正確');
      command.values={};
      for(const id of command.ids){const fields=new Map(GameMonsterRules.fields(this.byId.get(id).data).map(f=>[f.path,f]));
        for(const [path,value]of Object.entries(body.values)){
          const field=fields.get(path);check(field,`${this.byId.get(id).name} 沒有可調整的 ${path} 欄位`);
          check(value===null||typeof value==='number'&&Number.isFinite(value)&&value>=field.min&&value<=field.max&&(field.step!==1||Number.isInteger(value)),`${field.label} 須為 ${field.min}～${field.max}${field.step===1?' 的整數':''}`);
          command.values[path]=value;
        }
      }
    }
    check(command.reset||command.strength!==undefined||command.broadcast!==undefined||command.respawnSeconds!==undefined||Object.keys(command.values||{}).length,'沒有選擇要修改的項目');
    return command;
  }
  apply(state,command){
    if(command.type==='monster-strength'){state.monsterStrength=command.strength;return;}
    if(command.type==='kill-broadcast'){this.broadcast(state,command.enabled,command.monsters);return;}
    for(const id of command.ids){
      const original=state.monsters[id]||{},rule=command.reset?(original.respawnSeconds===undefined?{}:{respawnSeconds:original.respawnSeconds}):structuredClone(original);
      if(command.strength!==undefined){if(command.strength===null||command.strength===1)delete rule.strength;else rule.strength=command.strength;}
      for(const [path,value]of Object.entries(command.values||{})){rule.values||={};if(value===null)delete rule.values[path];else rule.values[path]=value;}
      const result=GameMonsterRules.apply(this.byId.get(id).data,rule);
      check((result.goldMax??0)>=(result.goldMin??0),'金幣上限不得小於下限（整批未儲存）');
      if(rule.values&&!Object.keys(rule.values).length)delete rule.values;
      if(Object.keys(rule).length)state.monsters[id]=rule;else delete state.monsters[id];
    }
    if(command.respawnSeconds!==undefined)for(const id of new Set(command.ids.flatMap(id=>this.respawnFamilies[id]))){
      const rule=state.monsters[id]||{};
      if(command.respawnSeconds===null)delete rule.respawnSeconds;else rule.respawnSeconds=command.respawnSeconds;
      if(Object.keys(rule).length)state.monsters[id]=rule;else delete state.monsters[id];
    }
    if(command.broadcast!==undefined){const selected=new Set(state.killBroadcast.monsters);for(const id of command.ids){if(command.broadcast)selected.add(id);else selected.delete(id);}this.broadcast(state,state.killBroadcast.enabled,[...selected].sort());}
  }
  broadcast(state,enabled,monsters){state.killBroadcast={enabled,monsters,generation:state.killBroadcast.generation+1,cursor:this.world.service.killBroadcasts?.latestId()||0,startedAt:Date.now()};}
}
