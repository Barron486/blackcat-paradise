// Shared by the browser, headless CLI and the server catalog sandbox.
var gmWorld = {revision:0,goldMultiplier:1,expMultiplier:1,dropMultiplier:1,showDropRates:false,maps:{},drops:{}};
var gmWorldInitialized = false;
function gmSetWorld(value) {
    if (!value || (gmWorldInitialized && value.revision <= gmWorld.revision)) return;
    gmWorld = Object.assign({}, gmWorld, value);
    gmWorldInitialized = true;
    if (typeof player !== 'undefined' && player.cls && typeof syncMapSelectors === 'function') syncMapSelectors();
}
function gmDropKey(source, name, item) { return JSON.stringify([source,name,item]); }
function gmDropChance(source, mob, item, percent, bonus) {
    const key = gmDropKey(source, typeof mob === 'string' ? mob : mob.n, item);
    const rate = Object.prototype.hasOwnProperty.call(gmWorld.drops,key) ? gmWorld.drops[key] : percent;
    return Math.min(1, Math.max(0, rate / 100 * gmWorld.dropMultiplier * (bonus == null ? 1 : bonus)));
}
// Exclusive pools keep their original one-item maximum. Above 100%, weights are normalized.
function gmChooseDrop(source, mob, entries, bonus) {
    const weights = entries.map(e => gmDropChance(source,mob,e[0],e[1],bonus));
    const sum = weights.reduce((a,b)=>a+b,0);
    let roll = Math.random();
    if (!sum || roll >= Math.min(1,sum)) return null;
    roll *= Math.max(1,sum);
    for (let i=0;i<entries.length;i++) { roll -= weights[i]; if (roll < 0) return entries[i][0]; }
    return entries[entries.length-1][0];
}
function gmMapRule(id) { return gmWorld.maps[id] || {}; }
function gmMapAllowed(id, announce) {
    const rule=gmMapRule(id);
    // Towns remain escape routes; GM teleport has its own explicit bypass.
    const allowed = String(id).startsWith('town_') || (rule.open !== false && (player.lv||1) >= (rule.minLevel||1));
    if (!allowed && announce && typeof logSys==='function') logSys(rule.open===false ? 'GM 已關閉此地圖。' : '此地圖需要等級 '+rule.minLevel+'。');
    return allowed;
}
function gmApplyTeleport() {
    const pending=player._gmTeleport;
    if (!pending || (player._gmTeleportApplied||0)>=pending.seq) return false;
    const id=pending.mapId;
    if (!DB.maps[id] && !DB.towns[id]) return false;
    // Clear per-run state before entering a destination with no entry cost.
    state.prideClimb=false; state.prideRanked=false; state.prideFloor=0;
    state.riftRun=false; state.oblivion=null; state.antharas=null;
    const select=document.getElementById('map-select');
    setMapSelectors(id);
    if (![...select.options].some(o=>o.value===id)) { const opt=document.createElement('option');opt.value=id;opt.textContent=pending.mapName||id;select.append(opt); }
    select.value=id;
    window._gmTeleporting=true;
    try { changeMap(true); } finally { window._gmTeleporting=false; }
    if (mapState.current!==id) return false;
    player._gmTeleportApplied=pending.seq;
    if (typeof logSys==='function') logSys('GM 已將你傳送至 '+(pending.mapName||id)+'。');
    return true;
}
function gmBuildWorldCatalog() {
    const maps=new Map();
    const extraNames={arena_pvp:'決鬥競技場',windwood_dungeon:'風木地監',hidden_lab_nolife:'無生物研究室',hidden_lab_darkmagic:'黑魔法研究室',hidden_seal_spirit:'惡靈封印室',hidden_seal_monster:'魔物封印室',hidden_seal_demon:'惡魔封印室',hidden_antqueen:'巨蟻女皇棲息地',dark_elf_sanctuary:'黑暗妖精聖地',cursed_dark_elf_sanctuary:'受詛咒的黑暗妖精聖地',collapsed_elder_council_hall:'崩壞的長老會議廳',rift_battle:'時空裂痕戰場',oblivion_travel:'遺忘之島途中',oblivion_island:'遺忘之島',antharas_nest_1:'侵蝕的安塔瑞斯巢穴入口',antharas_nest_2:'侵蝕的安塔瑞斯巢穴通道',antharas_nest_3:'侵蝕的安塔瑞斯巢穴深處',antharas_lair:'侵蝕的安塔瑞斯棲息地'};
    for(const c of Object.values(SIEGE_CITY)){extraNames[c.outer]=c.outerName;extraNames[c.inner]=c.innerName;}
    for (const [category,rows] of Object.entries(MAP_CATEGORIES)) for(const m of rows) maps.set(m.v,{id:m.v,name:m.t,category});
    for(const [id,t] of Object.entries(DB.towns)) if(!maps.has(id)) maps.set(id,{id,name:t.n||id,category:'village'});
    for(const id of Object.keys(DB.maps)) if(!maps.has(id)) maps.set(id,{id,name:extraNames[id]||(/^pride_f\d+$/.test(id)?'傲慢之塔 '+id.slice(7)+' 樓':id),category:mapCategoryOf(id)});
    const monsters=new Map(Object.entries(DB.mobs).map(([id,m])=>[m.n,{id,name:m.n,level:m.lv,boss:!!m.boss}]));
    const rows=new Map();
    const add=(source,mob,item,rate,condition='',group='')=>{
        if(!DB.items[item]) return;
        const key=gmDropKey(source,mob,item);
        // Duplicate entries in the same table retain their independent rolls.
        const old=rows.get(key);
        if(old){old.rolls++;return;}
        rows.set(key,{key,source,monster:mob,itemId:item,itemName:DB.items[item].n,baseRate:rate,condition,group,rolls:1});
        if(!monsters.has(mob))monsters.set(mob,{id:mob,name:mob});
    };
    for(const [source,table] of Object.entries({normal:MOB_DROPS,darkWeapon:DARK_WEAPON_DROPS,darkCrystal:DARK_CRYSTAL_DROPS,dragon:DRAGON_DROPS,warrior:WARRIOR_DROPS,memory:MEM_DROPS})) {
        for(const [name,entries] of Object.entries(table)) for(const e of entries) {
            const forced=['normal','dragon','warrior'].includes(source)&&typeof trialForced100==='function'&&trialForced100(e[0]);
            add(source,name,e[0],forced?100:e[1],TRIAL_ITEM_CLASS[e[0]]?'限對應職業與已接取任務'+(forced?'；任務保底原為 100%':''):'');
        }
    }
    const ore={'石頭高崙':100,'鋼鐵高崙':100,'侏儒':50,'侏儒戰士':50,'黑騎士':50,'哈柏哥布林':50,'蜥蜴人':50};
    const trials={'黑暗妖精將軍':'item_dantes_letter','巨大兵蟻':'item_ancient_book','黑暗棲林者':'item_chaos_key','小惡魔':'item_royal_order'};
    const panaceas=['panacea_str','panacea_dex','panacea_con','panacea_int','panacea_wis','panacea_cha'];
    for(const mob of Object.values(DB.mobs)) {
        const name=mob.n;
        if(mob.transformTo || mob.trollPlayer || mob.race==='建築' || mob.race==='血盟')continue;
        const locations=Object.entries(DB.maps).filter(([,ids])=>Array.isArray(ids)&&ids.some(id=>DB.mobs[id]?.n===name)).map(([id])=>id);
        if(ore[name])add('ore',name,'mat_silverore',ore[name]);
        if(trials[name])add('trial50',name,trials[name],1,'對應職業／傭兵已接取 50 級試煉且未集滿');
        if(name==='魔族暗殺團')for(const id of ['item_sealed_intel','item_spy_report'])add('trial50',name,id,100,'對應職業／傭兵已接取試煉且未持有');
        if(locations.includes('elf_grave'))add('trial50',name,'item_elf_whisper',1,'騎士試煉第二階段，未集滿 10 個');
        if(Object.values(MASTERY_DATA).some(m=>m.boss===name))add('mastery',name,'item_mastery_proof',100,'已接取對應職業精通任務且未持有');
        if(['安塔瑞斯','法利昂','巴拉卡斯','林德拜爾'].includes(name))for(const id of ['item_dragon_egg','item_dragon_egg2'])add('egg',name,id,10);
        if((mob.lv||0)>=40)for(const id of panaceas)add('panacea',name,id,(mob.boss?1:0.01)/6,'Lv40+；夢幻之島頭目、城戰守軍除外；六選一','panacea');
        if(locations.includes('silent_outer')){
            add('stoneSilent',name,'mat_blackstone2',20,'沉默洞穴周邊；提煉魔石技能再 ×1.5');
            add('stoneSilent',name,'mat_blackstone3',10,'沉默洞穴周邊；提煉魔石技能再 ×1.5');
        }
        if(locations.some(id=>['wild','dungeon'].includes(mapCategoryOf(id))&&id!=='silent_outer'))for(const [id,rate] of [['mat_blackstone2',1],['mat_blackstone3',0.5],['mat_blackstone4',0.1]])add('stoneField',name,id,rate,'野外／地監；需提煉魔石技能');
        if(locations.some(id=>typeof mapRegionOf==='function'&&mapRegionOf(id)==='rastabad'))add('holy',name,'mat_holy_relic',0.1,'拉斯塔巴德區；持有死亡騎士之印記');
        if(locations.some(id=>AREA_BONUS_MAPS.includes(id)))for(const id of AREA_BONUS_ITEMS)add('area',name,id,id==='new_item_195'?20:2,'妖精森林周邊／眠龍洞穴；世界樹技能再 ×1.5');
        add('sherine',name,'sherine_crystal',(mob.boss?0.01:0.001)*(mob.lv||1),'僅席琳世界；瘋狂世界再 ×3');
        const nm=CARD_DROP_ALIAS[name]||name;
        if(CARD_MOB_INFO[nm])for(const [tier,rate] of [[1,0.1],[2,0.01],[3,0.001]]){
            const pool=CARD_CHAIN_BY_FINAL[nm]||[nm];
            for(const n of pool)add('card'+tier,name,cardId(n,tier),rate/pool.length,'同階卡片擇一；未開通圖鑑時自動登錄','card'+tier);
        }
    }
    return {maps:[...maps.values()],monsters:[...monsters.values()],drops:[...rows.values()]};
}
var gmWorldCatalogCache;
var gmLootSourcesCache;
function gmLootRarity(itemId, monster) {
    const item = DB.items[itemId], special = GameLootRarity.classify(item);
    if (special || !item || !['wpn','arm','acc'].includes(item.type) || item.isArrow) return special;
    if (!gmWorldCatalogCache) gmWorldCatalogCache = gmBuildWorldCatalog();
    if (!gmLootSourcesCache) {
        gmLootSourcesCache = new Map();
        for (const row of gmWorldCatalogCache.drops) {
            const key = JSON.stringify([row.monster,row.itemId]);
            if (!gmLootSourcesCache.has(key)) gmLootSourcesCache.set(key,[]);
            gmLootSourcesCache.get(key).push(row);
        }
    }
    // Use this monster's configured base rates, independent of temporary reward bonuses.
    const rows = gmLootSourcesCache.get(JSON.stringify([monster,itemId])) || [];
    return GameLootRarity.classify(item, Math.max(0,...rows.map(r=>gmWorld.drops[r.key]??r.baseRate)));
}
function gmMonsterDropHtml(name) {
    if(!gmWorldCatalogCache)gmWorldCatalogCache=gmBuildWorldCatalog();
    const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    return gmWorldCatalogCache.drops.filter(r=>{
        if(r.monster!==name)return false;
        const id=mapState.current;
        if(r.source==='stoneSilent'&&id!=='silent_outer')return false;
        if(r.source==='stoneField'&&(id==='silent_outer'||!['wild','dungeon'].includes(mapCategoryOf(id))))return false;
        if(r.source==='area'&&!AREA_BONUS_MAPS.includes(id))return false;
        if(r.source==='holy'&&mapRegionOf(id)!=='rastabad')return false;
        if(r.source==='sherine'&&!sherineWorldActive())return false;
        if(trialDropBlocked(r.itemId))return false;
        return true;
    }).map(r=>{
        let rate=gmDropChance(r.source,name,r.itemId,r.baseRate)*100;
        if(r.group){const total=gmWorldCatalogCache.drops.filter(x=>x.monster===name&&x.group===r.group).reduce((n,x)=>n+gmDropChance(x.source,name,x.itemId,x.baseRate),0);if(total>1)rate/=total;}
        const rarity=gmLootRarity(r.itemId,name),label=GameLootRarity.labels[rarity];
        return '<span'+(rarity?' class="loot-name-'+rarity+'"':'')+' title="'+escape([label,gmWorld.showDropRates?r.condition:''].filter(Boolean).join(' · '))+'">'+escape(r.itemName)+(gmWorld.showDropRates?' <b>'+Number(rate.toFixed(8))+'%</b>'+(r.condition?' <small>（'+escape(r.condition)+'）</small>':''):'')+'</span>';
    }).join('、')||'（無掉落物）';
}
if(typeof window!=='undefined' && window.CloudStore?.boot?.worldSettings) gmSetWorld(window.CloudStore.boot.worldSettings);
