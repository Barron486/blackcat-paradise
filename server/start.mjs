import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Restart only the game process after its own confirmed, fully flushed exit.
// Crashes still propagate to Railway's restart policy instead of looping forever.
let child,stopping=false,relaunch,deadline;
function launch(){
  child=spawn(process.execPath,[fileURLToPath(new URL('./index.mjs',import.meta.url))],{stdio:['inherit','inherit','inherit','ipc'],env:{...process.env,BLACKCAT_SUPERVISED:'1'}});
  child.on('error',error=>{console.error('[supervisor]',error.message);process.exitCode=1;});
  child.on('exit',(code,signal)=>{
    clearTimeout(deadline);
    if(!stopping&&code===75){console.log('[supervisor] 已保存進度，重新啟動遊戲服務');relaunch=setTimeout(launch,500);}
    else process.exitCode=stopping?0:(code||signal?code||1:0);
  });
}
function stop(){if(stopping)return;stopping=true;clearTimeout(relaunch);if(child?.exitCode===null){if(child.connected)child.send('shutdown',()=>{});else child.kill('SIGTERM');deadline=setTimeout(()=>child.kill('SIGKILL'),25000);deadline.unref();}}
process.on('SIGTERM',()=>stop('SIGTERM'));process.on('SIGINT',()=>stop('SIGINT'));launch();
if(typeof process.send==='function')process.on('message',message=>{if(message==='shutdown'){stop();process.disconnect();}});
