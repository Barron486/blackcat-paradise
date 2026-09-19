// One home for shared player chat, the original NPC conversations, and presence.
export function startWorldChat(cloud, toolbar, isStopped = () => false) {
  if (!document.getElementById('game-screen')) return {refresh: async () => {}};
  const chat = document.createElement('section');
  chat.id = 'cloud-chat';chat.hidden = true;
  chat.setAttribute('aria-label', '世界頻道');
  chat.innerHTML = `<header><strong>世界頻道</strong><button type="button" data-close aria-label="關閉世界聊天">×</button></header>
    <nav class="cloud-chat-tabs" role="tablist" aria-label="聊天與線上玩家">
      <button type="button" role="tab" id="chat-tab-players" data-pane="players" aria-controls="chat-pane-players">玩家聊天</button>
      <button type="button" role="tab" id="chat-tab-npc" data-pane="npc" aria-controls="chat-pane-npc">NPC 對話</button>
      <button type="button" role="tab" id="chat-tab-online" data-pane="online" aria-controls="chat-pane-online">線上玩家</button>
    </nav>
    <div id="chat-pane-players" class="cloud-chat-pane" role="tabpanel" aria-labelledby="chat-tab-players">
      <p class="cloud-chat-note">與各地冒險者交流，分享旅途中的見聞。</p>
      <div class="cloud-messages" aria-live="polite" tabindex="0" aria-label="玩家聊天紀錄"></div>
      <form><input aria-label="聊天訊息" maxlength="500" placeholder="和其他冒險者說點什麼…" required><button type="submit">送出</button></form>
    </div>
    <div id="chat-pane-npc" class="cloud-chat-pane" role="tabpanel" aria-labelledby="chat-tab-npc" hidden>
      <p class="cloud-chat-note">遊戲內 NPC 的對話與服務，集中顯示在這裡。</p>
    </div>
    <div id="chat-pane-online" class="cloud-chat-pane" role="tabpanel" aria-labelledby="chat-tab-online" hidden>
      <div class="cloud-online-summary"><strong data-count>查詢中…</strong><button type="button" data-refresh>更新</button></div>
      <p class="cloud-online-note">每 10 秒更新；離線帳號最多約 45 秒後移出名單。</p>
      <div class="cloud-player-list" aria-live="polite"></div>
    </div>
    <p class="cloud-chat-error" role="status"></p>`;
  document.body.append(chat);
  const npc = document.getElementById('syslog-panel');
  if (npc) {
    chat.querySelector('#chat-pane-npc').append(npc);
    const input = npc.querySelector('#world-input');
    if (input) { input.placeholder = '向 NPC 詢問攻略、裝備…';input.setAttribute('aria-label', 'NPC 提問'); }
  }
  const buttons = [...chat.querySelectorAll('[data-pane]')];
  const opener = toolbar.querySelector('[data-chat]'), onlineButton = toolbar.querySelector('[data-online]');
  const list = chat.querySelector('.cloud-messages'), errorBox = chat.querySelector('.cloud-chat-error');
  let pane = 'players', lastChatId = '', worldBusy = false, presenceBusy = false, follow = true;
  function select(next) {
    pane = next;errorBox.textContent = '';
    for (const button of buttons) {
      const selected = button.dataset.pane === next;
      button.setAttribute('aria-selected', String(selected));button.tabIndex = selected ? 0 : -1;
      chat.querySelector('#' + button.getAttribute('aria-controls')).hidden = !selected;
    }
    if (next === 'players') { if (follow) list.scrollTop = list.scrollHeight;void refresh(); }
    if (next === 'npc') window.worldLogToBottom?.();
    if (next === 'online') void presence();
  }
  function open(next) {
    chat.hidden = false;opener.setAttribute('aria-expanded', 'true');onlineButton.setAttribute('aria-expanded', 'true');
    select(next);
  }
  function close() {
    chat.hidden = true;opener.setAttribute('aria-expanded', 'false');onlineButton.setAttribute('aria-expanded', 'false');
  }
  opener.onclick = () => !chat.hidden && pane === 'players' ? close() : open('players');
  onlineButton.onclick = () => !chat.hidden && pane === 'online' ? close() : open('online');
  chat.querySelector('[data-close]').onclick = close;
  for (const button of buttons) {
    button.onclick = () => select(button.dataset.pane);
    button.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (buttons.indexOf(button) + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      select(buttons[index].dataset.pane);buttons[index].focus();
    };
  }
  list.addEventListener('scroll', () => { follow = list.scrollHeight - list.scrollTop - list.clientHeight < 48; });
  async function presence() {
    if (isStopped() || presenceBusy || document.hidden) return;
    presenceBusy = true;
    try {
      const data = await cloud.request('/api/online');
      onlineButton.textContent = `線上 ${data.total}`;
      onlineButton.title = `目前在線 ${data.total} 人`;
      chat.querySelector('[data-count]').textContent = `在線 ${data.total} 人`;
      const target = chat.querySelector('.cloud-player-list');target.replaceChildren();
      for (const player of data.list) {
        const row = document.createElement('div'), name = document.createElement('strong'), map = document.createElement('small');
        row.className = 'cloud-player';name.textContent = player.name;map.textContent = player.map;
        row.append(name);
        row.append(map);target.append(row);
      }
      if (!data.list.length) target.textContent = '目前沒有在線角色。';
      if (pane === 'online') errorBox.textContent = '';
    } catch (error) {
      onlineButton.textContent = '線上 —';onlineButton.title = '暫時無法取得線上人數';
      if (!chat.hidden && pane === 'online') errorBox.textContent = error.message;
    } finally { presenceBusy = false; }
  }
  async function refresh() {
    if (chat.hidden || pane !== 'players' || isStopped() || worldBusy || document.hidden) return;
    worldBusy = true;
    try {
      const data = await cloud.request('/api/world');
      const messages=[...data.messages.map(m=>({...m,rowId:'chat:'+m.id})),...(data.lootBroadcasts||[]).map(m=>({...m,rowId:'loot:'+m.id,loot:true}))].sort((a,b)=>a.at-b.at||a.rowId.localeCompare(b.rowId)).slice(-160);
      const last = messages.map(m=>m.rowId).join('|');
      if (last === lastChatId) return;
      const previousTop = list.scrollTop, previousHeight = list.scrollHeight;
      const droppedFirst = list.firstElementChild && !messages.some(m => m.rowId === list.firstElementChild.dataset.id);
      lastChatId = last;list.replaceChildren();
      for (const m of messages) {
        const line = document.createElement('p'), name = document.createElement('strong'), time = document.createElement('small');
        line.dataset.id = m.rowId;
        if(m.loot){
          line.className='cloud-loot-message loot-name-'+(GameLootRarity.types.includes(m.rarity)?m.rarity:'rare');
          name.textContent='稀有掉落　';line.append(name,document.createTextNode(GameLootRarity.message(m)));list.append(line);continue;
        }
        name.textContent = (m.displayName || m.username) + '　';name.title = m.displayName || m.username;
        time.textContent = new Date(m.at).toLocaleTimeString('zh-TW');line.append(time);
        line.append(name, document.createTextNode(m.text));list.append(line);
      }
      list.scrollTop = follow ? list.scrollHeight : droppedFirst ? Math.max(0, previousTop + list.scrollHeight - previousHeight) : previousTop;
      errorBox.textContent = '';
    } catch (error) { errorBox.textContent = error.message; }
    finally { worldBusy = false; }
  }
  chat.querySelector('[data-refresh]').onclick = presence;
  chat.querySelector('form').onsubmit = async event => {
    event.preventDefault();const input = chat.querySelector('form input'), submit = chat.querySelector('form button');
    if (submit.disabled) return;submit.disabled = true;
    try { await cloud.request('/api/chat', {text: input.value});input.value = '';follow = true;errorBox.textContent = '';await refresh(); }
    catch (error) { errorBox.textContent = error.message; }
    finally { submit.disabled = false; }
  };
  select('players');void presence();
  setInterval(presence, 10000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void presence(); });
  return {refresh};
}
