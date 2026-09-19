'use strict';

/* AI chat is intentionally a UI-only module. The server owns providers, models and keys. */
(() => {
  let api, notify, ready = false, loaded = false, visible = false, dirty = false, timer = null, latest = null, working = false;
  const $ = id => document.getElementById(id);
  const root = () => $('view-ai-chat');

  function shell() {
    root().innerHTML = `<div class="ai-chat-grid">
      <section class="surface ai-chat-main">
        <div class="section-heading"><div><span class="eyebrow">AI WORLD CHAT</span><h2>AI 世界聊天</h2></div><span class="ai-label">✦ AI 發言</span></div>
        <p class="hint">讓伺服器上的角色偶爾加入世界聊天。內容由你選擇；玩家介面統一顯示角色名稱，模型與生成紀錄保留於本管理台。</p>
        <div class="ai-status-row"><span id="ai-status" class="status-pill">讀取中</span><span id="ai-runtime-summary" class="muted"></span></div>
        <div class="ai-form-grid">
          <label class="toggle-label"><input id="ai-enabled" type="checkbox"><span><strong>啟用 AI 自動聊天</strong><small>依間隔自動發言</small></span></label>
          <label class="toggle-label"><input id="ai-respond" type="checkbox"><span><strong>回覆真人玩家</strong><small>看到玩家訊息時可接話</small></span></label>
          <label>執行方式<select id="ai-provider"></select><small class="field-note">Ollama 使用你電腦的模型；Codex 使用帳戶用量；Railway API 另計 API 費用。</small></label>
          <label>聊天話題<select id="ai-topic"></select></label>
          <label>發言間隔（秒）<input id="ai-interval" type="number" min="30" max="3600" step="1" inputmode="numeric"><small class="field-note">30–3600 秒</small></label>
          <label>每日生成上限<input id="ai-limit" type="number" min="0" max="2000" step="1" inputmode="numeric"><small class="field-note">0 代表不限；仍依發言間隔排程</small></label>
        </div>
        <section id="ai-ollama-wrap" class="ollama-settings" hidden><h3>本機 Ollama</h3><p class="hint">由這台電腦的聊天橋接程式連線，localhost 指的是執行橋接程式的電腦。</p><div class="ai-form-grid"><label>Ollama 網址<input id="ai-ollama-url" type="url" value="http://127.0.0.1:11434" placeholder="http://127.0.0.1:11434"><small class="field-note">限本機位址，可指定連接埠；不需公開 Ollama 到網路。</small></label><label>模型名稱<input id="ai-ollama-model" list="ai-ollama-models" maxlength="120" placeholder="qwen3:8b"><datalist id="ai-ollama-models"></datalist><small class="field-note">可輸入模型名稱，或從本機已安裝清單選擇。</small></label></div><p id="ai-ollama-state" class="field-note" role="status">儲存後由本機橋接程式檢查連線與模型。</p></section>
        <label id="ai-custom-wrap">自訂提示詞（最多 2000 字）<textarea id="ai-custom" maxlength="2000" rows="6" placeholder="例如：以熱心的新手村嚮導口吻，分享簡短的冒險小知識。"></textarea><small id="ai-custom-count" class="field-note">0 / 2000</small></label>
        <fieldset class="speaker-field"><legend>AI 發言角色（最多選 4 位一般玩家）</legend><p class="hint">伺服器會使用這些帳號作為 AI 的聊天室角色。</p><div id="ai-speakers" class="speaker-list"></div></fieldset>
        <div class="ai-actions"><button id="ai-save" class="primary">儲存設定</button><button id="ai-reload" class="secondary">重新載入設定</button><button id="ai-request" class="secondary">立即要求一次發言</button><span id="ai-save-state" class="muted" role="status"></span></div>
      </section>
      <aside class="surface ai-chat-side"><h2>執行狀態</h2><dl class="runtime-list"><div><dt>本機聊天代理</dt><dd id="ai-bridge">—</dd></div><div><dt>今日發言</dt><dd id="ai-today">—</dd></div><div><dt>最近發言</dt><dd id="ai-last-at">—</dd></div><div><dt>最近錯誤</dt><dd id="ai-error">—</dd></div></dl><h2 class="recent-title">最近 AI 發言</h2><div id="ai-recent" class="ai-recent"></div></aside>
    </div>`;
    $('ai-custom').oninput = () => { $('ai-custom-count').textContent = `${$('ai-custom').value.length} / 2000`; markDirty(); };
    root().querySelectorAll('input,select,textarea').forEach(el => { if (el !== $('ai-custom')) { el.addEventListener('input', markDirty); el.addEventListener('change', markDirty); } });
    $('ai-topic').onchange = () => { $('ai-custom-wrap').hidden = $('ai-topic').value !== 'custom'; markDirty(); };
    $('ai-provider').onchange = () => { $('ai-ollama-wrap').hidden = $('ai-provider').value !== 'ollama'; markDirty(); };
    $('ai-save').onclick = save;
    $('ai-reload').onclick = reload;
    $('ai-request').onclick = requestNow;
    root().querySelectorAll('input,select,textarea,button').forEach(el => { el.disabled = true; });
  }
  function markDirty() { dirty = true; $('ai-save-state').textContent = '有尚未儲存的變更'; }
  function option(select, value, label, title, model) { const o = document.createElement('option'); o.value = value; o.textContent = label; if (title) o.title = title; if (model) o.dataset.model = model; select.append(o); }
  function fillSettings(data) {
    latest = data;
    const s = data.settings || {}, opts = data.options || {};
    $('ai-enabled').checked = !!s.enabled; $('ai-respond').checked = s.respondToPlayers !== false;
    $('ai-interval').value = s.intervalSeconds ?? 90; $('ai-limit').value = s.dailyMessageLimit ?? 0; $('ai-custom').value = s.customPrompt || '';
    $('ai-provider').replaceChildren(); (opts.providers || []).forEach(p => option($('ai-provider'), p.id, `${p.name || p.id} · ${p.model || ''}`, p.description, p.model));
    $('ai-provider').value = s.provider || $('ai-provider').options[0]?.value || '';
    $('ai-ollama-url').value=s.ollamaUrl||'http://127.0.0.1:11434';$('ai-ollama-model').value=s.ollamaModel||'qwen3:8b';$('ai-ollama-wrap').hidden=$('ai-provider').value!=='ollama';
    $('ai-topic').replaceChildren(); (opts.topics || []).forEach(t => option($('ai-topic'), t.id, t.name || t.id, t.description));
    $('ai-topic').value = s.topic || 'casual'; $('ai-custom-wrap').hidden = $('ai-topic').value !== 'custom';
    $('ai-speakers').replaceChildren(); const selected = new Set(s.speakers || []);
    (opts.speakers || []).forEach(p => { const label = document.createElement('label'); label.className = 'speaker-option'; const input = document.createElement('input'); input.type = 'checkbox'; input.value = p.id; input.checked = selected.has(p.id); input.addEventListener('change', () => { const checked = root().querySelectorAll('#ai-speakers input:checked'); if (checked.length > 4) { input.checked = false; notify('最多選擇 4 位 AI 發言角色', true); return; } markDirty(); }); const name = document.createElement('span'); name.textContent = `${p.name || p.username}（${p.username}） · ${p.cls || '玩家'}${p.online ? ' · 在線' : ''}`; label.append(input, name); $('ai-speakers').append(label); });
    $('ai-custom-count').textContent = `${$('ai-custom').value.length} / 2000`;
    loaded = true; root().querySelectorAll('input,select,textarea,button').forEach(el => { el.disabled = false; });
    dirty = false; $('ai-save-state').textContent = '';
  }
  function renderRuntime(data) {
    const local=data.local;$('ai-ollama-models').replaceChildren();(local?.models||[]).forEach(name=>option($('ai-ollama-models'),name,name));
    const installed=local?.models?.includes(data.settings?.ollamaModel)||local?.models?.includes(data.settings?.ollamaModel+':latest');
    $('ai-ollama-state').textContent=!local?.online?'等待本機橋接程式回報；請確認電腦與聊天橋接程式已開啟。':!local.ready?'Ollama 無法連線，請啟動本機 Ollama 並確認網址。':`Ollama 已連線 · ${local.models.length} 個模型${installed?' · 指定模型已就緒':' · 尚未安裝指定模型'}`;
    const r = data.runtime || {}, limit = data.settings?.dailyMessageLimit === 0 ? '不限' : (data.settings?.dailyMessageLimit ?? '—'), capped = Number(data.settings?.dailyMessageLimit) > 0 && Number.isFinite(r.todayAttempts) && r.todayAttempts >= data.settings.dailyMessageLimit; $('ai-status').textContent = capped ? '已達每日生成上限（失敗也計成本）' : (r.busy ? 'AI 正在準備發言' : (data.settings?.enabled ? 'AI 已啟用' : 'AI 已停用')); $('ai-status').className = 'status-pill ' + (data.settings?.enabled ? 'on' : 'off');
    $('ai-runtime-summary').textContent = r.busy ? '目前忙碌中' : '等待下一次排程'; const openai = data.settings?.provider === 'openai'; $('ai-bridge').textContent = openai ? (r.apiReady ? 'API 已就緒' : 'API 未就緒') : (r.bridgeOnline ? '在線' : '離線'); $('ai-bridge').className = (openai ? r.apiReady : r.bridgeOnline) ? 'runtime-good' : 'runtime-bad'; $('ai-today').textContent = `${r.todayCount ?? 0} 則（實際發送）；每日生成上限：${limit}${r.todayAttempts != null ? `；生成嘗試 ${r.todayAttempts} 次` : ''}`; $('ai-last-at').textContent = r.lastMessageAt ? new Date(r.lastMessageAt).toLocaleString('zh-TW') : '尚未發言'; $('ai-error').textContent = r.lastError || '無'; $('ai-error').className = r.lastError ? 'runtime-bad' : '';
    $('ai-recent').replaceChildren(); const entries = data.recent || []; if (!entries.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = '尚無 AI 發言紀錄。'; $('ai-recent').append(p); } entries.forEach(e => { const article = document.createElement('article'); article.className = 'ai-recent-entry'; const head = document.createElement('div'); const who = document.createElement('strong'); who.textContent = `✦ AI · ${e.name || e.username || '角色'}`; const time = document.createElement('time'); time.textContent = e.at ? new Date(e.at).toLocaleTimeString('zh-TW') : ''; const text = document.createElement('p'); text.textContent = e.text || ''; head.append(who, time); article.append(head, text); $('ai-recent').append(article); });
  }
  async function refresh(force = false) { if (!ready || !visible) return; try { const data = await api('/api/gm/ai-chat'); if (!dirty || force) fillSettings(data); renderRuntime(data); } catch (e) { notify(e.message, true); } }
  function values() { const fields = [$('ai-interval'), $('ai-limit')]; if($('ai-provider').value==='ollama')fields.push($('ai-ollama-url'));if (fields.some(field => !field.reportValidity())) throw new Error('請輸入有效的設定值'); return { enabled: $('ai-enabled').checked, provider: $('ai-provider').value, model: $('ai-provider').selectedOptions[0]?.dataset.model || '',ollamaUrl:$('ai-ollama-url').value.trim(),ollamaModel:$('ai-ollama-model').value.trim(), topic: $('ai-topic').value, customPrompt: $('ai-custom').value, intervalSeconds: Number($('ai-interval').value), dailyMessageLimit: Number($('ai-limit').value), respondToPlayers: $('ai-respond').checked, speakers: [...root().querySelectorAll('#ai-speakers input:checked')].slice(0, 4).map(i => i.value), revision: latest?.settings?.revision }; }
  async function save() { if (!loaded || working) return; let payload; try { payload = values(); } catch (e) { notify(e.message, true); return; } const button = $('ai-save'); working = true; button.disabled = true; try { const data = await api('/api/gm/ai-chat/settings', payload); fillSettings(data); renderRuntime(data); notify('AI 聊天設定已儲存'); } catch (e) { notify(e.message, true); } finally { working = false; button.disabled = false; } }
  async function reload() { if (dirty && !confirm('重新載入會捨棄尚未儲存的變更，確定要繼續嗎？')) return; dirty = false; await refresh(true); }
  async function requestNow() { if (!loaded || working) return; if (dirty) { notify('請先儲存設定，再要求 AI 發言。', true); return; } const button = $('ai-request'); working = true; button.disabled = true; try { await api('/api/gm/ai-chat/request', {}); notify('已要求 AI 盡快發言'); await refresh(); } catch (e) { notify(e.message, true); } finally { working = false; button.disabled = false; } }
  window.initAiChat = injected => { if (ready) return; ({ api, notify } = injected); shell(); ready = true; visible = !root().hidden; document.addEventListener('gm:view-change', e => { visible = e.detail.view === 'ai-chat'; if (visible) { if (timer) clearInterval(timer); refresh(); timer = setInterval(() => refresh(), 10000); } else if (timer) { clearInterval(timer); timer = null; } }); if (visible) { refresh(); timer = setInterval(() => refresh(), 10000); } };
})();
