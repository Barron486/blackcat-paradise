// Read-only presentation of game effects. Buffs use seconds; status/HoT clocks use 0.1s ticks.
const statNames = {ac:'AC 防禦',mr:'MR 魔防',er:'ER 迴避',dr:'傷害減免',str:'力量',dex:'敏捷',con:'體質',int:'智力',wis:'精神',cha:'魅力',extraDmg:'額外傷害',extraHit:'額外命中',magicDmg:'魔法傷害',extraMp:'額外魔法點數',mpR:'MP 恢復',hpR:'HP 恢復',meleeHit:'近距離命中',rangedHit:'遠距離命中',meleeDmg:'近距離傷害',rangedDmg:'遠距離傷害',resFire:'火抗性',resWater:'水抗性',resEarth:'地抗性',resWind:'風抗性'};
const special = {
  sk_sunlight:'怪物出現的等待時間縮短 20%。', sk_load_up:'負重上限 +50。',
  sk_reveal:'看破隱形的敵人。', sk_helm_str2:'看破隱形的敵人。',
  sk_magic_shield:'吸收下一次魔法攻擊，觸發後消失並進入 3 秒施放冷卻。',
  sk_invisible:'尚未受傷的一般怪物不會主動攻擊你；首領不受影響。',
  sk_holy_barrier:'受到的直接攻擊傷害減少 30%。', sk_soul_up:'HP、MP 上限 +20%。',
  sk_abs_barrier:'隔絕傷害；期間無法攻擊、施法、使用道具或自然恢復。',
  sk_counter_barrier:'強化單手劍的反擊與武士刀的居合傷害；部分武器另有專屬加成。',
  sk_elf_singleres:'自身契約屬性的抗性 +50。',
  sk_elf_watervital:'受到瞬間治癒時恢復量加倍；觸發間隔 7 秒，不影響持續治療。',
  sk_elf_earthshield:'免疫一般攻擊傷害。', sk_elf_flamesoul:'近戰一般攻擊使用武器傷害的最大值。',
  sk_elf_preciseshot:'取消一般攻擊的最低 5% 必定失誤，命中率上限提高至 100%。',
  sk_elf_attrfire:'一般攻擊有 30% 機率造成 1.5 倍傷害。',
  sk_elf_mirror:'受到魔法傷害時，以精神值 % 的機率向施法者反射等量傷害。',
  sk_dark_stealth:'閃避一次物理攻擊後消失，並進入 5 秒施放冷卻。',
  sk_dark_poison:'一般攻擊命中時有機率附加持續毒傷；毒傷依該次攻擊與精通決定。',
  sk_dark_poisonres:'受到的中毒傷害減半。', sk_dark_burn:'一般攻擊有 30% 機率造成 1.5 倍傷害。',
  sk_dark_walkhaste:'攻擊速度 +15%。',
  sk_dark_dodge:'有 50% 機率閃避必中傷害魔法；成功後消失並進入 5 秒施放冷卻。',
  sk_dark_double:'使用雙刀或鋼爪時，有機率造成雙倍傷害；機率隨等級提升。',
  sk_dragon_flameslash:'下一次近戰一般攻擊額外傷害 +7，並轉為火屬性；觸發後消失。',
  sk_dragon_bloodlust:'攻擊速度 +15%。', sk_dragon_deadlybody:'受到直接攻擊時有 23% 機率反射等量傷害。',
  sk_warrior_outlaw:'一般攻擊的命中率下限提高至 50%。',
  sk_set_dragonscion:'受到的直接攻擊傷害減少 15%。',
  sk_charm:'被迷魅的怪物協助戰鬥，怪物消失時效果結束。',
};
const basics = {
  haste:['加速','攻擊速度 +33%；與同類加速效果不重複計算。'],
  brave:['勇敢藥水','攻擊速度 +33%。'], blue:['藍色藥水','依目前精神值提升 MP 恢復。'],
  cautious:['慎重藥水','魔法傷害 +2、MP 恢復 +2。'], elfcookie:['精靈餅乾','攻擊速度 +15%。'],
  shield:['護盾','目前不提供額外能力加成。'], sk_set_dragonscion:['龍裔',special.sk_set_dragonscion],
};
const debuffs = {
  stun:['暈眩','無法行動。'], freeze:['冰凍','無法行動。'], stone:['石化','無法行動。'],
  paralyze:['麻痺','無法行動。'], sleep:['睡眠','無法行動，受到攻擊時可能甦醒。'],
  silence:['沉默','無法施放魔法。'], magicseal:['魔法封印','無法施放魔法。'],
  poison:['中毒','持續受到毒傷。'], burn:['灼燒','持續受到火焰傷害。'],
  scald:['燙傷','持續受到燙傷傷害。'], bleed:['出血','持續流失 HP。'],
  weaken:['弱化','一般攻擊傷害 -5、命中 -2。'], disease:['疾病','AC +8、一般攻擊命中 -4。'],
  blind:['目盲','一般攻擊命中 -6。'], potionFrost:['藥水霜化','治癒藥水的恢復量減少 50%。'],
  foulWater:['汙濁之水','受到的治癒效果減半。'], evilAura:['邪靈之氣','AC +10、ER 迴避 -10。'],
  broken:['壞物術','一般攻擊的物理傷害減少 20%。'], slowAtk:['攻擊減速','攻擊間隔加倍。'],
  bind:['束縛','無法進行近距離一般攻擊；遠距離武器不受影響。'],
  armorBreak:['破壞盔甲','一般攻擊受到的傷害增加。'], cleave:['切割','暫時提升攻擊速度。'],
};
const companions = new Set(['poisonDmg','poisonTick','burnDmg','burnTick','scaldDmg','scaldTick','bleedDmg','bleedTick','armorBreakPct']);
const sets = {
  紅獅:['額外傷害 +5、額外魔法點數 +3','傷害減免 +10','最終傷害 +10%'],
  白鳥:['額外命中 +5','魅力 +10','一般攻擊命中附加脆弱 3 秒'],
  鐵衛:['AC -3、傷害減免 +5','受到傷害 -20%','一般攻擊命中附加嘲諷 3 秒'],
  麗人:['近距離傷害與命中 +3','近距離爆擊 +3','裝備近距離武器時攻速 +20%'],
  疾風:['遠距離傷害與命中 +3','遠距離爆擊 +3','連射傷害提高至 80%'],
  月光:['額外傷害 +2、額外命中 +3','ER +5、MR +10','攻擊與技能附加碎裂 3 秒'],
  學徒:['MP 恢復 +5、額外魔法點數 +6','魔法爆擊 +3','MP 低於 30% 時技能耗魔減半'],
  魔女:['魔法傷害 +3','水抗性 +10、額外魔法點數 +5','每 5 次共鳴觸發免費冰雪暴'],
  暗影:['額外傷害 +7','鋼爪或雙刀的雙擊機率 +20%','雙擊追加攻擊傷害加倍'],
  幻覺:['每次免費觸發法術事件恢復等級 /10（無條件捨去）的 MP','輔助技能 MP 消耗 -50%','免費觸發法術傷害加倍'],
  龍血:['物理傷害吸血 1%；HP 低於 50% 時吸血 5%','施放消耗 HP 的技能可獲得龍裔減傷','消耗 HP 的技能傷害 +20%'],
  狂怒:['負重上限 +500','HP 上限 +20%','隨血量降低增加傷害並減少受傷，最多各 15%'],
};
export function describeSkill(id, sk = {}, p = {}) {
  const parts = [];
  if (sk.d && typeof sk.d === 'object') for (const [key, value] of Object.entries(sk.d)) {
    if (typeof value !== 'number' || !value) continue;
    const signed = key === 'ac' ? -value : value;
    parts.push(`${statNames[key] || key} ${signed > 0 ? '+' : ''}${signed}`);
  }
  if (special[id]) parts.push(special[id]);
  if (sk.haste) parts.push(basics.haste[1]);
  if (sk.moveSpeedMult) parts.push(`移動速度 +${Math.round((sk.moveSpeedMult - 1) * 100)}%，縮短尋敵等待。`);
  if (sk.moveSpeedReplacesCookie) parts.push('移動加成與精靈餅乾取較高者。');
  if (sk.loadFreeRegen) parts.push('負重不會阻止自然恢復。');
  if (sk.hpRegenIv) parts.push(`每 ${sk.hpRegenIv / 10} 秒自然恢復 HP。`);
  if (sk.dmgTakenReduce) parts.push(`受到傷害減少 ${sk.dmgTakenReduce}%。`);
  if (sk.painReflect) parts.push('將受到的直接傷害等量反射給攻擊者，不反射持續傷害。');
  if (sk.throwAxe) parts.push('鈍器攻擊改為投擲，能攻擊遠處目標。');
  if (sk.stormInterval) parts.push(`每 ${sk.stormInterval / 10} 秒對全體敵人造成${sk.ele === 'water' ? '水' : '火'}屬性傷害${sk.ele === 'water' ? '，並有機率冰凍' : ''}。`);
  if (sk.cube) parts.push(`每 ${sk.cube.iv / 10} 秒${({dmg:'造成火屬性傷害',slow:'使敵人減速',mrdown:'降低敵人魔防',dmgmp:'造成傷害並恢復 MP'})[sk.cube.kind] || '發動立方效果'}。`);
  if (sk.awaken) {
    parts.push(`覺醒攻速 +${p.mastery === 'k_awaken' ? 50 : 20}%（多種覺醒不重複計算）。`);
    if (id === 'sk_dragon_awaken_antares') parts.push(`免疫中毒、麻痺；HP 上限 +${2 * (p.lv || 1)}。`);
    if (id === 'sk_dragon_awaken_falion') parts.push('MR 魔防 +15%。');
  }
  if (id === 'sk_reduction_armor') parts.push(`傷害減免 +${Math.floor((p.lv || 1) / 10)}（每 10 級 +1）。`);
  if (id === 'sk_warrior_endurance') parts.push(`HP 上限 +${(p.lv || 1) / 2}%。`);
  if (id === 'sk_royal_precise') parts.push('場上敵人受到的傷害增加，幅度依施放者等級決定。');
  if (id === 'sk_royal_bravewill') parts.push(`一般攻擊有 ${p.mastery === 'k_royal_sword' ? 20 : 10}% 機率造成 1.5 倍傷害。`);
  if (sk.reqShield) parts.push('需裝備盾牌。');
  if (sk.summon) parts.push('召喚夥伴協助戰鬥；召喚物消失時結束。');
  if (!parts.length && typeof sk.desc === 'string') parts.push(sk.desc);
  if (!parts.length && typeof sk.d === 'string') parts.push(sk.d);
  return parts.join('；').replace(/。；/g, '。') || '效果持續中；此狀態尚無詳細說明。';
}
export function formatRemaining(seconds) {
  if (seconds === null) return '常駐';
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 時 ${Math.floor(s % 3600 / 60)} 分 ${s % 60} 秒`;
}
export function collectStatuses(p, {skills = {}, lures = {}, auraIds = [], icons = {}, debuffIcons = {}, now = Date.now(), ticks = 0, polyDescription = ''} = {}) {
  if (!p) return [];
  const rows = [], buffs = p.buffs || {}, gmIds = new Set(p._gmBuffs?.ids || []), shopIds = new Set(p._shopBuffs?.ids || []);
  function add(id, name, description, seconds, kind = 'buff', source = '自身', icon = '') {
    if (seconds !== null && (!Number.isFinite(seconds) || seconds <= 0)) return;
    rows.push({id, name, description, seconds, kind, source, icon});
  }
  for (const [id, raw] of Object.entries(buffs)) {
    if (typeof raw !== 'number' || raw <= 0 || id === 'poly') continue;
    const sk = skills[id];
    if (sk?.summon || id === 'sk_charm') {
      const active = id === 'sk_charm' ? p.charmed : (p._summonV2Sk === id ? p.summonsV2?.some(s => s && s.curHp > 0) : p.summon?.skId === id);
      if (!active) continue;
    }
    const gmSeconds=gmIds.has(id)?(p._gmBuffs.expiresAt-now)/1000:0,shopSeconds=shopIds.has(id)?(p._shopBuffs.expiresAt-now)/1000:0;
    const seconds = gmIds.has(id)||shopIds.has(id) ? Math.max(gmSeconds,shopSeconds) : raw;
    const name = sk?.n || lures[id]?.n || basics[id]?.[0] || id;
    const description = sk ? describeSkill(id, sk, p) : lures[id] ? '期間擊殺對應動物即可捕獲為寵物。' : basics[id]?.[1] || '效果持續中；此狀態尚無詳細說明。';
    const source=shopSeconds>0&&gmSeconds>0?'藍鑽商店／GM 賦予':shopSeconds>0?'藍鑽商店':gmIds.has(id)?'GM 賦予':'自身';
    add(`buff:${id}`, name, description, seconds, 'buff', source, icons[id] || (lures[id] ? '誘捕' : ''));
  }
  for (const [id, raw] of Object.entries(p.statuses || {})) {
    if (companions.has(id) || typeof raw !== 'number' || raw <= 0) continue;
    let [name, description] = debuffs[id] || [id, '異常效果持續中；此狀態尚無詳細說明。'];
    if (id === 'armorBreak') description = `一般攻擊受到的傷害增加 ${p.statuses.armorBreakPct || 50}%。`;
    if (id === 'cleave') description = p.classicMode ? '經典模式不套用切割攻速加成。' : `攻擊速度 +${p.mastery === 'k_cleave' ? 50 : 20}%。`;
    add(`status:${id}`, name, description, raw / 10, id === 'cleave' ? 'buff' : 'debuff', '戰鬥', debuffIcons[id]);
  }
  for (const [id, h] of Object.entries(p.hots || {})) if (h?.ticksLeft > 0) {
    const remaining = ((h.ticksLeft - 1) * (h.interval || 0) + (h.cd || 0)) / 10;
    add(`hot:${id}`, skills[id]?.n || h.skName || id, `全隊每 ${(h.interval || 0) / 10} 秒持續恢復 HP，還有 ${h.ticksLeft} 次治療。`, Math.max(0.1, remaining), 'buff', '持續治療', skills[id]?.n);
  }
  for (const id of auraIds) {
    if (rows.some(r => r.id === `buff:${id}`)) continue;
    let remaining = 0, provider;
    for (const ally of p.allies || []) if (ally && !ally._downed && (ally.buffs?.[id] || 0) > remaining) { remaining = ally.buffs[id];provider = ally; }
    add(`aura:${id}`, skills[id]?.n || id, describeSkill(id, skills[id], provider), remaining, 'buff', '隊友光環', icons[id]);
  }
  if (p._equipHaste) add('equip:haste', '裝備加速', basics.haste[1], null, 'permanent', '裝備');
  const form = p._setPoly || (buffs.poly > 0 ? p.poly : null);
  if (form) add('poly', `變身：${form.n}`, polyDescription || '套用目前變身的攻擊、移動及施法能力。', p._setPoly ? null : buffs.poly, p._setPoly ? 'permanent' : 'buff', p._setPoly ? '裝備變身' : '變形術', '變形術');
  for (const [group, count] of Object.entries(p._sherineSetCnt || {})) if (count >= 2) {
    const effects = sets[group];
    add(`set:${group}`, `${group}套裝 ${Math.min(count, 5)}/5`, effects ? effects.filter((_, i) => count >= [2, 3, 5][i]).join('；') : '套裝能力生效中。', null, 'permanent', '套裝');
  }
  for (const [field, name, description, kind] of [
    ['_crushFuryUntil','粉碎鎚狂熱','攻擊速度 +20%。','buff'],
    ['_fangFuryUntil','邪惡利牙狂熱','攻擊速度 +30%。','buff'],
    ['_giltasWandFuryUntil','吉爾塔斯魔杖狂熱','依邪惡值提高額外魔法點數，最多 +20；需持續裝備魔杖。','buff'],
    ['_golemMrDebuffUntil','高崙印記','MR 魔防 -100。','debuff'],
    ['_spellbladeUntil','魔劍士之刀','近距離傷害與命中依最後法術階級增加 +1 至 +25；一般攻擊改為該法術屬性。需持續裝備武器。','buff'],
    ['_eyePetrifyUntil','地龍之魔眼','額外傷害 +5、額外命中 +5、ER 迴避 +5。','buff'],
  ]) add(`trigger:${field}`, name, description, ((p[field] || 0) - ticks) / 10, kind, '裝備觸發');
  return rows.sort((a, b) => ({debuff:0,buff:1,permanent:2})[a.kind] - ({debuff:0,buff:1,permanent:2})[b.kind] || a.name.localeCompare(b.name, 'zh-Hant'));
}
