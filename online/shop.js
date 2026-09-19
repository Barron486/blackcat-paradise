const cloud=window.CloudStore;
if(cloud){
  const css=document.createElement('link');css.rel='stylesheet';css.href='/online/shop.css';document.head.append(css);
  const dialog=document.createElement('dialog');dialog.id='diamond-shop';dialog.className='diamond-dialog';
  dialog.setAttribute('aria-labelledby','diamond-title');
  dialog.innerHTML=`<header><div><small>BLACK CAT STORE</small><h2 id="diamond-title">藍鑽商店</h2></div><button type="button" data-close aria-label="關閉藍鑽商店">×</button></header>
    <div class="diamond-wallet"><span>帳號藍鑽餘額</span><strong id="diamond-balance">—</strong><span>💎</span></div>
    <p class="diamond-note">藍鑽由帳號內所有角色共用，儲值一律由 GM 發送。需要儲值時，請向 GM 提供登入帳號。</p>
    <p id="diamond-message" role="status" aria-live="polite"></p>
    <section class="diamond-products" aria-label="商品"><article><h3>更名卡</h3><p>變更一位角色的名稱</p><strong>3,000 藍鑽</strong><button type="button" data-buy="rename_card">購買更名卡</button></article><article><h3>更改密碼卡</h3><p>變更目前帳號的登入密碼</p><strong>500 藍鑽</strong><button type="button" data-buy="password_card">購買密碼卡</button></article><article class="diamond-buff-product"><h3>全狀態</h3><p>選定角色立即獲得全套增益，持續 1 小時。再次購買延長 1 小時，離線照常倒數；可在「狀態」分頁查看能力與時間。</p><strong>300 藍鑽／次</strong><label>套用角色<select id="diamond-buff-slot" aria-label="全狀態套用角色"></select></label><p id="diamond-buff-status"></p><button type="button" data-buy="full_status" disabled>購買全狀態 · 1 小時</button><button type="button" data-buff-retry hidden>確認購買結果／重試</button></article></section>
    <section class="diamond-section"><h3>我的卡片</h3><p id="diamond-cards"></p>
    <form id="diamond-rename"><h4>使用更名卡</h4><label>選擇角色<select name="slot" required></select></label><label>新的角色名稱<input name="name" maxlength="12" required placeholder="1～12 字" autocomplete="off"></label><button type="submit">消耗 1 張更名卡</button></form>
    <form id="diamond-password"><h4>使用更改密碼卡</h4><label>目前密碼<input type="password" name="current" autocomplete="current-password" maxlength="128" required></label><label>新密碼<input type="password" name="next" autocomplete="new-password" minlength="12" maxlength="128" required placeholder="12～128 字"></label><label>再次輸入新密碼<input type="password" name="repeat" autocomplete="new-password" minlength="12" maxlength="128" required></label><p class="diamond-note">成功後會登出所有裝置，請以新密碼重新登入。忘記目前密碼時請聯絡 GM。</p><button type="submit">消耗 1 張密碼卡</button></form></section>
    <section class="diamond-section"><div class="diamond-history-heading"><h3>最近交易</h3><button type="button" data-refresh>更新餘額</button></div><div id="diamond-history"></div></section>`;
  document.body.append(dialog);
  dialog.querySelector('.diamond-products').insertAdjacentHTML('beforeend',`<article class="diamond-spy-product"><h3>偷窺卡</h3><p>選擇線上角色，查看裝備清單、HP／MP、等級、正義值與所在位置。每次取得一份資料快照，再次查看需重新使用。</p><strong>300 藍鑽／次</strong><label>選擇線上玩家<select id="diamond-spy-target" aria-label="偷窺卡查看對象"></select></label><button type="button" data-buy="spy_card" disabled>使用偷窺卡 · 300 藍鑽</button><button type="button" data-spy-retry hidden>確認查看結果／重試</button><p class="diamond-note">也可從「聊天 → 線上玩家」點擊名字選取。資料以最近一次雲端同步為準；確認前不扣款。</p><section id="diamond-spy-report" aria-label="角色查看結果" aria-live="polite" hidden></section></article>`);
  const confirmDialog=document.createElement('dialog');confirmDialog.className='diamond-dialog diamond-confirm';confirmDialog.setAttribute('aria-label','確認藍鑽交易');
  confirmDialog.innerHTML='<h2>確認交易</h2><p data-detail></p><div class="diamond-confirm-actions"><button type="button" data-cancel>取消</button><button type="button" data-confirm>確認</button></div>';document.body.append(confirmDialog);
  function confirmChoice(text){
    if(confirmDialog.open)return Promise.resolve(false);
    confirmDialog.querySelector('[data-detail]').textContent=text;
    return new Promise(resolve=>{const done=value=>{confirmDialog.close();resolve(value);};confirmDialog.querySelector('[data-cancel]').onclick=()=>done(false);confirmDialog.querySelector('[data-confirm]').onclick=()=>done(true);confirmDialog.oncancel=event=>{event.preventDefault();done(false);};confirmDialog.showModal();});
  }
  const $=selector=>dialog.querySelector(selector),pending=new Map();let info=null,busy=false,buffPending=null,spyPending=null,wasRunning=false,timeOffset=0;
  function renderSpy(){
    const select=$('#diamond-spy-target'),targets=info.spyTargets||[],previous=spyPending?.targetId||select.value;select.replaceChildren();
    for(const target of targets){const option=document.createElement('option');option.value=target.id;option.textContent=target.name+(target.map?' · '+target.map:'');select.append(option);}
    if(spyPending&&!targets.some(t=>t.id===spyPending.targetId)){const option=document.createElement('option');option.value=spyPending.targetId;option.textContent=spyPending.name+'（等待確認結果）';select.append(option);}
    if([...select.options].some(o=>o.value===previous))select.value=previous;
    if(!select.options.length){const option=document.createElement('option');option.value='';option.textContent='目前沒有其他線上角色';select.append(option);}
    select.disabled=busy||!!spyPending||!!buffPending||!targets.length;
    $('[data-buy="spy_card"]').disabled=busy||!!spyPending||!!buffPending||!select.value||info.wallet.diamonds<300;
    $('[data-spy-retry]').hidden=!spyPending;$('[data-spy-retry]').disabled=busy||!!buffPending;
  }
  function showSpyReport(report){
    const target=$('#diamond-spy-report');target.replaceChildren();target.hidden=false;
    const heading=document.createElement('h4');heading.textContent=report.name+' · Lv.'+report.level;target.append(heading);
    const stats=document.createElement('dl');stats.className='diamond-spy-stats';
    for(const [label,value] of [['HP',`${report.hp} / ${report.maxHp}`],['MP',`${report.mp} / ${report.maxMp}`],['正義值',report.alignment],['所在位置',report.map]]){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=String(value);stats.append(dt,dd);}target.append(stats);
    const time=document.createElement('p');time.className='diamond-note';time.textContent='查看時間：'+new Date(report.inspectedAt).toLocaleString('zh-TW')+' · 玩家資料同步於 '+new Date(report.savedAt).toLocaleString('zh-TW');target.append(time);
    const list=document.createElement('ul');list.className='diamond-spy-equipment';
    for(const row of report.equipment){const li=document.createElement('li'),slot=document.createElement('strong'),item=document.createElement('span');slot.textContent=row.label;item.textContent=row.item?.name||'未裝備';if(row.item?.description)item.title=row.item.description;li.append(slot,item);list.append(li);}target.append(list);
  }
  async function useSpy(target){
    await perform(async()=>{
      if(!spyPending)spyPending={targetId:target.id,name:target.name,requestId:crypto.randomUUID()};
      try{const result=await cloud.request('/api/shop/buy',{productId:'spy_card',targetId:spyPending.targetId,requestId:spyPending.requestId});spyPending=null;info.wallet=result.wallet;cloud.diamonds=result.wallet.diamonds;showSpyReport(result.report);notice('偷窺卡已使用，扣除 300 藍鑽。下方為本次查看的資料快照。');try{await refresh();}catch{notice('偷窺卡已使用，扣除 300 藍鑽；查看結果已保留，交易清單暫時無法更新。');}$('#diamond-spy-report').scrollIntoView?.({block:'start'});return false;}
      catch(error){if(error.status&&error.status<500)spyPending=null;if(spyPending)throw new Error('查看結果尚未確認，請按「確認查看結果／重試」，不會重複扣款。');throw error;}
    });
  }
  function renderBuffTime(){
    const character=info?.characters.find(c=>String(c.slot)===$('#diamond-buff-slot').value);
    const seconds=Math.max(0,Math.ceil(((character?.fullStatusExpiresAt||0)-Date.now()-timeOffset)/1000));
    $('#diamond-buff-status').textContent=!character?'請先建立角色':seconds?`剩餘 ${Math.floor(seconds/3600)} 時 ${Math.floor(seconds%3600/60)} 分 ${seconds%60} 秒`:'目前尚未啟用全狀態';
  }
  function notice(text,error=false){$('#diamond-message').textContent=text;$('#diamond-message').classList.toggle('error',error);}
  function render(){
    if(!info)return;const w=info.wallet;cloud.diamonds=w.diamonds;
    $('#diamond-balance').textContent=w.diamonds.toLocaleString('zh-TW');
    $('#diamond-cards').textContent=`更名卡 ${w.renameCards} 張 · 更改密碼卡 ${w.passwordCards} 張`;
    for(const product of info.products){const b=$(`[data-buy="${product.id}"]`);if(b)b.disabled=busy||!!buffPending||!!spyPending||w.diamonds<product.price||(product.id==='full_status'&&(!cloud.ready||!info.characters.length));}
    $('#diamond-rename button').disabled=busy||!!buffPending||!!spyPending||!w.renameCards||!info.characters.length;
    $('#diamond-password button').disabled=busy||!!buffPending||!!spyPending||!w.passwordCards;
    const buffSelect=$('#diamond-buff-slot'),previousBuff=buffSelect.value||(typeof currentSlot!=='undefined'?String(currentSlot):'');buffSelect.replaceChildren();
    for(const c of info.characters){const option=document.createElement('option');option.value=c.slot;option.textContent=`${c.name} · Lv.${c.level}（角色 ${c.slot}）`;buffSelect.append(option);}
    if(info.characters.some(c=>String(c.slot)===previousBuff))buffSelect.value=previousBuff;
    buffSelect.disabled=busy||!!buffPending;renderBuffTime();
    $('[data-buff-retry]').hidden=!buffPending;$('[data-buff-retry]').disabled=busy;
    const select=$('#diamond-rename select'),previous=select.value;select.replaceChildren();
    for(const c of info.characters){const option=document.createElement('option');option.value=c.slot;option.textContent=`${c.name} · Lv.${c.level}（角色 ${c.slot}）`;select.append(option);}
    if(info.characters.some(c=>String(c.slot)===previous))select.value=previous;
    $('#diamond-history').replaceChildren();
    for(const row of info.history){const p=document.createElement('p'),time=document.createElement('small');p.textContent=row.note+(row.diamonds?` · ${row.diamonds>0?'+':''}${row.diamonds.toLocaleString('zh-TW')} 藍鑽`:'');time.textContent=new Date(row.at).toLocaleString('zh-TW');p.append(time);$('#diamond-history').append(p);}
    if(!info.history.length)$('#diamond-history').textContent='尚無交易紀錄';
    renderSpy();
  }
  async function refresh(){info=await cloud.request('/api/shop');timeOffset=(info.serverTime||Date.now())-Date.now();render();}
  async function mutate(path,body){
    const key=path+'|'+JSON.stringify(body);if(!pending.has(key))pending.set(key,crypto.randomUUID());
    try{const result=await cloud.request(path,{...body,requestId:pending.get(key)});pending.delete(key);return result;}
    catch(error){if(error.status&&error.status<500)pending.delete(key);throw error;}
  }
  async function perform(work){
    if(busy)return;busy=true;notice('處理中…');render();
    try{if(await work()!==false)await refresh();}catch(error){notice(error.message,true);}
    finally{busy=false;render();}
  }
  function finishBuffPurchase(){
    cloud.shopPending=false;buffPending=null;
    if(typeof state!=='undefined'&&typeof player!=='undefined'&&!player?.dead)state.running=wasRunning;
  }
  async function purchaseBuff(character){
    await perform(async()=>{
      try{
        if(!buffPending){
          wasRunning=typeof state!=='undefined'&&state.running;
          if(typeof state!=='undefined')state.running=false;
          try{await cloud.flush();}catch(error){if(typeof state!=='undefined')state.running=wasRunning;throw error;}
          buffPending={productId:'full_status',slot:character.slot,epoch:character.epoch,lease:cloud.lease,requestId:crypto.randomUUID()};
          cloud.shopPending=true;
        }
        const result=await cloud.request('/api/shop/buy',buffPending);
        cloud.reconcile(result);cloud.diamonds=result.wallet.diamonds;
        finishBuffPurchase();notice('全狀態已生效，增加 1 小時。能力與倒數可在「狀態」分頁查看。');
      }catch(error){
        if(buffPending&&error.status&&error.status<500){if(error.data?.snapshot)cloud.reconcile(error.data);finishBuffPurchase();}
        if(buffPending)throw new Error('購買結果尚未確認，已暫停戰鬥。請按「確認購買結果／重試」，不會重複扣款。');
        throw error;
      }
    });
  }
  $('#diamond-buff-slot').onchange=renderBuffTime;
  $('[data-buff-retry]').onclick=()=>purchaseBuff();
  $('[data-spy-retry]').onclick=()=>useSpy();
  cloud.showShop=async()=>{if(!dialog.open)dialog.showModal();try{await refresh();}catch(error){notice(error.message,true);}};
  cloud.showSpy=async id=>{await cloud.showShop();if(!info||spyPending)return;if(info.spyTargets?.some(t=>t.id===id))$('#diamond-spy-target').value=id;else notice('這位玩家已離線、切換角色或無法查看，請選擇其他線上角色。',true);$('.diamond-spy-product').scrollIntoView?.({block:'start'});};
  $('[data-close]').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>$('#diamond-password').reset());
  $('[data-refresh]').onclick=()=>refresh().catch(error=>notice(error.message,true));
  for(const button of dialog.querySelectorAll('[data-buy]'))button.onclick=async()=>{
    const product=info?.products.find(p=>p.id===button.dataset.buy);if(!product||busy||spyPending)return;
    if(product.id==='spy_card'){
      const target=info.spyTargets?.find(t=>t.id===$('#diamond-spy-target').value);if(!target||spyPending||buffPending)return;
      if(!await confirmChoice(`使用 1 次偷窺卡，花費 ${product.price.toLocaleString('zh-TW')} 藍鑽查看「${target.name}」的裝備與角色資訊？`))return;
      void useSpy(target);return;
    }
    if(product.id==='full_status'){
      const character=info.characters.find(c=>String(c.slot)===$('#diamond-buff-slot').value);if(!character||buffPending)return;
      if(!await confirmChoice(`花費 ${product.price.toLocaleString('zh-TW')} 藍鑽，為「${character.name}」購買全狀態 1 小時？已有時間會延長，離線仍會倒數。`))return;
      void purchaseBuff(character);return;
    }
    if(!await confirmChoice(`花費 ${product.price.toLocaleString('zh-TW')} 藍鑽購買 1 張${product.name}？`))return;
    void perform(async()=>{await mutate('/api/shop/buy',{productId:product.id});notice(`已購買 1 張${product.name}。`);});
  };
  $('#diamond-rename').onsubmit=async event=>{
    event.preventDefault();const form=event.currentTarget,slot=Number(form.elements.slot.value),character=info?.characters.find(c=>c.slot===slot),name=form.elements.name.value.trim();
    if(!character)return;
    if(!await confirmChoice(`消耗 1 張更名卡，將「${character.name}」改為「${name}」？`))return;
    void perform(async()=>{
      await cloud.flush();await mutate('/api/shop/rename',{slot,epoch:character.epoch,name});
      cloud.adoptNames(await cloud.request('/api/bootstrap'));
      if(typeof updateUI==='function')updateUI();if(typeof renderLoadSelect==='function')renderLoadSelect();
      notice(`角色已更名為「${name}」。`);form.elements.name.value='';
    });
  };
  $('#diamond-password').onsubmit=event=>{
    event.preventDefault();const form=event.currentTarget;
    if(form.elements.next.value!==form.elements.repeat.value){notice('兩次輸入的新密碼不同。',true);return;}
    void perform(async()=>{
      await cloud.flush();
      await mutate('/api/shop/password',{currentPassword:form.elements.current.value,newPassword:form.elements.next.value});
      form.reset();cloud.ready=false;location.assign('/login?passwordChanged=1');return false;
    });
  };
  cloud.exportCharacterReport=async slot=>{
    try{
      await cloud.flush();const report=await cloud.request('/api/character-report?slot='+encodeURIComponent(slot));
      const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
      const a=document.createElement('a');a.href=url;a.download=`黑貓天堂_角色資訊_${slot}.json`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){alert(error.message);}
  };
  document.getElementById('st-class')?.setAttribute('title','使用更名卡變更名稱');
  setInterval(()=>{if(dialog.open&&!busy&&!document.hidden)void refresh().catch(()=>{});},10000);
  setInterval(()=>{if(dialog.open&&!document.hidden)renderBuffTime();},1000);
}
