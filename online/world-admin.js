'use strict';
window.initWorldAdmin=function({api,notify}){
  const $=id=>document.getElementById(id), make=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;};
  let settings, maps=[],dropPage=1,dropRequest=0,activeDrop=null,pending=null,clanState=null,clanPending=null;
  const sourceNames={normal:'一般掉落',darkWeapon:'黑妖武器',darkCrystal:'黑妖水晶',dragon:'龍騎士道具',warrior:'戰士印記',memory:'記憶水晶',ore:'銀礦石',trial50:'50 級試煉',mastery:'精通任務',egg:'幼龍蛋',panacea:'萬能藥',stoneSilent:'洞穴魔石',stoneField:'野外魔石',holy:'聖地遺物',area:'區域材料',sherine:'席琳結晶',card1:'普卡',card2:'銀卡',card3:'金卡'};
  const fmt=value=>Number(Number(value).toFixed(8)).toLocaleString('zh-TW',{maximumFractionDigits:8})+'%';
  $('view-world-settings').innerHTML=`<section class="surface"><div class="section-heading"><h2>世界倍率</h2><button id="world-refresh" class="secondary small">重新整理設定</button></div>
    <p class="muted">套用到全伺服器的後續擊殺。在線角色於下次同步生效；離線角色登入時讀取。0 倍代表停止該類獎勵。</p>
    <form id="world-global"><div class="world-fields"><label>金幣掉落金額倍率<input id="world-gold" type="number" min="0" max="1000" step="any" required></label><label>經驗倍率<input id="world-exp" type="number" min="0" max="1000" step="any" required></label><label>物品掉落機率倍率<input id="world-drop" type="number" min="0" max="1000" step="any" required></label></div>
    <label class="world-check"><input id="world-visible" type="checkbox">向玩家顯示怪物掉落率</label><p class="hint">玩家可在「統計 → 本圖掉落物品」查看。機率最高 100%；既有隊伍、裝備與地圖加成另計。藍鑽與 GM 直接發放不受倍率影響。</p>
    <label>修改原因<input id="world-reason" minlength="2" maxlength="200" required placeholder="例如：週末雙倍活動"></label><button class="primary" type="submit">儲存世界設定</button></form><p id="world-version" class="hint"></p></section>
    <section class="surface world-section"><h2>玩家位置權限</h2><form id="world-presence"><label class="world-check"><input id="world-locations-visible" type="checkbox">向所有玩家公開線上位置</label><p class="hint">預設關閉。自己、GM 與同血盟成員仍可查看位置；其餘玩家的線上名單與偷窺卡選人清單不顯示位置。使用 300 藍鑽偷窺卡仍可取得當次位置快照。</p><label>修改原因<input id="world-presence-reason" minlength="2" maxlength="200" required></label><button class="primary" type="submit">儲存位置權限</button></form>
    <h3>血盟成員指派</h3><p class="hint">由 GM 核定跨玩家血盟名冊。同一帳號的所有角色共用所屬血盟，加入同盟後自動開放彼此的位置。這份名冊不改變角色原有的血盟等級與增益。</p><form id="world-clan-form"><div class="world-fields"><label>玩家帳號<select id="world-clan-account" required></select></label><label>所屬血盟<input id="world-clan-name" list="world-clan-names" maxlength="24" placeholder="選擇或輸入血盟，留空移出"><datalist id="world-clan-names"></datalist></label><label>修改原因<input id="world-clan-reason" minlength="2" maxlength="200" required></label></div><p id="world-clan-current" class="hint"></p><button class="primary" type="submit">儲存血盟成員</button></form><div id="world-clan-history" class="audit-list"></div></section>
    <section class="surface world-section"><h2>稀有掉落廣播</h2><form id="world-broadcast"><label class="world-check"><input id="world-broadcast-enabled" type="checkbox">啟用全服跑馬燈與玩家聊天室掉落公告</label><fieldset><legend>廣播範圍（可複選）</legend><div class="world-fields"><label class="world-check loot-name-legend"><input type="checkbox" name="loot-rarity" value="legend">傳說裝備</label><label class="world-check loot-name-relic"><input type="checkbox" name="loot-rarity" value="relic">遺物裝備</label><label class="world-check loot-name-rare"><input type="checkbox" name="loot-rarity" value="rare">極低掉率裝備</label></div></fieldset><p class="hint">僅武器、防具、飾品；排除箭矢、材料與消耗品。傳說／遺物依所屬分類，其餘依該怪物設定基礎掉率 ≤ 0.01% 分類，不受世界倍率影響。</p><p class="hint">公告含掉落時間（台灣時間）、玩家、物品與地圖。修改立即影響後續廣播，玩家畫面約 4 秒更新；不補播關閉期間或原未勾選分類的掉落。既有聊天室公告保留。</p><label>修改原因<input id="world-broadcast-reason" minlength="2" maxlength="200" required placeholder="例如：只廣播傳說與遺物"></label><button class="primary" type="submit">儲存廣播設定</button></form></section>
    <section class="surface world-section"><div class="section-heading"><h2>地圖進入規則</h2><input id="world-map-search" placeholder="搜尋地圖" aria-label="搜尋地圖"></div><p class="hint">可關閉地圖或增加最低進入等級；原有任務、鑰匙條件仍須符合。村莊保持開放供復活與返回使用。關閉不會踢出已在地圖內的角色，GM 傳送可略過進入限制。</p><div class="table-scroll"><table><thead><tr><th>地圖</th><th>開放</th><th>最低等級</th><th>操作</th></tr></thead><tbody id="world-map-list"></tbody></table></div></section>
    <section class="surface world-section"><h2>最近 50 筆設定紀錄</h2><div id="world-history" class="audit-list"></div></section>`;
  $('view-drops').innerHTML=`<section class="surface"><div class="section-heading"><h2>怪物掉落表</h2><button id="drops-refresh" class="secondary small">更新掉落表</button></div><p class="muted">列出一般掉落、職業道具、卡片、任務與特殊材料。每條規則獨立修改；不符合任務、技能或地圖條件時仍不掉落。</p>
    <div class="world-fields"><label>搜尋怪物或物品<input id="drops-search" placeholder="名稱或物品 ID"></label><label>指定怪物<select id="drops-monster"><option value="">全部怪物</option></select></label><label class="world-check"><input id="drops-modified" type="checkbox">只看已修改</label></div>
    <p id="drops-summary" role="status" class="hint"></p><p class="hint">「世界倍率後」以單人、無額外加成計算。六選一萬能藥與同階卡片為互斥池，總和超過 100% 時按比例分配。任務保底與額外條件請見每列說明。</p>
    <div class="table-scroll"><table class="drops-table"><thead><tr><th>怪物／規則</th><th>物品／條件</th><th>原始</th><th>設定</th><th>世界倍率後</th><th>操作</th></tr></thead><tbody id="drops-list"></tbody></table></div><div class="world-pagination"><button id="drops-prev" class="secondary">上一頁</button><span id="drops-page"></span><button id="drops-next" class="secondary">下一頁</button></div></section>`;
  const dialog=make('dialog');dialog.id='world-edit-dialog';dialog.innerHTML=`<h2 id="world-edit-title"></h2><p id="world-edit-description" class="hint"></p><form id="world-edit-form"><label id="world-rate-label">基礎掉落率（%）<input id="world-rate" type="number" min="0" max="100" step="any"></label><label>修改原因<input id="world-edit-reason" minlength="2" maxlength="200" required></label><p id="world-edit-error" role="alert" class="error"></p><div class="dialog-actions"><button id="world-edit-cancel" type="button" class="secondary">取消</button><button id="world-edit-reset" type="button" class="secondary">恢復原始掉率</button><button id="world-edit-submit" class="primary" type="submit">確認儲存</button></div></form>`;document.body.append(dialog);
  function run(task){return task().catch(e=>notify(e.message,true));}
  async function load(){
    const data=await api('/api/gm/world-settings');settings=data.settings;maps=data.maps;
    $('world-locations-visible').checked=settings.showPlayerLocations===true;renderClans(data.locationClans);
    $('world-gold').value=settings.goldMultiplier;$('world-exp').value=settings.expMultiplier;$('world-drop').value=settings.dropMultiplier;$('world-visible').checked=settings.showDropRates;
    const broadcast=settings.lootBroadcast||{enabled:true,rarities:['legend','relic','rare']};$('world-broadcast-enabled').checked=broadcast.enabled;for(const input of document.querySelectorAll('[name="loot-rarity"]'))input.checked=broadcast.rarities.includes(input.value);
    $('world-version').textContent=`設定版本 ${settings.revision} · ${data.monsterCount} 種怪物 · ${data.dropCount.toLocaleString()} 筆掉落規則 · GM 目前位置：${data.location?.mapName||'尚未進入遊戲並同步'}`;
    renderMaps();$('world-history').replaceChildren();
    for(const r of data.history){
      const c=r.command,entry=make('article',null,'audit-entry'),text=make('div');
      const subject=c.type==='global'?'世界倍率／顯示設定':c.type==='broadcast'?'稀有掉落廣播':c.type==='presence'?'玩家位置權限':c.type==='map'?'地圖：'+(maps.find(m=>m.id===c.mapId)?.name||c.mapId):'掉落：'+JSON.parse(c.key).slice(1).join(' / ');
      const detail=c.type==='presence'?(c.showPlayerLocations?'向所有玩家公開':'限自己、GM 與同血盟成員'):c.type==='broadcast'?`${c.enabled?'開啟':'關閉'} · ${c.rarities.map(r=>({legend:'傳說',relic:'遺物',rare:'極低掉率'})[r]).join('、')||'未選分類'}`:c.type==='drop'?(c.rate===null?'恢復原始':fmt(c.rate)):c.type==='map'?`${c.open?'開放':'關閉'} · Lv.${c.minLevel}`:`金幣 ×${c.goldMultiplier} / 經驗 ×${c.expMultiplier} / 掉落 ×${c.dropMultiplier}`;
      text.append(make('strong',subject),make('p',c.reason),make('small',r.actor+' · '+detail));entry.append(text,make('time',new Date(r.created_at).toLocaleString('zh-TW')));$('world-history').append(entry);
    }
    if(!data.history.length)$('world-history').textContent='尚無設定修改紀錄。';
  }
  function renderClans(data){
    clanState=data;if(!data)return;const previous=$('world-clan-account').value;$('world-clan-account').replaceChildren();
    for(const player of data.players){const option=make('option',`${player.username} · ${player.characters.map(c=>c.name).join('、')||'尚未創角'}${player.clanName?' · '+player.clanName:''}`);option.value=player.id;$('world-clan-account').append(option);}
    if(data.players.some(p=>p.id===previous))$('world-clan-account').value=previous;
    $('world-clan-names').replaceChildren();for(const name of data.clans){const option=make('option');option.value=name;$('world-clan-names').append(option);}
    selectClanAccount();$('world-clan-history').replaceChildren();
    for(const row of data.history){const account=data.players.find(p=>p.id===row.command.accountId),entry=make('article',null,'audit-entry');entry.append(make('strong',`${account?.username||'玩家'}：${row.previousClan||'無血盟'} → ${row.command.clanName||'無血盟'}`),make('p',row.command.reason),make('small',row.actor+' · '+new Date(row.at).toLocaleString('zh-TW')));$('world-clan-history').append(entry);}
  }
  function selectClanAccount(){const player=clanState?.players.find(p=>p.id===$('world-clan-account').value);$('world-clan-name').value=player?.clanName||'';$('world-clan-current').textContent='目前血盟：'+(player?.clanName||'未加入');}
  $('world-clan-account').onchange=selectClanAccount;
  $('world-presence').onsubmit=event=>{event.preventDefault();const button=event.submitter;button.disabled=true;run(async()=>{await update({type:'presence',showPlayerLocations:$('world-locations-visible').checked,reason:$('world-presence-reason').value});await load();}).finally(()=>button.disabled=false);};
  $('world-clan-form').onsubmit=event=>{event.preventDefault();const button=event.submitter;button.disabled=true;run(async()=>{
    const command={accountId:$('world-clan-account').value,clanName:$('world-clan-name').value.trim(),reason:$('world-clan-reason').value},fingerprint=JSON.stringify(command);
    if(!clanPending||clanPending.fingerprint!==fingerprint)clanPending={fingerprint,body:{...command,revision:clanState.revision,requestId:crypto.randomUUID()}};
    const data=await api('/api/gm/location-clans',clanPending.body);clanPending=null;renderClans(data);notify('血盟成員已儲存；同血盟的位置權限立即生效。');
  }).finally(()=>button.disabled=false);};
  function renderMaps(){
    const q=$('world-map-search').value.trim().toLowerCase();$('world-map-list').replaceChildren();
    for(const m of maps.filter(m=>(m.name+' '+m.id).toLowerCase().includes(q))){
      const rule=settings.maps[m.id]||{open:true,minLevel:1},tr=make('tr'),name=make('td',m.name),open=make('input'),level=make('input'),button=make('button','修改','secondary small');
      name.append(make('small',m.id,'world-sub'));open.type='checkbox';open.checked=rule.open!==false;open.setAttribute('aria-label',m.name+' 開放');level.type='number';level.min=1;level.max=100;level.value=rule.minLevel||1;level.setAttribute('aria-label',m.name+' 最低等級');
      open.disabled=level.disabled=button.disabled=m.id.startsWith('town_');
      const a=make('td'),b=make('td'),c=make('td');a.append(open);b.append(level);c.append(button);tr.append(name,a,b,c);$('world-map-list').append(tr);
      button.onclick=()=>{if(!level.checkValidity()){level.reportValidity();return;}activeDrop={type:'map',mapId:m.id,open:open.checked,minLevel:Number(level.value)};openEdit('地圖進入規則：'+m.name,`${open.checked?'開放':'關閉'} · 最低等級 ${level.value}`,false);};
    }
  }
  async function loadDrops(){
    const request=++dropRequest;const params=new URLSearchParams({q:$('drops-search').value,monster:$('drops-monster').value,page:String(dropPage)});if($('drops-modified').checked)params.set('modified','1');
    const data=await api('/api/gm/drops?'+params);if(request!==dropRequest)return;
    if(!settings)settings={revision:data.revision};settings.revision=data.revision;dropPage=data.page;
    if($('drops-monster').options.length===1)for(const m of data.monsters.sort((a,b)=>a.name.localeCompare(b.name,'zh-TW'))){const opt=make('option',m.name);opt.value=m.name;$('drops-monster').append(opt);}
    $('drops-summary').textContent=`共 ${data.total.toLocaleString()} 筆 · 世界掉落倍率 ×${data.multiplier} · 設定版本 ${data.revision}`;$('drops-page').textContent=`${data.page} / ${data.totalPages}`;$('drops-prev').disabled=data.page<=1;$('drops-next').disabled=data.page>=data.totalPages;$('drops-list').replaceChildren();
    for(const r of data.rows){
      const tr=make('tr'),mob=make('td',r.monster),item=make('td',r.itemName),action=make('td'),button=make('button','修改','secondary small');
      mob.append(make('small',(sourceNames[r.source]||r.source)+(r.rolls>1?` · ${r.rolls} 次獨立判定`:''),'world-sub'));item.append(make('small',r.itemId,'world-sub'));if(r.condition)item.append(make('small',r.condition,'world-sub'));
      const rate=make('td',fmt(r.rate),r.modified?'world-changed':'');if(r.modified)rate.append(make('small','已修改','world-sub'));button.onclick=()=>{activeDrop={type:'drop',key:r.key,rate:r.rate};openEdit(r.monster+' → '+r.itemName,`原始 ${fmt(r.baseRate)} · ${r.condition||'一般掉落'}`,true);};action.append(button);tr.append(mob,item,make('td',fmt(r.baseRate)),rate,make('td',fmt(r.effectiveRate)),action);$('drops-list').append(tr);
    }
    if(!data.rows.length){const tr=make('tr'),td=make('td','沒有符合條件的掉落資料。');td.colSpan=6;tr.append(td);$('drops-list').append(tr);}
  }
  function openEdit(title,description,isDrop){pending=null;$('world-edit-title').textContent=title;$('world-edit-description').textContent=description;$('world-rate-label').hidden=!isDrop;$('world-rate').required=isDrop;$('world-rate').value=isDrop?activeDrop.rate:'';$('world-edit-reset').hidden=!isDrop;$('world-edit-reason').value='';$('world-edit-error').textContent='';dialog.showModal();}
  async function update(command){
    const fingerprint=JSON.stringify(command);if(!pending||pending.fingerprint!==fingerprint)pending={fingerprint,body:{...command,revision:settings.revision,requestId:crypto.randomUUID()}};
    const result=await api('/api/gm/world-settings',pending.body);settings=result.settings;pending=null;notify(command.type==='presence'?'位置權限已儲存；線上名單下次更新生效。':command.type==='broadcast'?'廣播設定已儲存；玩家畫面約 4 秒更新。':'世界設定已儲存；在線角色於下次同步套用。');
  }
  $('world-global').onsubmit=event=>{event.preventDefault();const button=event.submitter;button.disabled=true;run(async()=>{await update({type:'global',goldMultiplier:Number($('world-gold').value),expMultiplier:Number($('world-exp').value),dropMultiplier:Number($('world-drop').value),showDropRates:$('world-visible').checked,reason:$('world-reason').value});await load();}).finally(()=>button.disabled=false);};
  $('world-broadcast').onsubmit=event=>{event.preventDefault();const button=event.submitter;button.disabled=true;run(async()=>{await update({type:'broadcast',enabled:$('world-broadcast-enabled').checked,rarities:[...document.querySelectorAll('[name="loot-rarity"]:checked')].map(input=>input.value),reason:$('world-broadcast-reason').value});await load();}).finally(()=>button.disabled=false);};
  async function saveEdit(reset=false){
    if(!$('world-edit-form').reportValidity())return;
    $('world-edit-submit').disabled=$('world-edit-reset').disabled=true;
    try{await update({...activeDrop,...(activeDrop.type==='drop'?{rate:reset?null:Number($('world-rate').value)}:{}),reason:$('world-edit-reason').value});dialog.close();await load();if(activeDrop.type==='drop')await loadDrops();}catch(e){$('world-edit-error').textContent=e.message+'；可重試，操作不會重複。';}finally{$('world-edit-submit').disabled=$('world-edit-reset').disabled=false;}
  }
  $('world-edit-form').onsubmit=e=>{e.preventDefault();void saveEdit();};$('world-edit-reset').onclick=()=>saveEdit(true);$('world-edit-cancel').onclick=()=>dialog.close();
  $('world-refresh').onclick=()=>{pending=null;clanPending=null;run(load);};$('world-map-search').oninput=renderMaps;
  let timer;$('drops-search').oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>{dropPage=1;run(loadDrops);},250);};
  for(const id of ['drops-monster','drops-modified'])$(id).onchange=()=>{dropPage=1;run(loadDrops);};
  $('drops-prev').onclick=()=>{dropPage--;run(loadDrops);};$('drops-next').onclick=()=>{dropPage++;run(loadDrops);};$('drops-refresh').onclick=()=>{pending=null;run(loadDrops);};
  document.addEventListener('gm:view-change',e=>{if(e.detail.view==='world-settings')run(load);if(e.detail.view==='drops')run(async()=>{if(!settings)await load();await loadDrops();});});
};
