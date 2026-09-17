const cloud=window.CloudStore;
if(cloud){
  const css=document.createElement('link');css.rel='stylesheet';css.href='/online/shop.css';document.head.append(css);
  const dialog=document.createElement('dialog');dialog.id='diamond-shop';dialog.className='diamond-dialog';
  dialog.setAttribute('aria-labelledby','diamond-title');
  dialog.innerHTML=`<header><div><small>BLACK CAT STORE</small><h2 id="diamond-title">藍鑽商店</h2></div><button type="button" data-close aria-label="關閉藍鑽商店">×</button></header>
    <div class="diamond-wallet"><span>帳號藍鑽餘額</span><strong id="diamond-balance">—</strong><span>💎</span></div>
    <p class="diamond-note">藍鑽由帳號內所有角色共用，儲值一律由 GM 發送。需要儲值時，請向 GM 提供登入帳號。</p>
    <p id="diamond-message" role="status" aria-live="polite"></p>
    <section class="diamond-products" aria-label="商品"><article><h3>更名卡</h3><p>變更一位角色的名稱</p><strong>3,000 藍鑽</strong><button type="button" data-buy="rename_card">購買更名卡</button></article><article><h3>更改密碼卡</h3><p>變更目前帳號的登入密碼</p><strong>500 藍鑽</strong><button type="button" data-buy="password_card">購買密碼卡</button></article></section>
    <section class="diamond-section"><h3>我的卡片</h3><p id="diamond-cards"></p>
    <form id="diamond-rename"><h4>使用更名卡</h4><label>選擇角色<select name="slot" required></select></label><label>新的角色名稱<input name="name" maxlength="12" required placeholder="1～12 字" autocomplete="off"></label><button type="submit">消耗 1 張更名卡</button></form>
    <form id="diamond-password"><h4>使用更改密碼卡</h4><label>目前密碼<input type="password" name="current" autocomplete="current-password" maxlength="128" required></label><label>新密碼<input type="password" name="next" autocomplete="new-password" minlength="12" maxlength="128" required placeholder="12～128 字"></label><label>再次輸入新密碼<input type="password" name="repeat" autocomplete="new-password" minlength="12" maxlength="128" required></label><p class="diamond-note">成功後會登出所有裝置，請以新密碼重新登入。忘記目前密碼時請聯絡 GM。</p><button type="submit">消耗 1 張密碼卡</button></form></section>
    <section class="diamond-section"><div class="diamond-history-heading"><h3>最近交易</h3><button type="button" data-refresh>更新餘額</button></div><div id="diamond-history"></div></section>`;
  document.body.append(dialog);
  const confirmDialog=document.createElement('dialog');confirmDialog.className='diamond-dialog diamond-confirm';confirmDialog.setAttribute('aria-label','確認藍鑽交易');
  confirmDialog.innerHTML='<h2>確認交易</h2><p data-detail></p><div class="diamond-confirm-actions"><button type="button" data-cancel>取消</button><button type="button" data-confirm>確認</button></div>';document.body.append(confirmDialog);
  function confirmChoice(text){
    if(confirmDialog.open)return Promise.resolve(false);
    confirmDialog.querySelector('[data-detail]').textContent=text;
    return new Promise(resolve=>{const done=value=>{confirmDialog.close();resolve(value);};confirmDialog.querySelector('[data-cancel]').onclick=()=>done(false);confirmDialog.querySelector('[data-confirm]').onclick=()=>done(true);confirmDialog.oncancel=event=>{event.preventDefault();done(false);};confirmDialog.showModal();});
  }
  const $=selector=>dialog.querySelector(selector),pending=new Map();let info=null,busy=false;
  function notice(text,error=false){$('#diamond-message').textContent=text;$('#diamond-message').classList.toggle('error',error);}
  function render(){
    if(!info)return;const w=info.wallet;cloud.diamonds=w.diamonds;
    $('#diamond-balance').textContent=w.diamonds.toLocaleString('zh-TW');
    $('#diamond-cards').textContent=`更名卡 ${w.renameCards} 張 · 更改密碼卡 ${w.passwordCards} 張`;
    for(const product of info.products){const b=$(`[data-buy="${product.id}"]`);b.disabled=busy||w.diamonds<product.price;}
    $('#diamond-rename button').disabled=busy||!w.renameCards||!info.characters.length;
    $('#diamond-password button').disabled=busy||!w.passwordCards;
    const select=$('#diamond-rename select'),previous=select.value;select.replaceChildren();
    for(const c of info.characters){const option=document.createElement('option');option.value=c.slot;option.textContent=`${c.name} · Lv.${c.level}（角色 ${c.slot}）`;select.append(option);}
    if(info.characters.some(c=>String(c.slot)===previous))select.value=previous;
    $('#diamond-history').replaceChildren();
    for(const row of info.history){const p=document.createElement('p'),time=document.createElement('small');p.textContent=row.note+(row.diamonds?` · ${row.diamonds>0?'+':''}${row.diamonds.toLocaleString('zh-TW')} 藍鑽`:'');time.textContent=new Date(row.at).toLocaleString('zh-TW');p.append(time);$('#diamond-history').append(p);}
    if(!info.history.length)$('#diamond-history').textContent='尚無交易紀錄';
  }
  async function refresh(){info=await cloud.request('/api/shop');render();}
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
  cloud.showShop=async()=>{if(!dialog.open)dialog.showModal();try{await refresh();}catch(error){notice(error.message,true);}};
  $('[data-close]').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>$('#diamond-password').reset());
  $('[data-refresh]').onclick=()=>refresh().catch(error=>notice(error.message,true));
  for(const button of dialog.querySelectorAll('[data-buy]'))button.onclick=async()=>{
    const product=info?.products.find(p=>p.id===button.dataset.buy);if(!product||busy)return;
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
}
