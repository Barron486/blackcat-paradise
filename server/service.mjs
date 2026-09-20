import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { applyEffect } from '../shared/gm-effects.js';
import {fullStatusBuffIds} from '../shared/full-status.js';
import { itemGrantRules, rollWishes } from './item-rules.mjs';
import {characterName,onlineCharacters} from './characters.mjs';
import {PresenceService} from './presence.mjs';
import {SaveGuard} from './save-guard.mjs';

const scrypt = promisify(scryptCallback);
const hash = s => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const SLOT = /^lineage_idle_save_([1-8])$/;
const CLASSES = ['royal','knight','mage','elf','dark','illusion','dragon','warrior'];
export class ApiError extends Error {
  constructor(status, message, details = {}) { super(message); this.status = status; this.details = details; }
}
const requireValue = (condition, message, status = 400) => { if (!condition) throw new ApiError(status, message); };

export class GameService {
  constructor(filename, catalog) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.catalog = catalog;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('player','gm')), created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
        csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);
      CREATE TABLE IF NOT EXISTS saves(account_id TEXT PRIMARY KEY REFERENCES accounts(id), data TEXT NOT NULL DEFAULT '{}',
        revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS leases(account_id TEXT PRIMARY KEY REFERENCES accounts(id), token TEXT NOT NULL,
        expires_at INTEGER NOT NULL, display_name TEXT, slot INTEGER, map_name TEXT);
      CREATE TABLE IF NOT EXISTS gm_commands(seq INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL REFERENCES accounts(id),
        request_id TEXT NOT NULL, payload TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL, UNIQUE(actor_id,request_id));
      CREATE TABLE IF NOT EXISTS gm_effects(id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES accounts(id),
        revision INTEGER NOT NULL, save_key TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS effects_account_revision ON gm_effects(account_id,revision);
      CREATE TABLE IF NOT EXISTS chat(id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES accounts(id),
        text TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_account_time ON chat(account_id,created_at);
      CREATE TABLE IF NOT EXISTS ai_chat_messages(chat_id INTEGER PRIMARY KEY REFERENCES chat(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,model TEXT NOT NULL,provider TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS role_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL,
        account_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS character_epochs(epoch TEXT PRIMARY KEY,account_id TEXT NOT NULL,slot_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS clans(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,leader_id TEXT NOT NULL REFERENCES accounts(id),created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS clan_members(clan_id TEXT NOT NULL REFERENCES clans(id) ON DELETE CASCADE,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,joined_at INTEGER NOT NULL,PRIMARY KEY(clan_id,account_id),UNIQUE(account_id));
    `);
    if(!this.db.prepare('PRAGMA table_info(chat)').all().some(c=>c.name==='character_name'))this.db.exec('ALTER TABLE chat ADD COLUMN character_name TEXT');
    this.presence=new PresenceService(this);
    this.saveGuard=new SaveGuard(this);
    // Keep past character identities after deletion so exported characters cannot be cloned or restored as new ones.
    for(const row of this.db.prepare('SELECT account_id,data FROM saves').all())for(const [key,raw]of Object.entries(JSON.parse(row.data))){
      if(!SLOT.test(key))continue;
      try{const p=this.catalog.unwrap(raw).p,epoch=p._roleEpoch||p.enSeed;if(epoch)this.db.prepare('INSERT OR IGNORE INTO character_epochs VALUES(?,?,?)').run(epoch,row.account_id,key);}catch{}
    }
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  hasGm() { return !!this.db.prepare("SELECT 1 FROM accounts WHERE role='gm'").get(); }
  async register(username, password, { initialGm = false } = {}) {
    requireValue(typeof username === 'string' && /^[A-Za-z0-9_]{3,24}$/.test(username), '帳號須為 3～24 個英文字母、數字或底線');
    requireValue(typeof password === 'string' && password.length >= 12 && password.length <= 128, '密碼長度須為 12～128 字');
    const salt = token();
    const digest = (await scrypt(password, salt, 64)).toString('hex');
    return this.transaction(() => {
      if (initialGm) requireValue(!this.hasGm(), 'GM 已建立，首次設定已關閉', 409);
      const id = randomUUID();
      try {
        this.db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?)').run(id, username, digest, salt, initialGm ? 'gm' : 'player', Date.now());
      } catch (e) { if (String(e).includes('UNIQUE')) throw new ApiError(409, '這個帳號已存在'); throw e; }
      this.db.prepare('INSERT INTO saves(account_id,updated_at) VALUES(?,?)').run(id, Date.now());
      return { id, username, role: initialGm ? 'gm' : 'player' };
    });
  }
  async login(username, password) {
    requireValue(typeof username === 'string' && username.length <= 24 && typeof password === 'string' && password.length <= 128, '帳號或密碼不正確', 401);
    const account = this.db.prepare('SELECT * FROM accounts WHERE username=? COLLATE NOCASE').get(username);
    const candidate = await scrypt(password, account?.salt || 'invalid-account-timing-pad', 64);
    requireValue(account && timingSafeEqual(candidate, Buffer.from(account.password_hash, 'hex')), '帳號或密碼不正確', 401);
    const session = token(), csrf = token();
    this.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(session), account.id, csrf, Date.now() + 7 * 86400000);
    return { session, csrf, user: { id: account.id, username: account.username, role: account.role } };
  }
  authenticate(session) {
    if (!session) throw new ApiError(401, '請先登入');
    const user = this.db.prepare('SELECT a.id,a.username,a.role,s.csrf FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.expires_at>?').get(hash(session), Date.now());
    if (!user) throw new ApiError(401, '登入已過期，請重新登入');
    return user;
  }
  logout(session) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(session)); }
  gameSessionCsrf(user, csrf) {
    // Signing into the same account in another tab replaces the shared cookie.
    // An open game may still use its original, unexpired session's CSRF token.
    // This compatibility path is only used for lease/sync, never GM mutations.
    return typeof csrf==='string'&&csrf.length>=32&&csrf.length<=128&&!!this.db.prepare(
      'SELECT 1 FROM sessions WHERE account_id=? AND csrf=? AND expires_at>?'
    ).get(user.id,csrf,Date.now());
  }
  gm(user) {
    // Re-read the role for every request; a stale session cannot retain revoked privileges.
    requireValue(this.db.prepare('SELECT role FROM accounts WHERE id=?').get(user.id)?.role === 'gm', '此操作需要 GM 權限', 403);
  }
  bootstrap(user) {
    const save = this.db.prepare('SELECT * FROM saves WHERE account_id=?').get(user.id);
    return { user: { id:user.id, username:user.username, role:user.role }, csrf:user.csrf,
      revision:save.revision, values:JSON.parse(save.data), serverTime:Date.now(), version:this.catalog.version, authoritative:!!this.authority, worldSettings:this.world?.state(), lootBroadcastCursor:this.lootBroadcasts?.latestId()||0,killBroadcastCursor:this.killBroadcasts?.latestId()||0 };
  }
  acquireLease(user, id, takeover = false) {
    requireValue(typeof id === 'string' && /^[\w-]{20,80}$/.test(id), '遊戲視窗識別碼不正確');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM leases WHERE account_id=?').get(user.id);
      requireValue(!existing || existing.expires_at < Date.now() || existing.token === id || takeover, '這個帳號正在其他視窗遊玩，請關閉另一個視窗或按「接管遊戲」', 423);
      this.db.prepare('INSERT INTO leases(account_id,token,expires_at) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at').run(user.id,id,Date.now()+45000);
      return { ok:true };
    });
  }
  checkLease(user, id) {
    const lease=this.db.prepare('SELECT * FROM leases WHERE account_id=?').get(user.id);
    requireValue(lease && lease.token===id, '遊戲控制權已由其他視窗接管', 423);
    this.db.prepare('UPDATE leases SET expires_at=? WHERE account_id=?').run(Date.now()+45000,user.id);
  }
  effects(user, revision) {
    return this.db.prepare('SELECT save_key,payload FROM gm_effects WHERE account_id=? AND revision>? ORDER BY id').all(user.id,revision)
      .map(r=>({ key:r.save_key,...JSON.parse(r.payload) }));
  }
  sync(user, id, revision, changes, presence = {}) {
    requireValue(Number.isSafeInteger(revision) && revision>=0, '存檔版本不正確');
    requireValue(changes && typeof changes==='object' && !Array.isArray(changes) && Object.keys(changes).length<=300, '存檔更新格式不正確');
    try { return this.transaction(() => {
      this.checkLease(user,id);
      const row=this.db.prepare('SELECT * FROM saves WHERE account_id=?').get(user.id);
      if (revision!==row.revision) throw new ApiError(409,'雲端存檔已有更新',{snapshot:this.bootstrap(user),effects:this.effects(user,revision)});
      const values=JSON.parse(row.data);
      for(const [key,incoming] of Object.entries(changes)) {
        let value=incoming;
        requireValue(/^(lineage_|fb5_)[\w:-]{1,170}$/.test(key), '不支援的存檔欄位');
        requireValue(value===null || (typeof value==='string' && value.length<=8_000_000),'存檔內容過大');
        if(SLOT.test(key) && value!==null) {
          let doc;
          try { doc=this.catalog.unwrap(value); } catch { throw new ApiError(400,'角色存檔無法讀取'); }
          requireValue(doc?.p && CLASSES.includes(doc.p.cls) && Array.isArray(doc.p.inv) && doc.p.inv.length<=20000 && Number.isInteger(doc.p.lv) && doc.p.lv>=1 && doc.p.lv<=100,'角色資料格式不正確');
          if(values[key]) {
            const prior=this.catalog.unwrap(values[key]);
            if(this.saveGuard.validate(key,prior,doc))value=this.catalog.wrap(doc);
            this.market?.guard(user,key,prior,doc);
            requireValue((prior.p._roleEpoch||prior.p.enSeed)===(doc.p._roleEpoch||doc.p.enSeed),'禁止以匯入存檔替換角色',403);
            requireValue(prior.p.cls===doc.p.cls&&prior.p.avatar===doc.p.avatar&&prior.p.enSeed===doc.p.enSeed&&!!prior.p.classicMode===!!doc.p.classicMode,'角色職業與身分不可透過存檔修改',403);
            if((prior.p.name||'')!==(doc.p.name||''))throw new ApiError(409,'角色更名必須使用更名卡',{snapshot:this.bootstrap(user),effects:this.effects(user,revision),nameConflict:true});
            if((prior.p._roleEpoch || prior.p.enSeed)===(doc.p._roleEpoch || doc.p.enSeed)) {
              requireValue((doc.p._gmSeq||0)>=(prior.p._gmSeq||0),'尚未套用 GM 指令，請重新同步',409);
              // Older open tabs acknowledge the command sequence but do not know the
              // teleport fields. Preserve the server command instead of blocking all
              // subsequent earned progress until that tab is reloaded.
              const canonical=prior.p._gmTeleport;
              if(JSON.stringify(doc.p._gmTeleport||null)!==JSON.stringify(canonical||null)) {
                if(canonical)doc.p._gmTeleport={...canonical};else delete doc.p._gmTeleport;
                value=this.catalog.wrap(doc);
              }
            }
          } else {
            this.saveGuard.validate(key,null,doc);
            const epoch=doc.p._roleEpoch||doc.p.enSeed;
            requireValue(typeof epoch==='string'&&epoch.length>0&&epoch.length<=200,'新角色識別碼不正確');
            requireValue(!this.db.prepare('SELECT 1 FROM character_epochs WHERE epoch=?').get(epoch),'禁止複製角色或重新匯入已刪除角色',403);
            requireValue(doc.p.lv===1&&(doc.p.exp??0)===0&&(doc.p.gold??1000)===1000&&(doc.ticks??0)===0&&!doc.p._gmSeq&&!doc.p._gmDead&&!doc.p._marketSeq&&!doc.p._shopBuffSeq&&!doc.p._shopBuffs,'新角色必須從初始進度建立，禁止匯入存檔',403);
            requireValue(typeof doc.p.name==='string'&&doc.p.name.trim().length>=1&&doc.p.name.length<=12&&!/[<>&"'\x00-\x1f\x7f]/.test(doc.p.name),'角色名稱須為 1～12 個有效字元');
            this.db.prepare('INSERT INTO character_epochs VALUES(?,?,?)').run(epoch,user.id,key);
          }
          if(values[key]&&this.commerce?.restoreBuffs(this.catalog.unwrap(values[key]),doc))value=this.catalog.wrap(doc);
          this.lootBroadcasts?.record(user,values[key]?this.catalog.unwrap(values[key]):null,doc);
        }
        if(value===null) delete values[key]; else values[key]=value;
      }
      const data=JSON.stringify(values);
      requireValue(data.length<=32_000_000,'帳號存檔已超過 32 MB 上限');
      const next=revision+(Object.keys(changes).length?1:0);
      if(next!==revision) this.db.prepare('UPDATE saves SET data=?,revision=?,updated_at=? WHERE account_id=?').run(data,next,Date.now(),user.id);
      const activeSlot=Number.isInteger(presence.slot)&&presence.slot>=1&&presence.slot<=8?presence.slot:null;
      const active=activeSlot&&values['lineage_idle_save_'+activeSlot];
      const displayName=active?(this.catalog.unwrap(active).p.name||user.username):user.username;
      this.db.prepare('UPDATE leases SET display_name=?,slot=?,map_name=? WHERE account_id=?').run(
        displayName,activeSlot,String(presence.map||'角色選擇').slice(0,60),user.id);
      return { revision:next,serverTime:Date.now(),ok:true,worldSettings:this.world?.state() };
    }); } catch(error) { this.saveGuard.record(user,error);throw error; }
  }
  players(user) {
    this.gm(user);
    return this.db.prepare('SELECT a.id,a.username,a.role,s.data,s.revision,s.updated_at,l.expires_at,l.slot FROM accounts a JOIN saves s ON s.account_id=a.id LEFT JOIN leases l ON l.account_id=a.id ORDER BY a.created_at').all().map(row=>{
      const chars=[];
      for(const [key,value] of Object.entries(JSON.parse(row.data))) if(SLOT.test(key)) {
        try { const p=this.catalog.unwrap(value).p; if(p?.cls) chars.push({slot:Number(key.match(SLOT)[1]),name:p.name||'未命名',cls:p.cls,level:p.lv,hp:p.hp,maxHp:p.mhp,dead:!!p.dead}); } catch {}
      }
      return {id:row.id,username:row.username,role:row.role,online:row.expires_at>Date.now(),activeSlot:row.slot,characters:chars,updatedAt:row.updated_at};
    });
  }
  normalizeCommand(body) {
    const actions=['buff_all','kill','grant_item','revive','clear_buffs','teleport','restore_progress'];
    requireValue(actions.includes(body.action),'不支援的 GM 操作');
    requireValue(['all','online','account','character'].includes(body.scope),'請選擇有效的操作範圍');
    requireValue(typeof body.reason==='string' && body.reason.trim().length>=2 && body.reason.length<=200,'請填寫 2～200 字的操作原因');
    const accountScope=['account','character'].includes(body.scope);
    const command={action:body.action,scope:body.scope,accountId:accountScope?body.accountId:null,reason:body.reason.trim()};
    if(accountScope) requireValue(typeof body.accountId==='string' && !!this.db.prepare('SELECT id FROM accounts WHERE id=?').get(body.accountId),'找不到指定帳號');
    if(body.scope==='character') {
      requireValue(body.action==='grant_item','指定單一角色目前僅用於發放物品');
      requireValue(Number.isInteger(body.slot)&&body.slot>=1&&body.slot<=8,'請指定角色欄位 1～8');
      command.slot=body.slot;
    }
    if(body.action==='grant_item'&&body.slot!==undefined)requireValue(body.scope==='character','指定角色欄位時，請使用指定單一角色範圍');
    if(body.action==='restore_progress') {
      requireValue(body.scope==='account','進度修復必須指定單一帳號');
      requireValue(Number.isInteger(body.slot)&&body.slot>=1&&body.slot<=8,'請指定角色欄位 1～8');
      requireValue(Number.isSafeInteger(body.experienceDelta)&&body.experienceDelta>0,'補回經驗必須是安全範圍內的正整數');
      Object.assign(command,{slot:body.slot,experienceDelta:body.experienceDelta});
    }
    if(body.action==='buff_all') {
      requireValue(Number.isInteger(body.duration) && body.duration>=10 && body.duration<=86400,'持續時間須為 10～86400 秒'); command.duration=body.duration;
    }
    if(body.action==='grant_item') {
      const item=this.catalog.items[body.itemId];
      requireValue(item,'找不到指定物品');
      requireValue(Number.isInteger(body.quantity) && body.quantity>=1 && body.quantity<=100000,'數量須為 1～100000');
      const rules=itemGrantRules(item);
      requireValue(Number.isInteger(body.enchant) && body.enchant>=0 && body.enchant<=rules.maxEnchant,`此物品強化值須為 0～${rules.maxEnchant}`);
      requireValue(!body.blessed || rules.canBless,'此物品不可附加祝福詞綴');
      requireValue(!item.wishRing || body.quantity<=100,'願望戒指每只獨立抽取能力，單次最多發放 100 只');
      requireValue(!item.maxHold || body.quantity<=item.maxHold,`此物品持有上限為 ${item.maxHold}`);
      Object.assign(command,{itemId:body.itemId,quantity:body.quantity,enchant:body.enchant,blessed:body.blessed===true});
    }
    if(body.action==='teleport'&&body.mapId){
      const map=this.world?.maps.get(body.mapId);requireValue(map,'找不到傳送地圖');
      Object.assign(command,{mapId:map.id,mapName:map.name});
    }
    return command;
  }
  targets(command) {
    const rows=this.db.prepare('SELECT a.id,a.username,s.data,s.revision,l.expires_at,l.slot FROM accounts a JOIN saves s ON s.account_id=a.id LEFT JOIN leases l ON l.account_id=a.id').all();
    return rows.filter(row=>!['account','character'].includes(command.scope)||row.id===command.accountId).flatMap(row=>{
      if(command.scope==='online' && !(row.expires_at>Date.now())) return [];
      const values=JSON.parse(row.data), chars=[];
      for(const [key,value] of Object.entries(values)) if(SLOT.test(key)) {
        if((command.action==='restore_progress'||command.scope==='character')&&Number(key.match(SLOT)[1])!==command.slot)continue;
        if(command.scope==='online' && Number(key.match(SLOT)[1])!==row.slot) continue;
        let doc; try { doc=this.catalog.unwrap(value); } catch { throw new ApiError(409,`帳號 ${row.username} 的角色存檔損壞，已取消整批操作`); }
        if(doc?.p?.cls) chars.push({key,doc});
      }
      return chars.length?[{...row,values,chars}]:[];
    });
  }
  preview(user,body) {
    this.gm(user); const command=this.normalizeCommand(body),targets=this.targets(command);
    if(command.action==='teleport'){
      const location=this.world.location(user);
      requireValue(!command.mapId||command.mapId===location.mapId,'GM 所在地圖已改變，請重新預覽',409);
      Object.assign(command,{mapId:location.mapId,mapName:location.mapName});
    }
    return {command,accountCount:targets.length,characterCount:targets.reduce((n,t)=>n+t.chars.length,0),
      targetFingerprint:hash((command.mapId||'')+targets.map(t=>t.id+':'+t.chars.map(c=>c.key+':'+(c.doc.p._roleEpoch||c.doc.p.enSeed||'')).join(',')).sort().join('|')),
      targets:targets.map(t=>({username:t.username,characters:t.chars.map(c=>c.doc.p.name||'未命名')}))};
  }
  execute(user,body) {
    this.gm(user);
    requireValue(typeof body.requestId==='string' && /^[\w-]{16,80}$/.test(body.requestId),'缺少指令識別碼');
    return this.transaction(()=>{
      const previous=this.db.prepare('SELECT result,payload FROM gm_commands WHERE actor_id=? AND request_id=?').get(user.id,body.requestId);
      const command=this.normalizeCommand(body);
      if(previous) {
        requireValue(previous.payload===JSON.stringify(command),'同一識別碼不能重用於不同操作',409);
        return {...JSON.parse(previous.result),replayed:true};
      }
      const preview=this.preview(user,body);
      requireValue(body.targetFingerprint===preview.targetFingerprint,'玩家名單已改變，請重新預覽再確認',409);
      requireValue(preview.characterCount>0,'目前範圍內沒有已建立的角色');
      requireValue(command.action!=='teleport'||command.mapId===preview.command.mapId,'請先預覽傳送地點',409);
      const targets=this.targets(command), now=Date.now();
      const seq=Number(this.db.prepare('INSERT INTO gm_commands(actor_id,request_id,payload,created_at) VALUES(?,?,?,?)').run(user.id,body.requestId,JSON.stringify(command),now).lastInsertRowid);
      const buffs=fullStatusBuffIds(this.catalog.skills);
      for(const target of targets) {
        const revision=target.revision+1;
        for(const {key,doc} of target.chars) {
          if(command.action==='grant_item') {
            const max=this.catalog.items[command.itemId].maxHold;
            const held=(doc.p.inv||[]).filter(i=>i.id===command.itemId).reduce((n,i)=>n+(i.cnt||0),0);
            requireValue(!max || held+command.quantity<=max,`${target.username} 持有數量將超過物品上限，已取消整批操作`,409);
          }
          const effect={seq,action:command.action,epoch:doc.p._roleEpoch||doc.p.enSeed||'',at:now,reason:command.reason};
          if(command.action==='restore_progress') {
            let level=doc.p.lv,experience=(doc.p.exp||0)+command.experienceDelta;
            requireValue(Number.isInteger(level)&&level>=1&&level<=100&&Number.isSafeInteger(experience)&&experience>=0,'角色經驗資料不正確，已取消修復',409);
            let bonus=doc.p.bonus||0;
            while(level<100){
              const required=this.catalog.experience?.[level];
              requireValue(Number.isSafeInteger(required)&&required>0,'經驗表不完整，已取消修復',409);
              if(experience<required)break;
              experience-=required;level++;if(level>=50)bonus++;
            }
            Object.assign(effect,{level,experience,bonus});
          }
          if(command.action==='teleport')Object.assign(effect,{mapId:command.mapId,mapName:command.mapName});
          if(command.action==='buff_all') Object.assign(effect,{expiresAt:now+command.duration*1000,buffs});
          if(command.action==='grant_item') {
            effect.item={id:command.itemId,cnt:command.quantity,en:command.enchant,bless:command.blessed,anc:false,attr:false,seteff:false,uid:randomUUID(),lock:true,junk:false};
            if(this.catalog.items[command.itemId].wishRing) {
              effect.items=Array.from({length:command.quantity},()=>({...effect.item,cnt:1,uid:randomUUID(),gw:rollWishes()}));
              delete effect.item;
            }
            requireValue(doc.p.inv.length+(effect.items?.length||1)<=20000,'背包欄位將超過上限，已取消整批操作',409);
          }
          applyEffect(doc,effect,now);
          target.values[key]=this.catalog.wrap(doc);
          this.db.prepare('INSERT INTO gm_effects(account_id,revision,save_key,payload) VALUES(?,?,?,?)').run(target.id,revision,key,JSON.stringify(effect));
        }
        this.db.prepare('UPDATE saves SET data=?,revision=?,updated_at=? WHERE account_id=?').run(JSON.stringify(target.values),revision,now,target.id);
        // A running client must reload this repaired snapshot before writing again.
        if(command.action==='restore_progress')this.db.prepare('DELETE FROM leases WHERE account_id=?').run(target.id);
      }
      const result={seq,accountCount:preview.accountCount,characterCount:preview.characterCount,action:command.action,createdAt:now};
      if(command.scope==='character')result.recipient={accountId:command.accountId,username:targets[0].username,slot:command.slot,name:targets[0].chars[0].doc.p.name||'未命名'};
      this.db.prepare('UPDATE gm_commands SET result=? WHERE seq=?').run(JSON.stringify(result),seq);
      return result;
    });
  }
  setRole(user,accountId,role) {
    this.gm(user); requireValue(['gm','player'].includes(role),'權限不正確');
    return this.transaction(()=>{
      const target=this.db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
      requireValue(target,'找不到帳號',404);
      if(target.role==='gm'&&role==='player') requireValue(this.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE role='gm'").get().n>1,'至少必須保留一個 GM 帳號',409);
      this.db.prepare('UPDATE accounts SET role=? WHERE id=?').run(role,accountId);
      this.db.prepare('INSERT INTO role_audit(actor_id,account_id,role,created_at) VALUES(?,?,?,?)').run(user.id,accountId,role,Date.now());
      return {ok:true};
    });
  }
  audit(user) {
    this.gm(user);
    return this.db.prepare('SELECT g.seq,a.username,g.payload,g.result,g.created_at FROM gm_commands g JOIN accounts a ON a.id=g.actor_id ORDER BY g.seq DESC LIMIT 100').all()
      .map(r=>({seq:r.seq,actor:r.username,command:JSON.parse(r.payload),result:JSON.parse(r.result),at:r.created_at}));
  }
  online() {
    return this.db.prepare('SELECT a.username,l.display_name AS name,l.map_name AS map,l.slot FROM leases l JOIN accounts a ON a.id=l.account_id WHERE l.expires_at>? ORDER BY a.username').all(Date.now());
  }
  onlineSummary(user){
    // Public presence lists characters uniformly; roles and automation stay in GM views.
    const players=this.presence.visibleCharacters(user,onlineCharacters(this));
    return {total:players.length,players:players.length,list:players,at:Date.now()};
  }
  clans(user) { return this.db.prepare('SELECT c.id,c.name,c.leader_id AS leaderId,c.created_at AS createdAt,a.username AS leader FROM clans c JOIN accounts a ON a.id=c.leader_id ORDER BY c.created_at').all().map(c=>({...c,members:this.db.prepare('SELECT a.id,a.username FROM clan_members m JOIN accounts a ON a.id=m.account_id WHERE m.clan_id=? ORDER BY m.joined_at').all(c.id)})); }
  createClan(user,name) { requireValue(typeof name==='string'&&name.trim().length>=2&&name.trim().length<=24,'血盟名稱須為 2～24 字'); return this.transaction(()=>{const id=randomUUID();try{this.db.prepare('INSERT INTO clans VALUES(?,?,?,?)').run(id,name.trim(),user.id,Date.now());this.db.prepare('INSERT INTO clan_members VALUES(?,?,?)').run(id,user.id,Date.now());}catch(e){if(String(e).includes('UNIQUE'))throw new ApiError(409,'血盟名稱或角色已存在');throw e;}return {ok:true,id,name:name.trim()};}); }
  joinClan(user,clanId) { requireValue(typeof clanId==='string'&&this.db.prepare('SELECT id FROM clans WHERE id=?').get(clanId),'找不到血盟',404); return this.transaction(()=>{try{this.db.prepare('INSERT INTO clan_members VALUES(?,?,?)').run(clanId,user.id,Date.now());}catch(e){if(String(e).includes('UNIQUE'))throw new ApiError(409,'角色已加入其他血盟');throw e;}return {ok:true,clanId};}); }
  chat(user,text) {
    requireValue(typeof text==='string'&&text.trim().length>0&&text.length<=500,'訊息須為 1～500 字');
    const last=this.db.prepare('SELECT MAX(created_at) AS at FROM chat WHERE account_id=?').get(user.id).at;
    requireValue(!last||Date.now()-last>=1500,'發言太快，請稍後再試',429);
    this.db.prepare('INSERT INTO chat(account_id,text,created_at,character_name) VALUES(?,?,?,?)').run(user.id,text.trim(),Date.now(),characterName(this,user.id));
    this.db.prepare('DELETE FROM chat WHERE id<(SELECT COALESCE(MAX(id),0)-1000 FROM chat)').run();
    return {ok:true};
  }
  messages() {
    const names=new Map();
    return this.db.prepare('SELECT c.id,c.account_id,c.character_name,a.username,c.text,c.created_at AS at,m.display_name,m.model,m.provider FROM chat c JOIN accounts a ON a.id=c.account_id LEFT JOIN ai_chat_messages m ON m.chat_id=c.id ORDER BY c.id DESC LIMIT 80').all().reverse().map(({account_id,character_name,display_name,...m})=>{
      if(!names.has(account_id))names.set(account_id,characterName(this,account_id));
      return {...m,displayName:character_name||(display_name&&display_name!==m.username?display_name:names.get(account_id)),ai:!!m.model};
    });
  }
  publicMessages() {
    // Keep provenance for moderation and reply scheduling, outside the player-facing API.
    return this.messages().map(({id,text,at,displayName})=>({id,text,at,displayName}));
  }
}
