import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {HeadlessGame} from './game-engine.mjs';
import {ApiError} from './service.mjs';

const slotKey=slot=>'lineage_idle_save_'+slot;
const epoch=doc=>doc?.p?._roleEpoch||doc?.p?.enSeed;
const requireValue=(ok,message,status=400)=>{if(!ok)throw new ApiError(status,message);};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The only online gameplay writer. Network callers supply intents, never save data. */
export class AuthoritativeGame {
  constructor(service,{clock=()=>performance.now(),Engine=HeadlessGame,idleMs=90000,maxRuntimes=64,autoTick=true}={}){
    this.service=service;this.db=service.db;this.clock=clock;this.Engine=Engine;
    this.idleMs=idleMs;this.maxRuntimes=maxRuntimes;this.runtimes=new Map();service.authority=this;
    this.db.exec(`CREATE TABLE IF NOT EXISTS game_requests(
      account_id TEXT NOT NULL,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,created_at INTEGER NOT NULL,
      PRIMARY KEY(account_id,request_id));
      CREATE TABLE IF NOT EXISTS game_sessions(
        account_id TEXT PRIMARY KEY REFERENCES accounts(id),slot INTEGER NOT NULL,epoch TEXT NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0,running INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL);`);
    this.cleanup=setInterval(()=>this.evict(),30000);this.cleanup.unref();
    if(autoTick){this.timer=setInterval(()=>void this.tickResponsive(),1000);this.timer.unref();}
  }
  row(user){const row=this.db.prepare('SELECT data,revision FROM saves WHERE account_id=?').get(user.id);return {...row,values:JSON.parse(row.data)};}
  // Disconnects do not end a hunt. Only dormant (paused/dead) engines can be evicted.
  evict(){for(const [id,r]of this.runtimes)if(r.running===false&&this.clock()-r.lastSeen>this.idleMs)this.drop(id);}
  drop(id){const r=this.runtimes.get(id);if(r){r.engine.close();this.runtimes.delete(id);}}
  forget(id){this.drop(id);this.db.prepare('DELETE FROM game_sessions WHERE account_id=?').run(id);}
  saveSession(user,r,doc){
    r.running=!r.paused&&!doc.p.dead;
    this.db.prepare(`INSERT INTO game_sessions(account_id,slot,epoch,paused,running,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET slot=excluded.slot,epoch=excluded.epoch,paused=excluded.paused,running=excluded.running,updated_at=excluded.updated_at`)
      .run(user.id,r.slot,epoch(doc),Number(r.paused),Number(r.running),Date.now());
  }
  restore(user){
    const saved=this.db.prepare('SELECT * FROM game_sessions WHERE account_id=?').get(user.id);
    if(!saved)return null;
    const row=this.row(user),raw=row.values[slotKey(saved.slot)],lease=this.db.prepare('SELECT token FROM leases WHERE account_id=?').get(user.id);
    if(!lease||!raw||epoch(this.service.catalog.unwrap(raw))!==saved.epoch){this.forget(user.id);return null;}
    this.evict();requireValue(this.runtimes.size<this.maxRuntimes,'遊戲伺服器忙碌，請稍後再試',503);
    const engine=new this.Engine({values:row.values,slot:saved.slot});
    const r={engine,slot:saved.slot,lease:lease.token,user:{id:user.id,username:user.username,role:user.role},revision:row.revision,inputRevision:row.revision,
      anchor:this.clock(),lastSeen:this.clock(),paused:!!saved.paused,running:!!saved.running};
    try{
      engine.setWorldSettings(this.service.world?.state());engine.load(saved.slot);
      this.service.transaction(()=>this.commit(user,r));this.runtimes.set(user.id,r);return r;
    }catch(error){engine.close();throw error;}
  }
  recoveryCandidates(){return this.db.prepare('SELECT a.id,a.username,a.role FROM game_sessions g JOIN accounts a ON a.id=g.account_id WHERE g.running=1 ORDER BY g.updated_at').all().filter(user=>!this.runtimes.has(user.id));}
  recover(user){
    try{this.restore(user);}catch(error){
      console.error('[game-resume]',user.id,error.message);
      // Preserve the checkpoint for an explicit reconnect, without a hot retry loop.
      this.db.prepare('UPDATE game_sessions SET running=0 WHERE account_id=?').run(user.id);
    }
  }
  close(){this.closed=true;clearInterval(this.cleanup);clearInterval(this.timer);for(const id of this.runtimes.keys())this.drop(id);}
  tickRuntime(id,r){
    if(this.runtimes.get(id)!==r)return;
    try{const lease=this.db.prepare('SELECT token FROM leases WHERE account_id=?').get(id);if(!lease){this.forget(id);return;}
      r.lease=lease.token; // UI control can change without restarting the account's combat clock.
      this.service.transaction(()=>this.advance(r.user,r));
    }catch(error){console.error('[game-tick]',id,error.message);this.drop(id);this.db.prepare('UPDATE game_sessions SET running=0 WHERE account_id=?').run(id);}
  }
  tick(){
    this.evict();
    for(const user of this.recoveryCandidates()){if(this.runtimes.size>=this.maxRuntimes)break;this.recover(user);}
    for(const [id,r]of this.runtimes)this.tickRuntime(id,r);
  }
  async tickResponsive(){
    if(this.ticking||this.closed)return;
    this.ticking=true;
    try{
      this.evict();
      for(const user of this.recoveryCandidates()){
        if(this.closed||this.runtimes.size>=this.maxRuntimes)break;
        if(!this.runtimes.has(user.id))this.recover(user);
        await yieldTurn();
      }
      for(const [id,r]of [...this.runtimes]){
        if(this.closed)break;
        this.tickRuntime(id,r);
        // Keep each character atomic while letting HTTP and battle streams run between characters.
        await yieldTurn();
      }
    }finally{this.ticking=false;}
  }
  commit(user,r){
    const before=this.row(user);
    requireValue(before.revision===r.revision,'伺服器角色版本已改變',409);
    const values=r.engine.save();
    const old=before.values[slotKey(r.slot)],raw=values[slotKey(r.slot)];
    const doc=this.service.catalog.unwrap(raw);
    requireValue(JSON.stringify(values).length<=32_000_000,'帳號存檔已超過上限');
    this.db.prepare('INSERT OR IGNORE INTO character_epochs VALUES(?,?,?)').run(epoch(doc),user.id,slotKey(r.slot));
    this.service.lootBroadcasts?.record(user,old?this.service.catalog.unwrap(old):null,doc);
    this.service.killBroadcasts?.record(user,old?this.service.catalog.unwrap(old):null,doc);
    const data=JSON.stringify(values);
    if(data!==before.data){r.revision++;this.db.prepare('UPDATE saves SET data=?,revision=?,updated_at=? WHERE account_id=?').run(data,r.revision,Date.now(),user.id);}
    const s=r.engine.status();
    this.db.prepare('UPDATE leases SET display_name=?,slot=?,map_name=? WHERE account_id=?').run(s.name,r.slot,s.mapName||s.map,user.id);
    this.saveSession(user,r,doc);
  }
  reconcile(user,r){
    const row=this.row(user);
    if(row.revision===r.revision)return;
    const raw=row.values[slotKey(r.slot)],local=r.engine.snapshot();
    requireValue(raw&&epoch(this.service.catalog.unwrap(raw))===epoch(local),'角色已刪除或更換，請重新選角',409);
    const doc=this.service.catalog.unwrap(raw);
    r.engine.setValues(row.values);r.engine.adopt(doc);r.revision=row.revision;r.inputRevision=row.revision;
  }
  advance(user,r){
    this.reconcile(user,r);
    const now=this.clock(),ticks=Math.min(100,Math.floor(Math.max(0,now-r.anchor)/100));
    // Only the server's live monotonic clock grants time. Bound each pass, retain
    // backlog for later passes, and start a fresh anchor after a server restart.
    if(ticks){r.anchor=r.paused?now:r.anchor+ticks*100;r.engine.setWorldSettings(this.service.world?.state());r.engine.refreshGm();if(!r.paused)r.engine.step(ticks);this.commit(user,r);}
  }
  response(user,r,cursor,compact=false){
    const snapshot=this.service.bootstrap(user);
    return {ok:true,authoritative:true,snapshot,game:r?{slot:r.slot,epoch:epoch(this.service.catalog.unwrap(snapshot.values[slotKey(r.slot)])),
      // Browsers already receive this character in snapshot.values. CLI clients retain their existing response.
      ...(compact?{}:{view:r.engine.view(),status:r.engine.status()}),logs:r.engine.logs.slice(-100),paused:r.paused,battle:cursor===false?undefined:r.engine.battle?.(cursor)}:null};
  }
  handle(user,body){
    requireValue(body&&typeof body==='object'&&!Array.isArray(body),'指令格式不正確');
    const {lease,op='state',slot,requestId,args={}}=body;
    requireValue(['state','select','create','delete','leave','pause','resume','action'].includes(op),'不支援的遊戲指令');
    requireValue(Object.keys(body).every(k=>['lease','op','slot','epoch','revision','requestId','args','client'].includes(k)),'不接受客戶端進度或時間數值');
    requireValue(body.client===undefined||body.client==='browser','不支援的回應格式');
    requireValue(args&&typeof args==='object'&&!Array.isArray(args)&&JSON.stringify(args).length<32000,'操作內容過大');
    const compact=body.client==='browser',cursor=op==='state'?(args.presentation??false):(compact?false:undefined);
    const mutation=op!=='state';
    if(mutation){requireValue(typeof requestId==='string'&&/^[\w-]{20,80}$/.test(requestId),'缺少指令識別碼');requireValue(Number.isSafeInteger(body.revision)&&body.revision>=0,'版本不正確');}
    let r=this.runtimes.get(user.id);
    this.service.checkLease(user,lease);
    if(!r)r=this.restore(user);
    if(r)r.lease=lease;
    const payloadHash=mutation?digest({op,slot:slot??null,epoch:body.epoch??null,args}):null;
    const prior=mutation&&this.db.prepare('SELECT payload_hash FROM game_requests WHERE account_id=? AND request_id=?').get(user.id,requestId);
    if(prior){requireValue(prior.payload_hash===payloadHash,'同一識別碼不能重用於不同指令',409);if(r)this.reconcile(user,r);return {...this.response(user,r,cursor,compact),replayed:true};}
    if(mutation){
      const latest=this.row(user).revision;
      // Combat checkpoints do not invalidate an intent. Another command or external writer still does.
      const liveIntent=['action','pause','resume','leave'].includes(op)&&r&&slot===r.slot&&body.epoch===epoch(r.engine.snapshot());
      const combatOnly=liveIntent&&r.revision===latest&&body.revision>=r.inputRevision&&body.revision<=latest;
      if(body.revision!==latest&&!combatOnly)throw new ApiError(409,'雲端角色已有更新，請重試',{snapshot:this.service.bootstrap(user)});
    }
    if(['select','create','delete'].includes(op))requireValue(Number.isInteger(slot)&&slot>=1&&slot<=8,'角色欄位須為 1～8');
    if(['action','pause','resume','leave'].includes(op)){
      requireValue(r,'請先選擇角色',409);
      requireValue(slot===r.slot&&body.epoch===epoch(r.engine.snapshot()),'角色已更換，請重新整理',409);
    }
    // Advance valid elapsed combat independently of whether the following action succeeds.
    if(r){this.service.transaction(()=>this.advance(user,r));r.lastSeen=this.clock();}
    // CLI controllers need settled state only; browsers explicitly request the animation stream.
    if(op==='state')return this.response(user,r,cursor,compact);
    try{return this.service.transaction(()=>{
      if(op==='create'||op==='select'){
        const row=this.row(user),raw=row.values[slotKey(slot)];
        requireValue(op==='create'?!raw:!!raw,op==='create'?'此欄位已有角色':'此欄位沒有角色',409);
        if(op==='select')requireValue(body.epoch===epoch(this.service.catalog.unwrap(raw)),'角色已更換',409);
        if(!r||r.slot!==slot||op==='create'){
          this.drop(user.id);this.evict();requireValue(this.runtimes.size<this.maxRuntimes,'遊戲伺服器忙碌，請稍後再試',503);
          const engine=new this.Engine({values:row.values,slot});
          r={engine,slot,lease,user:{id:user.id,username:user.username,role:user.role},revision:row.revision,inputRevision:row.revision,anchor:this.clock(),lastSeen:this.clock(),paused:false,running:true};this.runtimes.set(user.id,r);
          engine.setWorldSettings(this.service.world?.state());
          if(op==='create'){
            requireValue(Object.keys(args).every(k=>['classId','name','allocation','gender','classicMode'].includes(k)),'創角只接受職業、名稱與配點');
            engine.create(args);
          }else engine.load(slot);
          this.commit(user,r);
        }
      }else if(op==='delete'){
        const row=this.row(user),raw=row.values[slotKey(slot)];requireValue(raw,'此欄位沒有角色',404);
        const doc=this.service.catalog.unwrap(raw);requireValue(body.epoch===epoch(doc)&&args.name===(doc.p.name||'未命名'),'角色名稱或識別碼不正確',409);
        // Run upstream cleanup with server-owned data and the already validated confirmation.
        this.drop(user.id);const engine=new this.Engine({values:row.values,slot});
        try{engine.window.prompt=()=>args.name;engine.window.confirm=()=>true;engine.window.alert=()=>{};engine.run('_loadSelectedSlot=__args;loadDeleteSelected();',slot);
          const values=engine.values();requireValue(!values[slotKey(slot)],'角色目前無法刪除',409);
          this.db.prepare('UPDATE saves SET data=?,revision=revision+1,updated_at=? WHERE account_id=?').run(JSON.stringify(values),Date.now(),user.id);
          this.db.prepare('DELETE FROM game_sessions WHERE account_id=?').run(user.id);
        }finally{engine.close();}r=null;
      }else if(op==='leave'){this.forget(user.id);r=null;this.db.prepare('UPDATE leases SET slot=NULL,map_name=? WHERE account_id=?').run('角色選擇',user.id);
      }else if(op==='pause'||op==='resume'){r.paused=op==='pause';r.anchor=this.clock();
        this.saveSession(user,r,r.engine.snapshot());
      }else if(op==='action'){
        requireValue(typeof args.name==='string'&&args.params&&typeof args.params==='object'&&!Array.isArray(args.params),'操作格式不正確');
        r.engine.setWorldSettings(this.service.world?.state());
        r.engine.action(args.name,args.params);this.commit(user,r);
      }
      this.db.prepare('INSERT INTO game_requests VALUES(?,?,?,?)').run(user.id,requestId,payloadHash,Date.now());
      if(r)r.inputRevision=r.revision;
      // Retain request IDs for the account lifetime: delayed retries cannot spend twice.
      return this.response(user,r,cursor,compact);
    });}catch(error){
      // Roll back both SQLite and the in-memory simulation. An invalid click must
      // not leave half-spent items, nor disconnect a valid paused character.
      const failed=r;this.drop(user.id);
      const row=this.row(user);
      if(failed&&row.values[slotKey(failed.slot)]){
        const engine=new this.Engine({values:row.values,slot:failed.slot});
        try{engine.setWorldSettings(this.service.world?.state());engine.load(failed.slot);this.runtimes.set(user.id,{...failed,engine,revision:row.revision,inputRevision:Math.min(failed.inputRevision,row.revision),lastSeen:this.clock()});}catch{engine.close();}
      }
      if(error instanceof ApiError)throw error;throw new ApiError(400,error.message||'操作無法完成');
    }
  }
}
