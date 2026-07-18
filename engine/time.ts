import type { GameTime, Season, TimeOfDay } from './types';

export function timeToString(t: GameTime): string {
  return `${t.year}年 ${t.season} ${t.day}日 ${t.timeOfDay}`;
}

export function advanceTimeOfDay(tod: TimeOfDay): TimeOfDay {
  const order: TimeOfDay[] = ['卯时','午时','酉时','子时'];
  return order[(order.indexOf(tod) + 1) % 4];
}

export function advanceDay(t: GameTime, seasonDays: Record<Season,number>): GameTime {
  const newTod = advanceTimeOfDay(t.timeOfDay);
  if (newTod !== '卯时') return { ...t, timeOfDay: newTod };
  const newDay = t.day + 1;
  const maxDays = seasonDays[t.season];
  if (newDay <= maxDays) return { ...t, day: newDay, timeOfDay: newTod };
  const seasonOrder: Season[] = ['春','夏','秋','冬'];
  const idx = seasonOrder.indexOf(t.season);
  if (idx < 3) return { ...t, season: seasonOrder[idx+1], day: 1, timeOfDay: newTod };
  return { ...t, year: t.year + 1, season: '春', day: 1, timeOfDay: newTod };
}

export function advanceWorldFlowStep(t: GameTime, days: number, seasonDays: Record<Season,number>): GameTime {
  let result = { ...t };
  for (let i = 0; i < days * 4; i++) result = advanceDay(result, seasonDays);
  return result;
}
