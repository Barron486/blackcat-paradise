import {collectStatuses, formatRemaining} from '/shared/status-view.js';

const panel = document.getElementById('tab-status');
if (panel) {
  panel.innerHTML = `<header class="effects-heading"><div><h2>目前狀態</h2><p>能力效果與剩餘時間</p></div><span id="effects-count">0 個</span></header>
    <div class="effects-tools"><label for="effects-search">搜尋狀態</label><input id="effects-search" type="search" placeholder="搜尋名稱或能力效果" autocomplete="off">
    <div class="effects-filters" role="group" aria-label="狀態分類"><button type="button" data-kind="all" aria-pressed="true">全部</button><button type="button" data-kind="buff" aria-pressed="false">增益</button><button type="button" data-kind="debuff" aria-pressed="false">異常</button><button type="button" data-kind="permanent" aria-pressed="false">常駐</button></div></div>
    <p class="effects-note">倒數隨遊戲更新；GM 狀態依伺服器時間到期。常駐效果隨裝備條件解除。</p>
    <div id="effects-list" role="list" aria-label="目前生效的狀態"></div><p id="effects-empty">目前沒有生效中的狀態。</p>`;
  const list = panel.querySelector('#effects-list'), empty = panel.querySelector('#effects-empty');
  const search = panel.querySelector('#effects-search'), count = panel.querySelector('#effects-count');
  const cards = new Map();
  let kind = 'all';
  function update() {
    if (document.hidden || panel.classList.contains('hidden')) return;
    const current = typeof player !== 'undefined' ? player : null;
    const form = current?._setPoly || (current?.buffs?.poly > 0 ? current.poly : null);
    const rows = collectStatuses(current, {
      skills: typeof DB !== 'undefined' ? DB.skills : {},
      lures: typeof PET_LURES !== 'undefined' ? PET_LURES : {},
      auraIds: typeof TEAM_AURA_SKILLS !== 'undefined' ? [...TEAM_AURA_SKILLS, 'sk_royal_precise'] : [],
      icons: typeof STATUS_ICON_SKILLS !== 'undefined' ? STATUS_ICON_SKILLS : {},
      debuffIcons: typeof PLAYER_DEBUFF_ICON !== 'undefined' ? PLAYER_DEBUFF_ICON : {},
      now: window.CloudStore?.serverNow?.() ?? Date.now(),
      ticks: typeof state !== 'undefined' ? state.ticks : 0,
      polyDescription: form && typeof polyFormDesc === 'function' ? polyFormDesc(form) : '',
    });
    const query = search.value.trim().toLocaleLowerCase();
    const visible = rows.filter(row => (kind === 'all' || row.kind === kind) && `${row.name} ${row.description} ${row.source}`.toLocaleLowerCase().includes(query));
    count.textContent = `${rows.length} 個`;
    empty.hidden = visible.length > 0;
    empty.textContent = rows.length ? '沒有符合的狀態，試試其他關鍵字或分類。' : '目前沒有生效中的狀態。';
    const ids = new Set(visible.map(row => row.id));
    for (const [id, card] of cards) if (!ids.has(id)) { card.remove();cards.delete(id); }
    for (const row of visible) {
      let card = cards.get(row.id);
      if (!card) {
        card = document.createElement('article');card.className = 'effect-card';card.setAttribute('role', 'listitem');
        card.innerHTML = '<div class="effect-title"><span class="effect-symbol" aria-hidden="true"></span><h3></h3><span class="effect-kind"></span></div><p class="effect-description"></p><footer><span class="effect-source"></span><span class="effect-time"></span></footer>';
        if (row.icon) {
          const img = document.createElement('img');img.src = `/assets/state-icons/${encodeURIComponent(row.icon)}.jpg`;img.alt = '';img.loading = 'lazy';
          img.onerror = () => img.remove();card.querySelector('.effect-symbol').append(img);
        }
        cards.set(row.id, card);list.append(card);
      }
      card.dataset.kind = row.kind;
      // Keep card/image nodes stable as timers change, preserving scrolling and avoiding flashing.
      const set = (selector, value) => { const node = card.querySelector(selector);if (node.textContent !== value) node.textContent = value; };
      set('h3', row.name);set('.effect-description', row.description);
      set('.effect-kind', {buff:'增益',debuff:'異常',permanent:'常駐'}[row.kind]);
      set('.effect-source', row.source);set('.effect-time', row.seconds === null ? '常駐 · 條件解除時結束' : `剩餘 ${formatRemaining(row.seconds)}`);
      card.classList.toggle('expiring', row.seconds !== null && row.seconds <= 10);
    }
    // Reorder only when effects are added or removed, leaving existing DOM untouched otherwise.
    visible.forEach((row, i) => { const card = cards.get(row.id);if (list.children[i] !== card) list.insertBefore(card, list.children[i] || null); });
  }
  search.addEventListener('input', update);
  panel.querySelector('.effects-filters').addEventListener('click', event => {
    const button = event.target.closest('[data-kind]');if (!button) return;
    kind = button.dataset.kind;
    for (const b of button.parentElement.children) b.setAttribute('aria-pressed', String(b === button));
    update();
  });
  new MutationObserver(update).observe(panel, {attributes:true, attributeFilter:['class']});
  document.addEventListener('visibilitychange', update);
  setInterval(update, 500);
  document.body.classList.add('status-tab-ready');
  update();
}
