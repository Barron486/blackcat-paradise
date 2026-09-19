const PERSONALITIES = {
  royal: '有主見、講義氣，習慣照顧隊友；語氣隨和，偶爾自嘲，不用領隊訓話的口吻。',
  mage: '好奇、愛琢磨原因，偶爾有點冷幽默；說話清楚簡短，不賣弄術語，不扮演全知百科。',
  elf: '細心、溫和但有自己的看法；會接住對方的情緒，偶爾輕輕吐槽，不句句安慰。',
  knight: '直爽、重情義，話不多；先回應重點，偶爾乾脆地開個玩笑，不動不動喊衝鋒。',
  dark: '慢熟、嘴硬心軟，帶一點乾式幽默；不刻薄，不故作神秘。',
  dragon: '爽朗、好勝，喜歡挑戰；輸贏都能開玩笑，不誇耀不存在的戰績。',
  warrior: '豪爽、務實，喜歡簡單直接的做法；會替朋友抱不平，不吼口號。',
  illusion: '想像力豐富、機靈，偶爾用有趣的比喻；不故弄玄虛，不長篇說教。',
};
const HABITS = ['較常用短句，不常加表情符號。', '偶爾用「欸」起頭，但不要每句重複。', '喜歡順著對方的一個細節接話，不連續追問。', '先說自己的看法，再視需要接一句小玩笑。'];
const seed = value => [...String(value)].reduce((n, c) => (n * 31 + c.codePointAt(0)) >>> 0, 0);

export function defaultPersonality(speaker) {
  return (PERSONALITIES[speaker.cls] || '隨和、有自己的想法，喜歡聽人分享，不搶話。') + HABITS[seed(speaker.id || speaker.name) % HABITS.length];
}

export function mentionsCharacter(text, name) {
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'iu').test(text);
}

export function chooseSpeaker(speakers, lastSpeaker, recent, reply) {
  if (reply) {
    const addressed = speakers.find(s => mentionsCharacter(reply.text, s.name));
    if (addressed) return addressed;
    const previous = recent.filter(m => m.ai).at(-1);
    const ongoing = previous && speakers.find(s => s.name === previous.displayName);
    if (ongoing) return ongoing;
  }
  return speakers[(speakers.findIndex(s => s.id === lastSpeaker) + 1) % speakers.length];
}

export function replyKind(reply, speaker) {
  if (!reply) return '';
  const text = reply.text;
  const addressed = /你|妳|您|自己|本人|角色資訊|面板/.test(text) || mentionsCharacter(text, speaker.name);
  if (addressed && /(?:是|是不是|是否|算|到底|真人|機器人|人工智慧|模型).{0,12}(?:AI|ai|ＡＩ|機器人|人工智慧|真人|模型)|(?:AI|ＡＩ|機器人|人工智慧|真人)(?:嗎|吧|喔|啊|還是|對不對)/i.test(text)) return 'identity';
  const stats = /等級|幾級|多少級|LV|level|裝備|武器|防具|血量|魔力|魔量|生命值|HP|MP|正義值|位置|座標|地圖|在哪|哪裡|哪練|哪邊|穿什麼|拿什麼|身上|角色資訊|面板|金幣|藍鑽|攻擊力|防禦/i;
  const own = /(?:你|妳|您)(?:的|身上|目前|現在|穿|拿|裝備|等級|血量|魔力|HP|MP)|自己的/i.test(text);
  if (/怎麼|怎樣|如何|推薦|攻略|掉落|有什麼用|是什麼|你覺得|你認為|你知道/.test(text) && !own && !/(?:你|妳|您)是什麼/.test(text)) return '';
  const asking = /幾級|多少|在哪|哪裡|哪邊|哪張|哪練|什麼|怎樣|如何|給我看|看一下|看看|嗎|呢|[?？]/.test(text) || /(?:你|妳|您)(?:的)?(?:裝備|等級|血量|位置|正義值|HP|MP)[!！。，\s]*$/i.test(text);
  if (!asking) return '';
  // Restrict refusal to questions about a character, not general game mechanics.
  const personal = /(?:你|妳|您)(?:現在|目前|的|身上|自己|本人|到底|在|是|有|穿|拿|用|剩|多少|幾|第|哪)/.test(text) || mentionsCharacter(text, speaker.name) || /(?:你|妳|您).{0,8}(?:幾級|多少級|在哪|哪裡|哪邊|血量|裝備|HP|MP|等級|位置|正義值|面板)/i.test(text);
  return personal && stats.test(text) ? 'private' : '';
}

export function protectedReply(kind, speaker, jobId) {
  if (kind === 'identity') return '我是遊戲裡的 AI 角色，可以一起聊遊戲。';
  const responses = {
    royal: ['我的角色資料就先保密啦，聊別的也行。', '這個先留點神祕感，別把我底牌都看光嘛。'],
    mage: ['我的角色數值先保密，玩法倒是可以聊。', '這份角色筆記暫時不外借啦。'],
    elf: ['我的角色資料先留給自己吧，謝謝體諒。', '這個我想先保密，就讓我留點小祕密吧。'],
    knight: ['我的角色資料不公開，見諒啦。', '這個先不透露，聊點別的吧。'],
  };
  const replies = responses[speaker.cls] || ['我的角色資料先保密，見諒啦。', '這部分就不公開了，聊點別的吧。'];
  return replies[seed(jobId) % replies.length];
}
