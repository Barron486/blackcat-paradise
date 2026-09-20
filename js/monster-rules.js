// Shared numeric monster rules. Identity, skill types and progression flags stay read-only.
globalThis.GameMonsterRules=Object.freeze({
  respawnFamilies(definitions){
    const parents=new Map(Object.keys(definitions).map(id=>[id,id]));
    const root=id=>{while(parents.get(id)!==id)id=parents.get(id);return id;};
    for(const [id,mob]of Object.entries(definitions))if(parents.has(mob.transformTo))parents.set(root(mob.transformTo),root(id));
    const groups=new Map();for(const id of parents.keys()){const key=root(id);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(id);}
    return Object.fromEntries([...groups.values()].flatMap(ids=>{ids.sort();return ids.map(id=>[id,ids]);}));
  },
  core:Object.freeze({lv:['等級',1,500,1],hp:['HP',1,100000000,1],ac:['AC（越低越強）',-1000,1000,1],mr:['魔防 MR',0,10000,1],hit:['命中',-1000,10000,1],db:['物理附加傷害',0,1000000,1],dr:['傷害減免',0,1000000,1],er:['迴避',0,10000,1],atkSpd:['攻擊間隔（秒，越低越快）',0.1,60,0.1],exp:['基礎經驗',0,100000000,1],goldMin:['金幣下限',0,100000000,1],goldMax:['金幣上限',0,100000000,1],'dmg.0':['物理骰數',1,100,1],'dmg.1':['物理骰面',1,1000000,1]}),
  get(object,path){return path.split('.').reduce((o,k)=>o?.[k],object);},
  fields(base){
    const rows=Object.entries(this.core).map(([path,[label,min,max,step]])=>({path,label,min,max,step,value:this.get(base,path)??(path==='atkSpd'?1:0)}));
    const names={atkDoubleChance:'連擊機率',regenFix:'固定回血',regenHp:'回血',rageHpPct:'狂暴血量比例',rageHitMult:'狂暴命中倍率',rageDmgMult:'狂暴傷害倍率',cd:'冷卻（tick）',chance:'觸發機率',db:'附加傷害',d:'持續傷害',dur:'持續時間',tick:'觸發間隔',pbase:'基礎成功率',hpPct:'HP 比例',mpPct:'MP 比例'};
    const visit=(object,prefix='')=>{for(const [key,value]of Object.entries(object||{})){
      const path=prefix?prefix+'.'+key:key;
      if(Object.hasOwn(this.core,path))continue;
      if(typeof value==='number'&&Number.isFinite(value)){
        const fraction=/chance$|Pct$/i.test(key),dice=path.endsWith('.dmg.0'),positive=dice||path.endsWith('.dmg.1')||['cd','tick'].includes(key);
        rows.push({path,label:(prefix?prefix+' · ':'')+(names[key]||key),min:positive?1:0,max:fraction?(value<=1?1:100):dice?100:1000000,step:fraction?0.01:Number.isInteger(value)?1:0.1,value});
      }else if(value&&typeof value==='object')visit(value,path);
    }};
    for(const key of ['atkDoubleChance','regenFix','regenHp','rageHpPct','rageHitMult','rageDmgMult','mag','mag2','mag3','mag4','mag5'])if(base[key]!==undefined)visit({[key]:base[key]});
    return rows;
  },
  set(object,path,value){const parts=path.split('.');let target=object;for(const key of parts.slice(0,-1))target=target[key]||(target[key]={});target[parts.at(-1)]=value;},
  apply(base,rule={},globalStrength=1){
    const result=JSON.parse(JSON.stringify(base));
    for(const [path,value]of Object.entries(rule.values||{}))this.set(result,path,value);
    const factor=(rule.strength??1)*globalStrength;
    if(factor!==1){
      result.hp=Math.max(1,Math.min(100000000,Math.round(result.hp*factor)));
      const scale=object=>{if(!object||typeof object!=='object')return;for(const [key,value]of Object.entries(object)){
        if(key==='dmg'&&Array.isArray(value))object[key]=[value[0],Math.max(1,Math.min(1000000,Math.round(value[1]*factor)))];
        else if(['db','d','ddBase'].includes(key)&&typeof value==='number')object[key]=Math.max(0,Math.min(1000000,Math.round(value*factor)));
        else if(value&&typeof value==='object'&&!Array.isArray(value))scale(value);
      }};scale(result);
    }
    return result;
  }
});
