import {createGzip,constants} from 'node:zlib';

// One compact, authenticated presentation stream per controller. The engine alone owns time.
export class BattleFeed {
  constructor(authority,service){this.authority=authority;this.service=service;this.clients=new Map();}
  open({user,session,lease,after,req,res}){
    this.service.checkLease(user,lease);
    this.clients.get(user.id)?.();
    const match=/^([\w-]{1,64}):(\d{1,12})$/.exec(String(req.headers['last-event-id']||after||''));
    let cursor=match?{stream:match[1],seq:Number(match[2])}:null,blocked=false,closed=false,lastAuth=0,lastWrite=0;
    const compressed=/\bgzip\b/.test(req.headers['accept-encoding']||''),output=compressed?createGzip({flush:constants.Z_SYNC_FLUSH}):res;
    let timer;
    const close=()=>{if(closed)return;closed=true;clearInterval(timer);if(this.clients.get(user.id)===close)this.clients.delete(user.id);output.end();};
    this.clients.set(user.id,close);res.on('close',close);output.on('drain',()=>{blocked=false;});
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no',...(compressed?{'Content-Encoding':'gzip','Vary':'Accept-Encoding'}:{})});
    if(compressed){output.on('error',close);output.pipe(res);}
    output.write('retry: 1500\n\n');
    const push=()=>{
      if(closed)return;
      try{
        const now=Date.now();
        if(now-lastAuth>=1000){this.service.authenticate(session);this.service.checkLease(user,lease);lastAuth=now;}
        if(res.writableLength>512*1024){close();return;}
        if(blocked)return;
        const runtime=this.authority.runtimes.get(user.id);
        if(runtime?.lease===lease){
          runtime.lastSeen=this.authority.clock();
          const battle=runtime.engine.battle(cursor);
          if(battle.frames.length){
            cursor={stream:battle.stream,seq:battle.seq};
            const epoch=battle.frames.at(-1).epoch;
            blocked=!output.write(`id: ${battle.stream}:${battle.seq}\nevent: battle\ndata: ${JSON.stringify({slot:runtime.slot,epoch,battle})}\n\n`);
            lastWrite=now;return;
          }
        }
        if(now-lastWrite>=10000){blocked=!output.write(': heartbeat\n\n');lastWrite=now;}
      }catch(error){output.write(`event: denied\ndata: ${JSON.stringify({status:error.status||503,error:error.status?error.message:'戰鬥連線暫時中斷'})}\n\n`);close();}
    };
    timer=setInterval(push,200);timer.unref?.();push();
  }
  close(){for(const close of this.clients.values())close();}
}
