// Move the existing live panel instead of copying it: inputs and server updates
// keep their original IDs, event handlers and focus.
export function startSquadWindow(game) {
  const panel=document.getElementById('squad-panel');
  if(!game||!panel||document.getElementById('squad-window'))return;
  const key='blackcat.squad-window.'+(window.CloudStore?.boot?.user?.id||'local');
  let stored;try{stored=JSON.parse(localStorage.getItem(key)||'{}');}catch{}
  const prefs={simple:stored?.simple===true,collapsed:stored?.collapsed===true,
    x:Number.isFinite(stored?.x)?stored.x:null,y:Number.isFinite(stored?.y)?stored.y:null};
  const shell=document.createElement('section');shell.id='squad-window';shell.hidden=true;
  shell.setAttribute('role','dialog');shell.setAttribute('aria-modal','false');shell.setAttribute('aria-labelledby','squad-window-title');
  shell.innerHTML='<header class="squad-window-header"><button type="button" data-squad-drag aria-label="移動隊伍與夥伴視窗" title="拖曳移動；方向鍵微調，Home 重設位置"><strong id="squad-window-title">隊伍與夥伴</strong><small>拖曳移動</small></button><button type="button" data-squad-mode></button><button type="button" data-squad-collapse aria-controls="squad-panel"></button></header>';
  const handle=shell.querySelector('[data-squad-drag]'),mode=shell.querySelector('[data-squad-mode]'),collapse=shell.querySelector('[data-squad-collapse]');
  shell.append(panel);game.append(shell);
  let drag=null,fullTab='team';
  const save=()=>{try{localStorage.setItem(key,JSON.stringify(prefs));}catch{}};
  function fit(){
    if(shell.hidden)return;
    const vp=window.visualViewport,left=vp?.offsetLeft||0,top=vp?.offsetTop||0,width=vp?.width||innerWidth,height=vp?.height||innerHeight;
    shell.style.width=Math.max(0,Math.min(prefs.collapsed?218:prefs.simple?300:380,width-16))+'px';
    shell.style.maxHeight=Math.max(48,height-16)+'px';
    const box=shell.getBoundingClientRect();
    const x=Math.max(left+8,Math.min(prefs.x??left+width-box.width-12,left+width-box.width-8));
    const y=Math.max(top+8,Math.min(prefs.y??top+Math.min(128,height*.15),top+height-box.height-8));
    shell.style.left=x+'px';shell.style.top=y+'px';
    return {x,y};
  }
  function update(){
    shell.dataset.mode=prefs.simple?'simple':'full';shell.dataset.collapsed=String(prefs.collapsed);
    panel.hidden=prefs.collapsed;
    mode.textContent=prefs.simple?'完整':'簡易';mode.setAttribute('aria-label',prefs.simple?'切換完整模式':'切換簡易模式');mode.setAttribute('aria-pressed',String(prefs.simple));mode.hidden=prefs.collapsed;
    collapse.textContent=prefs.collapsed?'展開':'收起';collapse.setAttribute('aria-expanded',String(!prefs.collapsed));
    collapse.setAttribute('aria-label',prefs.collapsed?'展開隊伍與夥伴':'收起隊伍與夥伴');
    if(prefs.simple)window.switchSquadTab?.('team');
    syncVisibility();
  }
  function syncVisibility(){
    shell.hidden=game.classList.contains('hidden')||panel.style.display==='none';
    fit();
  }
  mode.onclick=()=>{
    if(!prefs.simple)fullTab=document.getElementById('squad-tab-skill').classList.contains('hidden')?'team':'skill';
    prefs.simple=!prefs.simple;update();if(!prefs.simple)window.switchSquadTab?.(fullTab);save();
  };
  collapse.onclick=()=>{prefs.collapsed=!prefs.collapsed;update();save();};
  shell.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&!prefs.collapsed){event.preventDefault();event.stopPropagation();prefs.collapsed=true;update();save();collapse.focus();}
  });
  handle.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();
    if(event.key==='Home'){prefs.x=prefs.y=null;}else{
      const box=shell.getBoundingClientRect(),step=event.shiftKey?40:10;
      prefs.x=box.left+(event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0);
      prefs.y=box.top+(event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0);
    }
    fit();save();
  });
  handle.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;
    const box=shell.getBoundingClientRect();drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:box.left,top:box.top};
    handle.focus({preventScroll:true});handle.setPointerCapture?.(event.pointerId);shell.classList.add('is-dragging');event.preventDefault();
  });
  handle.addEventListener('pointermove',event=>{
    if(!drag||drag.id!==event.pointerId)return;
    prefs.x=drag.left+event.clientX-drag.x;prefs.y=drag.top+event.clientY-drag.y;fit();
  });
  const endDrag=event=>{
    if(!drag||drag.id!==event.pointerId)return;
    Object.assign(prefs,fit());drag=null;shell.classList.remove('is-dragging');save();
  };
  handle.addEventListener('pointerup',endDrag);handle.addEventListener('pointercancel',endDrag);
  handle.addEventListener('lostpointercapture',endDrag);
  new MutationObserver(syncVisibility).observe(panel,{attributes:true,attributeFilter:['style']});
  new MutationObserver(syncVisibility).observe(game,{attributes:true,attributeFilter:['class']});
  new ResizeObserver(fit).observe(shell);
  window.addEventListener('resize',fit);window.visualViewport?.addEventListener('resize',fit);window.visualViewport?.addEventListener('scroll',fit);
  update();return {shell,fit};
}
