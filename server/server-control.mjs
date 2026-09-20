import {randomUUID} from 'node:crypto';
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';
import {ApiError} from './service.mjs';

const check=(ok,message,status=400)=>{if(!ok)throw new ApiError(status,message);};
const mb=bytes=>Math.round(bytes/1048576*10)/10;
export class ServerControl {
  constructor(service,{authority,battleFeed,restart,delayMs=15000,cooldownMs=60000}={}){
    Object.assign(this,{service,authority,battleFeed,restart,delayMs,cooldownMs});this.db=service.db;this.bootId=randomUUID();this.startedAt=Date.now();this.pending=null;
    this.db.exec(`CREATE TABLE IF NOT EXISTS server_restarts(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT NOT NULL REFERENCES accounts(id),request_id TEXT NOT NULL,boot_id TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL,requested_at INTEGER NOT NULL,scheduled_at INTEGER NOT NULL,finished_at INTEGER,error TEXT,UNIQUE(actor_id,request_id));`);
    this.db.prepare("UPDATE server_restarts SET status=CASE WHEN status='stopping' THEN 'completed' ELSE 'interrupted' END,finished_at=? WHERE status IN ('scheduled','stopping')").run(Date.now());
    this.lag=monitorEventLoopDelay({resolution:20});this.lag.enable();this.lastCpu=process.cpuUsage();this.lastTime=performance.now();this.cpuPercent=0;this.loop={meanMs:0,maxMs:0,p99Ms:0};
    this.monitor=setInterval(()=>{const now=performance.now(),cpu=process.cpuUsage(this.lastCpu);this.cpuPercent=Math.round((cpu.user+cpu.system)/1000/Math.max(1,now-this.lastTime)*1000)/10;this.lastCpu=process.cpuUsage();this.lastTime=now;
      const ms=n=>Number.isFinite(n)?Math.round(n/1e6*10)/10:0;this.loop={meanMs:ms(this.lag.mean),maxMs:ms(this.lag.max),p99Ms:ms(this.lag.percentile(99))};this.lag.reset();
    },5000);this.monitor.unref();
  }
  status(user){
    this.service.gm(user);const memory=process.memoryUsage(),now=Date.now();
    const last=this.db.prepare("SELECT MAX(scheduled_at) AS at FROM server_restarts WHERE status IN ('scheduled','stopping','completed')").get().at||0;
    return {bootId:this.bootId,startedAt:this.startedAt,serverTime:now,restartAvailable:typeof this.restart==='function',pending:this.pending&&{id:this.pending.id,scheduledAt:this.pending.scheduled_at,status:this.pending.status},cooldownUntil:last?last+this.cooldownMs:0,
      uptimeSeconds:Math.floor((now-this.startedAt)/1000),memory:{rssMB:mb(memory.rss),heapUsedMB:mb(memory.heapUsed),heapTotalMB:mb(memory.heapTotal),externalMB:mb(memory.external)},cpuPercent:this.cpuPercent,eventLoop:this.loop,
      game:{loaded:this.authority.runtimes.size,running:[...this.authority.runtimes.values()].filter(r=>r.running).length,streams:this.battleFeed.clients.size,...this.authority.metrics},
      history:this.db.prepare('SELECT r.id,a.username AS actor,r.reason,r.status,r.requested_at AS requestedAt,r.scheduled_at AS scheduledAt,r.finished_at AS finishedAt,r.error FROM server_restarts r JOIN accounts a ON a.id=r.actor_id ORDER BY r.id DESC LIMIT 20').all()};
  }
  request(user,body){
    this.service.gm(user);check(typeof this.restart==='function','此啟動方式不支援自動重啟，請由伺服器管理者使用 npm start 啟動',503);
    check(typeof body.requestId==='string'&&/^[\w-]{20,80}$/.test(body.requestId),'缺少重啟請求識別碼');
    check(body.confirmation==='重啟伺服器','請輸入「重啟伺服器」確認');
    check(typeof body.reason==='string'&&body.reason.trim().length>=2&&body.reason.length<=200,'請填寫 2～200 字的重啟原因');
    const prior=this.db.prepare('SELECT * FROM server_restarts WHERE actor_id=? AND request_id=?').get(user.id,body.requestId);
    if(prior){check(prior.reason===body.reason.trim()&&prior.boot_id===body.bootId,'此識別碼已用於另一筆重啟請求',409);return {ok:true,replayed:true,id:prior.id,status:prior.status,scheduledAt:prior.scheduled_at};}
    check(body.bootId===this.bootId,'伺服器已重新啟動，請更新狀態後再操作',409);check(!this.pending,'已有重啟排程，請勿重複操作',409);
    const now=Date.now(),last=this.db.prepare("SELECT MAX(scheduled_at) AS at FROM server_restarts WHERE status IN ('scheduled','stopping','completed')").get().at||0;
    check(now>=last+this.cooldownMs,'距離上次重啟未滿 1 分鐘，請稍後再試',429);
    const scheduledAt=now+this.delayMs,id=Number(this.db.prepare("INSERT INTO server_restarts(actor_id,request_id,boot_id,reason,status,requested_at,scheduled_at) VALUES(?,?,?,?,'scheduled',?,?)").run(user.id,body.requestId,this.bootId,body.reason.trim(),now,scheduledAt).lastInsertRowid);
    this.pending={id,scheduled_at:scheduledAt,status:'scheduled'};
    this.timer=setTimeout(()=>void this.run(),this.delayMs);this.timer.unref();return {ok:true,id,status:'scheduled',scheduledAt};
  }
  announcement(){const p=this.pending;if(!p)return null;return {id:'server-restart-'+p.id,pinned:true,startedAt:p.scheduled_at-this.delayMs,expiresAt:p.scheduled_at+120000,text:`伺服器將於 ${new Date(p.scheduled_at).toLocaleTimeString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})} 進行重啟，進度會先保存。屆時將短暫斷線，恢復後可繼續遊玩。`};}
  async run(){
    if(this.closed||!this.pending||this.pending.status!=='scheduled')return;
    clearTimeout(this.timer);
    const id=this.pending.id;this.pending.status='stopping';this.db.prepare("UPDATE server_restarts SET status='stopping' WHERE id=?").run(id);
    try{await this.restart();}catch(error){
      console.error('[restart]',error.message);this.db.prepare("UPDATE server_restarts SET status='failed',finished_at=?,error=? WHERE id=?").run(Date.now(),'保存或重啟未完成，服務仍保留，請查看伺服器紀錄。',id);this.pending=null;
    }
  }
  close(){this.closed=true;clearTimeout(this.timer);clearInterval(this.monitor);this.lag.disable();}
}
