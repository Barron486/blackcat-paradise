import './status.js';
import {startSquadWindow} from './squad-window.js';
// Phone navigation changes presentation only; the original game keeps running.
const game = document.getElementById('game-screen');
const toolbar = document.getElementById('cloud-toolbar');
const phone = matchMedia('(max-width: 1024px), (max-height: 520px) and (pointer: coarse)');

if (game && toolbar) {
  // The account controls and map selector share a normal-flow panel while playing.
  const mapControls=document.createElement('section');mapControls.id='adventure-controls';mapControls.className='panel';mapControls.setAttribute('aria-label','冒險地圖與帳號');
  const mapHeader=document.querySelector('#map-view-panel > .panel-header');
  mapControls.append(mapHeader);
  function placeControls(){
    if(phone.matches)document.getElementById('col-center').before(mapControls);
    else document.getElementById('col-left').prepend(mapControls);
    const playing=!game.classList.contains('hidden');
    if(playing)mapControls.append(toolbar);else document.body.append(toolbar);
    toolbar.classList.toggle('cloud-integrated',playing);
    reserveDockSpace();
  }
  function reserveDockSpace() {
    if(toolbar.classList.contains('cloud-integrated')){document.documentElement.style.setProperty('--cloud-dock-space','0px');return;}
    const bottom=Math.max(0,parseFloat(getComputedStyle(toolbar).bottom)||0);
    document.documentElement.style.setProperty('--cloud-dock-space', `${Math.ceil(toolbar.getBoundingClientRect().height+bottom+8)}px`);
  }
  new ResizeObserver(reserveDockSpace).observe(toolbar);
  window.addEventListener('resize',reserveDockSpace);
  new MutationObserver(placeControls).observe(game,{attributes:true,attributeFilter:['class']});
  phone.addEventListener('change',placeControls);placeControls();
  startSquadWindow(game);
  const nav = document.createElement('nav');
  nav.id = 'mobile-game-nav';
  nav.setAttribute('aria-label', '遊戲分區');
  const views = [['adventure', '冒險'], ['character', '角色'], ['bag', '背包'], ['status', '狀態'], ['logs', '日誌']];
  function selectView(view) {
    game.dataset.mobileView = view;
    for (const button of nav.children) button.setAttribute('aria-pressed', String(button.dataset.view === view));
    if (view === 'character' || view === 'bag' || view === 'status') {
      const tab = view === 'character' ? 'stats' : view === 'status' ? 'status' : 'items';
      const button = game.querySelector(`.tab-bar button[onclick*="switchTab('${tab}'"]`);
      if (button) button.click();
    }
    game.scrollTo({top: 0, behavior: 'instant'});
    followAdventureLogs();
  }
  for (const [view, label] of views) {
    const button = document.createElement('button');
    button.type = 'button';button.textContent = label;button.dataset.view = view;
    button.setAttribute('aria-pressed', String(view === 'adventure'));
    button.onclick = () => selectView(view);
    nav.append(button);
  }
  game.dataset.mobileView = 'adventure';
  document.getElementById('mobile-vitals').after(nav);
  document.body.classList.add('mobile-ui-ready');

  // Show the original live logs together; their history, filters and scroll locks stay shared.
  const logPanel = document.getElementById('combat-log-panel');
  const liveHeader = document.createElement('header');
  liveHeader.id = 'mobile-live-log-header';
  const liveTitle = document.createElement('strong');
  liveTitle.textContent = '即時日誌';
  const fullLogs = document.createElement('button');
  fullLogs.type = 'button';fullLogs.textContent = '完整日誌 ›';
  fullLogs.onclick = () => selectView('logs');
  liveHeader.append(liveTitle, fullLogs);
  logPanel.prepend(liveHeader);
  for (const [id, label] of [['combat-log', '戰鬥傷害'], ['sys-log', '掉寶 / 系統']]) {
    const heading = document.createElement('h3');
    heading.id = `mobile-${id}-heading`;
    heading.className = 'mobile-live-log-heading';
    heading.textContent = label;
    const log = document.getElementById(id);
    log.before(heading);
    log.setAttribute('aria-label', label);
    log.setAttribute('tabindex', '0');
  }
  function followAdventureLogs() {
    if (!phone.matches || game.dataset.mobileView !== 'adventure' || game.classList.contains('hidden')) return;
    requestAnimationFrame(() => {
      window.combatLogToBottom?.();
      window.sysLogToBottom?.();
    });
  }
  let wasGameHidden=game.classList.contains('hidden');
  new MutationObserver(()=>{
    const hidden=game.classList.contains('hidden');
    if(wasGameHidden&&!hidden)followAdventureLogs();
    wasGameHidden=hidden;
  }).observe(game, {attributes: true, attributeFilter: ['class']});
  followAdventureLogs();

  // Reuse the visible NPC actions so small map labels are never the only touch target.
  const townMap = document.getElementById('town-npc-map');
  const npcList = document.createElement('nav');
  npcList.id = 'mobile-npc-list';npcList.setAttribute('aria-label', '村莊服務');
  document.getElementById('town-view').after(npcList);
  function refreshNpcShortcuts() {
    npcList.replaceChildren();
    for (const npc of townMap.querySelectorAll('.town-npc')) {
      const button = document.createElement('button');button.type = 'button';
      button.textContent = [npc.querySelector('.tn-name')?.textContent, npc.querySelector('.tn-title')?.textContent].filter(Boolean).join(' · ');
      if (!button.textContent) continue;
      button.onclick = () => npc.click();npcList.append(button);
    }
  }
  new MutationObserver(refreshNpcShortcuts).observe(townMap, {childList: true});
  refreshNpcShortcuts();

  const more = toolbar.querySelector('[data-more]');
  const chat = document.getElementById('cloud-chat');
  const chatButton = toolbar.querySelector('[data-chat]');
  function closeMenu() { toolbar.classList.remove('menu-open');more.setAttribute('aria-expanded', 'false'); }
  more.onclick = () => { const open = toolbar.classList.toggle('menu-open');more.setAttribute('aria-expanded', String(open)); };
  document.addEventListener('click', event => { if (!toolbar.contains(event.target) || event.target.closest('#cloud-actions button, #cloud-actions a')) closeMenu(); });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    closeMenu();
    if (!chat.hidden) { chat.querySelector('[data-close]').click();chatButton.focus(); }
  });
  new MutationObserver(() => {
    chatButton.setAttribute('aria-expanded', String(!chat.hidden));
    if (!chat.hidden) closeMenu();
  }).observe(chat, {attributes: true, attributeFilter: ['hidden']});

  // Follow the visible viewport when the phone keyboard opens, without disabling pinch zoom.
  function fitVisibleViewport() {
    const vp = window.visualViewport;
    if (!phone.matches || !vp || vp.scale > 1.05) {
      document.documentElement.style.removeProperty('--phone-visible-height');
      document.documentElement.style.removeProperty('--phone-visible-top');
      return;
    }
    document.documentElement.style.setProperty('--phone-visible-height', `${vp.height}px`);
    document.documentElement.style.setProperty('--phone-visible-top', `${vp.offsetTop}px`);
  }
  window.visualViewport?.addEventListener('resize', fitVisibleViewport);
  window.visualViewport?.addEventListener('scroll', fitVisibleViewport);
  phone.addEventListener('change', () => { closeMenu();fitVisibleViewport();followAdventureLogs(); });
  fitVisibleViewport();
}
