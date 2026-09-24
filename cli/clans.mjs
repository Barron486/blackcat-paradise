import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './profiles.mjs';

const file = new URL('../data/cli/clans.json', import.meta.url);
const path = fileURLToPath(file);
function read() { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return { clans: [] }; } }
function save(value) { writeJsonAtomic(path, value); return value; }
export function clans() { return read().clans; }
export function createClan(name, leader) {
  if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 24) throw new Error('血盟名稱須為 2～24 字');
  const state = read(); if (state.clans.some(c => c.name === name.trim())) throw new Error('血盟名稱已存在');
  const clan = { id: randomUUID(), name: name.trim(), leader, members: [leader], createdAt: Date.now() };
  state.clans.push(clan); save(state); return clan;
}
export function joinClan(id, profile) {
  const state = read(), clan = state.clans.find(c => c.id === id); if (!clan) throw new Error('找不到血盟');
  if (state.clans.some(c => c.members.includes(profile))) throw new Error('角色已加入其他血盟');
  clan.members.push(profile); save(state); return clan;
}
