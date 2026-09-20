'use strict';
const $=id=>document.getElementById(id);
let csrf='',me=null,players=[],action='buff_all',selected=null,preview=null,requestId=null,executing=false;
const labels={buff_all:'賜予全狀態',grant_item:'發放指定物品',kill:'即刻死亡',revive:'復活與恢復',clear_buffs:'移除 GM 增益',teleport:'傳送至 GM 所在地圖',restore_progress:'修復已確認的經驗進度'};
const classNames={royal:'王族',knight:'騎士',elf:'妖精',mage:'法師',dark:'黑暗妖精',illusion:'幻術士',dragon:'龍騎士',warrior:'戰士'};
const scopeNames={all:'全部玩家（含離線）',online:'在線玩家目前角色',account:'指定帳號全部角色',character:'指定帳號內單一角色'};
async function api(path,body){
  const response=await fetch(path,{method:body===undefined?'GET':'POST',cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();if(!response.ok){if(response.status===401)location.href='/login';throw new Error(data.error||'請求失敗');}return data;
}
function notify(text,error=false){$('notice').hidden=false;$('notice').className='notice'+(error?' error':'');$('notice').textContent=text;}
function targetCount(){
  const scope=$('scope').value,id=$('target-account').value,slot=Number($('target-character').value);
  $('target-count').textContent=players.filter(p=>!['account','character'].includes(scope)||p.id===id).reduce((n,p)=>n+(scope==='online'?(p.online&&p.characters.some(c=>c.slot===p.activeSlot)?1:0):scope==='character'?p.characters.filter(c=>c.slot===slot).length:p.characters.length),0);
}
function renderTargetCharacters(preserve=true){
  const select=$('target-character'),slot=preserve?select.value:'';
  const characters=players.find(p=>p.id===$('target-account').value)?.characters||[];
  const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent=characters.length?'請選擇收件角色':'此帳號尚未建立角色';
  select.replaceChildren(placeholder);select.disabled=!characters.length;
  for(const c of [...characters].sort((a,b)=>a.slot-b.slot)){
    const option=document.createElement('option');option.value=String(c.slot);option.textContent=`第 ${c.slot} 格 · ${c.name} · Lv.${c.level} ${classNames[c.cls]||c.cls}`;select.append(option);
  }
  if(characters.some(c=>String(c.slot)===slot))select.value=slot;
  targetCount();
}
function updateTargetScope(){
  const single=$('character-scope');single.hidden=single.disabled=action!=='grant_item';
  if(single.disabled&&$('scope').value==='character')$('scope').value='account';
  $('account-wrap').hidden=!['account','character'].includes($('scope').value);
  $('character-wrap').hidden=$('scope').value!=='character';targetCount();
}
async function refreshPlayers(){
  const data=await api('/api/gm/players');players=data.players;
  $('metric-accounts').textContent=players.length;$('metric-online').textContent=players.filter(p=>p.online).length;
  $('metric-characters').textContent=players.reduce((n,p)=>n+p.characters.length,0);$('metric-gms').textContent=players.filter(p=>p.role==='gm').length;
  const selectedAccount=$('target-account').value;$('target-account').replaceChildren();
  for(const p of players){const option=document.createElement('option');option.value=p.id;option.textContent=`${p.username} · ${p.characters.length} 個角色`;$('target-account').append(option);}
  if(players.some(p=>p.id===selectedAccount))$('target-account').value=selectedAccount;
  renderPlayers();renderTargetCharacters($('target-account').value===selectedAccount);$('last-updated').textContent='最後更新 '+new Date().toLocaleTimeString('zh-TW');
}
function renderPlayers(){
  const q=$('player-search').value.toLowerCase();$('player-list').replaceChildren();
  for(const p of players.filter(p=>(p.username+' '+p.characters.map(c=>c.name).join(' ')).toLowerCase().includes(q))){
    const tr=document.createElement('tr'),account=document.createElement('td'),characters=document.createElement('td'),online=document.createElement('td'),role=document.createElement('td'),manage=document.createElement('td');
    account.textContent=p.username+(p.id===me?.id?'（你）':'');
    for(const [cell,label] of [[account,'帳號'],[characters,'角色'],[online,'連線'],[role,'權限'],[manage,'管理']])cell.dataset.label=label;
    if(!p.characters.length)characters.textContent='尚未建立角色';
    for(const c of p.characters){const line=document.createElement('div');line.className='gm-character-entry';const name=document.createElement('span');name.textContent=`第 ${c.slot} 格 · ${c.name} · Lv.${c.level} ${classNames[c.cls]||c.cls}${c.dead?' · 已死亡':''}`;const inspect=document.createElement('button');inspect.type='button';inspect.className='secondary small';inspect.textContent='檢視角色';inspect.setAttribute('aria-label',`檢視 ${p.username} 第 ${c.slot} 格 ${c.name}`);inspect.onclick=()=>window.openGmCharacter?.(p,c.slot);line.append(name,inspect);characters.append(line);}
    online.className=p.online?'online':'offline';online.textContent=p.online?'在線上':'離線';role.textContent=p.role==='gm'?'♛ GM':'玩家';
    const button=document.createElement('button');button.className='secondary small';button.textContent=p.role==='gm'?'取消 GM':'授予 GM';
    button.disabled=p.role==='gm'&&players.filter(a=>a.role==='gm').length===1;
    button.onclick=async()=>{
      const next=p.role==='gm'?'player':'gm';
      if(!confirm(`${next==='gm'?'授予':'取消'} ${p.username} 的 GM 權限？${next==='gm'?'此帳號將能對全部玩家執行指令。':''}`))return;
      try{await api('/api/gm/role',{accountId:p.id,role:next});notify('帳號權限已更新');await refreshPlayers();}catch(error){notify(error.message,true);}
    };manage.append(button);tr.append(account,characters,online,role,manage);$('player-list').append(tr);
  }
}
document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>{
  document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b===button));
  for(const view of ['commands','players','audit','ai-chat','diamonds','world-settings','drops','monsters','announcements','server'])$('view-'+view).hidden=view!==button.dataset.view;
  document.dispatchEvent(new CustomEvent('gm:view-change',{detail:{view:button.dataset.view}}));
  if(button.dataset.view==='audit')void refreshAudit().catch(e=>notify(e.message,true));
});
document.querySelectorAll('[data-action]').forEach(button=>button.onclick=()=>{
  action=button.dataset.action;document.querySelectorAll('[data-action]').forEach(b=>b.classList.toggle('selected',b===button));
  $('buff-options').hidden=action!=='buff_all';$('item-options').hidden=action!=='grant_item';
  updateTargetScope();
  $('action-explanation').hidden=['buff_all','grant_item'].includes(action);
  $('action-explanation').textContent=action==='kill'?'令目標角色 HP 立即歸零，停止戰鬥並顯示復活按鈕。GM 死亡不額外扣除經驗或掉落裝備。':action==='revive'?'解除死亡，恢復全部 HP 與 MP，並清除異常狀態。':action==='teleport'?'先用此 GM 帳號在另一個遊戲分頁移動到目的地並同步存檔，再預覽傳送。傳送略過地圖進入限制與費用，離線角色下次登入時套用。':'移除目前由 GM 施加的增益效果。';
  if(action==='grant_item')void searchItems().catch(e=>notify(e.message,true));
});
let searchTimer,searchSeq=0;
async function searchItems(){
  const seq=++searchSeq;
  const result=await api('/api/gm/catalog?q='+encodeURIComponent($('item-search').value)+'&type='+encodeURIComponent($('item-type').value));
  if(seq!==searchSeq)return;
  $('item-count').textContent=`找到 ${result.total} 項物品${result.total>100?'，顯示前 100 項，請輸入更完整名稱':''}`;$('item-results').replaceChildren();
  for(const item of result.items){
    const button=document.createElement('button');button.type='button';button.className='item-result';button.setAttribute('role','option');button.setAttribute('aria-selected',String(selected?.id===item.id));
    const strong=document.createElement('strong'),small=document.createElement('small');strong.textContent=(item.legend?'✦ ':'')+item.name;small.textContent=item.id;button.append(strong,small);
    button.onclick=()=>{
      selected=item;document.querySelectorAll('.item-result').forEach(b=>b.setAttribute('aria-selected',String(b===button)));
      $('selected-item').textContent=`已選擇：${item.name}（${item.id}） · 強化上限 +${item.maxEnchant}`;
      $('enchant').max=item.maxEnchant;$('enchant').disabled=!item.maxEnchant;
      $('enchant').value=Math.min(Number($('enchant').value),item.maxEnchant);
      $('blessed').disabled=!item.canBless;if(!item.canBless)$('blessed').checked=false;
    };$('item-results').append(button);
  }
}
$('item-search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>searchItems().catch(e=>notify(e.message,true)),250);};
$('item-type').onchange=()=>searchItems().catch(e=>notify(e.message,true));
$('scope').onchange=updateTargetScope;$('target-account').onchange=()=>renderTargetCharacters(false);$('target-character').onchange=targetCount;
$('player-search').oninput=renderPlayers;
$('refresh').onclick=()=>refreshPlayers().catch(e=>notify(e.message,true));
function command(){
  if(action==='grant_item'&&!selected)throw new Error('請先從清單選擇物品');
  const single=$('scope').value==='character';
  if(single&&!$('target-character').value)throw new Error('請先選擇帳號及收件角色');
  return {action,scope:$('scope').value,accountId:$('target-account').value,...(single?{slot:Number($('target-character').value)}:{}),reason:$('reason').value.trim(),duration:Number($('duration').value),itemId:selected?.id,quantity:Number($('quantity').value),enchant:Number($('enchant').value),blessed:$('blessed').checked};
}
function detail(label,value){const p=document.createElement('p'),strong=document.createElement('strong');p.append(document.createTextNode(label+'　'));strong.textContent=value;p.append(strong);$('confirm-detail').append(p);}
$('preview').onclick=async()=>{
  $('preview').disabled=true;
  try{
    preview=await api('/api/gm/preview',command());requestId=crypto.randomUUID();
    if(!preview.characterCount)throw new Error('這個範圍內尚未有角色，請先進入遊戲建立角色。');
    $('confirm-title').textContent=labels[preview.command.action];$('confirm-detail').replaceChildren();
    detail('作用範圍',scopeNames[preview.command.scope]);detail('影響人數',`${preview.accountCount} 個帳號 / ${preview.characterCount} 個角色`);
    if(preview.command.action==='teleport')detail('傳送目的地',preview.command.mapName);
    if(preview.command.action==='buff_all')detail('持續時間',`${preview.command.duration/60} 分鐘`);
    if(preview.command.action==='grant_item')detail('發放物品',`${selected.name} × ${preview.command.quantity} / 每個角色${preview.command.enchant?'，強化 +'+preview.command.enchant:''}${preview.command.blessed?'，祝福':''}`);
    detail('操作原因',preview.command.reason);detail('目標帳號',preview.targets.slice(0,15).map(t=>t.username).join('、')+(preview.targets.length>15?'…':''));
    if(preview.command.scope==='character')detail('收件角色',`第 ${preview.command.slot} 格 · ${preview.targets[0].characters[0]}`);
    $('kill-confirm-wrap').hidden=preview.command.action!=='kill';$('kill-confirm').value='';$('execute-error').textContent='';$('execute').disabled=false;
    $('confirm-dialog').showModal();
  }catch(e){notify(e.message,true);}finally{$('preview').disabled=false;}
};
$('cancel-command').onclick=()=>$('confirm-dialog').close();
$('execute').onclick=async()=>{
  if(executing||!preview)return;
  if(preview.command.action==='kill'&&$('kill-confirm').value!=='全體死亡'){$('execute-error').textContent='請輸入「全體死亡」確認。';return;}
  executing=true;$('execute').disabled=true;$('execute-error').textContent='';
  try{
    const result=await api('/api/gm/execute',{...preview.command,requestId,targetFingerprint:preview.targetFingerprint});
    $('confirm-dialog').close();notify(`指令 #${result.seq} 已完成：${labels[result.action]}，共影響 ${result.accountCount} 個帳號、${result.characterCount} 個角色。`);
    preview=null;requestId=null;await refreshPlayers();
  }catch(e){$('execute-error').textContent=e.message+'（重試不會重複發放）';}
  finally{executing=false;$('execute').disabled=false;}
};
async function refreshAudit(){
  const data=await api('/api/gm/audit');$('audit-list').replaceChildren();
  if(!data.entries.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='尚未執行任何 GM 指令。';$('audit-list').append(empty);}
  for(const entry of data.entries){
    const article=document.createElement('article');article.className='audit-entry';const body=document.createElement('div'),title=document.createElement('strong'),reason=document.createElement('p'),meta=document.createElement('small'),time=document.createElement('time');
    title.textContent=`#${entry.seq}　${labels[entry.command.action]}　·　${entry.result.characterCount} 個角色`;
    const recipient=entry.result.recipient;
    reason.textContent=entry.command.reason;meta.textContent=`操作者 ${entry.actor} · ${scopeNames[entry.command.scope]}${recipient?` · ${recipient.username} / 第 ${recipient.slot} 格 · ${recipient.name}`:''}${entry.command.itemId?' · '+entry.command.itemId+' × '+entry.command.quantity:''}`;time.textContent=new Date(entry.at).toLocaleString('zh-TW');body.append(title,reason,meta);article.append(body,time);$('audit-list').append(article);
  }
  const security=await api('/api/gm/save-security');$('save-security-list').replaceChildren();
  if(!security.entries.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='尚無存檔驗證拒絕紀錄。';$('save-security-list').append(empty);}
  const reasons={forged_gm_state:'偽造 GM 狀態',forged_gm_sequence:'偽造 GM 指令序號',forged_market_sequence:'偽造交易序號',forged_gm_death:'修改 GM 死亡狀態',forged_gm_buff:'修改 GM 增益',invalid_starting_items:'新角色攜帶非初始道具',invalid_starting_progress:'新角色進度不合法',invalid_starting_stats:'新角色配點不合法',unknown_item:'未知道具',duplicate_item:'重複道具識別碼',invalid_enchantment:'強化超過上限',invalid_quantity:'道具數量不合法',invalid_panacea:'萬能藥資料不合法',invalid_gold:'金幣資料不合法',invalid_exp:'經驗資料不合法'};
  for(const entry of security.entries){
    const article=document.createElement('article');article.className='audit-entry';const body=document.createElement('div'),title=document.createElement('strong'),detail=document.createElement('p'),time=document.createElement('time');
    title.textContent=`${entry.account} · 角色欄位 ${entry.slotKey.slice(-1)}`;detail.textContent=reasons[entry.code]||'角色數值不符合規則（'+entry.code+'）';time.textContent=new Date(entry.at).toLocaleString('zh-TW');body.append(title,detail);article.append(body,time);$('save-security-list').append(article);
  }
}
$('audit-refresh').onclick=()=>refreshAudit().catch(e=>notify(e.message,true));
(async()=>{try{const data=await api('/api/me');me=data.user;csrf=data.csrf;if(me.role!=='gm')throw new Error('這個帳號沒有 GM 權限');$('gm-account').textContent='♛ '+me.username;await refreshPlayers();if(typeof window.initServerAdmin==='function')window.initServerAdmin({api,notify});if(typeof window.initCharacterAdmin==='function')window.initCharacterAdmin({api,notify});if(typeof window.initAiChat==='function')window.initAiChat({api,notify});if(typeof window.initDiamondAdmin==='function')window.initDiamondAdmin({api,notify});if(typeof window.initWorldAdmin==='function')window.initWorldAdmin({api,notify});if(typeof window.initMonsterAdmin==='function')window.initMonsterAdmin({api,notify});}catch(e){notify(e.message,true);}})();
