'use strict';
window.initDiamondAdmin=function({api,notify}){
  const section=document.getElementById('view-diamonds');
  section.innerHTML=`<section class="surface"><h2>藍鑽儲值與發放</h2><p class="hint">藍鑽依帳號共用，只有 GM 能發放。更名卡 3,000 藍鑽，更改密碼卡 500 藍鑽。</p><form id="diamond-grant-form"><div class="field-row"><label class="grow">指定帳號<select id="diamond-account" required></select></label><label>發放藍鑽數量<input id="diamond-amount" type="number" min="1" max="2000000000" step="1" inputmode="numeric" required placeholder="例如 3500"></label></div><label>儲值／發放原因<input id="diamond-reason" minlength="2" maxlength="200" required placeholder="例如：儲值單號、開服獎勵"></label><p id="diamond-admin-wallet" class="hint"></p><button class="primary" id="diamond-grant" type="submit">確認發放藍鑽</button><button class="secondary" id="diamond-admin-refresh" type="button">更新餘額</button></form></section><section class="surface"><h2>此帳號最近交易</h2><div id="diamond-admin-history"></div></section>`;
  const $=id=>document.getElementById(id);let busy=false,pending=null,seq=0;
  const confirmation=document.createElement('dialog');confirmation.setAttribute('aria-label','確認發放藍鑽');confirmation.innerHTML='<h2>確認發放藍鑽</h2><p data-detail></p><div class="dialog-actions"><button type="button" class="secondary" data-cancel>取消</button><button type="button" class="primary" data-confirm>確認發放</button></div>';document.body.append(confirmation);
  function confirmGrant(text){
    if(confirmation.open)return Promise.resolve(false);confirmation.querySelector('[data-detail]').textContent=text;
    return new Promise(resolve=>{const done=value=>{confirmation.close();resolve(value);};confirmation.querySelector('[data-cancel]').onclick=()=>done(false);confirmation.querySelector('[data-confirm]').onclick=()=>done(true);confirmation.oncancel=event=>{event.preventDefault();done(false);};confirmation.showModal();});
  }
  async function wallet(){
    const id=$('diamond-account').value;if(!id)return;const request=++seq;
    const result=await api('/api/gm/diamonds?accountId='+encodeURIComponent(id));if(request!==seq)return;
    $('diamond-admin-wallet').textContent=`餘額 ${result.wallet.diamonds.toLocaleString('zh-TW')} 藍鑽 · 更名卡 ${result.wallet.renameCards} 張 · 密碼卡 ${result.wallet.passwordCards} 張`;
    $('diamond-admin-history').replaceChildren();
    for(const entry of result.history){const article=document.createElement('article');article.className='audit-entry';const body=document.createElement('div'),title=document.createElement('strong'),note=document.createElement('p'),time=document.createElement('time');title.textContent=entry.diamonds?`${entry.diamonds>0?'+':''}${entry.diamonds.toLocaleString('zh-TW')} 藍鑽 · 餘額 ${entry.balance.toLocaleString('zh-TW')}`:entry.kind==='rename'?'使用更名卡':'使用更改密碼卡';note.textContent=entry.note+' · 操作者 '+entry.actor;time.textContent=new Date(entry.at).toLocaleString('zh-TW');body.append(title,note);article.append(body,time);$('diamond-admin-history').append(article);}
    if(!result.history.length)$('diamond-admin-history').textContent='尚無交易紀錄';
  }
  async function refresh(){const previous=$('diamond-account').value,{players}=await api('/api/gm/players');$('diamond-account').replaceChildren();for(const p of players){const o=document.createElement('option');o.value=p.id;o.textContent=`${p.username} · ${p.characters.map(c=>c.name).join('、')||'尚未創角'}`;$('diamond-account').append(o);}if(players.some(p=>p.id===previous))$('diamond-account').value=previous;await wallet();}
  $('diamond-account').onchange=()=>wallet().catch(e=>notify(e.message,true));
  $('diamond-admin-refresh').onclick=()=>refresh().catch(e=>notify(e.message,true));
  $('diamond-grant-form').onsubmit=async event=>{
    event.preventDefault();if(busy)return;
    const body={accountId:$('diamond-account').value,amount:Number($('diamond-amount').value),reason:$('diamond-reason').value.trim()};
    if(!await confirmGrant(`向「${$('diamond-account').selectedOptions[0]?.textContent}」發放 ${body.amount.toLocaleString('zh-TW')} 藍鑽？原因：${body.reason}`))return;
    const signature=JSON.stringify(body);if(pending?.signature!==signature)pending={signature,requestId:crypto.randomUUID()};
    busy=true;$('diamond-grant').disabled=true;
    try{const result=await api('/api/gm/diamonds',{...body,requestId:pending.requestId});pending=null;notify(`已向 ${result.username} 發放 ${body.amount.toLocaleString('zh-TW')} 藍鑽。`);await wallet();}
    catch(error){notify(error.message+'；重試同一筆發放不會重複加值。',true);}
    finally{busy=false;$('diamond-grant').disabled=false;}
  };
  document.addEventListener('gm:view-change',event=>{if(event.detail.view==='diamonds')void refresh().catch(e=>notify(e.message,true));});
};
