import { randomInt } from 'node:crypto';

// Match enhanceCap() and gainItem() in upstream 01-drops-config / 08-items-equip.
export function itemGrantRules(item) {
  const equipment = ['wpn','arm','acc'].includes(item.type) && !item.isArrow;
  return {
    maxEnchant: equipment && !item.noEnhance ? (item.maxEn || {wpn:15,arm:15,acc:5}[item.type]) : 0,
    canBless: equipment && !item.relic,
  };
}

export function rollWishes() {
  const pool = ['hp60','mp30','md3','rd3','mdmg2','sp6','hpr10','mpr5','dr3','ac3','mr6','str1','dex1','int1','wis1','con1','cha1'];
  return Array.from({length:3}, () => pool.splice(randomInt(pool.length),1)[0]);
}
