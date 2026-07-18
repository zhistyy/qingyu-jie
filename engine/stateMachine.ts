// 游戏状态机 —— 管理全局状态转换和入口守卫
// 集中管理 idle / dialog / combat / world_flow 四个状态
// 不修改任何现有逻辑，只做状态追踪 + 转换校验

export type GameState = 'idle' | 'dialog' | 'combat' | 'world_flow';

interface StateDef {
  /** 此状态下允许的指令前缀（未列出的指令会被拒绝） */
  allowedCommands: string[];
  /** 从此状态可以转到哪些状态 */
  transitions: GameState[];
}

const STATE_MAP: Record<GameState, StateDef> = {
  idle: {
    allowedCommands: ['状态', '背包', '地图', '存档'],
    transitions: ['dialog', 'combat', 'world_flow'],
  },
  dialog: {
    allowedCommands: ['状态', '背包', '地图'],
    transitions: ['idle', 'combat'],
  },
  combat: {
    allowedCommands: ['状态'],
    transitions: ['idle'],
  },
  world_flow: {
    allowedCommands: [],
    transitions: ['idle'],
  },
};

export class GameStateMachine {
  private _state: GameState = 'idle';
  private _context: Record<string, any> = {};

  get state(): GameState { return this._state; }
  get context(): Record<string, any> { return this._context; }

  get isIdle() { return this._state === 'idle'; }
  get isDialog() { return this._state === 'dialog'; }
  get isCombat() { return this._state === 'combat'; }
  get isWorldFlow() { return this._state === 'world_flow'; }

  /** 检查是否可以执行某个指令 */
  canExecute(command: string): boolean {
    const cmd = command.startsWith('/') ? command.slice(1).split(/\s+/)[0] : command;
    // 自由文本（非指令）在 idle / combat / dialog 下允许
    if (!command.startsWith('/')) return this._state === 'combat' || this._state === 'dialog' || this._state === 'idle';
    return STATE_MAP[this._state].allowedCommands.includes(cmd);
  }

  /** 是否可以转换到目标状态 */
  canTransitionTo(target: GameState): boolean {
    return STATE_MAP[this._state].transitions.includes(target);
  }

  /** 执行状态转换，返回是否成功 */
  transition(target: GameState, ctx?: Record<string, any>): boolean {
    if (!this.canTransitionTo(target)) return false;
    this._state = target;
    if (ctx) this._context = { ...this._context, ...ctx };
    return true;
  }

  /** 重置到 idle */
  toIdle(): void { this._state = 'idle'; this._context = {}; }

  /** 获取当前状态描述 */
  get description(): string {
    const labels: Record<GameState, string> = {
      idle: '自由探索',
      dialog: '对话中',
      combat: '战斗中',
      world_flow: '世界流转中',
    };
    return labels[this._state];
  }
}
