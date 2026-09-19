// Keep battle frames independent of inventory/save downloads and UI actions.
export function startBattleFeed(cloud,{receive,cursor,onDenied,now=()=>Date.now()}={}){
  let source=null,key=null,lastFrame=null;
  function close(){source?.close();source=null;key=null;lastFrame=null;}
  function open(role){
    const next=role&&`${role.slot}:${role.epoch}`;
    if(next===key)return;
    close();if(!role||typeof EventSource!=='function')return;
    key=next;
    const c=cursor(),query=new URLSearchParams({lease:cloud.lease});
    if(c.stream)query.set('after',`${c.stream}:${c.seq}`);
    const stream=source=new EventSource('/api/game/battle?'+query);
    stream.addEventListener('battle',event=>{
      if(source!==stream)return;
      try{const data=JSON.parse(event.data);if(data.slot!==role.slot||data.epoch!==role.epoch)return;lastFrame=now();receive(data.battle);}catch{}
    });
    stream.addEventListener('denied',event=>{if(source!==stream)return;close();try{const data=JSON.parse(event.data);onDenied(Object.assign(new Error(data.error),{status:data.status}));}catch{}});
  }
  window.addEventListener('pagehide',close);
  return {open,close,healthy:()=>!!source&&lastFrame!==null&&now()-lastFrame<3500};
}
