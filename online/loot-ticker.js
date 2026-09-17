export function startLootTicker(cloud,canPoll){
  const game=document.getElementById('game-screen'),center=document.getElementById('col-center');
  if(!game||!center)return;
  const css=document.createElement('link');css.rel='stylesheet';css.href='/online/loot-ticker.css';document.head.append(css);
  const banner=document.createElement('aside');banner.id='loot-ticker';banner.hidden=true;banner.setAttribute('aria-label','全服稀有掉落廣播');
  const badge=document.createElement('strong');badge.textContent='稀有掉落';
  const viewport=document.createElement('div');viewport.className='loot-ticker-viewport';
  const text=document.createElement('span');text.className='loot-ticker-text';viewport.append(text);
  const close=document.createElement('button');close.type='button';close.textContent='×';close.setAttribute('aria-label','略過這則掉寶廣播');
  const status=document.createElement('span');status.className='loot-ticker-status';status.setAttribute('role','status');
  banner.append(badge,viewport,close,status);center.prepend(banner);
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const phone=matchMedia('(max-width: 768px), (max-height: 520px) and (pointer: coarse)');
  function placeBanner(){if(phone.matches)game.insertBefore(banner,center);else center.prepend(banner);}
  phone.addEventListener('change',placeBanner);placeBanner();
  const queue=[];let cursor=cloud.boot.lootBroadcastCursor||0,busy=false,active=false,timer,generation=0;
  function resizeBanner(change){
    const follow=['combat-log','sys-log'].map(id=>document.getElementById(id)).filter(el=>el.clientHeight>0&&el.scrollHeight-el.scrollTop-el.clientHeight<24);
    change();
    requestAnimationFrame(()=>{
      for(const log of follow){
        if(log.id==='combat-log'&&window.combatLogToBottom)window.combatLogToBottom();
        else if(log.id==='sys-log'&&window.sysLogToBottom)window.sysLogToBottom();
        else log.scrollTop=log.scrollHeight;
      }
    });
  }
  function finish(){clearTimeout(timer);generation++;active=false;resizeBanner(()=>{banner.hidden=true;game.classList.remove('has-loot-ticker');});next();}
  function next(){
    if(active||!queue.length)return;
    const event=queue.shift();active=true;const ticket=++generation;
    const tier=event.rarity==='relic'?'遺物':'傳說';
    const line=`恭喜 ${event.name} 在 ${event.mapName} 擊敗 ${event.monster}，獲得【${tier}】${event.itemName}${event.quantity>1?' ×'+event.quantity:''}！`;
    banner.dataset.rarity=event.rarity;text.textContent=line;banner.title=line;status.textContent=line;
    text.style.animation='none';resizeBanner(()=>{banner.hidden=false;game.classList.add('has-loot-ticker');});
    requestAnimationFrame(()=>{
      if(ticket!==generation)return;
      const width=viewport.clientWidth,textWidth=text.scrollWidth;
      const seconds=Math.max(12,(width+textWidth)/55);
      banner.style.setProperty('--ticker-start',width+'px');
      if(!reduced.matches){void text.offsetWidth;text.style.animation=`loot-ticker-scroll ${seconds}s linear 1`;}
      else text.style.animation='none';
      timer=setTimeout(finish,(reduced.matches?12:seconds+1)*1000);
    });
  }
  close.onclick=finish;text.addEventListener('animationend',finish);
  async function poll(){
    if(busy||!canPoll()||document.hidden||game.classList.contains('hidden')||queue.length>=100)return;
    busy=true;
    try{
      const data=await cloud.request('/api/loot-broadcasts?after='+cursor);
      for(const event of data.events||[])if(event.id>cursor){queue.push(event);cursor=event.id;}
      cursor=Math.max(cursor,data.cursor||0);next();
    }catch{/* The next poll resumes at the same cursor after reconnecting. */}
    finally{busy=false;}
  }
  setInterval(poll,4000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void poll();});
}
