const cloud=window.CloudStore;
if(cloud)startPandoraMarket(cloud);
export function startPandoraMarket(cloud){
  let opening=false,busy=false,generation=0;
  const panel=document.getElementById('town-interaction-container'),content=document.getElementById('interaction-content');
  const visible=()=>!panel.classList.contains('hidden')&&!!content.querySelector('#pandora-msg');
  const message=(text,error=false)=>{const el=content.querySelector('#pandora-msg');if(el){el.textContent=text;el.style.color=error?'#fca5a5':'#86efac';el.setAttribute('role','status');}};
  const offer=s=>JSON.stringify([s.id,s.price,s.bless===true,s.setTick]);
  function render(){
    pandoraTipHide();
    pandoraRenderMarket(content);
    // Capture the displayed offer. Background snapshots can replace player before
    // a click; an old card must never silently purchase its replacement.
    for(const [index,card]of [...content.querySelectorAll('.pandora-market-card')].entries()){
      const item=player.pandoraMarket2.slots[index],button=card.querySelector('button'),token=offer(item);
      button.removeAttribute('onclick');button.disabled=busy||item.sold||player.gold<item.price;
      button.onclick=()=>void buy(index,token);
    }
    const refresh=document.createElement('button');refresh.type='button';refresh.className='btn shrink-0';refresh.textContent='重新整理黑市';refresh.disabled=busy;
    refresh.onclick=()=>void update();content.querySelector('.pandora-market-title').after(refresh);
  }
  async function update(){
    if(busy)return;busy=true;const current=++generation;render();
    let note='商品已更新。',failed=false;
    try{await cloud.action('black-market',{operation:'view'});}
    catch(error){note=error.message;failed=true;}
    finally{busy=false;if(current===generation&&visible()){render();message(note,failed);}}
  }
  async function buy(index,token){
    if(busy)return;busy=true;const current=++generation;render();
    let note='',failed=false;
    try{await cloud.action('black-market',{operation:'buy',index,offer:token});note='購買成功，已存入角色資料。';}
    catch(error){note=error.message;failed=true;}
    finally{busy=false;if(current===generation&&visible()){render();message(note,failed);}}
  }
  cloud.showBlackMarket=async()=>{
    if(opening||busy)return;opening=true;
    const slot=currentSlot,epoch=player._roleEpoch;
    try{
      await cloud.action('black-market',{operation:'view'});
      if(currentSlot!==slot||player._roleEpoch!==epoch||document.getElementById('game-screen').classList.contains('hidden'))return;
      _activePanel=null;
      document.body.append(panel);panel.classList.remove('hidden');panel.classList.add('flex');
      document.getElementById('interaction-npc-name').textContent='潘朵拉';document.getElementById('interaction-npc-title').textContent='[黑市]';render();
    }catch(error){if(typeof logSys==='function')logSys(String(error.message).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])));}
    finally{opening=false;}
  };
}
