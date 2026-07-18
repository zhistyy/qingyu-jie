// 战斗 HUD —— 从 game.js 提取

export function createCombatHUD(state) {
  const { getActiveCombat } = state;

  function updateCombatHUD() {
    const hud = document.getElementById('combat-hud');
    if (!hud) return;

    const activeCombat = getActiveCombat();
    if (!activeCombat || activeCombat.ended) {
      hud.classList.add('combat-hud-hidden');
      return;
    }

    hud.classList.remove('combat-hud-hidden');

    const playerHpEl = document.getElementById('chud-player-hp');
    const playerBarEl = document.getElementById('chud-player-bar');
    const enemyNameEl = document.getElementById('chud-enemy-name');
    const enemyHpEl = document.getElementById('chud-enemy-hp');
    const enemyBarEl = document.getElementById('chud-enemy-bar');

    const playerMaxHp = activeCombat.playerMaxHp || 30;
    const enemyMaxHp = activeCombat.enemyMaxHp || 30;

    if (playerHpEl) playerHpEl.textContent = `HP ${activeCombat.playerHp}/${playerMaxHp}`;
    if (playerBarEl) playerBarEl.style.width = Math.round(activeCombat.playerHp / playerMaxHp * 100) + '%';
    if (enemyNameEl) enemyNameEl.textContent = activeCombat.enemyName || '—';
    if (enemyHpEl) enemyHpEl.textContent = `HP ${activeCombat.enemyHp}/${enemyMaxHp}`;
    if (enemyBarEl) enemyBarEl.style.width = Math.round(activeCombat.enemyHp / enemyMaxHp * 100) + '%';
  }

  return { updateCombatHUD };
}
