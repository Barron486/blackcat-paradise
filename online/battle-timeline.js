/** Plays only server-recorded frames. No attacks, random rolls or rewards run here. */
const TICK_MS=100;
const BUFFER_MS=400;

export class BattleTimeline {
  constructor({now=()=>performance.now(),paint=()=>{},reset=()=>{}}={}){
    this.now=now;this.paint=paint;this.onReset=reset;this.clear();
  }
  clear(){this.stream=null;this.seq=0;this.queue=[];this.last=null;this.due=0;this.tick=0;this.onReset();}
  cursor(){return {stream:this.stream,seq:this.seq};}
  ingest(packet,{reset=false,hidden=false}={}){
    if(!packet?.stream||!Array.isArray(packet.frames))return false;
    const frames=packet.frames.filter(f=>Number.isSafeInteger(f.seq)&&Number.isFinite(f.tick));
    if(!frames.length)return true;
    const newest=frames.at(-1),now=this.now();
    if(!reset&&!hidden&&this.stream===packet.stream&&newest.seq<=this.seq)return true;
    if(reset||hidden||this.stream!==packet.stream||newest.tick<this.tick){
      this.clear();this.stream=packet.stream;this.seq=newest.seq;this.tick=newest.tick;this.due=now;this.last=newest;this.paint(newest,{silent:true});return true;
    }
    const wasEmpty=this.queue.length===0;
    for(const frame of frames){
      if(frame.seq<=this.seq)continue;
      const gap=Math.max(0,(frame.tick-this.tick)*TICK_MS);
      this.due+=gap;
      this.queue.push({frame,due:this.due});this.tick=frame.tick;this.seq=frame.seq;
    }
    // The server sends ticks in batches (including 2s polling fallback). Starting
    // each batch immediately leaves no room for delivery jitter. Refill with a
    // small reserve, then keep the server's original tick spacing across packets.
    if(wasEmpty&&this.queue[0]?.due<now)this.retime(now+BUFFER_MS);
    // Bound genuinely obsolete backlogs after a long foreground suspension.
    // Ordinary 1–3s batches must NOT be squeezed into 1.2s: that speeds attacks
    // up, drains the queue and leaves the actors waiting for the next packet.
    if(this.queue.length>60){this.queue=this.queue.slice(-30);this.retime(now+BUFFER_MS);}
    this.pump();return true;
  }
  retime(now){
    if(!this.queue.length)return;
    const first=this.queue[0].frame.tick;
    this.queue.forEach(item=>{item.due=now+Math.max(0,(item.frame.tick-first)*TICK_MS);});
    this.due=this.queue.at(-1).due;
  }
  pump(){
    const now=this.now();
    if(this.queue.length&&now-this.queue[0].due>150)this.retime(now);
    while(this.queue.length&&this.queue[0].due<=now){const {frame}=this.queue.shift();this.last=frame;this.paint(frame,{silent:false});}
  }
}
