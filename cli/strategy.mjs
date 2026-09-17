// Decisions only: the engine executes every action through the original game rules.
const points = values => Object.freeze({ str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0, ...values });
const preset = (classId, name, allocation) => Object.freeze({ classId, rawClass: `m_${classId}`, name, points: points(allocation) });

export const CLASS_PRESETS = Object.freeze({
  royal: preset('royal', '代理王族', { str: 5, con: 3 }),
  mage: preset('mage', '代理法師', { int: 6, wis: 6, con: 4 }), // Original mage creation grants 16 points.
  elf: preset('elf', '代理妖精', { dex: 6, con: 2 }),
  knight: preset('knight', '代理騎士', { str: 2, con: 6 }),
});

const MAGIC_MASTERY_SKILLS = new Set(['sk_blizzard', 'sk_tornado', 'sk_quake', 'sk_fire_storm']);
const SUPPLY_NPCS = new Set(['npc_glin', 'npc_basin', 'npc_elpin', 'npc_meyer', 'npc_boni', 'npc_skvati']);
const CONTROL_STATES = ['stone', 'paralyze', 'freeze', 'stun', 'sleep'];
const count = item => item ? Math.max(0, Number(item.cnt ?? 1) || 0) : 0;
const action = (name, args, reason) => ({ name, args, reason });

function selectableMap(maps, target) {
  // HeadlessGame supplies MAP_CATEGORIES; data-only tools may supply DB.maps.
  const direct = maps?.[target];
  return (Object.hasOwn(maps || {}, target) && Array.isArray(direct) && direct.every(entry => typeof entry === 'string'))
    || Object.values(maps || {}).some(group => Array.isArray(group) && group.some(entry => entry?.v === target));
}

// Mirrors skillReqLv for these four classes. Engine useItem remains authoritative.
export function skillRequiredLevel(player, skill, skillId) {
  if (!skill) return undefined;
  if (player.cls === 'royal') {
    if (skill.reqRoy !== undefined) return skill.reqRoy;
    if (skill.reqM !== undefined && skill.tier === 1) return 10;
    if (skill.reqM !== undefined && skill.tier === 2) return 20;
    if (player.mastery === 'k_royal_magic' && skill.reqM !== undefined && [3, 4, 5].includes(skill.tier)) return skill.reqM;
    return undefined;
  }
  if (player.cls === 'mage') return skill.reqM;
  if (player.cls === 'knight') return skill.reqK;
  if (player.cls === 'elf') {
    if (skill.reqE !== undefined) return skill.reqE;
    if (player.mastery === 'e_magic' && MAGIC_MASTERY_SKILLS.has(skillId)) return skill.reqM;
  }
  return undefined;
}

function canLearn(p, skill, skillId) {
  const required = skillRequiredLevel(p, skill, skillId);
  return Number.isFinite(required) && p.lv >= required
    && (!skill.reqEle || skill.reqEle === p.elfEle)
    && (!skill.reqEleAny || Boolean(p.elfEle));
}

