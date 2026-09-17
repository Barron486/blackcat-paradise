import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { GameService } from './service.mjs';
import { databasePath } from './config.mjs';
import { randomBytes } from 'node:crypto';

const rl=createInterface({input:stdin,output:stdout});
const service=new GameService(databasePath(),{});
try {
  const username=process.argv[2]||await rl.question('GM 帳號（3～24 個英數字或底線）：');
  const password=randomBytes(18).toString('base64url');
  const user=await service.register(username,password);
  service.transaction(()=>{
    service.db.prepare("UPDATE accounts SET role='gm' WHERE id=?").run(user.id);
    service.db.prepare('INSERT INTO role_audit(actor_id,account_id,role,created_at) VALUES(?,?,?,?)').run('server-console',user.id,'gm',Date.now());
  });
  console.log(`GM 已建立：${username}\n一次性顯示初始密碼：${password}\n請妥善保存；伺服器只儲存密碼雜湊。`);
}finally{rl.close();service.close();}
