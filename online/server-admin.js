'use strict';
window.initServerAdmin=({api,notify})=>{
  const root=document.getElementById('view-server');
  root.innerHTML=`<section class="surface"><div class="section-heading"><div><span class="eyebrow">SERVER HEALTH</span><h2>伺服器狀態</h2></div><button id="server-refresh" class="secondary">更新狀態</button></div><p id="server-connection" class="hint" role="status">開啟此分頁時，每 5 秒更新。</p><div id="server-metrics" class="server-metrics"></div><p class="hint">處理延遲反映伺服器是否忙碌，不包含玩家網路延遲。CPU 以單一核心 100% 計算；記憶體數值本身不代表異常。</p></section>
  <section class="surface"><h2>重啟伺服器</h2><p class="muted">確認後會先發出全服通知，15 秒後保存角色進度並重啟。玩家會短暫斷線，服務恢復後重新連線；掛機角色會從已保存的進度繼續。</p><label>重啟原因<input id="server-reason" minlength="2" maxlength="200" placeholder="例如：遊戲操作延遲，重啟排查" autocomplete="off"></label><button id="server-restart" class="primary" disabled>準備重啟</button><p id="server-restart-state" class="hint" role="status"></p></section>
  <section class="surface"><h2>最近 20 筆重啟紀錄</h2><div id="server-history" class="audit-list"></div></section>`;
  const dialog=document.createElement('dialog');dialog.id='server-restart-dialog';dialog.setAttribute('aria-labelledby','server-confirm-title');
  dialog.innerHTML=`<h2 id="server-confirm-title">確認重啟全服</h2><p>15 秒後，所有玩家將短暫斷線。伺服器會先保存進度，再重新啟動。</p><p id="server-confirm-reason" class="hint"></p><label>請輸入「重啟伺服器」確認<input id="server-confirm-text" autocomplete="off" placeholder="重啟伺服器"></label><p id="server-confirm-error" class="error" role="alert"></p><div class="dialog-actions"><button id="server-cancel" class="secondary">取消</button><button id="server-confirm" class="primary">確認重啟</button></div>`;
  document.body.append(dialog);
  const $=id=>document.getElementById(id),labels={scheduled:'等待重啟',stopping:'保存並停止中',completed:'已重新啟動',failed:'未完成',interrupted:'排程中斷'};
  let state=null,loading=false,sending=false,request=null,waitingBoot=null;
  const time=at=>new Date(at).toLocaleString('zh-TW'),message=(text,error=false)=>{$('server-connection').textContent=text;$('server-connection').className=error?'error':'hint';};
  function render(){
    const s=state;
    const values=[['連續運行',`${Math.floor(s.uptimeSeconds/3600)} 小時 ${Math.floor(s.uptimeSeconds%3600/60)} 分`],['記憶體（RSS）',`${s.memory.rssMB} MB`],['JS 已用記憶體',`${s.memory.heapUsedMB} / ${s.memory.heapTotalMB} MB`],['CPU 使用量',`${s.cpuPercent}%`],['處理延遲（P99）',`${s.eventLoop.p99Ms} ms`],['最近 5 秒最高延遲',`${s.eventLoop.maxMs} ms`],['背景戰鬥一輪',`${s.game.lastPassMs} ms`],['已載入／掛機角色',`${s.game.loaded} / ${s.game.running}`],['戰鬥畫面連線',String(s.game.streams)]];
    $('server-metrics').replaceChildren();
    for(const [label,value]of values){const item=document.createElement('article'),name=document.createElement('span'),data=document.createElement('strong');name.textContent=label;data.textContent=value;item.append(name,data);$('server-metrics').append(item);}
    const cooling=s.cooldownUntil>s.serverTime;
    $('server-restart').disabled=!s.restartAvailable||!!s.pending||cooling||sending;
    $('server-restart-state').textContent=!s.restartAvailable?'目前啟動方式不支援重啟。請使用 npm start 啟動服務。':s.pending?`${labels[s.pending.status]} · 預定 ${time(s.pending.scheduledAt)}`:cooling?`重啟冷卻中，可於 ${time(s.cooldownUntil)} 再次操作。`:'每次操作會記錄 GM 帳號、時間與原因。';
    $('server-history').replaceChildren();
    if(!s.history.length)$('server-history').textContent='尚無重啟紀錄。';
    for(const entry of s.history){const article=document.createElement('article'),body=document.createElement('div'),title=document.createElement('strong'),reason=document.createElement('p'),date=document.createElement('time');article.className='audit-entry';title.textContent=`#${entry.id} · ${labels[entry.status]||entry.status} · ${entry.actor}`;reason.textContent=entry.reason+(entry.error?' · '+entry.error:'');date.textContent=time(entry.requestedAt);body.append(title,reason);article.append(body,date);$('server-history').append(article);}
  }
  async function refresh(){
    if(loading)return;loading=true;
    try{state=await api('/api/gm/server');render();
      if(waitingBoot&&waitingBoot!==state.bootId){waitingBoot=null;notify('伺服器已重新啟動，服務恢復。');}
      message(`最後更新 ${time(state.serverTime)} · 開啟此分頁時每 5 秒更新。`);
      if(waitingBoot&&!state.pending&&state.history[0]?.status==='failed'){waitingBoot=null;notify('重啟未完成，請查看下方操作紀錄。',true);}
      return state;
    }catch(error){message(waitingBoot?'正在等待伺服器恢復，將自動重新連線。':`無法取得狀態：${error.message}`,true);return null;}
    finally{loading=false;}
  }
  $('server-refresh').onclick=refresh;
  $('server-restart').onclick=async()=>{
    const reason=$('server-reason').value.trim();if(reason.length<2){notify('請填寫至少 2 字的重啟原因。',true);$('server-reason').focus();return;}
    const fresh=await refresh();if(!fresh||$('server-restart').disabled)return;
    request={requestId:crypto.randomUUID(),bootId:fresh.bootId,reason,confirmation:'重啟伺服器'};
    $('server-confirm-reason').textContent='重啟原因：'+reason;$('server-confirm-text').value='';$('server-confirm-error').textContent='';dialog.showModal();$('server-confirm-text').focus();
  };
  $('server-cancel').onclick=()=>dialog.close();
  dialog.addEventListener('cancel',event=>{if(sending)event.preventDefault();});
  $('server-confirm').onclick=async()=>{
    if(sending||!request)return;
    if($('server-confirm-text').value!=='重啟伺服器'){$('server-confirm-error').textContent='請輸入「重啟伺服器」確認。';return;}
    sending=true;$('server-confirm').disabled=$('server-cancel').disabled=true;
    try{const result=await api('/api/gm/server/restart',request);waitingBoot=['scheduled','stopping'].includes(result.status)?request.bootId:null;dialog.close();notify(`重啟 #${result.id}：${labels[result.status]||result.status}，預定 ${time(result.scheduledAt)}。`);await refresh();}
    catch(error){$('server-confirm-error').textContent=error.message+'；可重新確認，重試同一請求不會重複重啟。';}
    finally{sending=false;$('server-confirm').disabled=$('server-cancel').disabled=false;if(state)render();}
  };
  document.addEventListener('gm:view-change',event=>{if(event.detail.view==='server')void refresh();});
  setInterval(()=>{if(!root.hidden&&!document.hidden)void refresh();},5000);
};
