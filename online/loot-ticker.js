export function startLootTicker(cloud,canPoll){
  const game=document.getElementById('game-screen'),center=document.getElementById('col-center');
  if(!game||!center)return;
  if(!document.querySelector('link[href*="/online/loot-ticker.css"]')){const css=document.createElement('link');css.rel='stylesheet';css.href='/online/loot-ticker.css';document.head.append(css);}
  const banner=document.createElement('aside');banner.id='loot-ticker';banner.hidden=true;banner.setAttribute('aria-label','全服事件廣播');
  const badge=document.createElement('strong');badge.textContent='稀有掉落';
  const viewport=document.createElement('div');viewport.className='loot-ticker-viewport';
  const text=document.createElement('span');text.className='loot-ticker-text';viewport.append(text);
  const close=document.createElement('button');close.type='button';close.textContent='×';close.setAttribute('aria-label','略過這則廣播');
  const status=document.createElement('span');status.className='loot-ticker-status';status.setAttribute('role','status');
  banner.append(badge,viewport,close,status);center.prepend(banner);
  const announcement=document.createElement('aside');announcement.id='gm-announcement';announcement.hidden=true;announcement.setAttribute('aria-label','GM 公告');
  const announcementBadge=document.createElement('strong');announcementBadge.textContent='GM 公告';
  const announcementViewport=document.createElement('div'),announcementText=document.createElement('span');announcementViewport.append(announcementText);announcement.append(announcementBadge,announcementViewport);
  let announcementData=cloud.boot.worldSettings?.announcement||null,announcementId=null;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const phone=matchMedia('(max-width: 768px), (max-height: 520px) and (pointer: coarse)');
  function placeBanner(){if(phone.matches){game.insertBefore(banner,center);game.insertBefore(announcement,banner);}else{center.prepend(banner);center.prepend(announcement);}}
  phone.addEventListener('change',placeBanner);placeBanner();
  const queue=[];let cursor=cloud.boot.lootBroadcastCursor||0,killCursor=cloud.boot.killBroadcastCursor||0,busy=false,active=false,activeKind=null,timer,generation=0,policyGeneration=cloud.boot.worldSettings?.lootBroadcast?.generation||0,killGeneration=cloud.boot.worldSettings?.killBroadcast?.generation||0;
  function resizeBanner(change){
    const follow=['combat-log','sys-log'].map(id=>document.getElementById(id)).filter(el=>el&&el.clientHeight>0&&el.scrollHeight-el.scrollTop-el.clientHeight<24);
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
    const event=queue.shift();active=true;activeKind=event.kind==='kill'?'kill':'loot';const ticket=++generation;
    const line=GameLootRarity.message(event);
    badge.textContent=activeKind==='kill'?'討伐捷報':'稀有掉落';banner.dataset.rarity=activeKind==='kill'?'boss':event.rarity;text.textContent=line;banner.title=line;status.textContent=line;
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
  function clearKind(kind){for(let i=queue.length-1;i>=0;i--)if((queue[i].kind==='kill'?'kill':'loot')===kind)queue.splice(i,1);if(active&&activeKind===kind)finish();}
  function renderAnnouncement(){
    const data=announcementData,now=cloud.serverNow?.()||Date.now();
    if(!data||data.expiresAt<=now){announcement.hidden=true;announcementId=null;return;}
    if(announcementId===data.id)return;announcementId=data.id;
    announcementText.textContent=data.text;announcement.title=data.text;announcement.hidden=false;announcement.dataset.pinned=String(data.pinned);
    announcementText.style.animation='none';
    requestAnimationFrame(()=>{
      if(announcementId!==data.id||data.pinned||reduced.matches)return;
      const width=announcementViewport.clientWidth,seconds=Math.max(12,(width+announcementText.scrollWidth)/55);
      announcement.style.setProperty('--ticker-start',width+'px');announcementText.style.animation=`loot-ticker-scroll ${seconds}s linear infinite`;
    });
  }
  async function poll(){
    if(busy||!canPoll()||document.hidden||game.classList.contains('hidden'))return;
    busy=true;
    try{
      const data=await cloud.request('/api/loot-broadcasts?after='+cursor+'&afterKills='+killCursor);
      announcementData=data.announcement||null;renderAnnouncement();
      if(data.enabled===false||policyGeneration!==(data.generation||0)){clearKind('loot');policyGeneration=data.generation||0;}
      for(const event of data.events||[])if(data.enabled!==false&&event.id>cursor){if(queue.length<100)queue.push(event);cursor=event.id;}
      cursor=Math.max(cursor,data.cursor||0);
      if(data.kills){const kills=data.kills;if(kills.enabled===false||killGeneration!==(kills.generation||0)){clearKind('kill');killGeneration=kills.generation||0;}
        for(const event of kills.events||[])if(kills.enabled!==false&&event.id>killCursor){if(queue.length<100)queue.push({...event,kind:'kill'});killCursor=event.id;}killCursor=Math.max(killCursor,kills.cursor||0);}
      next();
    }catch{/* The next poll resumes at the same cursor after reconnecting. */}
    finally{busy=false;}
  }
  setInterval(poll,4000);
  setInterval(renderAnnouncement,1000);renderAnnouncement();
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void poll();});
}
