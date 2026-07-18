// 面板渲染器 —— 从 game.js 提取
// 9 个面板：自身 / 地图 / 角色 / 势力 / 兑换 / 制造 / 世界线 / 背包 / API日志
import { loadCharacter, loadAllCharacters } from '../engine/db.js';
import { getAllWorldFlowRecords } from '../engine/db.js';
import { calcCombatPower } from '../engine/combat.js';
import { fuzzyQuantity } from './state.js';

export function createPanels(worldConfig, playerId, bpContent, worldState) {
  const { mapping, K, P, timeToString, escapeHtml } = worldConfig._helpers;

  // ── 自身面板 ──
  async function renderSelf() {
    const player = await loadCharacter(playerId);
    if (!player) { bpContent.innerHTML = '<p style="color:#8a8a7a">未找到角色数据。</p>'; return; }

    const s = player.stats;
    const allChars = await loadAllCharacters();
    const locName = (worldConfig.locations || []).find(l => l.location_id === player.position.location_id)?.name || '?';

    const invStr = player.inventory.length > 0
      ? player.inventory.map(r => {
          const def = worldConfig.resource_types.find(rt => rt.resource_type_id === r.resource_type_id);
          const name = def?.name || r.resource_type_id;
          const rarity = def ? ` [${def.rarity}]` : '';
          return `${name}${rarity} ×${r.quantity}${r.durability !== undefined ? ' [耐久' + r.durability + ']' : ''}`;
        }).join('<br>')
      : '空';

    const drivesStr = player.drives.length > 0
      ? player.drives.map(d => `${d.description} [${Math.round(d.progress * 100)}%]`).join('<br>')
      : '无';

    const relStr = player.relationships.length > 0
      ? player.relationships.map(r => {
          if (r.target_id === playerId) return `${player.name}:好感${r.affinity}`;
          const target = allChars.find(c => c.character_id === r.target_id);
          const name = target?.name || r.target_id;
          return `${name}: ${r.affinity > 0 ? '好感' + r.affinity : '敌意' + Math.abs(r.affinity)}${(r.hatred || 0) >= 60 ? ' ⚠仇敌' : ''}`;
        }).join('<br>')
      : '暂无';

    const factionName = (worldConfig.factions || []).find(f => f.faction_id === player.faction_binding.faction_id)?.name || '无';
    const power = calcCombatPower(player, (worldConfig.locations || []).find(l => l.location_id === player.position.location_id) || null, worldConfig);

    bpContent.innerHTML = `
      <div class="setup-card">
        <div class="sc-header"><strong>${player.name}</strong> <span class="sc-tag">${player.identity.title}</span></div>
        <div class="sc-body">
          <div>${player.permanent_memory.core_identity}</div>
          <div class="sc-detail">${K(player.identity.k_level)} · ${P(s.p_level)} | HP ${s.hp}/${s.max_hp}</div>
          <div class="sc-detail">战力 ${power} | 修炼进度 ${s.cultivation_progress}</div>
          <div class="sc-detail">位置: ${locName} | 势力: ${factionName}${player.faction_binding ? ' 忠诚' + player.faction_binding.loyalty : ''}</div>
          <div class="sc-detail">物品:<br>${invStr}</div>
          <div class="sc-detail">目的:<br>${drivesStr}</div>
          <div class="sc-detail">关系:<br>${relStr}</div>
          <div class="sc-detail">记忆: ${player.long_term_memory.total_count}/${player.long_term_memory.capacity} | 模式: ${mapping.memory_mode_names[player.memory_mode] || '摘要'}</div>
        </div>
      </div>`;
  }

  // ── 地图面板 ──
  async function renderMap() {
    bpContent.innerHTML = '';
    const allChars = await loadAllCharacters();
    const player = await loadCharacter(playerId);

    const h3 = document.createElement('h3');
    h3.style.cssText = 'color:#3a8a7a;margin:0 0 6px;font-size:.9rem;padding-bottom:4px;border-bottom:1px solid #e0d8c8';
    h3.textContent = '地图';
    bpContent.appendChild(h3);

    const grid = document.createElement('div');
    grid.className = 'loc-grid';
    bpContent.appendChild(grid);

    for (const loc of (worldConfig.locations || [])) {
      const chars = allChars.filter(c => !c.is_player && c.position.location_id === loc.location_id);
      const dangerLabel = loc.danger_level === '低' ? '[低]' : loc.danger_level === '中' ? '[中]' : '[高]';
      const dangerColor = loc.danger_level === '高' ? '#e06060' : loc.danger_level === '中' ? '#c4a450' : '#6a9a8a';
      const isHere = loc.location_id === player?.position.location_id;

      const resTags = (loc.resources || []).map(r => {
        const def = worldConfig.resource_types.find(rt => rt.resource_type_id === r.resource_type_id);
        return `<span class="map-res-tag" style="background:#f0f4ea;color:#4a7a5a;padding:1px 5px;border-radius:3px;font-size:.6rem;margin-right:2px">${def?.name || r.resource_type_id}×${r.quantity}</span>`;
      }).join('') || '<span style="color:#b0a898;font-size:.6rem">无资源</span>';

      const npcTags = chars.length > 0
        ? chars.map(c => {
            const pwr = calcCombatPower(c, loc, worldConfig);
            return `<span class="map-npc-tag" style="background:#e8f0fa;color:#3a6a8a;padding:1px 5px;border-radius:3px;font-size:.6rem;margin-right:2px">${c.name}${c.identity.k_level >= 3 ? '☆' : ''}${pwr > 30 ? '⚔' : ''}</span>`;
          }).join('')
        : '<span style="color:#b0a898;font-size:.6rem">空</span>';

      const monTags = (loc.present_enemies || []).length > 0
        ? (loc.present_enemies || []).map(eid => {
            const def = (worldConfig.enemies || []).find(e => e.enemy_id === eid);
            return def ? `<span class="map-mon-tag" style="background:#fae8e8;color:#a05050;padding:1px 5px;border-radius:3px;font-size:.6rem;margin-right:2px">${def.name}</span>` : '';
          }).filter(Boolean).join('')
        : '';

      const card = document.createElement('div');
      card.className = 'char-card';
      card.style.cssText = 'font-size:.73rem;padding:8px 10px;margin:0';
      if (isHere) card.style.cssText += ';border:1px solid #3a8a7a;background:#3a8a7a0a;box-shadow:0 0 8px #3a8a7a20';

      card.innerHTML = `<span style="color:${dangerColor}">${dangerLabel}</span> <strong>${loc.name}</strong>${isHere ? ' <span style="color:#3a8a7a;font-size:.8rem">◆</span>' : ''}
        <br><small style="color:#8a8a7a">${loc.description.slice(0, 28)}...</small>
        <br><small style="color:#6a8a7a">人物:</small> <small>${npcTags}</small>
        ${monTags ? '<br><small style="color:#a06050">敌人:</small> <small>' + monTags + '</small>' : ''}
        <br><small style="color:#6a8a7a">资源:</small> <small style="line-height:1.8">${resTags}</small>`;
      grid.appendChild(card);
    }
  }

  // ── 角色面板 ──
  async function renderCharacters() {
    bpContent.innerHTML = '';
    const allChars = await loadAllCharacters();
    const player = await loadCharacter(playerId);
    const currentLoc = player?.position.location_id;
    const nearby = allChars.filter(c => !c.is_player && c.position.location_id === currentLoc);

    const h3 = document.createElement('h3');
    h3.style.cssText = 'color:#3a8a7a;margin:0 0 6px;font-size:.9rem;padding-bottom:4px;border-bottom:1px solid #e0d8c8';
    h3.textContent = `附近角色（${nearby.length}人）`;
    bpContent.appendChild(h3);

    if (nearby.length === 0) {
      const p = document.createElement('p');
      p.style.cssText = 'color:#8a8a7a;font-size:.75rem';
      p.textContent = '这里没有其他人。';
      bpContent.appendChild(p);
    }

    for (const c of nearby) {
      const rel = player?.relationships.find(r => r.target_id === c.character_id);
      const affStr = rel ? ((rel.hatred || 0) >= 60 ? '⚠仇敌' : rel.affinity > 0 ? '好感+' + rel.affinity : '敌意' + rel.affinity) : '中立0';
      const loc = (worldConfig.locations || []).find(l => l.location_id === c.position.location_id) || null;
      const power = calcCombatPower(c, loc, worldConfig);
      const invStr = c.inventory.slice(0, 6).map(r => {
        const def = worldConfig.resource_types.find(rt => rt.resource_type_id === r.resource_type_id);
        const name = def?.name || r.resource_type_id;
        const fq = fuzzyQuantity(r.quantity);
        return fq ? `${fq}${name}` : name;
      }).join('、') || '空';

      // NPC 对玩家的记忆
      const mems = (c.player_conversation_memory || []).slice(-3);
      const memStr = mems.length > 0
        ? ' 💭 ' + mems.map(m => m.summary).join(' | ')
        : '';

      const card = document.createElement('div');
      card.className = 'char-card';
      card.innerHTML = `<strong>${c.name}</strong> <span style="color:#8a8a7a">${c.identity.title} · ${K(c.identity.k_level)}</span><br><small>${c.permanent_memory.core_identity}</small><br><small>${affStr} | HP${c.stats.hp}/${c.stats.max_hp} | 战力${power} | <span class="p-level-tag p-level-${c.stats.p_level}">${P(c.stats.p_level)}</span></small><br><small style="color:#8a8a7a">物品: ${invStr}</small>${memStr ? `<br><small style="color:#6a8a7a;font-size:0.6rem">${memStr}</small>` : ''}`;
      bpContent.appendChild(card);
    }

    const locDef = (worldConfig.locations || []).find(l => l.location_id === currentLoc);
    const enemies = (worldConfig.enemies || []);
    const presentMonsters = locDef
      ? locDef.present_enemies.map(eid => enemies.find(e => e.enemy_id === eid)).filter(Boolean)
      : [];

    if (presentMonsters.length > 0) {
      const monH3 = document.createElement('h3');
      monH3.style.cssText = 'color:#e06060;margin:12px 0 6px;font-size:.8rem;padding-bottom:4px;border-bottom:1px solid #e0d8c8';
      monH3.textContent = `敌人（${presentMonsters.length}只）`;
      bpContent.appendChild(monH3);

      for (const m of presentMonsters) {
        if (!m) continue;
        const card = document.createElement('div');
        card.className = 'char-card mon-card';
        card.style.cssText = 'border-left:3px solid #c04040';
        card.innerHTML = `${m.danger_level === '高' ? '[高]' : m.danger_level === '中' ? '[中]' : '[低]'} <strong>${m.name}</strong> | HP ${m.hp} | 战力 ${m.combat_power} | ${P(m.p_level)}<br><small style="color:#8a8a7a">${m.description.slice(0, 50)}</small>${m.loot?.length ? '<br><small style="color:#4a7a5a">掉落: ' + m.loot.map(l => l.resource_type_id + '×' + l.quantity).join('、') + '</small>' : ''}`;
        bpContent.appendChild(card);
      }
    }
  }

  // ── 势力面板 ──
  async function renderFactions() {
    const factions = worldConfig.factions || [];
    const allChars = await loadAllCharacters();
    bpContent.innerHTML = '';

    let html = '';
    for (const f of factions) {
      const members = allChars.filter(c => c.faction_binding.faction_id === f.faction_id);
      const locs = (worldConfig.locations || []).filter(l => f.controlled_locations?.includes(l.location_id));
      html += `<div class="char-card" style="cursor:default">
        <div style="font-weight:700;color:#3a8a7a;font-size:.8rem;margin-bottom:4px">${f.name} <span style="color:#8a8a7a;font-size:.65rem">${K(f.k_level)}</span></div>
        <div style="color:#b0a898;font-size:.7rem">成员：${members.map(c => c.name).join('、') || '无'}（${members.length}人）</div>
        <div style="color:#b0a898;font-size:.7rem">控制地点：${locs.map(l => l.name).join('、') || '无'}</div>
        <div style="color:#b0a898;font-size:.7rem">核心利益：${f.core_interests?.join('、') || '未设定'}</div>
        <div style="color:#b0a898;font-size:.7rem">金库：${f.treasury?.length ? f.treasury.map(t => t.resource_type_id + '×' + t.quantity).join(' ') : '空'}</div>
      </div>`;
    }
    bpContent.innerHTML = html;
  }

  // ── 兑换面板 ──
  function renderExchangeRates() {
    const rates = worldConfig.exchange_rates || [];
    let html = '<h3 class="panel-section">兑换汇率</h3>';
    if (rates.length === 0) {
      html += '<p style="color:#8a8a7a;font-size:.75rem;padding:10px">暂无兑换汇率。</p>';
    } else {
      for (const r of rates) {
        const from = worldConfig.resource_types.find(rt => rt.resource_type_id === r.from_resource);
        const to = worldConfig.resource_types.find(rt => rt.resource_type_id === r.to_resource);
        html += `<div class="cmd-ref-item" style="cursor:default">
          <span class="cmd-ref-name">${from?.name || r.from_resource}</span>
          <span class="cmd-ref-arrow">→</span>
          <span class="cmd-ref-name">${to?.name || r.to_resource}</span>
          <span class="cmd-ref-hint" style="margin-left:auto">×${r.base_rate}</span>
        </div>`;
      }
    }
    bpContent.innerHTML = html;
  }

  // ── 制造面板 ──
  function renderCrafting() {
    const recipes = worldConfig.recipes || [];
    let html = '<h3 class="panel-section">制造配方</h3>';
    if (recipes.length === 0) {
      html += '<p style="color:#8a8a7a;font-size:.75rem;padding:10px">暂无制造配方。</p>';
    } else {
      for (const r of recipes) {
        const inputStr = r.inputs.map(i => {
          const def = worldConfig.resource_types.find(rt => rt.resource_type_id === i.resource_type_id);
          return `${def?.name || i.resource_type_id}×${i.quantity}`;
        }).join(' + ');
        const outputStr = r.outputs.map(o => {
          const def = worldConfig.resource_types.find(rt => rt.resource_type_id === o.resource_type_id);
          return `${def?.name || o.resource_type_id}×${o.quantity}`;
        }).join(' + ');
        const skillStr = r.prerequisite_skills?.length ? ` · 需${r.prerequisite_skills.length}技能` : '';
        html += `<div class="cmd-ref-item" style="cursor:default">
          <span class="cmd-ref-name">${r.name}</span>
          <span class="cmd-ref-hint">${inputStr} → ${outputStr}${skillStr}</span>
        </div>`;
      }
    }
    bpContent.innerHTML = html;
  }

  // ── 世界线面板 ──
  async function renderWorldline() {
    bpContent.innerHTML = '<h3 class="panel-section">世界线</h3>';
    bpContent.innerHTML += `<div class="char-card" style="cursor:default">世界流：<strong>${worldState.flow_count}</strong> | 阶段：<strong>${worldState.event_stage}</strong><br>时间：${timeToString(worldState.game_time)}<br>自由探索：${worldState.is_free_exploration ? '[Y]' : '[N]'} | 完结：${worldState.is_ended ? '是' : '否'}</div>`;

    const records = await getAllWorldFlowRecords();
    if (records.length) {
      bpContent.innerHTML += '<div class="panel-section">世界流记录</div>';
      const sorted = [...records].sort((a, b) => b.flow_number - a.flow_number);
      for (const rec of sorted) {
        const preview = rec.narrative ? rec.narrative.slice(0, 60) + '...' : '无叙事';
        const changes = rec.changeSummary?.length || 0;
        const card = document.createElement('div');
        card.className = 'wf-record-card';
        card.innerHTML = `
          <div class="wf-record-header">
            <span style="font-weight:700;color:#3a8a7a">#${rec.flow_number} · ${timeToString(rec.timestamp)}</span>
            <span style="font-size:.6rem;color:#8a8a7a">${changes}条变化</span>
          </div>
          <div class="wf-record-preview">${escapeHtml(preview)}</div>
          <div class="wf-record-footer">
            <button class="btn btn-sm wf-detail-btn" data-flow-id="${rec.flow_id}">详情</button>
          </div>`;
        bpContent.appendChild(card);
      }
      bpContent.querySelectorAll('.wf-detail-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const flowId = btn.dataset.flowId;
          const rec = records.find(r => r.flow_id === flowId);
          if (rec && window._showWorldFlowDetail) window._showWorldFlowDetail(rec);
        });
      });
    }
  }

  // ── 背包面板 ──
  async function renderBackpack() {
    const player = await loadCharacter(playerId);
    if (!player) { bpContent.innerHTML = '<p style="color:#8a8a7a">未找到角色数据。</p>'; return; }
    bpContent.innerHTML = '<h3 class="panel-section">背包</h3>';
    if (player.inventory.length === 0) {
      bpContent.innerHTML += '<p style="color:#8a8a7a;font-size:.75rem;padding:10px">空无一物。</p>';
      return;
    }
    const groups = { currency: [], material: [], consumable: [], skill: [], equipment: [], cultivation: [] };
    for (const item of player.inventory) {
      const def = worldConfig.resource_types.find(rt => rt.resource_type_id === item.resource_type_id);
      const cat = def?.category || 'material';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push({ ...item, def });
    }
    const catNames = mapping.resource_category_names || {};
    for (const [cat, items] of Object.entries(groups)) {
      if (items.length === 0) continue;
      bpContent.innerHTML += `<div class="panel-section">${catNames[cat] || cat}</div>`;
      for (const item of items) {
        const name = item.def?.name || item.resource_type_id;
        const rarity = item.def ? ` [${item.def.rarity}]` : '';
        const durability = item.durability !== undefined ? ` [耐久${item.durability}]` : '';
        bpContent.innerHTML += `<div class="cmd-ref-item" style="cursor:default">
          <span class="cmd-ref-name">${name}</span>
          <span class="cmd-ref-hint" style="margin-left:auto">${rarity} ×${item.quantity}${durability}</span>
        </div>`;
      }
    }
  }

  return {
    renderSelf, renderMap, renderCharacters, renderFactions,
    renderWorldline, renderBackpack,
  };
}
