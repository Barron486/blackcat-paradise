/** Plays only server-recorded frames. No attacks, random rolls or rewards run here. */
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
    for(const frame of frames){
      if(frame.seq<=this.seq)continue;
      const gap=Math.max(0,(frame.tick-this.tick)*100);
      this.due=Math.max(this.due+(gap||0),now);
      this.queue.push({frame,due:this.due});this.tick=frame.tick;this.seq=frame.seq;
    }
    // A slow foreground connection still needs hit/death feedback. Catch up at a
    // bounded cadence instead of silently deleting every attack in a large packet.
    if(this.queue.length>24||this.due-now>2000)this.retime(now);
    this.pump();return true;
  }
  retime(now){
    this.queue=this.queue.slice(-30);
    if(!this.queue.length)return;
    const first=this.queue[0].frame.tick,span=(this.queue.at(-1).frame.tick-first)*100;
    const scale=Math.min(1,1200/Math.max(100,span));
    this.queue.forEach((item,i)=>{item.due=now+Math.max(i*40,(item.frame.tick-first)*100*scale);});
    this.due=this.queue.at(-1).due;
  }
  pump(){
    const now=this.now();
    if(this.queue.length&&now-this.queue[0].due>150)this.retime(now);
    while(this.queue.length&&this.queue[0].due<=now){const {frame}=this.queue.shift();this.last=frame;this.paint(frame,{silent:false});}
  }
}
