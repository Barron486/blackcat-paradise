'use strict';
window.initCharacterAdmin=function({api,notify}){
  const dialog=document.createElement('dialog');dialog.id='gm-character-dialog';dialog.setAttribute('aria-labelledby','gm-character-title');
  dialog.innerHTML=`<header class="character-header"><div><small>SERVER CHARACTER INSPECTOR</small><h2 id="gm-character-title">角色資料查核</h2></div><button type="button" class="secondary" data-close aria-label="關閉角色查核">×</button></header>
    <div class="character-toolbar"><label>角色欄位<select data-slot aria-label="查核角色欄位"></select></label><button type="button" class="secondary" data-refresh>更新角色資料</button><button type="button" class="secondary" data-export disabled>匯出查核報告</button></div>
    <p data-message role="status" aria-live="polite"></p><p class="muted" data-meta></p>
    <nav class="character-tabs" aria-label="角色資訊分類"><button type="button" data-character-tab="overview">角色與能力</button><button type="button" data-character-tab="items">裝備與物品</button><button type="button" data-character-tab="progress">技能與進度</button><button type="button" data-character-tab="audit">異常與紀錄</button><button type="button" data-character-tab="raw">完整資料</button></nav>
    <div data-content></div>`;
  document.body.append(dialog);
  const $=s=>dialog.querySelector(s),content=$('[data-content]');let account=null,report=null,sequence=0,tab='overview',itemPage=1,itemQuery='',itemLocation='all';
  const text=(tag,value,className)=>{const el=document.createElement(tag);el.textContent=value;if(className)el.className=className;return el;};
  const display=value=>value===null||value===undefined?'—':typeof value==='boolean'?(value?'是':'否'):typeof value==='object'?JSON.stringify(value):typeof value==='number'?value.toLocaleString('zh-TW',{maximumFractionDigits:4}):String(value);
  const time=value=>value?new Date(value).toLocaleString('zh-TW'):'—';
  const classes={royal:'王族',knight:'騎士',elf:'妖精',mage:'法師',dark:'黑暗妖精',illusion:'幻術士',dragon:'龍騎士',warrior:'戰士'};
  const labels={str:'力量',dex:'敏捷',con:'體質',int:'智力',wis:'精神',cha:'魅力',ac:'防禦',mr:'魔法防禦',meleeDmg:'近戰傷害',meleeHit:'近戰命中',meleeCrit:'近戰暴擊率',meleeCritDmg:'近戰暴擊傷害',rangedDmg:'遠攻傷害',rangedHit:'遠攻命中',rangedCrit:'遠攻暴擊率',rangedCritDmg:'遠攻暴擊傷害',extraDmg:'額外傷害',extraHit:'額外命中',magicDmg:'魔法傷害',magicHit:'魔法命中',magicCrit:'魔法暴擊率',magicCritDmg:'魔法暴擊傷害',extraMp:'額外魔法點數',mpReduce:'MP 消耗減少',hpR:'HP 恢復',mpR:'MP 恢復',dr:'傷害減免',er:'閃避基值',aspd:'攻速基值',resFire:'火抗性',resWater:'水抗性',resEarth:'地抗性',resWind:'風抗性',resNone:'無屬性抗性',moveSpeedPct:'移速加成',atkSpdPct:'攻速加成',weightPct:'負重比例'};
  const slots={wpn:'武器',arrow:'箭矢',helm:'頭盔',armor:'盔甲',shin:'脛甲',shield:'盾牌',cloak:'斗篷',tshirt:'內衣',gloves:'手套',boots:'靴子',ring1:'戒指 1',ring2:'戒指 2',ring3:'戒指 3',ring4:'戒指 4',amulet:'項鍊',ear1:'耳環 1',ear2:'耳環 2',belt:'腰帶',pet:'寵物',doll:'魔法娃娃'};
  function grid(parent,entries){const dl=document.createElement('dl');dl.className='character-facts';for(const [label,value]of entries)dl.append(text('dt',label),text('dd',display(value)));parent.append(dl);}
  function group(title){const section=document.createElement('section');section.className='character-section';section.append(text('h3',title));content.append(section);return section;}
  function jsonDetails(parent,title,value){const details=document.createElement('details');details.append(text('summary',title));let rendered=false;details.addEventListener('toggle',()=>{if(details.open&&!rendered){details.append(text('pre',JSON.stringify(value??null,null,2)));rendered=true;}});parent.append(details);}
  function overview(){
    const p=report.snapshot.p,section=group('角色概況');
    grid(section,[['帳號',report.account.username],['角色 / 欄位',`${p.name||'未命名'} / 第 ${report.slot} 格`],['職業',classes[p.cls]||p.cls],['模式',p.classicMode?'經典':'一般'],['等級',p.lv],['經驗',`${display(p.exp)} / ${report.expRequired??'滿等或無資料'}`],['HP',`${display(p.hp)} / ${display(p.mhp)}`],['MP',`${display(p.mp)} / ${display(p.mmp)}`],['正義值',p.alignmentValue],['所在地',report.mapName],['金幣',p.gold],['帳號藍鑽',report.wallet.diamonds],['交易所待領金幣',report.goldProceeds],['血盟',report.account.clanName||'未加入'],['死亡',!!p.dead],['帳號連線',report.account.online?'在線':'離線'],['目前使用角色',report.account.activeSlot?`第 ${report.account.activeSlot} 格`:'未選角'],['伺服器掛機',report.session?.slot===report.slot&&report.session.running?'持續執行':'未執行'],['角色識別',p._roleEpoch||p.enSeed]]);
    const stats=group('六項能力值');
    const table=document.createElement('table');table.innerHTML='<thead><tr><th>能力</th><th>基礎</th><th>升級配點</th><th>萬能藥</th><th>最終值</th></tr></thead>';const body=document.createElement('tbody');
    for(const key of ['str','dex','con','int','wis','cha']){const tr=document.createElement('tr');for(const value of [labels[key],p.base?.[key],p.alloc?.[key]??0,p.panacea?.[key]??0,p.d?.[key]])tr.append(text('td',display(value)));body.append(tr);}table.append(body);const wrap=document.createElement('div');wrap.className='character-table';wrap.append(table);stats.append(wrap,text('p','最終值含裝備、技能與狀態加成；升級配點與萬能藥列為獨立資料，方便比對。','muted'));
    grid(stats,[['未分配點數',p.bonus],['萬能藥已使用',p.panaceaUsed]]);
    const derived=group('全部衍生能力（伺服器快照）');grid(derived,Object.entries(p.d||{}).map(([key,value])=>[labels[key]?`${labels[key]} (${key})`:key,value]));
  }
  function itemRows(){const p=report.snapshot.p,rows=[];for(const [slot,item]of Object.entries(p.eq||{}))if(item)rows.push({place:'equipment',label:slots[slot]||slot,item});for(const item of Array.isArray(p.inv)?p.inv:[])rows.push({place:'inventory',label:'背包',item});const stored=report.shared[report.warehouseKey]?.items;for(const item of Array.isArray(stored)?stored:[])rows.push({place:'warehouse',label:'同模式共用倉庫',item});return rows;}
  function items(){
    const section=group('裝備、背包與共用倉庫'),bar=document.createElement('div');bar.className='character-item-controls';
    const search=document.createElement('input');search.type='search';search.placeholder='搜尋名稱、物品 ID 或 UID';search.setAttribute('aria-label','搜尋角色物品');search.value=itemQuery;
    const location=document.createElement('select');location.setAttribute('aria-label','物品所在位置');for(const [value,label]of [['all','全部位置'],['equipment','已裝備'],['inventory','背包'],['warehouse','共用倉庫']]){const option=text('option',label);option.value=value;location.append(option);}location.value=itemLocation;
    bar.append(search,location);section.append(bar);const results=document.createElement('div');section.append(results);
    function render(){
      results.replaceChildren();const all=itemRows(),q=itemQuery.trim().toLowerCase(),rows=all.filter(({place,item})=>(itemLocation==='all'||itemLocation===place)&&[item?.id,item?.uid,report.itemCatalog[item?.id]?.name].join(' ').toLowerCase().includes(q));
      itemPage=Math.min(itemPage,Math.max(1,Math.ceil(rows.length/50)));
      results.append(text('p',`符合 ${rows.length} 筆 / 共 ${all.length} 筆 · 倉庫金幣 ${display(report.shared[report.warehouseKey]?.gold??0)}（同模式角色共用）`,'muted'));
      const list=document.createElement('div');list.className='character-items';
      for(const {label,item}of rows.slice((itemPage-1)*50,itemPage*50)){
        const article=document.createElement('article'),d=report.itemCatalog[item?.id];article.append(text('h4',`${item?.en?`${item.en>0?'+':''}${item.en} `:''}${d?.name||item?.id||'無法辨識物品'}`));
        grid(article,[['位置',label],['數量',item?.cnt??1],['物品 ID',item?.id],['UID',item?.uid],['強化 / 上限',`${display(item?.en??0)} / ${display(d?.maxEnchant)}`],['祝福',item?.bless??false],['鎖定',!!item?.lock],['綁定',!!item?.bound]]);if(d?.description)article.append(text('p',d.description,'muted'));jsonDetails(article,'完整物品屬性（含附魔與特殊效果）',item);list.append(article);
      }results.append(list);if(!rows.length)results.append(text('p','此範圍沒有物品。'));
      const pager=document.createElement('div');pager.className='character-pagination';
      for(const [label,delta,disabled]of [['上一頁',-1,itemPage<=1],['下一頁',1,itemPage*50>=rows.length]]){const button=text('button',label,'secondary');button.type='button';button.disabled=disabled;button.onclick=()=>{itemPage+=delta;render();results.scrollIntoView?.({block:'start'});};pager.append(button);}pager.append(text('span',`第 ${itemPage} / ${Math.max(1,Math.ceil(rows.length/50))} 頁`));results.append(pager);
    }
    search.oninput=()=>{itemQuery=search.value;itemPage=1;render();};location.onchange=()=>{itemLocation=location.value;itemPage=1;render();};render();
  }
  function progress(){
    const p=report.snapshot.p,skills=group('技能');grid(skills,Object.entries(report.skills));if(!Object.keys(report.skills).length)skills.append(text('p','尚無已學技能。'));
    const data=group('狀態、夥伴與角色進度');
    for(const [label,value]of [['目前增益',p.buffs],['異常狀態',p.statuses],['GM 增益與到期時間',p._gmBuffs],['藍鑽全狀態與到期時間',p._shopBuffs],['技能冷卻',p.cds],['傭兵隊員',p.allies],['召喚獸',p.summon],['魅惑夥伴',p.charmed],['寵物名冊（同模式共用）',report.shared['fb5_pet_roster'+(p.classicMode?'_classic':'')]],['角色設定與喝水規則',p.config],['精通',p.mastery],['精通任務',p.masteryQuest],['妖精屬性',p.elfEle],['任務追蹤',p.tracking],['攻城進度',p.siege],['席琳進度',p.sherineWorld],['全部角色欄位',p]])jsonDetails(data,label,value);
    const shared=group('帳號共用遊戲資料');for(const [key,value]of Object.entries(report.shared))jsonDetails(shared,key,value);
  }
  function audit(){
    const checks=group('資料一致性檢查');checks.append(text('p',report.checks.issueCount?`發現 ${report.checks.issueCount} 項待查核資料${report.checks.issueCount>200?'（顯示前 200 項）':''}`:'未發現已檢查項目的結構異常',report.checks.issueCount?'character-warning':'character-ok'),text('p',report.checks.notice,'muted'));
    for(const item of report.checks.issues){const row=document.createElement('article');row.className='character-event';row.append(text('strong',item.message),text('code',item.path+' · '+item.code));checks.append(row);}
    const security=group('最近 50 筆存檔驗證拒絕紀錄');security.append(text('p','包含此角色欄位與帳號整體上傳拒絕。舊版程式也可能觸發拒絕，需配合其他證據判斷。','muted'));
    const reasons={SERVER_AUTHORITY_REQUIRED:'拒絕本機存檔上傳（遊戲由伺服器結算）',unknown_item:'未知物品',duplicate_item:'重複物品識別碼',invalid_enchantment:'強化超過上限',invalid_quantity:'物品數量不合法',invalid_starting_stats:'創角配點不合法',invalid_gold:'金幣數值不合法',invalid_exp:'經驗數值不合法'};
    for(const entry of report.history.security){const row=document.createElement('article');row.className='character-event';row.append(text('strong',reasons[entry.code]||entry.code),text('small',`${time(entry.at)} · ${entry.slotKey==='all'?'帳號整體':entry.slotKey}`));security.append(row);}if(!report.history.security.length)security.append(text('p','保留的紀錄中沒有此角色的拒絕事件。'));
    const gm=group('此角色最近的 GM 指令');for(const entry of report.history.commands)jsonDetails(gm,`#${entry.seq} · ${entry.actor} · ${time(entry.at)} · ${entry.command.reason||entry.command.action}`,entry.command);if(!report.history.commands.length)gm.append(text('p','尚無可對應的 GM 指令。'));
    const wallet=group('帳號最近 30 筆藍鑽紀錄');for(const entry of report.history.ledger)wallet.append(text('p',`${time(entry.at)} · ${entry.actor} · ${entry.note} · ${entry.diamonds>0?'+':''}${entry.diamonds} 藍鑽 · 餘額 ${entry.balance}`));if(!report.history.ledger.length)wallet.append(text('p','尚無紀錄。'));
    const market=group('帳號最近 30 筆交易所紀錄');for(const entry of report.history.market)jsonDetails(market,`${time(entry.at)} · ${entry.direction==='sell'?'出售':'購買'} · ${entry.item?.id} · ${entry.price} ${entry.currency==='gold'?'金幣':'藍鑽'} · ${entry.status}`,entry);if(!report.history.market.length)market.append(text('p','尚無紀錄。'));
  }
  function render(){
    content.replaceChildren();for(const b of dialog.querySelectorAll('[data-character-tab]')){b.classList.toggle('active',b.dataset.characterTab===tab);b.setAttribute('aria-pressed',String(b.dataset.characterTab===tab));}
    if(!report)return;
    if(tab==='overview')overview();else if(tab==='items')items();else if(tab==='progress')progress();else if(tab==='audit')audit();else{
      const section=group('完整伺服器角色快照');section.append(text('p','唯讀資料，可展開或匯出供查核；包含角色所有欄位、地圖戰鬥狀態與共用遊戲資料。此報告無法匯入遊戲。','muted'));jsonDetails(section,'展開角色完整 JSON',report.snapshot);jsonDetails(section,'展開帳號共用遊戲資料',report.shared);
    }
  }
  async function load(){
    const seq=++sequence,id=account?.id,slot=Number($('[data-slot]').value);report=null;render();$('[data-export]').disabled=true;$('[data-refresh]').disabled=true;$('[data-meta]').textContent='';$('[data-message]').textContent='讀取伺服器角色快照…';
    try{const result=await api(`/api/gm/character?accountId=${encodeURIComponent(id)}&slot=${slot}`);if(seq!==sequence||!dialog.open)return;
      report=result;$('[data-message]').textContent=`${result.snapshot.p.name||'未命名'} · ${result.checks.issueCount?result.checks.issueCount+' 項待查核':'未發現結構異常'} · ${result.serverAuthoritative?'伺服器結算':'舊式存檔'}`;
      $('[data-meta]').textContent=`存檔版本 ${result.revision} · 帳號存檔更新 ${time(result.savedAt)} · 查詢 ${time(result.checkedAt)}。數值以此次伺服器快照為準。`;$('[data-export]').disabled=false;render();
    }catch(error){if(seq===sequence){$('[data-message]').textContent=error.message;}}finally{if(seq===sequence)$('[data-refresh]').disabled=false;}
  }
  $('[data-close]').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{sequence++;report=null;content.replaceChildren();});
  $('[data-refresh]').onclick=load;$('[data-slot]').onchange=()=>{itemPage=1;load();};
  for(const button of dialog.querySelectorAll('[data-character-tab]'))button.onclick=()=>{tab=button.dataset.characterTab;render();};
  $('[data-export]').onclick=()=>{if(!report)return;const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`gm-character-${report.account.username}-slot${report.slot}-${report.checkedAt}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  window.openGmCharacter=(player,slot)=>{account=player;tab='overview';itemPage=1;itemQuery='';itemLocation='all';const select=$('[data-slot]');select.replaceChildren();for(const c of player.characters){const option=text('option',`第 ${c.slot} 格 · ${c.name}`);option.value=String(c.slot);select.append(option);}select.value=String(slot);if(!dialog.open)dialog.showModal();void load();};
};
