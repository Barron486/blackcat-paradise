// Isolated browser QA: no connection to the real data directory.
import { createApp } from '../server/index.mjs';
const {server,service}=createApp({database:':memory:',publicOrigin:''});
await service.register('qa_admin','local-qa-only-2026!',{initialGm:true});
await service.register('qa_player','local-qa-only-2026!');
server.listen(8790,'127.0.0.1',()=>console.log('隔離測試：http://localhost:8790/login'));
process.on('SIGINT',()=>server.close());process.on('SIGTERM',()=>server.close());
