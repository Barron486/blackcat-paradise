import {npcIntents,townEntrances} from '../shared/game-intents.js';
const integer=(v,min=1,max=10000)=>{if(!Number.isSafeInteger(v)||v<min||v>max)throw new Error(`數量須為 ${min}～${max}`);return v;};
const id=v=>{if(typeof v!=='string'||!v.length||v.length>160||/[<>\x00-\x1f]/.test(v))throw new Error('識別碼不正確');return v;};
const stat=v=>{if(!['str','dex','con','int','wis','cha'].includes(v))throw new Error('屬性不正確');return v;};
const keys=(a,allowed)=>{if(Object.keys(a).some(k=>!allowed.includes(k)))throw new Error('操作包含不允許的欄位');};
/** Every entry resolves inventory, prices, costs and rewards inside the server VM. */
export function extraAction(game,name,a){
  const run=(code,args=a)=>game.run(code,args);
  switch(name){
    case 'clan':{
      if(!['create','donate-gold','donate-diamonds','toggle-buff','rename'].includes(a.operation))throw new Error('不支援的血盟操作');
      if(['create','rename'].includes(a.operation)){
        keys(a,['operation','name']);
        if(typeof a.name!=='string')throw new Error('血盟名稱不正確');
        const name=a.name.trim();
        if(!name||name.length>20||/[\x00-\x1f\x7f]/.test(name))throw new Error('血盟名稱需為 1 至 20 個字');
        run(`{
          const inputId=__args.operation==='create'?'clan-name-input':'clan-rename-input';
          const old=document.getElementById(inputId);if(old)old.remove();
          const input=document.createElement('input');input.id=inputId;input.value=__args.name;document.body.append(input);
          const originalSave=window.saveGame;window.saveGame=()=>true;
          try{
            const beforeGold=player.gold;
            if(__args.operation==='create')clanCreateFromInput();else clanRenameFromInput();
            const info=clanGetModeInfo(player);
            if(!info||info.name!==__args.name)throw new Error(__args.operation==='create'?'創立血盟未完成':'血盟改名未完成');
            if(__args.operation==='create'&&player.gold!==beforeGold-CLAN_CREATE_COST)throw new Error('創立血盟扣款不正確');
          }finally{window.saveGame=originalSave;input.remove();}
        }`,{operation:a.operation,name});
      }else if(a.operation==='donate-gold'){
        keys(a,['operation','amount']);
        if(!Number.isSafeInteger(a.amount)||a.amount<10000||a.amount%10000!==0)throw new Error('金幣捐獻需為 10,000 的整數倍');
        run(`{
          const old=document.getElementById('clan-gold-donate');if(old)old.remove();
          const input=document.createElement('input');input.id='clan-gold-donate';input.value=String(__args.amount);document.body.append(input);
          const originalSave=window.saveGame;window.saveGame=()=>true;
          try{
            const beforeGold=player.gold,before=_clanReadState(),id=clanRoleId(player);clanDonateGold();const after=_clanReadState();
            if(player.gold!==beforeGold-__args.amount||!after||after.xp!==(before?.xp||0)+__args.amount/10000||
              after.members[id]?.contribution!==(before?.members[id]?.contribution||0)+__args.amount/10000)throw new Error('血盟捐獻未完成');
          }finally{window.saveGame=originalSave;input.remove();}
        }`,{amount:a.amount});
      }else if(a.operation==='donate-diamonds'){
        keys(a,['operation','amount']);integer(a.amount,1,2_000_000_000);
        run(`{
          const points=__args.amount*100,before=_clanReadState(),mode=clanModeKey(player),role=clanRoleId(player);
          if(!before?.modes[mode])throw new Error('你尚未加入血盟');
          const oldMember=before.members[role],oldContribution=oldMember?.mode===mode?oldMember.contribution:0;
          if(before.xp>1_000_000_000_000-points||oldContribution>1_000_000_000_000-points)throw new Error('血盟經驗或貢獻已達上限');
          const result=_clanAdjustContribution(points),after=_clanReadState();
          if(!result.ok||after?.xp!==before.xp+points||after.members[role]?.contribution!==oldContribution+points)
            throw new Error(result.error||'血盟捐獻未完成');
          logSys('捐獻 '+__args.amount.toLocaleString()+' 顆藍鑽，獲得 '+points.toLocaleString()+' 貢獻與血盟經驗。');
        }`);
      }else{
        keys(a,['operation','on']);
        if(typeof a.on!=='boolean')throw new Error('血盟 Buff 設定不正確');
        run(`{clanToggleBuff(__args.on);const st=_clanReadState(),member=st?.members[clanRoleId(player)];if(!member||member.buffOn!==__args.on)throw new Error('血盟 Buff 設定未完成');}`,{on:a.on});
      }
      break;
    }
    case 'summon-choice':{
      keys(a,['name']);if(a.name!=='')id(a.name);
      run(`if(!hasSummonCtrlRing(player))throw new Error('需要裝備召喚控制戒指');
        if(__args.name&&(!_sumQualified(__args.name)||_sumCountFor(__args.name)<1))throw new Error('等級或魅力不足，無法選擇此召喚物');
        chooseSummon(__args.name);`);break;
    }
    case 'open-box':{
      keys(a,['uid','qty']);id(a.uid);integer(a.qty,1,1000);
      run(`{const item=player.inv.find(i=>i.uid===__args.uid);
        if(!item||DB.items[item.id]?.eff!=='osiris_box'||!Object.hasOwn(BOX_LOOT_BY_ID,item.id))throw new Error('背包沒有這個寶箱');
        if(player.dead||player._gmDead||inAbsBarrier())throw new Error('目前狀態無法開啟寶箱');
        if(item.cnt<__args.qty)throw new Error('寶箱數量不足，請重新選擇數量');
        if(playerCoreCount()<__args.qty)throw new Error('龜裂之核不足，每個寶箱需要 1 顆');
        doOpenOsirisBox(item.uid,__args.qty);
      }`);break;
    }
    case 'soul-orb':{
      keys(a,['uid','wand']);id(a.uid);
      if(!['wpn_powerless_baless','wpn_powerless_baphomet'].includes(a.wand))throw new Error('請選擇要恢復的魔杖');
      run(`{const item=player.inv.find(i=>i.uid===__args.uid);
        if(!item||DB.items[item.id]?.eff!=='soulorb'||item.cnt<1)throw new Error('背包沒有靈魂之球');
        if(player.dead||player._gmDead||inAbsBarrier())throw new Error('目前狀態無法使用靈魂之球');
        if(!player.inv.some(i=>i.id===__args.wand&&i.cnt>0))throw new Error('背包沒有選定的失去魔力魔杖');}`);
      const confirm=game.window.confirm;game.window.confirm=()=>a.wand==='wpn_powerless_baless';
      try{run('useItem(__args.uid);');}finally{game.window.confirm=confirm;}break;
    }
    case 'polymorph':{
      keys(a,['uid','name']);id(a.uid);id(a.name);
      run(`{const item=player.inv.find(i=>i.uid===__args.uid);
        if(!item||DB.items[item.id]?.eff!=='poly'||!Number.isSafeInteger(item.cnt)||item.cnt<1)throw new Error('背包沒有這張變形卷軸');
        if(player.dead||player._gmDead)throw new Error('死亡狀態無法變身，請先復活');
        if(inAbsBarrier())throw new Error('絕對屏障期間無法使用變形卷軸');
        if(!hasPolyRing())throw new Error('指定變身需要攜帶變形控制戒指，或裝備浣熊的變身葉');
        const found=findPolyForm(__args.name);
        if(!found||player.lv<found.form.lv||!polyFormMatchesEquippedWeapon(found.form))throw new Error('目前等級或武器無法使用此變身，請重新開啟選單');
        confirmPolySelect(item.uid,__args.name);
      }`);break;
    }
    case 'black-market':{
      keys(a,['operation','index','offer']);
      if(!['view','buy'].includes(a.operation))throw new Error('不支援的黑市操作');
      if(a.operation==='buy'){
        integer(a.index,0,23);id(a.offer);
        run(`refreshPandoraMarket(false);
          {const s=player.pandoraMarket2?.slots?.[__args.index];
          if(!s||s.sold||JSON.stringify([s.id,s.price,s.bless===true,s.setTick])!==__args.offer)throw new Error('商品已售出或輪換，請重新整理黑市');
          const d=DB.items[s.id];if(!d||!Number.isSafeInteger(s.price)||s.price<=0)throw new Error('商品資料不正確');
          if(player.gold<s.price)throw new Error('金幣不足');
          if(d.maxHold&&player.inv.filter(i=>i.id===s.id).reduce((n,i)=>n+(i.cnt||1),0)>=d.maxHold)throw new Error('物品已達持有上限');
          buyPandoraItem(__args.index);if(!s.sold)throw new Error('黑市購買未完成');}`);
      }else run('refreshPandoraMarket(false);player.pandoraAnnounce=null;player.pandoraAnnounceBless=false;');
      break;
    }
    case 'npc-command':{
      keys(a,['npcId','method','params','fields']);id(a.npcId);
      if(!npcIntents.includes(a.method)||!Array.isArray(a.params)||a.params.length>4)throw new Error('不支援的 NPC 操作');
      for(const value of a.params)if(value!==null&&(!['string','number','boolean'].includes(typeof value)||String(value).length>160))throw new Error('NPC 選項不正確');
      // The tier/count buttons only select a menu; validate them before rendering
      // the authoritative merchant menu that authorizes the actual synthesis.
      if(['dollSynth','dollSynthAll'].includes(a.method)){
        if(a.params.length!==2)throw new Error('合成選項不正確');
        integer(a.params[0],1,5);integer(a.params[1],2,4);
        run('_dollSynthTier=__args.params[0];_dollSynthCount=__args.params[1];');
      }
      // Clear stale markup before rendering: hidden/unavailable NPCs must not inherit
      // another menu, and map notices must validate their actual entrance location.
      const panel=game.window.document.getElementById('interaction-content');panel.innerHTML='';
      if(Object.hasOwn(townEntrances,a.npcId)){
        const entrance=townEntrances[a.npcId];
        run(`if(mapState.current!==__args.town)throw new Error('請先前往對應的入口地圖');window[__args.render](document.getElementById('interaction-content'));`,entrance);
      }else if(a.npcId==='_clan_siege')run(`if(!clanGetModeInfo(player)||!clanCanSiege(player))throw new Error('目前血盟無法攻城');openSiegeSelect();`);
      else run(`if(!DB.towns[mapState.current]?.npcs?.some(n=>n.id===__args.npcId))throw new Error('此地沒有這位 NPC');interactNPC(__args.npcId,mapState.current);`);
      // Parse only literal calls emitted by the server's menu. Never evaluate code,
      // callbacks, prices, material recipes, or function names supplied by the client.
      const allowed=[...panel.querySelectorAll('[onclick]:not([disabled])')].some(el=>{
        const match=/^\s*([A-Za-z]\w*)\((.*)\)\s*;?\s*$/.exec(el.getAttribute('onclick'));
        if(!match||match[1]!==a.method)return false;
        try{const parts=match[2].trim()?match[2].match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|true|false|null|-?\d+(?:\.\d+)?/g):[];
          if((parts||[]).join(',').replace(/\s/g,'')!==match[2].replace(/\s/g,''))return false;
          const parsed=parts.map(p=>JSON.parse(p.startsWith("'")?'"'+p.slice(1,-1).replace(/\\'/g,"'").replace(/"/g,'\\"')+'"':p));
          return JSON.stringify(parsed)===JSON.stringify(a.params);
        }catch{return false;}
      });
      if(!allowed)throw new Error('NPC 選項已改變或目前不可用，請重新開啟對話');
      if(a.method==='startSiege')run(`{const city=__args.params[1];if(!SIEGE_CITY[city]||!gmMapAllowed(SIEGE_CITY[city].outer,false))throw new Error('攻城地圖尚未開放或等級不足');}`);
      if(a.fields&&Object.keys(a.fields).length>100)throw new Error('表單過大');
      for(const [key,value]of Object.entries(a.fields||{})){
        const el=[...panel.querySelectorAll('input[id],select[id]')].find(el=>el.id===key);
        if(!el||el.disabled||el.readOnly)throw new Error('不允許的 NPC 輸入欄位');
        if(el.tagName==='SELECT'){if(![...el.options].some(o=>!o.disabled&&o.value===String(value)))throw new Error('選項不正確');el.value=String(value);}
        else if(el.type==='checkbox'){if(typeof value!=='boolean')throw new Error('勾選欄位不正確');el.checked=value;}
        else if(el.type==='number'){integer(Number(value),Math.max(0,Number(el.min)||0),Math.min(10000,Number(el.max)||10000));el.value=String(value);}
        else throw new Error('此操作不接受文字輸入');
      }
      const confirm=game.window.confirm;game.window.confirm=()=>true;
      try{run('window[__args.method](...__args.params);');}finally{game.window.confirm=confirm;}
      break;
    }
    case 'journey':{
      keys(a,['operation']);
      const methods={depart:'departToLastBattle',home:'returnToPledgeBase','rift-exit':'riftEvacuate'};
      if(!Object.hasOwn(methods,a.operation))throw new Error('不支援的移動操作');
      if(a.operation==='rift-exit')run(`if(!state.riftRun||mapState.current!=='rift_battle')throw new Error('目前不在時空裂痕');`);
      run('window[__args]();',methods[a.operation]);break;
    }
    case 'arena':{
      keys(a,['slot','card']);
      run(`if(mapState.current!=='arena_pvp'&&!DB.towns[mapState.current]?.npcs?.some(n=>n.id==='npc_arena'))throw new Error('請先前往古魯丁與鬥技場管理者對話');
        if(pvpArenaActive())throw new Error('目前已有一場決鬥進行中');
        if(!gmMapAllowed('arena_pvp',false))throw new Error('競技場尚未開放或等級不足');`);
      if(a.slot!==undefined){
        integer(a.slot,1,8);if(a.card!==undefined)throw new Error('請選擇一種挑戰方式');
        run(`{if(__args.slot===currentSlot)throw new Error('無法挑戰自己');const card=pvpCardFromSlot(__args.slot);if(!card)throw new Error('此角色不存在');if(!pvpArenaStart(card))throw new Error('目前無法開始決鬥');}`);
      }else{
        if(typeof a.card!=='string'||a.card.length>24000)throw new Error('對戰名片格式不正確');
        run(`{const decoded=pvpCardDecode(__args.card);if(!decoded?.ok)throw new Error('名片驗證失敗，請重新匯出對戰名片');if(!pvpArenaStart(decoded.card))throw new Error('目前無法開始決鬥');}`);
      }
      break;
    }
    case 'arena-result':{
      keys(a,['operation']);if(!['continue','return'].includes(a.operation))throw new Error('不支援的決鬥操作');
      run(`if(player._gmDead||mapState.current!=='arena_pvp'||pvpArenaActive()||!pvpServerSnapshot().result)throw new Error('目前沒有待結算的決鬥');`);
      run(a.operation==='continue'?'pvpResultContinue();':'pvpResultReturn();');break;
    }
    case 'pvp-mode':{
      keys(a,['on']);if(typeof a.on!=='boolean')throw new Error('PVP 設定不正確');
      run(`{pvpEnsureState();if(!__args.on&&typeof npcClanWarActive==='function'&&npcClanWarActive(player))throw new Error('血盟戰期間無法關閉 PVP');player.pvpOn=__args.on;}`);
      break;
    }
    case 'batch-use':{
      keys(a,['uid','qty']);id(a.uid);integer(a.qty,1,1000);
      run(`{const i=player.inv.find(i=>i.uid===__args.uid);if(!i||!DB.items[i.id]?.batchUse)throw new Error('無法批次使用此道具');}`);
      const prompt=game.window.prompt;game.window.prompt=()=>String(a.qty);try{run('batchUseItem(__args.uid);');}finally{game.window.prompt=prompt;}break;
    }
    case 'unequip':keys(a,['slot']);id(a.slot);run(`if(!Object.hasOwn(player.eq,__args.slot))throw new Error('未知裝備欄位');unequipItem(__args.slot);`);break;
    case 'sell':keys(a,['uid','qty']);id(a.uid);integer(a.qty);run(`{const i=player.inv.find(i=>i.uid===__args.uid);if(!i)throw new Error('背包沒有此物品');sellItem(i.uid,__args.qty,getSellPrice(i));}`);break;
    case 'lock':case 'junk':keys(a,['uid']);id(a.uid);run(name==='lock'?'toggleLock(__args.uid);':'toggleJunk(__args.uid);');break;
    case 'sell-junk':keys(a,[]);run('autoSellJunk(true);');break;
    case 'sort':keys(a,['mode','enabled']);if(a.mode!==undefined&&!['category','quality','name'].includes(a.mode))throw new Error('排列方式不正確');if(a.enabled!==undefined&&typeof a.enabled!=='boolean')throw new Error('自動排列設定不正確');run(`if(__args.mode)setInventorySortMode(__args.mode);if(__args.enabled!==undefined)toggleInventoryAutoSort(__args.enabled);sortInventoryNow();`);break;
    case 'quick-junk':case 'quick-enhance':{
      keys(a,['type','uids','goal','blessed']);if(!['wpn','arm','item'].includes(a.type)||!Array.isArray(a.uids)||a.uids.length>2000)throw new Error('批次選擇不正確');for(const uid of a.uids)id(uid);
      if(name==='quick-enhance'){integer(a.goal,0,15);if(typeof a.blessed!=='boolean')throw new Error('卷軸設定不正確');
        run(`{if(!Object.hasOwn(quickEnh,__args.type))throw new Error('分類不正確');const items=_qeEligibleItems(__args.type).filter(i=>__args.uids.includes(i.uid));if(items.reduce((n,i)=>n+(i.cnt||1),0)>1000)throw new Error('每次最多強化 1000 件');quickEnh[__args.type]={active:true,target:__args.goal,useBless:__args.blessed,sel:Object.fromEntries(__args.uids.map(id=>[id,true]))};document.getElementById('qe-target-'+__args.type)?.remove();runQuickEnhance(__args.type);}`);
      }else run(`{if(!Object.hasOwn(quickJunk,__args.type))throw new Error('分類不正確');const items=_qjEligibleItems(__args.type);quickJunk[__args.type]={active:true,sel:Object.fromEntries(__args.uids.map(id=>[id,true])),known:Object.fromEntries(items.map(i=>[i.uid,true]))};runQuickJunk(__args.type);}`);
      break;
    }
    case 'teleport':keys(a,[]);run('playerTeleport();');break;
    case 'revive-in-place':keys(a,[]);run(`if(player._gmDead)throw new Error('GM 死亡必須由 GM 復活');reviveInPlace();`);break;
    case 'target':
      keys(a,['index','uid']);if(a.uid!==undefined)id(a.uid);else integer(a.index,0,9);
      run(`{const index=__args.uid!==undefined?mapState.mobs.findIndex(m=>m&&String(m.uid)===__args.uid):__args.index;const mob=mapState.mobs[index];if(!mob||mob._dead||mob.curHp<=0)throw new Error('目標已離場，請選擇目前的怪物');mapState.targetIdx=index;}`);break;
    case 'bonus':keys(a,['stat']);stat(a.stat);run('adjBonusStat(__args.stat);');break;
    case 'element':{
      keys(a,['element']);if(!['fire','water','wind','earth'].includes(a.element))throw new Error('屬性不正確');
      run(`if(player.cls!=='elf')throw new Error('只有妖精能夠選擇屬性');
        if(!DB.towns[mapState.current]?.npcs?.some(n=>n.id==='npc_elion'))throw new Error('請前往妖精森林與艾莉溫對話');
        if(player.lv<30)throw new Error('需要達到 Lv 30 才能選擇屬性');
        if(player.elfEle&&player.elfEle!==__args.element&&player.gold<ELF_SWITCH_COST)throw new Error('金幣不足，無法轉換屬性');`);
      // The player confirms in the browser; a headless dialog must not cancel the intent.
      const confirm=game.window.confirm;game.window.confirm=()=>true;
      try{run('chooseElfElement(__args.element);');}finally{game.window.confirm=confirm;}break;
    }
    case 'respec':{
      keys(a,['allocation']);if(!a.allocation||Object.keys(a.allocation).length!==6)throw new Error('配點不完整');
      for(const [s,v]of Object.entries(a.allocation)){stat(s);integer(v,0,60);}
      run(`{if(player.dead||player._gmDead||inAbsBarrier())throw new Error('目前狀態無法使用回憶蠟燭');const b=createBase[player.cls],points=b.pts+Math.max(0,player.lv-49);if(Object.values(__args.allocation).reduce((s,n)=>s+n,0)>points||Object.entries(__args.allocation).some(([k,v])=>b[k]+v>60))throw new Error('配點不合法');_respec=null;startRespec();if(!_respec)throw new Error('需要回憶蠟燭');_respec.draft=__args.allocation;confirmRespec();}`);break;
    }
    case 'enhance':case 'auto-enhance':case 'curse-enhance':{
      keys(a,['uid','equipped','scrollId','goal']);id(a.uid);id(a.scrollId);if(typeof a.equipped!=='boolean')throw new Error('裝備位置不正確');
      if(name==='auto-enhance')integer(a.goal,0,15);
      run(`{const i=__args.equipped?Object.values(player.eq).find(i=>i?.uid===__args.uid):player.inv.find(i=>i.uid===__args.uid),s=DB.items[__args.scrollId];if(!i)throw new Error('物品不存在');const d=DB.items[i.id];const ids=d.type==='wpn'?['scroll_weapon','scroll_weapon_b','scroll_weapon_c']:d.type==='arm'?['scroll_armor','scroll_armor_b','scroll_armor_c']:d.type==='acc'?['scroll_acc']:[];if(d.noEnhance||d.isArrow||!ids.includes(__args.scrollId)||!player.inv.some(i=>i.id===__args.scrollId&&i.cnt>0))throw new Error('此卷軸無法強化這項物品');}`);
      if(name==='auto-enhance' && !['scroll_weapon','scroll_armor'].includes(a.scrollId))throw new Error('批次強化只接受一般卷軸');
      if((name==='curse-enhance')!==a.scrollId.endsWith('_c'))throw new Error('卷軸操作不符');
      if(name==='auto-enhance')run('executeAutoSafeEnhance(__args.uid,__args.equipped,__args.scrollId,__args.goal);');
      else if(name==='curse-enhance')run('executeCurseDeEnhance(__args.uid,__args.equipped,__args.scrollId);');
      else run('executeEnhance(player.inv.find(i=>i.id===__args.scrollId).uid,__args.uid,__args.equipped);');break;
    }
    case 'warehouse':{
      keys(a,['operation','uid','qty']);if(!['deposit','withdraw','gold-in','gold-out','deposit-all','sort'].includes(a.operation))throw new Error('未知倉庫操作');
      run(`if(!DB.towns[mapState.current])throw new Error('請先回村使用倉庫');`);
      if(['deposit','withdraw'].includes(a.operation)){id(a.uid);integer(a.qty);run(a.operation==='deposit'?'whDeposit(__args.uid,__args.qty);':'whWithdraw(__args.uid,__args.qty);');}
      else if(a.operation.startsWith('gold-')){integer(a.qty,1,Number.MAX_SAFE_INTEGER);run(`{const e=document.createElement('input');e.id='wh-gold-amt';document.getElementById(e.id)?.remove();e.value=String(__args.qty);document.body.append(e);whGold(__args.operation==='gold-in'?'in':'out');e.remove();}`);}
      else run(a.operation==='deposit-all'?'whOneClickDeposit();':'sortWarehouse();');break;
    }
    case 'craft':{
      keys(a,['npcId','index','qty']);id(a.npcId);integer(a.index,0,10000);integer(a.qty,1,1000);
      run(`{if(!DB.towns[mapState.current]?.npcs?.some(n=>n.id===__args.npcId)||!CRAFT_RECIPES[__args.npcId]?.[__args.index])throw new Error('此地無法製作這項物品');const id='craft-qty-'+__args.npcId+'-'+__args.index;document.getElementById(id)?.remove();const e=document.createElement('input');e.id=id;e.value=__args.qty;document.body.append(e);try{doCraft(__args.npcId,__args.index,false);}finally{e.remove();}}`);break;
    }
    case 'trial':keys(a,['key','complete']);id(a.key);if(typeof a.complete!=='boolean')throw new Error('任務操作不正確');run(`{const q=Object.hasOwn(TRIAL_Q,__args.key)&&TRIAL_Q[__args.key];if(!q||!DB.towns[mapState.current]?.npcs?.some(n=>n.n===q.npc))throw new Error('請向當地任務 NPC 交付');if(__args.complete)trialQComplete(__args.key);else trialQAccept(__args.key);}`);break;
    case 'pet':{
      keys(a,['operation','uid','slot','itemUid','method','value','fruitId']);id(a.uid);
      const calls={deploy:'petDeployToggle(__args.uid)',lock:'petToggleLock(__args.uid)',equip:'petGearEquip(__args.uid,__args.slot,__args.itemUid)',unequip:'petGearUnequip(__args.uid,__args.slot)',revive:'petRevive(__args.uid,__args.method)',potion:'petSetPotPct(__args.uid,__args.value)',evolve:'petEvolve(__args.uid,__args.fruitId)'};
      if(!Object.hasOwn(calls,a.operation))throw new Error('不支援的寵物操作');
      if(['equip','unequip'].includes(a.operation)&&!['wpn','arm'].includes(a.slot))throw new Error('寵物裝備欄不正確');
      if(a.operation==='equip')id(a.itemUid);if(a.operation==='revive'&&!['rez','scroll'].includes(a.method))throw new Error('復活方式不正確');if(a.operation==='potion')integer(a.value,0,95);
      if(a.operation==='evolve'){
        id(a.fruitId);if(!['item_evo_fruit','item_victory_fruit'].includes(a.fruitId))throw new Error('進化果實不正確');
        run(`{if(!DB.towns[mapState.current]?.npcs?.some(n=>n.type==='petstore'))throw new Error('請向寵物保管員進行進化');const p=_petFind(__args.uid);if(!p)throw new Error('找不到這隻寵物');if(_petOwnedByOther(p))throw new Error('這隻寵物由其他角色帶領');if((p.lv||1)<30)throw new Error('寵物等級 30 以上才能進化');const option=petEvoOptions(p).find(o=>o.fruitId===__args.fruitId);if(!option)throw new Error('此寵物無法使用這種果實進化');const fruit=player.inv.find(i=>i.id===__args.fruitId&&(i.cnt||0)>0);if(!fruit)throw new Error('身上沒有指定的進化果實');const from=p.form;fruit.cnt--;if(fruit.cnt<=0)player.inv=player.inv.filter(i=>i.uid!==fruit.uid);p.form=option.target;p.lv=1;p.exp=0;p.mhp=Math.max(1,Math.floor(p.mhp*.5));p.mmp=Math.max(0,Math.floor(p.mmp*.5));p.hp=p.mhp;p.mp=p.mmp;petMarkDirty();logSys('<span class="c-legend font-bold">✨ 進化成功！</span><span class="text-amber-200">'+from+' 進化為 </span><span class="text-amber-300 font-bold">'+p.form+'</span><span class="text-amber-200">（Lv.1·HP/MP 為進化前的 50%）！</span>');}`);
      }else run(`{const p=_petFind(__args.uid);if(!p)throw new Error('找不到這隻寵物');if(_petOwnedByOther(p))throw new Error('這隻寵物由其他角色帶領');}`+calls[a.operation]+`;if(!petRosterSave())throw new Error('寵物設定保存失敗');`);break;
    }
    case 'mercenary':{
      if(a.operation==='dismiss-all'){
        keys(a,['operation']);
        run(`if(!DB.towns[mapState.current])throw new Error('請回村管理傭兵');`);
        const confirm=game.window.confirm;game.window.confirm=()=>true;
        try{run(`dismissAllAllies();if((player.allies||[]).length)throw new Error('全員解散未完成');`);}finally{game.window.confirm=confirm;}
        break;
      }
      keys(a,['operation','slot','method']);integer(a.slot,1,8);
      if(!['toggle','dismiss','refresh','revive'].includes(a.operation))throw new Error('不支援的傭兵操作');
      run(`if(__args.slot===currentSlot)throw new Error('無法招募自己');if(__args.operation!=='revive'&&!DB.towns[mapState.current])throw new Error('請回村管理傭兵');`);
      if(a.operation==='revive'&&!['rez','scroll'].includes(a.method))throw new Error('復活方式不正確');
      const confirm=game.window.confirm;game.window.confirm=()=>true;
      try{run(({toggle:'toggleAlly(__args.slot);',dismiss:'dismissAlly(__args.slot);',refresh:'refreshAllyOnce(__args.slot);',revive:'reviveMercenary(__args.slot,__args.method);'})[a.operation]);}finally{game.window.confirm=confirm;}break;
    }
    case 'mercenary-equipment':{
      keys(a,['operation','slot','identity','uid','gearSlot']);integer(a.slot,1,8);id(a.identity);
      if(!['equip','unequip'].includes(a.operation))throw new Error('不支援的隊員裝備操作');
      run(`{const ally=_findAlly(__args.slot);if(__args.slot===currentSlot||!ally)throw new Error('該角色目前不在隊伍中');
        if(!DB.towns[mapState.current])throw new Error('請回到安全區的傭兵公會管理裝備');
        if(ally.enSeed!==__args.identity||_slotCharEnSeed(__args.slot)!==__args.identity)throw new Error('隊員資料已變更，請重新開啟裝備管理');
        if(!_allyManagerSource(__args.slot,false))throw new Error('隊員來源存檔目前無法管理');}`);
      if(a.operation==='equip'){
        id(a.uid);if(a.gearSlot!==undefined)throw new Error('穿戴操作不接受指定欄位');
        run(`{const item=player.inv.find(i=>i.uid===__args.uid),source=_allyManagerSource(__args.slot,false).source;
          if(!item||!_allyCanEquipLeaderItem(source,item))throw new Error('隊長未持有此裝備，或隊員不符合穿戴條件');}`);
      }else{
        id(a.gearSlot);if(a.uid!==undefined)throw new Error('卸裝操作不接受背包物品');
        run(`if(!Object.hasOwn(ALLY_EQUIP_SLOT_NAME,__args.gearSlot)||!_allyManagerSource(__args.slot,false).source.eq[__args.gearSlot])throw new Error('該裝備欄沒有可卸下的裝備');`);
      }
      const changed=run(a.operation==='equip'?'allyEquipItem(__args.slot,encodeURIComponent(__args.uid));':'allyUnequipItem(__args.slot,__args.gearSlot);');
      if(!changed)throw new Error('無法變更裝備，請檢查詛咒、職業、等級與裝備欄限制');
      break;
    }
    case 'mercenary-settings':{
      keys(a,['slot','identity','setting','value','skillId']);integer(a.slot,1,8);id(a.identity);
      const rules={attack:['setAllyAtkSkill','atk'],heal:['setAllyHealSkill','heal'],convert:['setAllyConvertSkill','convert'],
        'heal-hp':['setAllyHealHp'],'potion':['setAllyPotHp'],'hp-skill':['setAllyHpSkill'],'cast-mp':['setAllyCastMp'],poly:['setAllyPoly','poly'],'auto-buff':['setAllyAutoBuff']};
      if(!Object.hasOwn(rules,a.setting))throw new Error('不支援的隊伍設定');
      run(`{const ally=_findAlly(__args.slot);if(!ally)throw new Error('該角色目前不在隊伍中');
        if(ally.enSeed!==__args.identity||_slotCharEnSeed(__args.slot)!==__args.identity)throw new Error('隊員資料已變更，請重新開啟隊伍設定');}`);
      const [method,kind]=rules[a.setting];
      if(a.setting==='auto-buff'){
        id(a.skillId);if(typeof a.value!=='boolean')throw new Error('勾選欄位不正確');
        if(!run('allyAutoCastableSkills(_findAlly(__args.slot)).some(skill=>skill.sid===__args.skillId)'))throw new Error('隊員無法自動維持此技能');
      }else{
        if(a.skillId!==undefined)throw new Error('此設定不接受技能識別碼');
        if(kind==='poly'){
          if(typeof a.value!=='string'||a.value.length>160)throw new Error('變身選項不正確');
          const allowed=run(`(()=>{const select=document.createElement('select');select.innerHTML=_allyPolyOptions(_findAlly(__args.slot));return [...select.options].some(option=>option.value===__args.value);})()`,a);
          if(!allowed)throw new Error('隊員目前無法使用此變身');
        }else if(kind){
          if(typeof a.value!=='string'||a.value.length>160)throw new Error('技能選項不正確');
          const allowed=run(`(()=>{const select=document.createElement('select');select.innerHTML=_allySkillOptions(_findAlly(__args.slot),__args.kind,'');return [...select.options].some(option=>option.value===__args.value);})()`,{...a,kind});
          if(!allowed)throw new Error('隊員尚未學會此類技能或屬性不符');
        }else integer(a.value,0,100);
      }
      run(a.setting==='auto-buff'?'setAllyAutoBuff(__args.slot,__args.skillId,__args.value);':'window[__args.method](__args.slot,__args.value);',{...a,method});
      run('snapshotMercPrefs(_findAlly(__args.slot));');break;
    }
    case 'auto-sell':{
      keys(a,['rules','enabled','global']);if(typeof a.enabled!=='boolean'||typeof a.global!=='boolean')throw new Error('設定不正確');
      const r=a.rules;if(!r||typeof r!=='object'||Array.isArray(r))throw new Error('規則不正確');
      keys(r,['delaySec','protectBless','protectAnc','protectAttr','protectSet','protectLegend','protectOldSeries','protectRelic','protectCraftEquip','craftSets','equip','misc','overrides']);
      integer(r.delaySec,10,86400);integer(r.craftSets,1,1000);
      for(const [k,v]of Object.entries(r))if(k.startsWith('protect')&&typeof v!=='boolean')throw new Error('保護規則不正確');
      for(const [k,v]of Object.entries(r.equip||{})){if(!['wpn','arm','acc'].includes(k)||typeof v.on!=='boolean')throw new Error('裝備規則不正確');keys(v,['on','max']);integer(v.max,-1,15);}
      for(const [k,v]of Object.entries(r.misc||{})){id(k);if(!v||typeof v!=='object'||Array.isArray(v)||typeof v.on!=='boolean')throw new Error('道具規則不正確');keys(v,['on','keep']);integer(v.keep,0,100000);}
      for(const [k,v]of Object.entries(r.overrides||{})){id(k);if(!['sell','keep'].includes(v))throw new Error('道具例外不正確');}
      run('player.autoSellRules=__args.rules;player.autoSellOn=__args.enabled;player.autoSellGlobal=__args.global;(player.inv||[]).forEach(i=>{delete i._userKeep;});_saveGlobalAutoSellSettings(__args.global);applyAutoSellRules();');break;
    }
    default:throw new Error(`尚未支援的伺服器操作：${name}`);
  }
}
