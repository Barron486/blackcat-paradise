import {startLootTicker} from './loot-ticker.js';
import {startWorldChat} from './world-chat.js?v=presence-20260919';
import {npcIntents} from '/shared/game-intents.js';
import {startBattlePlayback} from './battle-playback.js';
import {startBattleFeed} from './battle-feed.js';

const cloud=window.CloudStore;
if(cloud)start();
function start(){
  const toolbar=document.createElement('aside');toolbar.id='cloud-toolbar';
  toolbar.innerHTML='<span class="cloud-account"></span><span class="cloud-save" role="status">連線中…</span><button type="button" data-online aria-controls="cloud-chat" aria-expanded="false">線上 —</button><button type="button" data-chat aria-controls="cloud-chat" aria-expanded="false">聊天</button><button type="button" data-more aria-controls="cloud-actions" aria-expanded="false" aria-label="帳號與設定">⋯</button><div id="cloud-actions"><button type="button" data-shop>💎 藍鑽商店</button><button type="button" data-save>同步存檔</button><a href="/gm" target="_blank" rel="noopener" data-gm>GM 控制台 ↗</a><button type="button" data-logout>登出</button></div>';
  toolbar.querySelector('.cloud-account').textContent=(cloud.boot.user.role==='gm'?'♛ GM · ':'')+cloud.boot.user.username;
  toolbar.querySelector('[data-gm]').hidden=cloud.boot.user.role!=='gm';document.body.append(toolbar);
  const status=toolbar.querySelector('.cloud-save');
  let active=null,queue=Promise.resolve(),pending=0,lastLog=0,logEpoch=null,offset=cloud.boot.serverTime-Date.now(),stopped=false;
  let npcId=null;
  const load=window.loadGame,leave=window.returnToCharacterSelect;
  const showError=error=>{status.textContent=error.message;status.classList.add('cloud-error');if(error.status===401||error.status===423){cloud.ready=false;stopped=true;block(error.message,true);}else if(typeof logSys==='function')logSys(escape(error.message));};
  const escape=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const docAt=slot=>{try{const raw=cloud.get('lineage_idle_save_'+slot),d=_saveUnwrap(raw);return d.ok?JSON.parse(d.payload):null;}catch{return null;}};
  const roleEpoch=doc=>doc?.p?._roleEpoch||doc?.p?.enSeed;
  const battle=startBattlePlayback();
  const feed=startBattleFeed(cloud,{receive:packet=>battle.receive(packet),cursor:battle.cursor,onDenied:showError});
  // The browser renders snapshots only. Even a modified browser has no progression upload API.
  stopGameTimers();
  for(const name of ['tick','gameLoop','startGameTimers','settleBackgroundMs','queueCatchupMs','_resumeIncrementalBackground'])window[name]=()=>{};
  window.saveGame=()=>true;
  cloud.serverNow=()=>Date.now()+offset;
  function render(view,initial=false,packet=null){
    if(!view)return;
    const oldMap=typeof mapState==='undefined'?null:mapState.current;
    if(initial){currentSlot=active.slot;const travel=window.changeMap;try{window.changeMap=()=>{};load();}finally{window.changeMap=travel;}initCombatLogLock();initSysLogLock();applyCombatFilter();_initTabGuard();}
    const draft=!initial&&_asBackup?{autoSellRules:player.autoSellRules,autoSellOn:player.autoSellOn,autoSellGlobal:player.autoSellGlobal}:null;
    player=view.p;mapState=view.ms;state.ticks=view.ticks;state.running=!player.dead;
    if(draft)Object.assign(player,draft);
    calcStats(); // Restore derived helpers (e.g. MP costs), which are not JSON values.
    _roleBindRuntime();
    if(initial||oldMap!==mapState.current){
      syncMapSelectors();applyAreaBackground();
      const town=!!DB.towns[mapState.current];
      document.getElementById('town-view')?.classList.toggle('hidden',!town);
      document.getElementById('battle-view')?.classList.toggle('hidden',town);
      if(town)renderTownNPCs(mapState.current);
      else closeNpcInteraction();
    }
    document.getElementById('btn-revive')?.classList.toggle('hidden',!player.dead);
    document.getElementById('btn-revive-inplace')?.classList.toggle('hidden',!player.dead||!!player._gmDead);
    if(initial||oldMap!==mapState.current)battle.clear();
    const playing=battle.receive(packet,{reset:initial});
    updateUI();if(!playing)renderMobs();renderTabs();
  }
  function adopt(result){
    const snapshot=result.snapshot||result;
    if(!snapshot.values)return;
    cloud.reset(snapshot);offset=snapshot.serverTime-Date.now();gmSetWorld(snapshot.worldSettings);
    if(result.game){
      const initial=!active||active.epoch!==result.game.epoch||document.getElementById('game-screen').classList.contains('hidden');
      active={slot:result.game.slot,epoch:result.game.epoch};
      if(logEpoch!==active.epoch){lastLog=0;logEpoch=active.epoch;}
      render(result.game.view,initial,result.game.battle);
      feed.open(active);
      if((result.game.logs?.at(-1)?.id||0)<lastLog)lastLog=0;
      for(const entry of result.game.logs||[])if(entry.id>lastLog){
        const message=entry.html||escape(entry.message);
        if(entry.type==='system')logSys(message);else logCombat(message,entry.type);
        lastLog=entry.id;
      }
    }else if(active){const doc=docAt(active.slot);if(roleEpoch(doc)===active.epoch)render(doc);}
    // Upstream rendering may write presentation caches; none are submitted to the server.
    cloud.reset(snapshot);status.textContent='伺服器已結算 · '+new Date(snapshot.serverTime).toLocaleTimeString('zh-TW');status.classList.remove('cloud-error');
  }
  cloud.reconcile=adopt;cloud.adoptNames=adopt;
  async function request(op,args={},target=active){
    if(!cloud.ready)throw new Error('請先完成伺服器連線');
    const body={lease:cloud.lease,op,args:op==='state'?{...args,presentation:feed.healthy()?false:battle.cursor()}:args,...(target?{slot:target.slot,epoch:target.epoch}:{}),...(op==='state'?{}:{requestId:crypto.randomUUID(),revision:cloud.revision})};
    for(let attempt=0;attempt<3;attempt++)try{
      const result=await cloud.request('/api/game',body);adopt(result);return result;
    }catch(error){
      if(error.status===409&&error.data?.snapshot){adopt(error.data);body.revision=cloud.revision;continue;}
      // A retry always carries the same ID: a lost response cannot repeat a purchase.
      if(!error.status&&attempt<2){await new Promise(r=>setTimeout(r,500));continue;}
      throw error;
    }
    throw new Error('角色狀態正在更新，請稍後重試');
  }
  function enqueue(fn){pending++;const p=queue.then(fn);queue=p.catch(showError).finally(()=>pending--);return p;}
  const action=(name,params={})=>{const target=active&&{...active};return enqueue(()=>request('action',{name,params},target));};
  cloud.action=action;
  const fire=(name,params)=>{void action(name,params).catch(()=>{});};
  async function poll(){if(!cloud.ready||stopped||cloud.marketPending||cloud.shopPending)return;const result=await request('state');if(active&&!result.game)await request('select',{},active);}
  cloud.flush=()=>enqueue(poll);
  function block(message,takeover=false){
    let e=document.getElementById('cloud-block');if(!e){e=document.createElement('div');e.id='cloud-block';document.body.append(e);}
    e.innerHTML='<section><h2>雲端遊戲連線</h2><p></p><button type="button"></button><a href="/login">返回登入</a></section>';
    e.querySelector('p').textContent=message;e.querySelector('button').textContent=takeover?'接管遊戲':'重新連線';e.querySelector('button').onclick=()=>connect(takeover);
  }
  async function connect(takeover=false){try{
    await cloud.request('/api/lease',{lease:cloud.lease,takeover});adopt(await cloud.request('/api/bootstrap'));
    cloud.ready=true;stopped=false;document.getElementById('cloud-block')?.remove();await enqueue(poll);
  }catch(error){block(error.message,error.status===423);}}
  window.startGame=()=>{
    if(!updateCreationName())return;
    const target={slot:currentSlot},args={classId:curCreate.cls,name:document.getElementById('creation-name').value.trim(),gender:curCreate.rawCls?.startsWith('f_')?'female':'male',classicMode:!!document.getElementById('create-classic-toggle')?.checked,allocation:Object.fromEntries(['str','dex','con','int','wis','cha'].map(k=>[k,curCreate[k]]))};
    void enqueue(()=>request('create',args,target)).catch(()=>{});
  };
  window.loadGame=()=>{const target={slot:currentSlot,epoch:roleEpoch(docAt(currentSlot))};void enqueue(()=>request('select',{},target)).catch(()=>{});};
  window.returnToCharacterSelect=()=>{void enqueue(async()=>{if(active)await request('leave');active=null;feed.close();battle.clear();leave();renderLoadSelect();}).catch(()=>{});return true;};
  window.loadDeleteSelected=()=>{const slot=_loadSelectedSlot,doc=docAt(slot);if(!doc)return;const name=doc.p.name||'未命名';if(prompt(`請輸入角色名稱「${name}」確認刪除：`)!==name||!confirm('確定永久刪除此角色？'))return;void enqueue(async()=>{await request('delete',{name},{slot,epoch:roleEpoch(doc)});active=null;renderLoadSelect();}).catch(()=>{});};
  window.importSave=()=>alert('線上角色由伺服器保存，無法匯入本機存檔。');
  window.changeMap=()=>fire('travel',{mapId:document.getElementById('map-select').value});
  window.setTarget=index=>{const uid=battle.target(index)||mapState.mobs[index]?.uid;if(uid)fire('target',{uid:String(uid)});};
  window.returnToTown=()=>fire('return-town');window.playerTeleport=()=>fire('teleport');
  window.revive=()=>fire('revive');window.reviveInPlace=()=>fire('revive-in-place');
  window.equipItem=item=>fire('equip',{uid:item.uid});window.unequipItem=slot=>fire('unequip',{slot});
  window.useItem=uid=>fire('use',{uid});window.sellItem=(uid,qty)=>fire('sell',{uid,qty});
  window.batchUseItem=uid=>{const qty=Number(prompt('要使用多少個？（最多 1000）','1'));if(qty>0)fire('batch-use',{uid,qty});};
  window.toggleLock=uid=>fire('lock',{uid});window.toggleJunk=uid=>fire('junk',{uid});window.autoSellJunk=()=>fire('sell-junk');
  window.setInventorySortMode=mode=>fire('sort',{mode});window.toggleInventoryAutoSort=enabled=>fire('sort',{enabled:!!enabled});window.sortInventoryNow=()=>fire('sort',{});
  window.runQuickJunk=type=>fire('quick-junk',{type,uids:Object.keys(quickJunk[type].sel).filter(k=>quickJunk[type].sel[k])});
  window.runQuickEnhance=type=>fire('quick-enhance',{type,uids:Object.keys(quickEnh[type].sel).filter(k=>quickEnh[type].sel[k]),goal:Number(document.getElementById('qe-target-'+type)?.value)||quickEnh[type].target,blessed:!!quickEnh[type].useBless});
  window.manualCast=skillId=>fire('cast',{skillId});window.castSkill=skillId=>{fire('cast',{skillId});return true;};
  window.adjBonusStat=stat=>fire('bonus',{stat});window.chooseElfElement=element=>fire('element',{element});
  const originalInteract=window.interactNPC;window.interactNPC=(id,town)=>{npcId=id;return originalInteract(id,town);};
  for(const method of npcIntents)window[method]=(...params)=>{
    const fields={};for(const el of document.querySelectorAll('#interaction-content input[id],#interaction-content select[id]'))if(!el.disabled&&!el.readOnly&&['number','checkbox','select-one'].includes(el.type))fields[el.id]=el.type==='checkbox'?el.checked:el.value;
    void action('npc-command',{npcId,method,params,fields}).then(()=>{if(DB.towns[mapState.current])originalInteract(npcId,mapState.current);}).catch(()=>{});
  };
  window.buyItem=(itemId,qty)=>fire('shop',{itemId,qty,npcId});
  window.doCraft=(id,index)=>fire('craft',{npcId:id,index,qty:Math.max(1,Number(document.getElementById(`craft-qty-${id}-${index}`)?.value)||1)});
  window.executeEnhance=(scrollUid,uid,equipped)=>fire('enhance',{uid,equipped:!!equipped,scrollId:player.inv.find(i=>i.uid===scrollUid)?.id});
  window.doEnhance=(uid,equipped=true)=>fire('enhance',{uid,equipped,scrollId:activeScroll?.id});
  window.executeAutoSafeEnhance=(uid,equipped,scrollId,goal)=>fire('auto-enhance',{uid,equipped:!!equipped,scrollId,goal});
  window.executeCurseDeEnhance=(uid,equipped,scrollId)=>fire('curse-enhance',{uid,equipped:!!equipped,scrollId});
  for(const [fn,operation]of [['whDeposit','deposit'],['whWithdraw','withdraw']])window[fn]=(uid,qty)=>{const items=operation==='deposit'?player.inv:loadWarehouse().items;fire('warehouse',{operation,uid,qty:qty||_whQtyVal()||items.find(i=>i.uid===uid)?.cnt||1});};
  window.whGold=dir=>fire('warehouse',{operation:dir==='in'?'gold-in':'gold-out',qty:Number(document.getElementById('wh-gold-amt').value)});
  window.whOneClickDeposit=()=>fire('warehouse',{operation:'deposit-all'});window.sortWarehouse=()=>fire('warehouse',{operation:'sort'});
  window.trialQAccept=key=>fire('trial',{key,complete:false});window.trialQComplete=key=>fire('trial',{key,complete:true});
  window.confirmRespec=()=>{if(_respec){fire('respec',{allocation:{..._respec.draft}});_respec=null;}};
  const autoSell=()=>{_readAutoSellForm();const args={rules:JSON.parse(JSON.stringify(getAutoSellRules())),enabled:player.autoSellOn!==false,global:!!document.getElementById('as-global')?.checked};_asBackup=null;closeAutoSellRules();return action('auto-sell',args);};
  window.saveAutoSellRules=()=>void autoSell().catch(()=>{});window.sellAutoSellItemsNow=()=>void autoSell().then(()=>action('sell-junk')).catch(()=>{});
  for(const [fn,operation]of [['petDeployToggle','deploy'],['petToggleLock','lock']])window[fn]=uid=>fire('pet',{operation,uid});
  window.petSetPotPct=(uid,value)=>fire('pet',{operation:'potion',uid,value:Number(value)});
  window.petGearEquip=(uid,slot,itemUid)=>fire('pet',{operation:'equip',uid,slot,itemUid});window.petGearUnequip=(uid,slot)=>fire('pet',{operation:'unequip',uid,slot});window.petRevive=(uid,method)=>fire('pet',{operation:'revive',uid,method});
  for(const [fn,operation]of [['toggleAlly','toggle'],['dismissAlly','dismiss'],['refreshAllyOnce','refresh']])window[fn]=slot=>fire('mercenary',{operation,slot:Number(slot)});
  window.reviveMercenary=(slot,method)=>fire('mercenary',{operation:'revive',slot:Number(slot),method});
  document.addEventListener('change',event=>{const el=event.target;if(!active||!el.id||!(/^(set-|sel-|auto-sk-)/.test(el.id)))return;fire('settings',{values:{[el.id]:el.type==='checkbox'?el.checked:el.value}});});
  toolbar.querySelector('[data-save]').onclick=()=>void cloud.flush().catch(()=>{});
  toolbar.querySelector('[data-shop]').onclick=()=>cloud.showShop?.();
  toolbar.querySelector('[data-logout]').onclick=()=>void enqueue(async()=>{if(active)await request('leave');await cloud.request('/api/auth/logout',{});location.href='/login';}).catch(()=>{});
  const {refresh:world}=startWorldChat(cloud,toolbar,()=>stopped);startLootTicker(cloud,()=>cloud.ready&&!stopped);
  setInterval(()=>{if(!pending)void enqueue(poll).catch(()=>{});},2000);setInterval(world,4000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!pending)void enqueue(poll).catch(()=>{});});
  block('正在連接伺服器…');void connect();
}
