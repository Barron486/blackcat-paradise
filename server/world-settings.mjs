import {ApiError} from './service.mjs';
import '../js/loot-rarity.js';
import {MonsterSettings} from './monster-settings.mjs';

const check=(ok,message,status=400)=>{if(!ok)throw new ApiError(status,message);};
const broadcastDefaults=()=>({enabled:true,rarities:[...GameLootRarity.types],generation:0,cursor:0,startedAt:0});
const killDefaults=()=>({enabled:false,monsters:[],generation:0,cursor:0,startedAt:0});
const siegeDefaults=()=>({kent:true,windwood:true,heine:true});
const defaults=()=>({revision:0,goldMultiplier:1,expMultiplier:1,dropMultiplier:1,showDropRates:false,showPlayerLocations:false,lootBroadcast:broadcastDefaults(),killBroadcast:killDefaults(),announcement:null,monsterStrength:1,monsters:{},maps:{},drops:{},siege:siegeDefaults()});
export class WorldSettingsService {
  constructor(service){
    this.service=service;this.db=service.db;
    this.catalog=service.catalog.world||{maps:[],monsters:[],drops:[]};
    this.maps=new Map(this.catalog.maps.map(m=>[m.id,m]));
    this.drops=new Map(this.catalog.drops.map(r=>[r.key,r]));
    this.monsters=new MonsterSettings(this);
    this.db.exec(`CREATE TABLE IF NOT EXISTS world_settings(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS world_settings_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,payload TEXT NOT NULL,before_data TEXT NOT NULL,after_data TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(actor_id,request_id));`);
    this.db.prepare('INSERT OR IGNORE INTO world_settings VALUES(1,?)').run(JSON.stringify(defaults()));
    service.world=this;
  }
  state(){const saved=JSON.parse(this.db.prepare('SELECT data FROM world_settings WHERE id=1').get().data);return {...defaults(),...saved,lootBroadcast:{...broadcastDefaults(),...saved.lootBroadcast},killBroadcast:{...killDefaults(),...saved.killBroadcast},siege:{...siegeDefaults(),...saved.siege}};}
  admin(user){this.service.gm(user);return {settings:this.state(),maps:this.catalog.maps,monsterCount:this.catalog.monsters.length,dropCount:this.catalog.drops.length,location:this.location(user,false),history:this.history(),locationClans:this.service.presence.admin(user)};}
  location(user,required=true){
    const lease=this.db.prepare('SELECT slot,expires_at FROM leases WHERE account_id=?').get(user.id);
    let location=null;
    if(lease?.expires_at>Date.now()&&lease.slot){
      const values=JSON.parse(this.db.prepare('SELECT data FROM saves WHERE account_id=?').get(user.id).data);
      const raw=values['lineage_idle_save_'+lease.slot];
      if(raw){const doc=this.service.catalog.unwrap(raw),map=this.maps.get(doc.ms?.current);if(map)location={mapId:map.id,mapName:map.name,slot:lease.slot};}
    }
    if(required)check(location,'請先用這個 GM 帳號進入遊戲，移動到目的地並完成雲端同步',409);
    return location;
  }
  history(){return this.db.prepare('SELECT w.id,a.username AS actor,w.payload,w.created_at FROM world_settings_audit w JOIN accounts a ON a.id=w.actor_id ORDER BY w.id DESC LIMIT 50').all().map(r=>({...r,command:JSON.parse(r.payload),payload:undefined}));}
  listDrops(user,params){
    this.service.gm(user);const s=this.state(),q=(params.get('q')||'').toLowerCase().slice(0,100),monster=params.get('monster'),page=Math.max(1,Math.min(100000,Number(params.get('page'))||1));
    const rows=this.catalog.drops.filter(r=>(!monster||r.monster===monster)&&(!q||(r.monster+' '+r.itemName+' '+r.itemId).toLowerCase().includes(q))&&(!params.get('modified')||Object.hasOwn(s.drops,r.key)));
    const totalPages=Math.max(1,Math.ceil(rows.length/60)),current=Math.min(totalPages,Math.floor(page));
    const totals=new Map();for(const r of this.catalog.drops)if(r.group){const key=JSON.stringify([r.monster,r.group]);totals.set(key,(totals.get(key)||0)+Math.min(100,(s.drops[r.key]??r.baseRate)*s.dropMultiplier));}
    return {revision:s.revision,multiplier:s.dropMultiplier,total:rows.length,page:current,totalPages,monsters:this.catalog.monsters,rows:rows.slice((current-1)*60,current*60).map(r=>({...r,rate:s.drops[r.key]??r.baseRate,modified:Object.hasOwn(s.drops,r.key),effectiveRate:Math.min(100,(s.drops[r.key]??r.baseRate)*s.dropMultiplier)/Math.max(1,(totals.get(JSON.stringify([r.monster,r.group]))||0)/100)}))};
  }
  update(user,body){
    this.service.gm(user);
    check(typeof body.requestId==='string'&&/^[\w-]{16,80}$/.test(body.requestId),'缺少操作識別碼');
    check(typeof body.reason==='string'&&body.reason.trim().length>=2&&body.reason.length<=200,'請填寫 2～200 字的修改原因');
    const command={type:body.type,reason:body.reason.trim()};
    if(['monsters','monster-strength','kill-broadcast'].includes(body.type))Object.assign(command,this.monsters.command(body));
    else if(body.type==='announcement'){
      check(typeof body.text==='string'&&body.text.trim().length>=1&&body.text.trim().length<=300&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(body.text),'廣播內容須為 1～300 字');
      check(typeof body.pinned==='boolean','置頂設定不正確');
      check(Number.isInteger(body.seconds)&&body.seconds>=10&&body.seconds<=604800,'廣播時間須為 10 秒～7 天');
      Object.assign(command,{text:body.text.trim(),pinned:body.pinned,seconds:body.seconds});
    }else if(body.type==='announcement-clear'){}
    else if(body.type==='global'){
      for(const key of ['goldMultiplier','expMultiplier','dropMultiplier']) {check(typeof body[key]==='number'&&Number.isFinite(body[key])&&body[key]>=0&&body[key]<=1000,'倍率須為 0～1000');command[key]=body[key];}
      check(typeof body.showDropRates==='boolean','掉落率顯示設定須為勾選值');command.showDropRates=body.showDropRates;
    }else if(body.type==='presence'){
      check(typeof body.showPlayerLocations==='boolean','位置公開設定須為勾選值');command.showPlayerLocations=body.showPlayerLocations;
    }else if(body.type==='siege'){
      check(body.castles&&typeof body.castles==='object'&&!Array.isArray(body.castles),'攻城設定不正確');
      const keys=Object.keys(body.castles);check(keys.length===3&&['kent','windwood','heine'].every(key=>keys.includes(key)),'須提供三座城堡的攻城設定');
      for(const key of keys)check(['kent','windwood','heine'].includes(key)&&typeof body.castles[key]==='boolean','城堡攻城開關須為勾選值');
      command.castles=Object.fromEntries(['kent','windwood','heine'].map(key=>[key,body.castles[key]]));
    }else if(body.type==='broadcast'){
      check(typeof body.enabled==='boolean','廣播開關須為勾選值');
      check(Array.isArray(body.rarities)&&body.rarities.every(r=>GameLootRarity.types.includes(r)),'廣播範圍不正確');
      command.enabled=body.enabled;command.rarities=GameLootRarity.types.filter(r=>body.rarities.includes(r));
      check(!command.enabled||command.rarities.length>0,'啟用廣播時請至少選擇一種裝備');
    }else if(body.type==='map'){
      check(this.maps.has(body.mapId),'找不到地圖');check(typeof body.open==='boolean','地圖開放設定不正確');
      check(Number.isInteger(body.minLevel)&&body.minLevel>=1&&body.minLevel<=100,'進入等級須為 1～100');
      check(!body.mapId.startsWith('town_')||(body.open&&body.minLevel===1),'村莊須保持開放，供復活與返回使用');
      Object.assign(command,{mapId:body.mapId,open:body.open,minLevel:body.minLevel});
    }else if(body.type==='drop'){
      check(this.drops.has(body.key),'找不到掉落規則');
      check(body.rate===null||(typeof body.rate==='number'&&Number.isFinite(body.rate)&&body.rate>=0&&body.rate<=100),'掉落率須為 0～100%');
      Object.assign(command,{key:body.key,rate:body.rate});
    }else throw new ApiError(400,'未知世界設定類型');
    return this.service.transaction(()=>{
      const payload=JSON.stringify(command),previous=this.db.prepare('SELECT payload,after_data FROM world_settings_audit WHERE actor_id=? AND request_id=?').get(user.id,body.requestId);
      if(previous){check(previous.payload===payload,'操作識別碼已用於其他修改',409);return {settings:this.state(),replayed:true};}
      const s=this.state();check(body.revision===s.revision,'設定已被其他 GM 修改，請重新整理後再送出',409);
      const before=JSON.stringify(s);
      if(['monsters','monster-strength','kill-broadcast'].includes(command.type))this.monsters.apply(s,command);
      if(command.type==='announcement')s.announcement={id:body.requestId,text:command.text,pinned:command.pinned,startedAt:Date.now(),expiresAt:Date.now()+command.seconds*1000};
      if(command.type==='announcement-clear')s.announcement=null;
      if(command.type==='global')for(const key of ['goldMultiplier','expMultiplier','dropMultiplier','showDropRates'])s[key]=command[key];
      if(command.type==='presence')s.showPlayerLocations=command.showPlayerLocations;
      if(command.type==='siege')s.siege={...command.castles};
      if(command.type==='broadcast')s.lootBroadcast={enabled:command.enabled,rarities:command.rarities,generation:s.lootBroadcast.generation+1,cursor:this.service.lootBroadcasts?.latestId()||0,startedAt:Date.now()};
      if(command.type==='map')s.maps[command.mapId]={open:command.open,minLevel:command.minLevel};
      if(command.type==='drop'){if(command.rate===null)delete s.drops[command.key];else s.drops[command.key]=command.rate;}
      s.revision++;const after=JSON.stringify(s);
      this.db.prepare('UPDATE world_settings SET data=? WHERE id=1').run(after);
      this.db.prepare('INSERT INTO world_settings_audit(actor_id,request_id,payload,before_data,after_data,created_at) VALUES(?,?,?,?,?,?)').run(user.id,body.requestId,payload,before,after,Date.now());
      return {settings:s};
    });
  }
}
