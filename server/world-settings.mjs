import {ApiError} from './service.mjs';

const check=(ok,message,status=400)=>{if(!ok)throw new ApiError(status,message);};
const defaults=()=>({revision:0,goldMultiplier:1,expMultiplier:1,dropMultiplier:1,showDropRates:false,maps:{},drops:{}});
export class WorldSettingsService {
  constructor(service){
    this.service=service;this.db=service.db;
    this.catalog=service.catalog.world||{maps:[],monsters:[],drops:[]};
    this.maps=new Map(this.catalog.maps.map(m=>[m.id,m]));
    this.drops=new Map(this.catalog.drops.map(r=>[r.key,r]));
    this.db.exec(`CREATE TABLE IF NOT EXISTS world_settings(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS world_settings_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,payload TEXT NOT NULL,before_data TEXT NOT NULL,after_data TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(actor_id,request_id));`);
    this.db.prepare('INSERT OR IGNORE INTO world_settings VALUES(1,?)').run(JSON.stringify(defaults()));
    service.world=this;
  }
  state(){return JSON.parse(this.db.prepare('SELECT data FROM world_settings WHERE id=1').get().data);}
  admin(user){this.service.gm(user);return {settings:this.state(),maps:this.catalog.maps,monsterCount:this.catalog.monsters.length,dropCount:this.catalog.drops.length,location:this.location(user,false),history:this.history()};}
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
    if(body.type==='global'){
      for(const key of ['goldMultiplier','expMultiplier','dropMultiplier']) {check(typeof body[key]==='number'&&Number.isFinite(body[key])&&body[key]>=0&&body[key]<=1000,'倍率須為 0～1000');command[key]=body[key];}
      check(typeof body.showDropRates==='boolean','掉落率顯示設定須為勾選值');command.showDropRates=body.showDropRates;
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
      if(command.type==='global')for(const key of ['goldMultiplier','expMultiplier','dropMultiplier','showDropRates'])s[key]=command[key];
      if(command.type==='map')s.maps[command.mapId]={open:command.open,minLevel:command.minLevel};
      if(command.type==='drop'){if(command.rate===null)delete s.drops[command.key];else s.drops[command.key]=command.rate;}
      s.revision++;const after=JSON.stringify(s);
      this.db.prepare('UPDATE world_settings SET data=? WHERE id=1').run(after);
      this.db.prepare('INSERT INTO world_settings_audit(actor_id,request_id,payload,before_data,after_data,created_at) VALUES(?,?,?,?,?,?)').run(user.id,body.requestId,payload,before,after,Date.now());
      return {settings:s};
    });
  }
}
