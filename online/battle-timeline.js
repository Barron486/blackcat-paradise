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
    if(reset||hidden||this.stream!==packet.stream||newest.tick<this.tick||now-this.due>2200){
      this.clear();this.stream=packet.stream;this.seq=newest.seq;this.tick=newest.tick;this.due=now;this.last=newest;this.paint(newest,{silent:true});return true;
    }
    for(const frame of frames){
      if(frame.seq<=this.seq)continue;
      const gap=Math.max(0,(frame.tick-this.tick)*100);
      this.due=Math.max(this.due+(gap||0),now);
      this.queue.push({frame,due:this.due});this.tick=frame.tick;this.seq=frame.seq;
    }
    // A background tab or slow network must not replay a long burst of old hits.
    if(this.queue.length>24||this.due-now>2000){
      this.queue=[];this.last=newest;this.due=now;this.onReset();this.paint(newest,{silent:true});
    }
    this.pump();return true;
  }
  pump(){
    const now=this.now();
    if(this.queue.length&&now-this.queue[0].due>1200){const item=this.queue.at(-1);this.queue=[];this.last=item.frame;this.due=now;this.onReset();this.paint(item.frame,{silent:true});return;}
    while(this.queue.length&&this.queue[0].due<=now){const {frame}=this.queue.shift();this.last=frame;this.paint(frame,{silent:false});}
  }
}