function* candidates(snapshot, catalog, options) {
  const p = snapshot?.p;
  const ms = snapshot?.ms;
  if (!p || !ms || !CLASS_PRESETS[p.cls] || !catalog?.items || !catalog.skills) return;
  if (p._gmDead) return;
  if (p.dead) { yield action('revive', {}, '正常死亡，回出生村莊復活'); return; }
  const hp = Number(p.hp), maxHp = Number(p.mhp);
  if (!Number.isFinite(hp) || !(maxHp > 0) || hp <= 0) return;
  const hpRatio = hp / maxHp;
  const statuses = p.statuses || {};
  const controlled = CONTROL_STATES.some(key => Number(statuses[key]) > 0);
  if (Number(p.buffs?.sk_abs_barrier) > 0) return;
  const town = catalog.towns?.[ms.current];
  const isTown = Boolean(town) || String(ms.current).startsWith('town_');
  const inv = (p.inv || []).filter(item => item && count(item) > 0);
  const skills = new Set(p.skills || []);
  const red = inv.find(item => item.id === 'potion_heal');
  const redCount = inv.filter(item => item.id === 'potion_heal').reduce((sum, item) => sum + count(item), 0);
  const gold = Math.max(0, Math.floor(Number(p.gold) || 0));
  const redPrice = Number(catalog.items.potion_heal?.p);
  const usesBow = Boolean(catalog.items[p.eq?.wpn?.id]?.isBow);
  const arrowCount = count(p.eq?.arrow) + inv.reduce((sum, item) => sum + (catalog.items[item.id]?.isArrow ? count(item) : 0), 0);
  const canCast = id => skills.has(id) && canLearn(p, catalog.skills[id], id)
    && !controlled && !(statuses.silence > 0) && !(statuses.magicseal > 0)
    && (p.d?.loadTier || 0) < 2 && Number(p.mp) >= Number(catalog.skills[id]?.mp || 0);

  if (!isTown && hpRatio < 0.35 && !controlled) {
    yield action('return-town', {}, 'HP 低於 35%，返回安全區恢復');
    return;
  }
  if (hpRatio < 0.65 && red && !(p.cds?.pot > 0)) {
    yield action('use', { uid: red.uid }, '使用背包紅色藥水補血');
  }
  if (controlled) return;
  if (!isTown && hpRatio < 0.75 && canCast('sk_heal1') && !(p.cds?.healSk > 0)) {
    yield action('cast', { skillId: 'sk_heal1' }, '使用已學會的初級治癒術');
  }

  for (const item of inv) {
    const definition = catalog.items[item.id];
    if (definition?.type !== 'skillbk' || definition.noUse || skills.has(definition.sk)) continue;
    if (canLearn(p, catalog.skills[definition.sk], definition.sk)) {
      yield action('use', { uid: item.uid }, `學習背包中的${definition.n || item.id}`);
    }
  }

  if (isTown) {
    // These NPCs sell both supplies in the original SHOP_LISTS. Never buy from
    // an arbitrary NPC, and never request catalog-only/drop-only merchandise.
    const supplier = (town?.npcs || []).find(npc => npc.type === 'shop' && SUPPLY_NPCS.has(npc.id));
    if (supplier && usesBow && arrowCount < 100 && gold >= 100 && catalog.items.wpn_5?.isArrow) {
      yield action('shop', { npcId: supplier.id, itemId: 'wpn_5', qty: 1 }, '購買一份 1,000 根普通箭，原價 100 金幣');
    }
    if (supplier && redCount < 20 && Number.isFinite(redPrice) && redPrice > 0) {
      // Buy affordable quantities; upstream auto-buy otherwise requires 100 bottles.
      const qty = Math.min(50 - redCount, Math.floor(gold / redPrice));
      if (qty > 0) yield action('shop', { npcId: supplier.id, itemId: 'potion_heal', qty }, `依現有金幣補充 ${qty} 瓶紅水`);
    }
    if ((usesBow && arrowCount === 0) || redCount === 0) return;
    const target = options.targetMap ?? 'training';
    if (typeof target === 'string' && !target.startsWith('town_') && selectableMap(catalog.maps, target)) {
      yield action('travel', { mapId: target }, `補給就緒，前往${target === 'training' ? '新兵修練場' : target}`);
    }
    return;
  }

  if (usesBow && arrowCount === 0) {
    yield action('return-town', {}, '箭矢耗盡，回村補給');
    return;
  }
  if (redCount < 10 && (gold >= redPrice || redCount === 0)) {
    yield action('return-town', {}, '紅水不足，回村檢查補給');
    return;
  }
  const target = options.targetMap ?? 'training';
  if (typeof target === 'string' && target !== ms.current && !target.startsWith('town_') && selectableMap(catalog.maps, target)) {
    yield action('travel', { mapId: target }, `前往指定狩獵地圖 ${target}`);
  }
  // Keep existing gear. Only a learned basic ward and attack are used here;
  // the original combat loop continues normal attacks and auto-potions.
  if (!(p.buffs?.sk_shield > 0) && canCast('sk_shield') && !(p.cds?.healSk > 0)) {
    yield action('cast', { skillId: 'sk_shield' }, '維持已學會的保護罩');
  }
  if ((ms.mobs || []).some(mob => mob && mob.curHp > 0)
      && p.mmp > 0 && p.mp / p.mmp > 0.5 && canCast('sk_lightarrow') && !(p.cds?.atkSk > 0)) {
    yield action('cast', { skillId: 'sk_lightarrow' }, '魔力充足，使用已學會的光箭');
  }
}

export function chooseAction(snapshot, catalog, options = {}) {
  return candidates(snapshot, catalog, options).next().value ?? null;
}

function actionFingerprint(proposal, snapshot) {
  const p = snapshot.p;
  switch (proposal.name) {
    case 'use': return JSON.stringify([p.inv?.find(item => item.uid === proposal.args.uid), p.skills]);
    case 'shop': return JSON.stringify([p.gold, p.inv?.filter(item => item.id === proposal.args.itemId)]);
    case 'cast': return JSON.stringify([p.mp, p.hp, p.buffs?.[proposal.args.skillId]]);
    case 'revive': return JSON.stringify([p.dead, p._gmDead, snapshot.ms.current]);
    default: return snapshot.ms.current;
  }
}

// One instance per account. If an action made no observable change, wait before
// retrying it; another eligible action may still proceed. This never changes a save.
export function createStrategy(options = {}) {
  const recent = new Map();
  const settings = { ...options };
  const now = options.now || Date.now;
  const retryMs = options.retryMs ?? 30_000;
  return {
    setTarget(mapId) {
      if (typeof mapId !== 'string' || !mapId.trim() || mapId.trim().startsWith('town_')) throw new Error('請指定有效的狩獵地圖');
      settings.targetMap = mapId.trim();
      // A changed destination is a new instruction, so old movement retries no
      // longer apply. Catalog membership is checked when deciding a travel action.
      for (const key of recent.keys()) if (JSON.parse(key)[0] === 'travel') recent.delete(key);
      return settings.targetMap;
    },
    recordResult(proposal, success) {
      if (!proposal || typeof proposal.name !== 'string') return;
      const key = JSON.stringify([proposal.name, proposal.args || {}]);
      if (success) recent.delete(key);
      else recent.set(key, { ...recent.get(key), failed: true, time: now() });
    },
    decide(snapshot, catalog) {
      const time = now();
      for (const proposal of candidates(snapshot, catalog, settings)) {
        const key = JSON.stringify([proposal.name, proposal.args]);
        const fingerprint = actionFingerprint(proposal, snapshot);
        const previous = recent.get(key);
        if (previous && (previous.failed || previous.fingerprint === fingerprint) && time - previous.time < retryMs) continue;
        recent.set(key, { fingerprint, time });
        for (const [oldKey, old] of recent) if (time - old.time > retryMs * 2) recent.delete(oldKey);
        return proposal;
      }
      return null;
    },
  };
}
