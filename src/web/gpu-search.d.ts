// Types for what TypeScript imports from gpu-search.js (plain JS: the browser loads it as is).
import type { GpuModel } from '../engine/gpu-model.ts';

export const CHANNELS: string[];
export const CH: Record<string, number>;
export const P: Record<string, number>;
export const STRIDE: number;
export function binomial(n: number, k: number): number;
export function proxyScore(model: GpuModel, combo: number[]): number;
export function cpuSearch(model: GpuModel, limit?: number): Array<{ combo: number[]; score: number }>;
