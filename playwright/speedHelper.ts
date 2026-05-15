import { globalState } from '../state/globalState';

export function isSpeedMode(): boolean {
  return !!(globalState.getState().config as any)?.speedMode;
}

export function sp(normal: number): number {
  return isSpeedMode() ? Math.max(30, Math.round(normal * 0.4)) : normal;
}
