import { applyEffect, refreshGmBuffs } from '/shared/gm-effects.js';
import { startLootTicker } from './loot-ticker.js';
import { startWorldChat } from './world-chat.js?v=presence-20260919';

const cloud=window.CloudStore;
if(cloud)startOnline();
function startOnline(){
  const ui=document.createElement('aside');ui.id='cloud-toolbar';
  ui.innerHTML='<span class="cloud-account"></span><span class="cloud-save" role="status">連線中…</span><button type="button" data-online aria-controls="cloud-chat" aria-expanded="false">線上 —</button><button type="button" data-chat aria-controls="cloud-chat" aria-expanded="false">聊天</button><button type="button" data-more aria-controls="cloud-actions" aria-expanded="false" aria-label="帳號與設定">⋯</button><div id="cloud-actions"><button type="button" data-shop>💎 藍鑽商店</button><button type="button" data-save>同步存檔</button><a href="/gm" target="_blank" rel="noopener" data-gm>GM 控制台 ↗</a><button type="button" data-logout>登出</button></div>';
  document.body.append(ui);
  ui.querySelector('.cloud-account').textContent=`${cloud.boot.user.role==='gm'?'♛ GM · ':''}${cloud.boot.user.username}`;
  ui.querySelector('[data-gm]').hidden=cloud.boot.user.role!=='gm';
  const status=ui.querySelector('.cloud-save');
  const syncWarning=document.createElement('div');syncWarning.id='cloud-sync-warning';syncWarning.hidden=true;
  syncWarning.innerHTML='<span role="alert"></span>';document.body.append(syncWarning);
  let busy=false, stopped=false, offset=cloud.boot.serverTime-Date.now();
  cloud.serverNow = () => Date.now() + offset;
  function message(text,error=false){
    status.textContent=text;status.title=text;status.classList.toggle('cloud-error',error);
    syncWarning.hidden=!error;
    syncWarning.querySelector('span').textContent=error?'雲端尚未同步：'+text+'。請保留此分頁，避免遺失進度。':'';
  }
  function capture(){
    if(typeof player==='undefined'||!player?.cls||typeof saveStateJson!=='function')return;
    if(typeof _roleSaveAllowed==='function'&&!_roleSaveAllowed())return;
    if(player.dead&&!player._gmDead)return;
    cloud.set('lineage_idle_save_'+currentSlot,_saveWrap(saveStateJson()));
  }
  function refresh(){
    if(typeof player==='undefined'||!player?.cls)return;
    if(typeof gmApplyTeleport==='function')gmApplyTeleport();
    refreshGmBuffs(player,Date.now()+offset);
    if(player._gmDead){
      player.hp=0;player.dead=true;state.running=false;
      document.getElementById('btn-revive')?.classList.remove('hidden');
      document.getElementById('btn-revive-inplace')?.classList.add('hidden');
    }
    if(typeof calcStats==='function')calcStats();
    if(typeof renderTabs==='function')renderTabs(true);
    if(typeof renderMobs==='function')renderMobs();
  }
  function reconcile(data){
    capture();
    const effects=data.effects||[];
    cloud.rebase(data.snapshot);offset=data.snapshot.serverTime-Date.now();
    adoptNames(data.snapshot);
    if(typeof gmSetWorld==='function')gmSetWorld(data.snapshot.worldSettings);
    for(const effect of effects){
      const raw=cloud.get(effect.key);
      if(raw){const unwrapped=_saveUnwrap(raw);if(unwrapped.ok){const doc=JSON.parse(unwrapped.payload);if(applyEffect(doc,effect,Date.now()+offset))cloud.set(effect.key,_saveWrap(JSON.stringify(doc)));}}
      if(typeof player!=='undefined'&&player?.cls&&effect.key==='lineage_idle_save_'+currentSlot){
        if(applyEffect({p:player},effect,Date.now()+offset)){
          if(effect.action==='revive'){
            state.running=true;
            document.getElementById('btn-revive')?.classList.add('hidden');
            document.getElementById('btn-revive-inplace')?.classList.add('hidden');
          }
          refresh();capture();
          const source=effect.action==='market'?'交易':effect.action==='shop_buff'?'藍鑽全狀態':'GM 指令';
          if(typeof logSys==='function')logSys(`<span class="text-amber-300">${source} #${effect.purchaseSeq||effect.seq} 已套用。</span>`);
          message(`已收到${source} #${effect.purchaseSeq||effect.seq}`);
        }
      }
    }
  }
  function adoptNames(snapshot){
    for(const [key,raw]of Object.entries(snapshot.values||{})){
      if(!/^lineage_idle_save_[1-8]$/.test(key)||!cloud.get(key))continue;
      const remote=_saveUnwrap(raw),local=_saveUnwrap(cloud.get(key));if(!remote.ok||!local.ok)continue;
      const serverDoc=JSON.parse(remote.payload),doc=JSON.parse(local.payload);
      if((doc.p._roleEpoch||doc.p.enSeed)!==(serverDoc.p._roleEpoch||serverDoc.p.enSeed))continue;
      if(doc.p.name!==serverDoc.p.name){doc.p.name=serverDoc.p.name;cloud.set(key,_saveWrap(JSON.stringify(doc)));}
      if(typeof player!=='undefined'&&player?.cls&&key==='lineage_idle_save_'+currentSlot&&(player._roleEpoch||player.enSeed)===(serverDoc.p._roleEpoch||serverDoc.p.enSeed))player.name=serverDoc.p.name;
    }
  }
  cloud.adoptNames=adoptNames;
  cloud.reconcile=reconcile;
  cloud.flush=async()=>{for(let i=0;busy&&i<300;i++)await new Promise(r=>setTimeout(r,50));await sync();if(stopped||!cloud.ready||Object.keys(cloud.pending()).length)throw new Error('請先完成雲端同步，再進行此操作');};
  async function sync(){
    if(busy||stopped||!cloud.ready||cloud.marketPending||cloud.shopPending)return;
    busy=true;
    try{
      for(let attempt=0;attempt<3;attempt++){
        capture();const changes=cloud.pending();
        try{
          const result=await cloud.request('/api/sync',{lease:cloud.lease,revision:cloud.revision,changes,
            presence:typeof player!=='undefined'&&player?.cls?{name:player.name||cloud.boot.user.username,slot:currentSlot,map:DB.maps[mapState.current]?.n||mapState.current}:{}});
          if(typeof gmSetWorld==='function')gmSetWorld(result.worldSettings);
          cloud.ack(changes,result.revision);offset=result.serverTime-Date.now();message('雲端已同步 · '+new Date().toLocaleTimeString('zh-TW'));return;
        }catch(error){
          if(error.status===409&&error.data.snapshot){reconcile(error.data);continue;}
          throw error;
        }
      }
      message('伺服器忙碌，稍後同步',true);
    }catch(error){
      message(error.message,true);
      if(error.status===401||error.status===423){stopped=true;if(typeof state!=='undefined')state.running=false;showBlock(error.message,true);}
    }finally{busy=false;}
  }
  function showBlock(text,takeover=false){
    let block=document.getElementById('cloud-block');
    if(!block){block=document.createElement('div');block.id='cloud-block';document.body.append(block);}
    block.replaceChildren();const card=document.createElement('section'),title=document.createElement('h2'),p=document.createElement('p');
    title.textContent='雲端遊戲連線';p.textContent=text;card.append(title,p);
    const retry=document.createElement('button');retry.textContent=takeover?'接管遊戲':'重試連線';retry.onclick=()=>connect(takeover);card.append(retry);
    const login=document.createElement('a');login.href='/login';login.textContent='返回登入';card.append(login);block.append(card);
  }
  async function connect(takeover=false){
    try{
      await cloud.request('/api/lease',{lease:cloud.lease,takeover});
      if(takeover){
        const snapshot=await cloud.request('/api/bootstrap');cloud.reset(snapshot);offset=snapshot.serverTime-Date.now();
        if(typeof player!=='undefined'&&player?.cls&&typeof loadGame==='function')loadGame();
      }
      cloud.ready=true;stopped=false;document.getElementById('cloud-block')?.remove();await sync();
    }catch(error){showBlock(error.message,error.status===423);message(error.message,true);}
  }
  // Preserve upstream character initialization, then restore server-issued effects
  // that the offline loader normally clears (notably the GM death state).
  for(const name of ['startGame','loadGame']){
    const original=window[name];
    window[name]=function(...args){const result=original.apply(this,args);refresh();capture();void sync();return result;};
  }
  for(const name of ['revive','reviveInPlace']){
    const original=window[name];
    window[name]=function(...args){
      const wasGmDead=!!player?._gmDead;
      // Let the original reviveInPlace check death and resources before changing flags.
      const result=original.apply(this,args);
      if(wasGmDead&&!player.dead){player._gmDead=false;state.running=true;}
      capture();void sync();return result;
    };
  }
  // Cloud death persists even though the original local save intentionally skips dead characters.
  ui.querySelector('[data-save]').onclick=async()=>{if(typeof saveGame==='function'&&player?.cls&&!player.dead)saveGame();await sync();};
  ui.querySelector('[data-shop]').onclick=()=>cloud.showShop?.();
  ui.querySelector('[data-logout]').onclick=async()=>{
    await sync();if(Object.keys(cloud.pending()).length){message('仍有未同步進度，請完成同步後再登出',true);return;}
    await cloud.request('/api/auth/logout',{});location.href='/login';
  };
  const {refresh:world}=startWorldChat(cloud,ui,()=>stopped);
  startLootTicker(cloud,()=>cloud.ready&&!stopped);
  showBlock('正在載入帳號的雲端存檔…');void connect();
  setInterval(sync,3000);setInterval(world,4000);
  setInterval(()=>{if(typeof player!=='undefined'&&(player?._gmBuffs||player?._shopBuffs)){refreshGmBuffs(player,Date.now()+offset);if(typeof calcStats==='function')calcStats();}},1000);
  setInterval(()=>{if(cloud.ready&&!stopped&&typeof player!=='undefined'&&player?.cls&&!player.dead)saveGame();},15000);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)void sync();else{void sync();void world();}});
  window.addEventListener('beforeunload',event=>{capture();if(Object.keys(cloud.pending()).length){event.preventDefault();event.returnValue='';}});
}
