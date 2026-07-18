import type { WorldState, WorldCardConfig } from './types';
import { executeWorldFlow } from './worldFlow';

export async function initializeWorld(
  worldState: WorldState, config: WorldCardConfig,
  onProgress?: (step: string, detail: string) => void
): Promise<void> {
  // 调用 executeWorldFlow(isInitialFlow=true)
  await executeWorldFlow(
    worldState,
    config,
    false, // 不跳过 AI
    (step, lines) => {
      onProgress?.(step, lines.join(' | '));
    },
    true, // isInitialFlow
  );
}
