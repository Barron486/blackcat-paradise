import {createHash} from 'node:crypto';

const slotKey=slot=>'lineage_idle_save_'+slot;
function readCharacter(service,values,slot){
  try{const doc=service.catalog.unwrap(values[slotKey(slot)]);return doc?.p?.cls?doc:null;}catch{return null;}
}
export function characterName(service,accountId){
  const row=service.db.prepare('SELECT s.data,l.slot FROM saves s LEFT JOIN leases l ON l.account_id=s.account_id WHERE s.account_id=?').get(accountId);
  if(!row)return '冒險者';
  const values=JSON.parse(row.data),slots=[row.slot,...Array.from({length:8},(_,i)=>i+1)].filter(Boolean);
  for(const slot of slots){const doc=readCharacter(service,values,slot);if(doc)return doc.p.name||'未命名';}
  return '冒險者';
}
export function onlineCharacters(service){
  const maps=new Map((service.catalog.world?.maps||[]).map(m=>[m.id,m.name]));
  return service.db.prepare('SELECT l.account_id,l.slot,s.data,s.updated_at FROM leases l JOIN saves s ON s.account_id=l.account_id WHERE l.expires_at>? ORDER BY l.account_id').all(Date.now()).map(row=>{
    const doc=row.slot?readCharacter(service,JSON.parse(row.data),row.slot):null,p=doc?.p;
    const epoch=p?._roleEpoch||p?.enSeed;
    return {accountId:row.account_id,slot:row.slot,epoch,p,savedAt:row.updated_at,
      id:p&&epoch?createHash('sha256').update(JSON.stringify([row.account_id,row.slot,epoch])).digest('hex'):null,
      name:p?(p.name||'未命名'):'角色選擇中',map:p?(maps.get(doc.ms?.current)||doc.ms?.current||'未知位置'):'角色選擇'};
  });
}
const slots={wpn:'武器',arrow:'箭矢',helm:'頭盔',armor:'盔甲',shin:'脛甲',shield:'盾牌',cloak:'斗篷',tshirt:'內衣',gloves:'手套',boots:'靴子',ring1:'戒指 1',ring2:'戒指 2',ring3:'戒指 3',ring4:'戒指 4',amulet:'項鍊',ear1:'耳環 1',ear2:'耳環 2',belt:'腰帶',pet:'寵物',doll:'魔法娃娃'};
const number=(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback;
const stat=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
export function inspectionReport(service,target){
  const p=target.p,maxHp=Math.max(0,number(p.mhp)),maxMp=Math.max(0,number(p.mmp));
  return {name:target.name,level:number(p.lv,1),hp:Math.max(0,number(p.hp)),maxHp,mp:Math.max(0,number(p.mp)),maxMp,
    alignment:Math.max(-32767,Math.min(32767,Math.round(number(p.alignmentValue)))),map:target.map,inspectedAt:Date.now(),savedAt:target.savedAt,
    attributes:Object.fromEntries(['str','dex','con','int','wis','cha'].map(key=>[key,stat(p.d?.[key])??stat(p.base?.[key])])),
    defenses:{ac:stat(p.d?.ac),mr:stat(p.d?.mr)},
    equipment:Object.entries(slots).map(([slot,label])=>{
      const item=p.eq?.[slot],definition=item&&service.catalog.items[item.id];
      if(!definition)return {slot,label,item:null};
      const enchant=number(item.en),prefix=[item.anc?'遠古':'',item.bless===true?'祝福的':item.bless==='cursed'?'詛咒的':'',item.attr?'賦予的':'',enchant?(enchant>0?'+':'')+enchant:''].filter(Boolean).join(' ');
      return {slot,label,item:{name:(prefix?prefix+' ':'')+definition.n,description:definition.d||''}};
    })};
}
