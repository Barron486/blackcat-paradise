(function () {
  'use strict';
  const el=document.getElementById('cloud-boot');
  if(!el)return;
  const boot=JSON.parse(el.textContent);el.remove();
  let values=Object.assign(Object.create(null),boot.values),dirty=Object.create(null);
  const supported=key=>/^(lineage_|fb5_)[\w:-]{1,170}$/.test(key);
  window.CloudStore={
    boot, revision:boot.revision, lease:crypto.randomUUID(), ready:false,
    get(key){return supported(key)?values[key]??null:localStorage.getItem(key);},
    set(key,value){
      if(!supported(key)){localStorage.setItem(key,String(value));return true;}
      value=String(value);if(values[key]===value)return true;
      values[key]=value;dirty[key]=value;return true;
    },
    remove(key){if(!supported(key)){localStorage.removeItem(key);return;}delete values[key];dirty[key]=null;},
    pending(){return {...dirty};},
    ack(sent,revision){for(const [key,value] of Object.entries(sent))if(dirty[key]===value)delete dirty[key];this.revision=revision;},
    rebase(snapshot){
      values=Object.assign(Object.create(null),snapshot.values);
      for(const [key,value]of Object.entries(dirty)){if(value===null)delete values[key];else values[key]=value;}
      this.revision=snapshot.revision;
    },
    reset(snapshot){ values=Object.assign(Object.create(null),snapshot.values);dirty=Object.create(null);this.revision=snapshot.revision; },
    async request(url,body,{signal}={}){
      const controller=new AbortController(),cancel=()=>controller.abort(signal.reason);
      if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
      const timeout=setTimeout(()=>controller.abort(new DOMException('伺服器連線逾時，請稍後重試','TimeoutError')),15000);
      try{
      const response=await fetch(url,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',
        headers:body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':boot.csrf},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});
      const data=await response.json();if(!response.ok){const error=new Error(data.error||'伺服器連線失敗');error.status=response.status;error.data=data;throw error;}return data;
      }finally{clearTimeout(timeout);signal?.removeEventListener('abort',cancel);}
    }
  };
})();
