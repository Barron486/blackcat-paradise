import {startLootTicker} from './loot-ticker.js';
import {startWorldChat} from './world-chat.js?v=presence-20260919';
import {npcIntents,townEntrances,journeyDefaults} from '/shared/game-intents.js';
import {startBattlePlayback} from './battle-playback.js';
import {startBattleFeed} from './battle-feed.js';

const cloud=window.CloudStore;
if(cloud)start();
function start(){
  const toolbar=document.createElement('aside');toolbar.id='cloud-toolbar';
  toolbar.innerHTML='<span class="cloud-account"></span><span class="cloud-save" role="status">連線中…</span><button type="button" data-online aria-controls="cloud-chat" aria-expanded="false">線上 —</button><button type="button" data-chat aria-controls="cloud-chat" aria-expanded="false">聊天</button><button type="button" data-more aria-controls="cloud-actions" aria-expanded="false" aria-label="帳號與設定">⋯</button><div id="cloud-actions"><button type="button" data-shop>💎 藍鑽商店</button><button type="button" data-save>同步存檔</button><a href="/gm" target="_blank" rel="noopener" data-gm>GM 控制台 ↗</a><button type="button" data-logout>登出</button></div>';
  toolbar.querySelector('.cloud-account').textContent=(cloud.boot.user.role==='gm'?'♛ GM · ':'')+cloud.boot.user.username;
  toolbar.querySelector('[data-gm]').hidden=cloud.boot.user.role!=='gm';document.body.append(toolbar);
  const huntNote=document.createElement('p');huntNote.className='cloud-hunt-note';
  huntNote.textContent='關閉分頁或鎖屏後仍會持續掛機。回到選角、登出或角色死亡時停止。';
  toolbar.querySelector('#cloud-actions').prepend(huntNote);
  const status=toolbar.querySelector('.cloud-save');
  let active=null,queue=Promise.resolve(),pending=0,lastLog=0,logEpoch=null,offset=cloud.boot.serverTime-Date.now(),stopped=false;
  let npcId=null,pollController=null,managedAlly=null;
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
  function render(view,initial=false,packet=null,values={},petState){
    if(!view)return;
    if(initial){_respec=null;for(const id of ['poly-modal','osiris-box-modal','soul-orb-modal'])document.getElementById(id)?.classList.add('hidden');document.getElementById('summon-select-overlay')?.remove();}
    const oldMap=typeof mapState==='undefined'?null:mapState.current;
    if(initial){currentSlot=active.slot;const travel=window.changeMap;try{window.changeMap=()=>{};load();}finally{window.changeMap=travel;}initCombatLogLock();initSysLogLock();applyCombatFilter();_initTabGuard();}
    const draft=!initial&&_asBackup?{autoSellRules:player.autoSellRules,autoSellOn:player.autoSellOn,autoSellGlobal:player.autoSellGlobal}:null;
    player=view.p;mapState=view.ms;state.ticks=view.ticks;state.running=!player.dead;
    petAdoptServerRoster(values,petState);
    const journey=view._serverState||docAt(active.slot)?._serverState||{};
    for(const [key,fallback]of Object.entries(journeyDefaults))state[key]=journey[key]??fallback;
    pvpServerRestore(view._serverPvp||docAt(active.slot)?._serverPvp);
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
    updateUI();if(!playing)renderMobs();renderTabs();renderSquadPanel();pvpServerRender();
  }
  function adopt(result){
    const snapshot=result.snapshot||result;
    if(!snapshot.values)return;
    cloud.reset(snapshot);offset=snapshot.serverTime-Date.now();gmSetWorld(snapshot.worldSettings);
    if(result.game){
      const initial=!active||active.epoch!==result.game.epoch||document.getElementById('game-screen').classList.contains('hidden');
      active={slot:result.game.slot,epoch:result.game.epoch};
      if(logEpoch!==active.epoch){lastLog=0;logEpoch=active.epoch;}
      render(result.game.view||docAt(active.slot),initial,result.game.battle,snapshot.values,result.game.petState);
      feed.open(active);
      if((result.game.logs?.at(-1)?.id||0)<lastLog)lastLog=0;
      for(const entry of result.game.logs||[])if(entry.id>lastLog){
        const message=entry.html||escape(entry.message);
        if(entry.type==='system')logSys(message);else logCombat(message,entry.type);
        lastLog=entry.id;
      }
    }else if(active){const doc=docAt(active.slot);if(roleEpoch(doc)===active.epoch)render(doc,false,null,snapshot.values);}
    // Upstream rendering may write presentation caches; none are submitted to the server.
    cloud.reset(snapshot);status.textContent='伺服器已結算 · '+new Date(snapshot.serverTime).toLocaleTimeString('zh-TW');status.classList.remove('cloud-error');
  }
  cloud.reconcile=adopt;cloud.adoptNames=adopt;
  async function request(op,args={},target=active,signal){
    if(!cloud.ready)throw new Error('請先完成伺服器連線');
    const body={client:'browser',lease:cloud.lease,op,args:op==='state'?{...args,presentation:feed.healthy()?false:battle.cursor()}:args,...(target?{slot:target.slot,epoch:target.epoch}:{}),...(op==='state'?{}:{requestId:crypto.randomUUID(),revision:cloud.revision})};
    for(let attempt=0;attempt<3;attempt++)try{
      const result=await cloud.request('/api/game',body,{signal});if(signal?.aborted)throw signal.reason;adopt(result);return result;
    }catch(error){
      if(signal?.aborted)throw error;
      if(error.status===409&&error.data?.snapshot){adopt(error.data);body.revision=cloud.revision;continue;}
      // A retry always carries the same ID: a lost response cannot repeat a purchase.
      if(!error.status&&attempt<2){await new Promise(r=>setTimeout(r,500));continue;}
      throw error;
    }
    throw new Error('角色狀態正在更新，請稍後重試');
  }
  function enqueue(fn){pending++;const p=queue.then(fn);queue=p.catch(showError).finally(()=>pending--);return p;}
  function command(fn){pollController?.abort();return enqueue(fn);}
  const action=(name,params={})=>{const target=active&&{...active};return command(()=>request('action',{name,params},target));};
  cloud.action=action;
  const fire=(name,params)=>{void action(name,params).catch(()=>{});};
  async function poll(){
    if(!cloud.ready||stopped||cloud.marketPending||cloud.shopPending)return;
    const controller=new AbortController();pollController=controller;
    try{const result=await request('state',{},active,controller.signal);if(active&&!result.game)await request('select',{},active);}
    catch(error){if(!controller.signal.aborted)throw error;}
    finally{if(pollController===controller)pollController=null;}
  }
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
    void command(()=>request('create',args,target)).catch(()=>{});
  };
  window.loadGame=()=>{const target={slot:currentSlot,epoch:roleEpoch(docAt(currentSlot))};void command(()=>request('select',{},target)).catch(()=>{});};
  window.returnToCharacterSelect=()=>{void command(async()=>{if(active)await request('leave');active=null;feed.close();battle.clear();leave();renderLoadSelect();}).catch(()=>{});return true;};
  window.loadDeleteSelected=()=>{const slot=_loadSelectedSlot,doc=docAt(slot);if(!doc)return;const name=doc.p.name||'未命名';if(prompt(`請輸入角色名稱「${name}」確認刪除：`)!==name||!confirm('確定永久刪除此角色？'))return;void enqueue(async()=>{await request('delete',{name},{slot,epoch:roleEpoch(doc)});active=null;renderLoadSelect();}).catch(()=>{});};
  window.importSave=()=>alert('線上角色由伺服器保存，無法匯入本機存檔。');
  window.changeMap=()=>fire('travel',{mapId:document.getElementById('map-select').value});
  window.setTarget=index=>{const uid=battle.target(index)||mapState.mobs[index]?.uid;if(uid)fire('target',{uid:String(uid)});};
  window.returnToTown=()=>fire('return-town');window.playerTeleport=()=>fire('teleport');
  window.departToLastBattle=()=>fire('journey',{operation:'depart'});
  window.returnToPledgeBase=()=>fire('journey',{operation:'home'});
  window.riftEvacuate=()=>fire('journey',{operation:'rift-exit'});
  const arenaField=id=>document.querySelector('#pvp-arena-modal #'+id)||document.querySelector('#interaction-content #'+id);
  window.pvpChallengeSlot=()=>fire('arena',{slot:Number(arenaField('pvp-slot-sel')?.value)});
  window.pvpChallengePasted=()=>fire('arena',{card:arenaField('pvp-foe-card')?.value||''});
  window.pvpArenaSurrender=()=>fire('return-town');
  window.pvpResultContinue=()=>{void action('arena-result',{operation:'continue'}).then(()=>openPvpArena()).catch(()=>{});};
  window.pvpResultReturn=()=>fire('arena-result',{operation:'return'});
  window.revive=()=>fire('revive');window.reviveInPlace=()=>fire('revive-in-place');
  window.equipItem=item=>fire('equip',{uid:item.uid});window.unequipItem=slot=>fire('unequip',{slot});
  let polyBusy=false;
  const closePoly=window.closePolyModal;
  window.closePolyModal=()=>{if(!polyBusy)closePoly();};
  window.useItem=uid=>{
    const item=player.inv.find(i=>i.uid===uid);
    const effect=DB.items[item?.id]?.eff;
    if(['poly','osiris_box','reset','soulorb'].includes(effect)&&(player.dead||inAbsBarrier())){showError(new Error('目前狀態無法使用此道具'));return;}
    if(effect==='osiris_box'){
      if(boxBusy)return;
      if(playerCoreCount()<1){showError(new Error('缺少龜裂之核：每個寶箱需要 1 顆，可向希培利亞的巴特爾製作'));return;}
      closeModal();openOsirisBox(uid);return;
    }
    if(effect==='reset'){closeModal();startRespec();return;}
    if(effect==='soulorb'&&['wpn_powerless_baless','wpn_powerless_baphomet'].every(id=>player.inv.some(i=>i.id===id&&i.cnt>0))){openSoulChoice(uid);return;}
    if(DB.items[item?.id]?.eff==='poly'&&hasPolyRing()){
      if(polyBusy)return;
      if(player.dead||inAbsBarrier()){showError(new Error(player.dead?'死亡狀態無法變身，請先復活':'絕對屏障期間無法使用變形卷軸'));return;}
      closeModal();openPolySelect(uid);return;
    }
    fire('use',{uid});
  };
  window.confirmPolySelect=(uid,name)=>{
    if(polyBusy)return;polyBusy=true;
    const modal=document.getElementById('poly-modal');
    let notice=modal?.querySelector('[data-poly-notice]');
    if(modal&&!notice){notice=document.createElement('p');notice.dataset.polyNotice='';notice.setAttribute('role','alert');notice.className='text-red-300 text-sm mt-2';modal.querySelector('#poly-modal-list').after(notice);}
    if(notice)notice.textContent='正在套用變身…';
    modal?.querySelectorAll('button').forEach(button=>button.disabled=true);
    void action('polymorph',{uid,name}).then(()=>{closePoly();}).catch(error=>{if(notice)notice.textContent=error.message;}).finally(()=>{
      polyBusy=false;modal?.querySelectorAll('button').forEach(button=>button.disabled=false);
    });
  };
  let boxBusy=false,soulBusy=false;
  const closeBox=window.closeOsirisBoxModal;
  window.closeOsirisBoxModal=()=>{if(!boxBusy)closeBox();};
  window.confirmOsirisBox=uid=>window.doOpenOsirisBox(uid,Number(document.getElementById('osiris-box-qty')?.value));
  window.doOpenOsirisBox=(uid,qty)=>{
    if(boxBusy)return;
    const modal=document.getElementById('osiris-box-modal'),notice=modal?.querySelector('[data-box-notice]');
    if(!Number.isSafeInteger(qty)||qty<1||qty>1000){if(notice)notice.textContent='請輸入 1～1000 的整數數量';return;}
    boxBusy=true;if(notice)notice.textContent='正在開啟寶箱…';
    modal?.querySelectorAll('button,input').forEach(el=>el.disabled=true);
    void action('open-box',{uid,qty}).then(closeBox).catch(error=>{if(notice)notice.textContent=error.message;}).finally(()=>{
      boxBusy=false;modal?.querySelectorAll('button,input').forEach(el=>el.disabled=false);
    });
  };
  function openSoulChoice(uid){
    if(soulBusy)return;closeModal();
    let modal=document.getElementById('soul-orb-modal');
    if(!modal){modal=document.createElement('div');modal.id='soul-orb-modal';modal.className='fixed inset-0 flex items-center justify-center';document.body.append(modal);}
    modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-labelledby','soul-orb-title');
    modal.innerHTML='<div class="absolute inset-0 bg-black/60"></div><div class="panel p-5 relative flex flex-col gap-3"><h2 id="soul-orb-title" class="panel-header">靈魂之球 — 選擇魔杖</h2><p>消耗 1 顆靈魂之球與選定的失去魔力魔杖，恢復該魔杖。</p><div data-choices class="flex flex-col gap-2"></div><p role="alert" data-notice></p><button class="btn" data-cancel>取消</button></div>';
    const close=()=>{if(!soulBusy)modal.classList.add('hidden');};
    modal.firstElementChild.onclick=close;modal.querySelector('[data-cancel]').onclick=close;
    for(const [wand,name]of [['wpn_powerless_baless','巴列斯魔杖'],['wpn_powerless_baphomet','巴風特魔杖']]){
      const button=document.createElement('button');button.className='btn';button.textContent=name;
      button.onclick=()=>{
        if(soulBusy)return;soulBusy=true;modal.querySelectorAll('button').forEach(el=>el.disabled=true);
        modal.querySelector('[data-notice]').textContent='正在恢復魔杖…';
        void action('soul-orb',{uid,wand}).then(()=>modal.classList.add('hidden')).catch(error=>{modal.querySelector('[data-notice]').textContent=error.message;}).finally(()=>{soulBusy=false;modal.querySelectorAll('button').forEach(el=>el.disabled=false);});
      };modal.querySelector('[data-choices]').append(button);
    }
    modal.classList.remove('hidden');modal.querySelector('button').focus();
  }
  window.sellItem=(uid,qty)=>fire('sell',{uid,qty});
  window.batchUseItem=uid=>{const qty=Number(prompt('要使用多少個？（最多 1000）','1'));if(qty>0)fire('batch-use',{uid,qty});};
  window.toggleLock=uid=>fire('lock',{uid});window.toggleJunk=uid=>fire('junk',{uid});window.autoSellJunk=()=>fire('sell-junk');
  window.setInventorySortMode=mode=>fire('sort',{mode});window.toggleInventoryAutoSort=enabled=>fire('sort',{enabled:!!enabled});window.sortInventoryNow=()=>fire('sort',{});
  window.runQuickJunk=type=>fire('quick-junk',{type,uids:Object.keys(quickJunk[type].sel).filter(k=>quickJunk[type].sel[k])});
  window.runQuickEnhance=type=>fire('quick-enhance',{type,uids:Object.keys(quickEnh[type].sel).filter(k=>quickEnh[type].sel[k]),goal:Number(document.getElementById('qe-target-'+type)?.value)||quickEnh[type].target,blessed:!!quickEnh[type].useBless});
  window.manualCast=skillId=>fire('cast',{skillId});window.castSkill=skillId=>{fire('cast',{skillId});return true;};
  let summonBusy=false;
  window.chooseSummon=name=>{
    if(summonBusy)return;summonBusy=true;
    const modal=document.getElementById('summon-select-overlay');
    void action('summon-choice',{name}).then(()=>modal?.remove()).catch(error=>{
      if(modal?.isConnected){let notice=modal.querySelector('[role="alert"]');if(!notice){notice=document.createElement('p');notice.setAttribute('role','alert');modal.firstElementChild.prepend(notice);}notice.textContent=error.message;}
    }).finally(()=>{summonBusy=false;});
  };
  window.adjBonusStat=stat=>fire('bonus',{stat});
  window.chooseElfElement=element=>{
    if(!Object.hasOwn(ELF_ELE,element)||player.elfEle===element)return;
    if(player.elfEle&&!confirm(`確定花費 ${ELF_SWITCH_COST.toLocaleString()} 金幣將屬性轉換為「${ELF_ELE[element].name}」？`))return;
    void action('element',{element}).then(()=>{
      applyElfBorder();renderSkillSelects();
      if(npcId==='npc_elion'&&mapState.current==='town_elf')renderElionUI(document.getElementById('interaction-content'));
    }).catch(()=>{});
  };
  const originalInteract=window.interactNPC;window.interactNPC=(id,town)=>{npcId=id;managedAlly=null;return originalInteract(id,town);};
  const originalFloat=window.openTownFloatWindow;
  window.openTownFloatWindow=(name,title,renderer)=>{
    npcId=Object.keys(townEntrances).find(id=>window[townEntrances[id].render]===renderer)||null;
    return originalFloat(name,title,renderer);
  };
  const originalSiegeMenu=window.openSiegeSelect;
  window.openSiegeSelect=(...args)=>{npcId='_clan_siege';return originalSiegeMenu(...args);};
  for(const method of npcIntents)window[method]=(...params)=>{
    const sourceNpc=npcId,sourceMap=mapState.current;
    const fields={};for(const el of document.querySelectorAll('#interaction-content input[id],#interaction-content select[id]'))if(!el.disabled&&!el.readOnly&&['number','checkbox','select-one'].includes(el.type))fields[el.id]=el.type==='checkbox'?el.checked:el.value;
    void action('npc-command',{npcId:sourceNpc,method,params,fields}).then(()=>{
      if(mapState.current!==sourceMap||npcId!==sourceNpc||document.getElementById('town-interaction-container').classList.contains('hidden'))return;
      if(Object.hasOwn(townEntrances,sourceNpc)){const panel=document.getElementById('interaction-content');panel.innerHTML='';window[townEntrances[sourceNpc].render](panel);}
      else if(sourceNpc==='_clan_siege')originalSiegeMenu();
      else if(DB.towns[mapState.current])originalInteract(sourceNpc,mapState.current);
    }).catch(()=>{});
  };
  window.buyItem=(itemId,qty=1)=>{
    // Quantity inputs return strings; skillbook buttons omit the single-item quantity.
    const quantity=typeof qty==='string'?Number(qty):qty;
    if(!Number.isInteger(quantity)||quantity<1||quantity>10000){showError(new Error('請輸入 1～10000 的整數購買數量'));return;}
    fire('shop',{itemId,qty:quantity,npcId});
  };
  window.doCraft=(id,index)=>fire('craft',{npcId:id,index,qty:Math.max(1,Number(document.getElementById(`craft-qty-${id}-${index}`)?.value)||1)});
  window.executeEnhance=(scrollUid,uid,equipped)=>fire('enhance',{uid,equipped:!!equipped,scrollId:player.inv.find(i=>i.uid===scrollUid)?.id});
  window.doEnhance=(uid,equipped=true)=>fire('enhance',{uid,equipped,scrollId:activeScroll?.id});
  window.executeAutoSafeEnhance=(uid,equipped,scrollId,goal)=>fire('auto-enhance',{uid,equipped:!!equipped,scrollId,goal});
  window.executeCurseDeEnhance=(uid,equipped,scrollId)=>fire('curse-enhance',{uid,equipped:!!equipped,scrollId});
  for(const [fn,operation]of [['whDeposit','deposit'],['whWithdraw','withdraw']])window[fn]=(uid,qty)=>{const items=operation==='deposit'?player.inv:loadWarehouse().items;fire('warehouse',{operation,uid,qty:qty||_whQtyVal()||items.find(i=>i.uid===uid)?.cnt||1});};
  window.whGold=dir=>fire('warehouse',{operation:dir==='in'?'gold-in':'gold-out',qty:Number(document.getElementById('wh-gold-amt').value)});
  window.whOneClickDeposit=()=>fire('warehouse',{operation:'deposit-all'});window.sortWarehouse=()=>fire('warehouse',{operation:'sort'});
  window.trialQAccept=key=>fire('trial',{key,complete:false});window.trialQComplete=key=>fire('trial',{key,complete:true});
  let respecBusy=false;
  const adjustAllocation=window.adjAlloc,cancelAllocation=window.cancelRespec;
  window.adjAlloc=(...args)=>{if(!respecBusy)adjustAllocation(...args);};
  window.cancelRespec=()=>{if(!respecBusy)cancelAllocation();};
  window.confirmRespec=()=>{
    if(!_respec||respecBusy)return;respecBusy=true;
    void action('respec',{allocation:{..._respec.draft}}).then(()=>{_respec=null;updateUI();}).catch(()=>{}).finally(()=>{respecBusy=false;});
  };
  const autoSell=()=>{_readAutoSellForm();const args={rules:JSON.parse(JSON.stringify(getAutoSellRules())),enabled:player.autoSellOn!==false,global:!!document.getElementById('as-global')?.checked};_asBackup=null;closeAutoSellRules();return action('auto-sell',args);};
  window.saveAutoSellRules=()=>void autoSell().catch(()=>{});window.sellAutoSellItemsNow=()=>void autoSell().then(()=>action('sell-junk')).catch(()=>{});
  const petAction=params=>{
    const sourceNpc=npcId,sourceMap=mapState.current,panel=document.getElementById('interaction-content');
    const sourcePanel=panel.firstElementChild;
    return action('pet',params).then(()=>{
      if(sourceNpc&&npcId===sourceNpc&&mapState.current===sourceMap&&panel.firstElementChild===sourcePanel&&!document.getElementById('town-interaction-container').classList.contains('hidden')&&DB.towns[sourceMap]?.npcs?.some(n=>n.id===sourceNpc&&n.type==='petstore'))renderPetStorageNPC(panel);
    });
  };
  for(const [fn,operation]of [['petDeployToggle','deploy'],['petToggleLock','lock']])window[fn]=uid=>void petAction({operation,uid}).catch(()=>{});
  window.petGearEquip=(uid,slot,itemUid)=>void petAction({operation:'equip',uid,slot,itemUid}).catch(()=>{});
  window.petGearUnequip=(uid,slot)=>void petAction({operation:'unequip',uid,slot}).catch(()=>{});
  window.petRevive=(uid,method)=>void petAction({operation:'revive',uid,method}).catch(()=>{});
  const petPending=new Map();cloud.petEditing=uid=>petPending.has(uid);
  window.petSetPotPct=(uid,value)=>{
    if(typeof value==='string'&&!value.trim())return;
    value=Number(value);if(!Number.isInteger(value)||value<0||value>95){showError(new Error('寵物喝水門檻請輸入 0～95 的整數百分比'));return;}
    petPending.set(uid,(petPending.get(uid)||0)+1);syncPetTeamPanel();
    void action('pet',{operation:'potion',uid,value}).catch(()=>{}).finally(()=>{
      const count=petPending.get(uid)-1;if(count)petPending.set(uid,count);else petPending.delete(uid);
      syncPetTeamPanel();
    });
  };
  for(const [fn,operation]of [['toggleAlly','toggle'],['dismissAlly','dismiss'],['refreshAllyOnce','refresh']])window[fn]=slot=>fire('mercenary',{operation,slot:Number(slot)});
  window.reviveMercenary=(slot,method)=>fire('mercenary',{operation:'revive',slot:Number(slot),method});
  const openAllyEquipment=window.openAllyEquipmentManager,closeAllyEquipment=window.closeAllyEquipmentManager;
  window.openAllyEquipmentManager=slot=>{managedAlly={slot:Number(slot),identity:_findAlly(slot)?.enSeed};return openAllyEquipment(slot);};
  window.closeAllyEquipmentManager=()=>{managedAlly=null;return closeAllyEquipment();};
  for(const [fn,operation]of [['allyEquipItem','equip'],['allyUnequipItem','unequip']])window[fn]=(slot,value)=>{
    const source=managedAlly&&{...managedAlly},sourceNpc=npcId,sourceMap=mapState.current;
    if(!source||source.slot!==Number(slot))return;
    const params={...source,operation,...(operation==='equip'?{uid:decodeURIComponent(String(value))}:{gearSlot:value})};
    void action('mercenary-equipment',params).then(()=>{
      if(managedAlly?.slot===source.slot&&managedAlly.identity===source.identity&&npcId===sourceNpc&&mapState.current===sourceMap&&!document.getElementById('town-interaction-container').classList.contains('hidden'))openAllyEquipment(source.slot);
    }).catch(()=>{});
  };
  const squadPending=new Map();cloud.squadEditing=slot=>squadPending.has(String(slot));
  for(const [fn,setting,type]of [
    ['setAllyAtkSkill','attack','skill'],['setAllyHealSkill','heal','skill'],['setAllyConvertSkill','convert','skill'],
    ['setAllyHealHp','heal-hp','percent'],['setAllyPotHp','potion','percent'],['setAllyHpSkill','hp-skill','percent'],['setAllyCastMp','cast-mp','percent'],['setAllyAutoBuff','auto-buff','toggle'],
  ])window[fn]=(slot,value,enabled)=>{
    const ally=_findAlly(slot);if(!ally)return;
    if(type==='percent'){
      if(typeof value==='string'&&!value.trim())return; // Keep an unfinished numeric edit until the next digit.
      value=Number(value);if(!Number.isInteger(value)||value<0||value>100){showError(new Error('隊伍設定請輸入 0～100 的整數百分比'));return;}
    }
    const key=String(slot),params={slot:Number(slot),identity:ally.enSeed,setting,...(type==='toggle'?{skillId:value,value:enabled}:{value})};
    squadPending.set(key,(squadPending.get(key)||0)+1);
    void action('mercenary-settings',params).catch(()=>{}).finally(()=>{
      const count=squadPending.get(key)-1;if(count)squadPending.set(key,count);else squadPending.delete(key);
      syncSquadSettings();
    });
  };
  document.addEventListener('change',event=>{const el=event.target;if(!active||!el.id||!(/^(set-|sel-|auto-sk-)/.test(el.id)))return;fire('settings',{values:{[el.id]:el.type==='checkbox'?el.checked:el.value}});});
  toolbar.querySelector('[data-save]').onclick=()=>void cloud.flush().catch(()=>{});
  toolbar.querySelector('[data-shop]').onclick=()=>cloud.showShop?.();
  toolbar.querySelector('[data-logout]').onclick=()=>void enqueue(async()=>{if(active)await request('leave');await cloud.request('/api/auth/logout',{});location.href='/login';}).catch(()=>{});
  const {refresh:world}=startWorldChat(cloud,toolbar,()=>stopped);startLootTicker(cloud,()=>cloud.ready&&!stopped);
  setInterval(()=>{if(!pending)void enqueue(poll).catch(()=>{});},2000);setInterval(world,4000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!pending)void enqueue(poll).catch(()=>{});});
  block('正在連接伺服器…');void connect();
}
