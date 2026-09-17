import { GameService } from './service.mjs';
import { databasePath } from './config.mjs';

const username = process.argv[2];
if (!username) throw new Error('用法：node server/promote-gm.mjs 已註冊的帳號');
const service = new GameService(databasePath(), {});
try {
  service.transaction(() => {
    const account = service.db.prepare('SELECT id,username FROM accounts WHERE username=? COLLATE NOCASE').get(username);
    if (!account) throw new Error('帳號不存在，請先在遊戲登入頁註冊帳號');
    service.db.prepare("UPDATE accounts SET role='gm' WHERE id=?").run(account.id);
    service.db.prepare('INSERT INTO role_audit(actor_id,account_id,role,created_at) VALUES(?,?,?,?)').run('server-console',account.id,'gm',Date.now());
    console.log(`${account.username} 已取得 GM 權限。重新整理 /gm 即可使用。`);
  });
} finally { service.close(); }
