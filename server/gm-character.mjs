import {ApiError} from './service.mjs';
import {itemGrantRules} from './item-rules.mjs';

const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const natural=value=>Number.isSafeInteger(value)&&value>=0;
const attributes=['str','dex','con','int','wis','cha'];
const sharedKey=/^(?:lineage_idle_(?:warehouse|equipdex|miscdex|carddex|relicdex)(?:_classic)?|fb5_pet_roster(?:_classic)?|fb5_clan_state_v1|fb5_mercenary_employment_v1_(?:normal|classic))$/;

// Inspect persisted game data only. Do not load an engine, acquire a lease,
// refresh buffs, or write a checkpoint when an administrator opens this view.
export function gmCharacterReport(service,user,accountId,slot){
  service.gm(user);
  if(typeof accountId!=='string'||accountId.length>80||!Number.isInteger(slot)||slot<1||slot>8)throw new ApiError(400,'帳號或角色欄位不正確');
  const row=service.db.prepare(`SELECT a.id,a.username,a.role,a.created_at,s.data,s.revision,s.updated_at,l.slot AS active_slot,l.expires_at
    FROM accounts a JOIN saves s ON s.account_id=a.id LEFT JOIN leases l ON l.account_id=a.id WHERE a.id=?`).get(accountId);
  if(!row)throw new ApiError(404,'找不到指定帳號');
  const values=JSON.parse(row.data),key='lineage_idle_save_'+slot;
  if(!values[key])throw new ApiError(404,'此欄位沒有角色，可能已刪除，請更新玩家名單');
  let snapshot;
  try{snapshot=service.catalog.unwrap(values[key]);}catch{throw new ApiError(422,'此角色存檔無法解碼，請檢查伺服器備份');}
  if(!object(snapshot?.p))throw new ApiError(422,'此角色存檔缺少角色資料');
  const p=snapshot.p,issues=[],shared={};let issueCount=0;
  const issue=(code,path,message)=>{issueCount++;if(issues.length<200)issues.push({code,path,message});};
  for(const [name,raw]of Object.entries(values))if(sharedKey.test(name)){
    try{shared[name]=service.catalog.unwrap(raw);}catch{issue('unreadable_shared',name,'共用資料無法解碼，需查核備份');}
  }
  if(!['royal','knight','mage','elf','dark','illusion','dragon','warrior'].includes(p.cls))issue('invalid_class','p.cls','職業代碼不符合規則');
  if(!Number.isInteger(p.lv)||p.lv<1||p.lv>100)issue('invalid_level','p.lv','等級須介於 1～100');
  for(const field of ['gold','exp','bonus','panaceaUsed'])if(p[field]!==undefined&&!natural(p[field]))issue('invalid_number','p.'+field,'應為非負安全整數');
  for(const field of ['hp','mhp','mp','mmp'])if(typeof p[field]!=='number'||!Number.isFinite(p[field])||p[field]<0)issue('invalid_vital','p.'+field,'血魔數值格式不合法');
  for(const group of ['base','alloc','panacea','d']){
    if(!object(p[group])){if(p[group]!==undefined)issue('invalid_stats','p.'+group,'能力資料格式不合法');continue;}
    for(const stat of attributes)if(p[group][stat]!==undefined&&!(group==='d'?typeof p[group][stat]==='number'&&Number.isFinite(p[group][stat])&&p[group][stat]>=0:natural(p[group][stat])))issue('invalid_stats',`p.${group}.${stat}`,'能力值格式不合法');
  }
  if((p.panaceaUsed||0)>60||attributes.reduce((sum,key)=>sum+(Number(p.panacea?.[key])||0),0)>60)issue('invalid_panacea','p.panacea','萬能藥使用點數超過 60');
  if(p.dead&&p.hp>0)issue('death_health','p.hp','死亡角色仍有生命值，需查核狀態');
  if(!Array.isArray(p.inv))issue('invalid_inventory','p.inv','背包格式不合法');
  if(!object(p.eq))issue('invalid_equipment','p.eq','裝備欄格式不合法');
  const itemCatalog={},uids=new Map();
  function inspectItem(item,path){
    if(!object(item)){issue('invalid_item',path,'道具格式不合法');return;}
    const definition=Object.hasOwn(service.catalog.items,item.id)?service.catalog.items[item.id]:null;
    if(!definition)issue('unknown_item',path+'.id','道具 ID 不在目前物品庫內');
    else{
      itemCatalog[item.id]={name:definition.n,description:definition.d||'',type:definition.type,...itemGrantRules(definition)};
      if(item.en!==undefined&&(!Number.isInteger(item.en)||item.en < -1||item.en>itemGrantRules(definition).maxEnchant))issue('invalid_enchantment',path+'.en','強化值超過此物品上限或格式不合法');
    }
    if(item.cnt!==undefined&&(!natural(item.cnt)||item.cnt<1))issue('invalid_quantity',path+'.cnt','物品數量應為正整數');
    if(item.uid!==undefined){
      if(typeof item.uid!=='string'||!item.uid||item.uid.length>200)issue('invalid_uid',path+'.uid','物品識別碼格式不合法');
      else if(uids.has(item.uid))issue('duplicate_item',path+'.uid','與 '+uids.get(item.uid)+' 使用相同物品識別碼');
      else uids.set(item.uid,path);
    }
  }
  if(Array.isArray(p.inv))p.inv.forEach((item,i)=>inspectItem(item,`p.inv[${i}]`));
  if(object(p.eq))for(const [slot,item]of Object.entries(p.eq))if(item)inspectItem(item,'p.eq.'+slot);
  // Warehouse contents are shared by same-mode characters, not owned by one slot.
  const warehouseKey='lineage_idle_warehouse'+(p.classicMode?'_classic':''),warehouse=shared[warehouseKey];
  if(object(warehouse)&&Array.isArray(warehouse.items)){
    warehouse.items.forEach((item,i)=>inspectItem(item,`${warehouseKey}.items[${i}]`));
    if(warehouse.gold!==undefined&&!natural(warehouse.gold))issue('invalid_gold',warehouseKey+'.gold','倉庫金幣格式不合法');
  }
  else if(warehouse!==undefined)issue('invalid_warehouse',warehouseKey,'倉庫資料格式不合法');
  const epoch=p._roleEpoch||p.enSeed;
  const identity=typeof epoch==='string'?service.db.prepare('SELECT account_id,slot_key FROM character_epochs WHERE epoch=?').get(epoch):null;
  if(!identity||identity.account_id!==accountId||identity.slot_key!==key)issue('character_identity','p._roleEpoch','角色識別碼與伺服器登記不符，需查核歷史存檔');
  const clan=service.db.prepare('SELECT c.name FROM clan_members m JOIN clans c ON c.id=m.clan_id WHERE m.account_id=?').get(accountId);
  const session=service.authority?service.db.prepare('SELECT slot,paused,running FROM game_sessions WHERE account_id=?').get(accountId):null;
  const wallet=service.commerce?service.db.prepare('SELECT diamonds,rename_cards AS renameCards,password_cards AS passwordCards FROM wallets WHERE account_id=?').get(accountId):null;
  const security=service.db.prepare(`SELECT id,slot_key AS slotKey,code,created_at AS at FROM save_security_events WHERE account_id=? AND (slot_key=? OR slot_key='all') ORDER BY id DESC LIMIT 50`).all(accountId,key);
  const effects=service.db.prepare(`SELECT revision,save_key AS slotKey,payload FROM gm_effects WHERE account_id=? AND save_key=? AND json_extract(payload,'$.action') IN ('buff_all','kill','grant_item','revive','clear_buffs','teleport','restore_progress') ORDER BY id DESC LIMIT 30`).all(accountId,key).map(({payload,...row})=>({...row,effect:JSON.parse(payload)}));
  const gmSeqs=[...new Set(effects.map(e=>e.effect.seq).filter(Number.isSafeInteger))];
  const commands=gmSeqs.length?service.db.prepare(`SELECT c.seq,c.created_at AS at,a.username AS actor,c.payload FROM gm_commands c JOIN accounts a ON a.id=c.actor_id WHERE c.seq IN (${gmSeqs.map(()=>'?').join(',')}) ORDER BY c.seq DESC`).all(...gmSeqs).map(({payload,...row})=>({...row,command:JSON.parse(payload)})):[];
  const ledger=service.commerce?service.commerce.history(accountId):[];
  const market=service.market?service.db.prepare(`SELECT id,seller_name AS sellerName,currency,price,status,created_at AS at,closed_at AS closedAt,item,
    CASE WHEN seller_id=? THEN 'sell' ELSE 'buy' END AS direction FROM market_listings WHERE seller_id=? OR buyer_id=? ORDER BY COALESCE(closed_at,created_at) DESC LIMIT 30`).all(accountId,accountId,accountId).map(({item,...r})=>({...r,item:JSON.parse(item)})):[];
  return {format:'black-cat-gm-character-report',readOnly:true,checkedAt:Date.now(),savedAt:row.updated_at,revision:row.revision,slot,
    account:{id:row.id,username:row.username,role:row.role,createdAt:row.created_at,clanName:clan?.name||'',online:row.expires_at>Date.now(),activeSlot:row.active_slot},
    serverAuthoritative:!!service.authority,session:session?{slot:session.slot,paused:!!session.paused,running:!!session.running}:null,
    wallet:wallet||{diamonds:0,renameCards:0,passwordCards:0},goldProceeds:service.market?.gold(accountId)||0,
    mapName:service.catalog.world?.maps?.find(m=>m.id===snapshot.ms?.current)?.name||snapshot.ms?.current||'未知位置',
    expRequired:p.lv>=100?null:service.catalog.experience?.[p.lv]||null,snapshot,shared,warehouseKey,itemCatalog,
    skills:Object.fromEntries((Array.isArray(p.skills)?p.skills:[]).map(id=>[id,service.catalog.skills[id]?.n||id])),
    checks:{issues,issueCount,notice:'檢查結構、物品上限與角色識別；高數值可能來自合法裝備、增益或 GM 發放。此結果不是作弊定論，不會自動處罰。'},
    history:{security,commands,ledger,market}};
}
