// 引擎层 —— AI 调用基础设施（世界观无关）
// 提供通用的 AI 对话/叙事/报告接口，具体的 prompt 由转化层构建

import type { CharacterInstance, WorldState, WorldCardConfig, AIInstruction, InstructionType, APILogEntry } from './types';
import { saveAPILog } from './db';
import { timeToString } from './time';
import { getAPIKey, API_URL, MODEL_NAME, genId, API_TIMEOUT_MS } from './config';

// 模块级当前世界流编号 —— 由 worldFlow.ts 在执行前设置
let _currentFlowNumber: number | undefined;

export function setCurrentFlowNumber(n: number | undefined) { _currentFlowNumber = n; }
export function getCurrentFlowNumber() { return _currentFlowNumber; }

export async function callDeepSeek(
  systemPrompt: string, userPrompt: string,
  logMeta: { type: APILogEntry['type']; gameTime: string; characterName?: string; flowNumber?: number },
  maxTokens: number = 500,
  temperature: number = 0.7,
): Promise<{ text: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
  const startTime = Date.now();
  const entry: APILogEntry = {
    id: genId('api_'), timestamp: startTime, gameTime: logMeta.gameTime,
    flow_number: logMeta.flowNumber ?? _currentFlowNumber,
    type: logMeta.type, characterName: logMeta.characterName,
    request: { model: MODEL_NAME, systemPrompt, userPrompt, maxTokens },
    durationMs: 0,
  };

  let logSaved = false;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getAPIKey()}` },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        max_tokens: maxTokens, temperature,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const durationMs = Date.now() - startTime;
    entry.durationMs = durationMs;

    if (!response.ok) {
      const err = await response.text();
      entry.error = `HTTP ${response.status}: ${err.slice(0, 200)}`;
      await saveAPILog(entry);
      logSaved = true;
      throw new Error(`DeepSeek API error: ${response.status}`);
    }

    const data = await response.json();
    if (!data.choices?.length || !data.choices[0].message?.content) {
      entry.error = 'API 返回空响应';
      await saveAPILog(entry);
      logSaved = true;
      throw new Error('DeepSeek API returned empty choices');
    }
    const text = data.choices[0].message.content;
    const usage = data.usage;
    entry.response = { text, tokenUsage: usage };
    entry.durationMs = durationMs;
    await saveAPILog(entry);
    logSaved = true;
    return { text, usage };
  } catch (e: any) {
    entry.durationMs = Date.now() - startTime;
    if (!entry.error) entry.error = e.message;
    // 避免重复保存：仅在尚未保存过日志时保存
    if (!logSaved) {
      try { await saveAPILog(entry); } catch { /* 日志保存失败不应掩盖原错误 */ }
    }
    throw e;
  }
}

// ── 对话AI（接收拆分的 systemPrompt + userPrompt） ──
export async function converseAI(
  character: CharacterInstance, worldState: WorldState, config: WorldCardConfig,
  systemPrompt: string, userPrompt: string
): Promise<{ text: string; instructions?: AIInstruction[] }> {
  try {
    const { text } = await callDeepSeek(systemPrompt, userPrompt, {
      type: 'conversation', gameTime: timeToString(worldState.game_time), characterName: character.name,
    });
    
    const instructions = extractInstructions(text, config);
    const cleanText = text.replace(/\[INSTRUCTION:[^\]]*\]/g, '').trim();
    
    return { text: cleanText, instructions: instructions.length > 0 ? instructions : undefined };
  } catch (e) {
    console.error('对话AI调用失败:', e);
    return { text: `${character.name}沉默了片刻，似乎在想什么。` };
  }
}

function extractInstructions(text: string, config: WorldCardConfig): AIInstruction[] {
  const results: AIInstruction[] = [];
  const regex = /\[INSTRUCTION:\s*(\S+)\s+(\S+)\s+([+-]?\d+)\s*([^\]]*?)\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const [, type, targetId, deltaStr, reason] = match;
    const delta = parseInt(deltaStr);
    if (isNaN(delta)) continue;
    results.push({ instruction_type: type, target_id: targetId, delta, reason: reason?.trim() || '' });
  }
  return results;
}

// ── 世界AI（通用：prompt 由转化层构建后传入） ──
export async function worldAI(fullPrompt: string, worldState: WorldState): Promise<string | null> {
  try {
    const { text } = await callDeepSeek(fullPrompt, '请生成世界叙事。', {
      type: 'world_narrative', gameTime: timeToString(worldState.game_time),
    }, 4000);
    return text;
  } catch (e) {
    console.error('世界AI调用失败:', e);
    return null;
  }
}

// ── 报告AI（通用：prompt 由转化层构建后传入） ──
export async function reportAI(character: CharacterInstance, fullPrompt: string, worldState: WorldState): Promise<string> {
  try {
    const { text } = await callDeepSeek(fullPrompt, '请生成角色报告。', {
      type: 'report', gameTime: timeToString(worldState.game_time), characterName: character.name,
    });
    return text.slice(0, 100);
  } catch (e) {
    return `${character.name}按部就班地度过了一天。`;
  }
}

// ── 指令管线验证（三道检查，纯逻辑） ──
export function validateInstruction(
  instruction: AIInstruction, whiteList: InstructionType[]
): { valid: boolean; reason?: string } {
  const typeDef = whiteList.find(t => t.type === instruction.instruction_type);
  if (!typeDef) return { valid: false, reason: `指令类型 ${instruction.instruction_type} 不在白名单中` };
  if (!typeDef.allowed_targets.includes(instruction.target_id)) {
    return { valid: false, reason: `目标 ${instruction.target_id} 不在该指令类型允许列表中` };
  }
  if (Math.abs(instruction.delta) > typeDef.max_delta) {
    return { valid: false, reason: `变化量 ${instruction.delta} 超出上限 ${typeDef.max_delta}` };
  }
  return { valid: true };
}