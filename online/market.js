const cloud=window.CloudStore;
if(cloud){
  const css=document.createElement('link');css.rel='stylesheet';css.href='/online/market.css';document.head.append(css);
  const dialog=document.createElement('dialog');dialog.id='player-market';dialog.setAttribute('aria-labelledby','market-title');
  dialog.innerHTML=`<header><div><h2 id="market-title">玩家交易所</h2><p>玩家上架 · 全服交易</p></div><button data-close aria-label="關閉交易所">✕</button></header>
    <p class="market-wallet"></p><p class="market-policy">整組售價成交，系統收取 20% 手續費（不足 1 枚進位）。藍鑽由 GM 儲值；售出藍鑽直接入帳，金幣可在此領取。下架不收費。</p>
    <nav aria-label="交易所分頁"><button data-tab="browse" aria-pressed="true">逛市場</button><button data-tab="sell" aria-pressed="false">我要上架</button><button data-tab="mine" aria-pressed="false">我的交易</button></nav>
    <p class="market-notice" role="status"></p><button data-retry hidden>確認交易結果 / 重試</button><section class="market-review" aria-label="確認交易內容" hidden><h3>確認交易內容</h3><p></p><button data-confirm>確認交易</button><button data-cancel-review>返回修改</button></section>
    <section data-pane="browse"><form class="market-search"><input name="q" aria-label="搜尋物品或賣家" placeholder="搜尋物品或賣家"><select name="currency" aria-label="篩選交易幣別"><option value="">全部幣別</option><option value="diamonds">藍鑽</option><option value="gold">金幣</option></select><button>搜尋</button></form><div class="market-offers"></div><footer><button data-prev>上一頁</button><span data-page></span><button data-next>下一頁</button></footer></section>
    <section data-pane="sell" hidden><form class="market-sell"><p data-character></p><label>背包物品<select name="uid" required></select></label><p class="market-hint">只顯示目前角色背包中可交易、未上鎖且未裝備的物品。請先卸下並解鎖要賣的物品。</p><label>出售數量<input name="quantity" type="number" min="1" step="1" value="1" required></label><label>交易幣別<select name="currency"><option value="diamonds">藍鑽</option><option value="gold">金幣</option></select></label><label>整組售價<input name="price" type="number" min="1" max="2000000000" step="1" required placeholder="輸入整組售價"></label><p data-estimate></p><button type="submit">確認上架</button></form></section>
    <section data-pane="mine" hidden><div class="market-proceeds"><span data-proceeds></span><button data-claim>領取金幣</button><button data-refresh>重新整理</button></div><div class="market-mine"></div></section>`;
  document.body.append(dialog);
  const $=q=>dialog.querySelector(q),notice=$('.market-notice'),sell=$('.market-sell'),search=$('.market-search');
  let data=null,page=1,busy=false,pending=null,tab='browse',wasRunning=false,review=null;
  const money=c=>c==='gold'?'金幣':'藍鑽',number=n=>Number(n||0).toLocaleString('zh-TW');
  function describe(row){return `${row.item.bless?'祝福 ':''}${row.item.anc?'遠古 ':''}${row.item.en?`+${row.item.en} `:''}${row.name} × ${number(row.item.cnt)}`;}
  function active(){if(typeof player==='undefined'||!player?.cls||document.getElementById('game-screen').classList.contains('hidden'))throw new Error('請先進入遊戲角色再交易');return {slot:currentSlot,epoch:player._roleEpoch||player.enSeed};}
  function message(text,error=false){notice.textContent=text;notice.classList.toggle('error',error);if(text&&dialog.open)notice.scrollIntoView?.({block:'nearest'});}
  function confirmTrade(action,body,text){
    review={action,body};message('');$('.market-review p').textContent=text;
    for(const pane of dialog.querySelectorAll('[data-pane]'))pane.hidden=true;
    $('.market-review').hidden=false;$('[data-confirm]').textContent=action==='list'?'確認上架':action==='cancel'?'確認下架':'確認購買';
    $('[data-confirm]').focus();$('.market-review').scrollIntoView?.({block:'nearest'});
  }
  function setBusy(value){busy=value;dialog.setAttribute('aria-busy',String(value));for(const el of dialog.querySelectorAll('button,input,select'))el.disabled=value||el.dataset.inactive==='true';}
  function choose(value){review=null;$('.market-review').hidden=true;tab=value;for(const el of dialog.querySelectorAll('[data-pane]'))el.hidden=el.dataset.pane!==value;for(const el of dialog.querySelectorAll('[data-tab]'))el.setAttribute('aria-pressed',String(el.dataset.tab===value));}
  async function refresh(){
    const qs=new URLSearchParams(new FormData(search));qs.set('page',page);
    data=await cloud.request('/api/market?'+qs);cloud.diamonds=data.wallet.diamonds;
    $('.market-wallet').textContent=`💎 藍鑽 ${number(data.wallet.diamonds)}　·　金幣待領 ${number(data.goldProceeds)}`;
    const render=(container,rows,own)=>{
      container.replaceChildren();if(!rows.length){const p=document.createElement('p');p.className='market-empty';p.textContent=own?'還沒有上架紀錄。':'目前沒有符合的商品，成為第一位賣家吧。';container.append(p);return;}
      for(const row of rows){
        const card=document.createElement('article'),title=document.createElement('strong'),details=document.createElement('p'),price=document.createElement('b'),button=document.createElement('button');
        title.textContent=describe(row);details.textContent=`賣家：${row.seller}　${row.description}`;price.textContent=`${number(row.price)} ${money(row.currency)}`;
        card.append(title,details,price);
        if(own){const net=document.createElement('small');net.textContent=row.status==='cancelled'?'未成交 · 未收取手續費':`${row.status==='active'?'成交後':''}系統手續費 ${number(row.fee)} · 實收 ${number(row.net)} ${money(row.currency)}`;card.append(net);}
        button.textContent=row.status==='sold'?'已售出':row.status==='cancelled'?'已下架':row.own?'下架取回':'購買';
        button.disabled=row.status!=='active';button.dataset.inactive=String(button.disabled);button.onclick=()=>{
          const action=row.own?'cancel':'buy',prompt=row.own?`下架「${describe(row)}」並取回目前角色背包？`:`以 ${number(row.price)} ${money(row.currency)} 購買「${describe(row)}」？`;
          confirmTrade(action,{listingId:row.id},prompt);
        };card.append(button);container.append(card);
      }
    };
    render($('.market-offers'),data.offers,false);render($('.market-mine'),data.mine,true);
    $('[data-page]').textContent=`第 ${page} / ${Math.max(1,Math.ceil(data.total/30))} 頁 · ${data.total} 筆`;
    $('[data-prev]').disabled=page<=1;$('[data-next]').disabled=page*30>=data.total;
    $('[data-proceeds]').textContent=`待領取：${number(data.goldProceeds)} 金幣`;$('[data-claim]').disabled=!data.goldProceeds;
    let character;try{const a=active();character=data.characters.find(c=>c.slot===a.slot&&c.epoch===a.epoch);}catch{}
    $('[data-character]').textContent=character?`目前角色：${character.name} · ${number(character.gold)} 金幣`:'請先進入遊戲角色';
    const select=sell.elements.uid,selected=select.value;select.replaceChildren();
    const placeholder=new Option(character?.items.length?'選擇要出售的物品':'沒有可出售物品（請先解鎖物品）','');select.append(placeholder);
    for(const row of character?.items||[])select.append(new Option(describe(row),row.item.uid));
    if([...select.options].some(o=>o.value===selected))select.value=selected;estimate();
  }
  function estimate(){const price=Number(sell.elements.price.value)||0,fee=Math.ceil(price/5),currency=money(sell.elements.currency.value);$('[data-estimate]').textContent=`成交手續費 ${number(fee)} ${currency} · 預計實收 ${number(price-fee)} ${currency}`;}
  async function load(){if(busy||pending)return;setBusy(true);try{await cloud.flush();await refresh();message('');}catch(e){message(e.message,true);}finally{setBusy(false);if(data){$('[data-claim]').disabled=!data.goldProceeds;$('[data-prev]').disabled=page<=1;$('[data-next]').disabled=page*30>=data.total;}}}
  function resume(){cloud.marketPending=false;pending=null;$('[data-retry]').hidden=true;if(typeof state!=='undefined'&&!player.dead)state.running=wasRunning;}
  async function transact(action,body){
    if(busy)return;setBusy(true);
    try{
      if(!pending){
        const character=active();wasRunning=state.running;state.running=false;
        try{await cloud.flush();}catch(e){state.running=wasRunning;throw e;}
        pending={action,body:{...body,...character,lease:cloud.lease,revision:cloud.revision,requestId:crypto.randomUUID()}};
        cloud.marketPending=true;
      }
      message('交易處理中…');
      let result;
      for(let attempt=0;attempt<3;attempt++)try{
        result=await cloud.request('/api/market/'+pending.action,pending.body);break;
      }catch(e){
        if(e.status===409&&e.data?.code==='market_revision_conflict'&&e.data.snapshot&&attempt<2){
          cloud.reconcile(e.data);pending.body.revision=cloud.revision;continue;
        }
        throw e;
      }
      cloud.reconcile(result);cloud.diamonds=result.wallet.diamonds;
      const completed=pending.action;resume();choose(completed==='list'||completed==='cancel'?'mine':tab);
      if(completed==='list'){sell.elements.quantity.value='1';sell.elements.price.value='';}
      message(result.message);
      try{await refresh();}catch{message(result.message+'；清單更新失敗，請按重新整理。');}
    }catch(e){
      if(pending&&e.status&&e.status<500){if(e.data?.snapshot)cloud.reconcile(e.data);resume();}
      if(!pending)choose(tab);
      message(pending?'連線中斷，正在保留交易識別碼。請按「確認交易結果 / 重試」，不會重複扣款。':e.message,true);
    }finally{
      setBusy(false);
      if(pending){for(const el of dialog.querySelectorAll('button,input,select'))el.disabled=true;$('[data-retry]').hidden=false;$('[data-retry]').disabled=false;}
      else {if(data){$('[data-claim]').disabled=!data.goldProceeds;$('[data-prev]').disabled=page<=1;$('[data-next]').disabled=page*30>=data.total;}void cloud.flush().catch(()=>{});}
    }
  }
  cloud.showMarket=()=>{if(!dialog.open)dialog.showModal();choose(tab);void load();};
  window.openPandoraShortcut=()=>cloud.showMarket();
  $('[data-close]').onclick=()=>{if(!busy&&!pending)dialog.close();};dialog.addEventListener('cancel',e=>{if(busy||pending)e.preventDefault();});
  for(const button of dialog.querySelectorAll('[data-tab]'))button.onclick=()=>{choose(button.dataset.tab);void load();};
  $('[data-retry]').onclick=()=>transact();
  $('[data-confirm]').onclick=()=>{if(review){const {action,body}=review;review=null;$('.market-review').hidden=true;void transact(action,body);}};
  $('[data-cancel-review]').onclick=()=>choose(tab);
  $('[data-refresh]').onclick=()=>load();$('[data-claim]').onclick=()=>transact('claim-gold',{});
  search.onsubmit=e=>{e.preventDefault();page=1;void load();};
  $('[data-prev]').onclick=()=>{if(page>1){page--;void load();}};$('[data-next]').onclick=()=>{if(page*30<(data?.total||0)){page++;void load();}};
  sell.querySelector('[type=submit]').textContent='下一步：確認上架';
  sell.oninput=estimate;sell.onsubmit=e=>{e.preventDefault();if(!sell.reportValidity())return;const b={uid:sell.elements.uid.value,quantity:Number(sell.elements.quantity.value),currency:sell.elements.currency.value,price:Number(sell.elements.price.value)};const item=sell.elements.uid.selectedOptions[0].textContent;confirmTrade('list',b,`物品：${item}。出售 ${b.quantity} 件，整組 ${number(b.price)} ${money(b.currency)}，成交後實收 ${number(b.price-Math.ceil(b.price/5))} ${money(b.currency)}。`);};
  async function balance(){try{cloud.diamonds=(await cloud.request('/api/shop')).wallet.diamonds;}catch{}}
  void balance();setInterval(balance,30000);
}
