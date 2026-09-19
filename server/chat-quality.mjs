const normalize=text=>String(text).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const sentences=text=>String(text).split(/[。！？!?\n]+/u).map(normalize).filter(s=>s.length>=8);
function overlap(a,b){
  const pairs=s=>new Set(Array.from({length:s.length-1},(_,i)=>s.slice(i,i+2)));
  const x=pairs(a),y=pairs(b);
  return 2*[...x].filter(p=>y.has(p)).length/(x.size+y.size);
}

// Compare all speakers, so taking turns or changing a greeting cannot repeat a line.
export function repeatedChat(text,recent){
  const next=normalize(text);
  if(!next)return false;
  const parts=sentences(text);
  if(new Set(parts).size<parts.length)return true;
  return recent.some(previous=>{
    const before=normalize(previous.text??previous);
    if(next===before)return true;
    if(Math.min(next.length,before.length)<8)return false;
    // Changed numbers or negation can change the answer; do not erase that distinction.
    if((next.match(/\d+/g)||[]).join(',')!==(before.match(/\d+/g)||[]).join(','))return false;
    if((next.match(/不|沒|無|否|别|別/g)||[]).join('')!==(before.match(/不|沒|無|否|别|別/g)||[]).join(''))return false;
    if(parts.some(a=>sentences(previous.text??previous).some(b=>a===b&&a.length>=Math.min(next.length,before.length)*0.55)))return true;
    return overlap(next,before)>=0.72&&Math.min(next.length,before.length)/Math.max(next.length,before.length)>=0.6;
  });
}

export function echoedChat(text,recent){
  const next=normalize(text);
  return recent.some(message=>{
    const previous=normalize(message.text);
    return !message.ai&&previous.length>=6&&next.endsWith(previous)&&next.length-previous.length<=3;
  });
}

export function mentionedItems(catalog,recent,reply){
  const text=[...recent.slice(-6).map(m=>m.text),reply?.text||''].join('\n');
  return Object.values(catalog?.items||{}).filter(item=>item.n?.length>=2&&text.includes(item.n)).slice(0,4)
    .map(item=>({name:item.n,type:({wpn:'武器',arm:'防具',acc:'飾品',etc:'道具'})[item.type]||'物品',description:String(item.d||'').slice(0,240)}));
}
