// Pure helpers shared by classic game scripts, chat modules and the Node server.
globalThis.GameLootRarity = Object.freeze({
    types: Object.freeze(['legend', 'relic', 'rare']),
    labels: Object.freeze({legend: '傳說', relic: '遺物', rare: '極低掉率'}),
    classify(item, baseRate) {
        if (!item || !['wpn', 'arm', 'acc'].includes(item.type) || item.isArrow) return '';
        if (item.relic) return 'relic';
        if (item.legend) return 'legend';
        return Number.isFinite(baseRate) && baseRate > 0 && baseRate <= 0.01 ? 'rare' : '';
    },
    time(at) {
        return new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'}).format(new Date(at));
    },
    message(event) {
        const tier = this.labels[event.rarity] || '稀有';
        return `[${this.time(event.droppedAt ?? event.at)}] 恭喜 ${event.name} 在 ${event.mapName} 擊敗 ${event.monster}，獲得【${tier}】${event.itemName}${event.quantity > 1 ? ' ×' + event.quantity : ''}！`;
    }
});
