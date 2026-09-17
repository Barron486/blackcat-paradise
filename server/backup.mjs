import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { databasePath } from './config.mjs';

const source = databasePath();
if (!existsSync(source)) throw new Error('找不到遊戲資料庫');
const stamp = new Date().toISOString().replace(/[:.]/g,'-');
const destination = path.resolve(process.argv[2] || path.join(path.dirname(source),'backups',`game-${stamp}.sqlite`));
if (existsSync(destination)) throw new Error('備份目的檔已存在，請使用新的檔名');
mkdirSync(path.dirname(destination), {recursive:true});
const db = new DatabaseSync(source, {readOnly:true});
try { await backup(db,destination); console.log(`備份完成：${destination}`); }
finally { db.close(); }
