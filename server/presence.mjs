import {randomUUID} from 'node:crypto';
import {ApiError} from './service.mjs';

const check=(ok,message,status=400)=>{if(!ok)throw new ApiError(status,message);};
export class PresenceService {
  constructor(service){
    this.service=service;this.db=service.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS clans(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,leader_id TEXT NOT NULL REFERENCES accounts(id),created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS clan_members(clan_id TEXT NOT NULL REFERENCES clans(id) ON DELETE CASCADE,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,joined_at INTEGER NOT NULL,PRIMARY KEY(clan_id,account_id),UNIQUE(account_id));
      CREATE TABLE IF NOT EXISTS location_clan_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO location_clan_state VALUES(1,0);
      CREATE TABLE IF NOT EXISTS location_clan_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,payload TEXT NOT NULL,previous_clan TEXT,created_at INTEGER NOT NULL,UNIQUE(actor_id,request_id));`);
  }
  visibleCharacters(user,characters){
    const account=user&&this.db.prepare('SELECT role FROM accounts WHERE id=?').get(user.id);
    const all=!!account&&(account.role==='gm'||this.service.world?.state().showPlayerLocations===true);
    const visible=new Set(account?[user.id]:[]);
    if(account&&!all)for(const row of this.db.prepare('SELECT peer.account_id FROM clan_members own JOIN clan_members peer ON peer.clan_id=own.clan_id WHERE own.account_id=?').all(user.id))visible.add(row.account_id);
    return characters.map(({id,name,map,accountId})=>({id,name,map:all||visible.has(accountId)?map:null}));
  }
  admin(user){
    this.service.gm(user);
    return {revision:this.db.prepare('SELECT revision FROM location_clan_state WHERE id=1').get().revision,
      clans:this.db.prepare('SELECT name FROM clans ORDER BY name').all().map(c=>c.name),
      players:this.service.players(user).map(p=>({...p,clanName:this.db.prepare('SELECT c.name FROM clan_members m JOIN clans c ON c.id=m.clan_id WHERE m.account_id=?').get(p.id)?.name||''})),
      history:this.db.prepare('SELECT a.username AS actor,l.payload,l.previous_clan AS previousClan,l.created_at AS at FROM location_clan_audit l JOIN accounts a ON a.id=l.actor_id ORDER BY l.id DESC LIMIT 30').all().map(({payload,...row})=>({...row,command:JSON.parse(payload)}))};
  }
  assign(user,body){
    this.service.gm(user);
    check(typeof body.accountId==='string'&&this.db.prepare('SELECT 1 FROM accounts WHERE id=?').get(body.accountId),'請選擇玩家帳號');
    check(typeof body.clanName==='string','血盟名稱不正確');const clanName=body.clanName.trim();
    check(clanName===''||(clanName.length>=2&&clanName.length<=24&&!/[<>&"'\x00-\x1f\x7f]/.test(clanName)),'血盟名稱須為 2～24 字；留空表示移出血盟');
    check(typeof body.reason==='string'&&body.reason.trim().length>=2&&body.reason.length<=200,'請填寫 2～200 字的修改原因');
    check(typeof body.requestId==='string'&&/^[\w-]{16,80}$/.test(body.requestId),'缺少操作識別碼');
    const payload=JSON.stringify({accountId:body.accountId,clanName,reason:body.reason.trim()});
    const replayed=this.service.transaction(()=>{
      const previous=this.db.prepare('SELECT payload FROM location_clan_audit WHERE actor_id=? AND request_id=?').get(user.id,body.requestId);
      if(previous){check(previous.payload===payload,'操作識別碼已用於其他修改',409);return true;}
      check(body.revision===this.db.prepare('SELECT revision FROM location_clan_state WHERE id=1').get().revision,'血盟名冊已被其他 GM 修改，請重新整理',409);
      const old=this.db.prepare('SELECT c.name FROM clan_members m JOIN clans c ON c.id=m.clan_id WHERE m.account_id=?').get(body.accountId)?.name||'';
      let clan=clanName&&this.db.prepare('SELECT id FROM clans WHERE name=?').get(clanName);
      if(clanName&&!clan){clan={id:randomUUID()};this.db.prepare('INSERT INTO clans VALUES(?,?,?,?)').run(clan.id,clanName,body.accountId,Date.now());}
      this.db.prepare('DELETE FROM clan_members WHERE account_id=?').run(body.accountId);
      if(clan)this.db.prepare('INSERT INTO clan_members VALUES(?,?,?)').run(clan.id,body.accountId,Date.now());
      this.db.prepare('UPDATE location_clan_state SET revision=revision+1 WHERE id=1').run();
      this.db.prepare('INSERT INTO location_clan_audit(actor_id,request_id,payload,previous_clan,created_at) VALUES(?,?,?,?,?)').run(user.id,body.requestId,payload,old,Date.now());
      return false;
    });
    return {ok:true,replayed,...this.admin(user)};
  }
}
