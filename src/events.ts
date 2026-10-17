import { EventEmitter } from 'node:events';

export type Role = 'controller' | 'scanner' | 'investigator' | 'verifier' | 'fixer' | 'learner' | 'gate' | 'eval' | 'llm' | 'research' | 'vision';
export interface LpEvent { t: number; job?: string; role: Role; kind: 'info' | 'step' | 'finding' | 'warn' | 'error' | 'done'; msg: string; data?: unknown }

export const bus = new EventEmitter();
bus.setMaxListeners(100);

let quiet = false;
export function setQuiet(q: boolean) { quiet = q; }

const colors: Record<Role, string> = {
  controller: '37', scanner: '36', investigator: '35', verifier: '32', fixer: '33', learner: '34', gate: '31', eval: '96', llm: '90', research: '94',
  vision: '95',
};

export function emit(role: Role, kind: LpEvent['kind'], msg: string, data?: unknown, job?: string) {
  const e: LpEvent = { t: Date.now(), role, kind, msg, data, job };
  bus.emit('event', e);
  if (!quiet) console.log(`\x1b[${colors[role]}m[${role}]\x1b[0m ${msg}`);
}
