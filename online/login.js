'use strict';
let mode='login', setupAvailable=false;
const form=document.getElementById('auth-form'),error=document.getElementById('auth-error');
if(new URLSearchParams(location.search).has('passwordChanged'))document.getElementById('auth-description').textContent='密碼已變更，請使用新密碼重新登入。';
function setMode(next){
  mode=next;error.textContent='';
  document.getElementById('auth-title').textContent=mode==='setup'?'建立首位 GM':mode==='register'?'建立冒險帳號':'登入遊戲';
  document.getElementById('auth-description').textContent=mode==='setup'?'這個帳號可以管理玩家及執行全體指令。設定完成後，此入口自動關閉。':mode==='register'?'選擇帳號和密碼，角色進度會儲存在伺服器。':'使用帳號載入你的雲端角色與存檔。';
  document.getElementById('repeat-wrap').hidden=mode==='login';form.elements.repeat.required=mode!=='login';
  form.elements.password.autocomplete=mode==='login'?'current-password':'new-password';
  document.getElementById('auth-submit').textContent=mode==='setup'?'建立 GM 並進入控制台 →':mode==='register'?'建立帳號 →':'登入遊戲 →';
  document.getElementById('auth-toggle').textContent=mode==='login'?'還沒有帳號？建立新帳號':'已有帳號？返回登入';
}
document.getElementById('auth-toggle').onclick=()=>setMode(mode==='login'?'register':'login');
document.getElementById('setup-link').onclick=()=>setMode('setup');
fetch('/api/auth/config').then(r=>r.json()).then(config=>{setupAvailable=config.setupAvailable;document.getElementById('setup-link').hidden=!setupAvailable;if(setupAvailable&&location.pathname==='/setup')setMode('setup');}).catch(()=>{error.textContent='無法連線伺服器，請稍後再試。';});
form.onsubmit=async event=>{
  event.preventDefault();error.textContent='';
  if(mode!=='login'&&form.elements.password.value!==form.elements.repeat.value){error.textContent='兩次輸入的密碼不同';return;}
  const submit=document.getElementById('auth-submit');submit.disabled=true;
  try{
    const response=await fetch('/api/auth/'+mode,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:form.elements.username.value.trim(),password:form.elements.password.value})});
    const data=await response.json();if(!response.ok)throw new Error(data.error);
    location.href=mode==='setup'?'/gm':'/';
  }catch(e){error.textContent=e.message||'無法連線伺服器';}finally{submit.disabled=false;}
};
