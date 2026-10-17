import { BackendStore } from './store.ts';
import type { Job } from './store.ts';

export type JobExecutor = (job: Job) => Promise<unknown>;
export class JobWorker {
  readonly store: BackendStore;
  readonly execute: JobExecutor;
  private pending: Promise<void> | null = null;
  private stopped = false;
  constructor(store: BackendStore, execute: JobExecutor) { this.store = store; this.execute = execute; }
  kick(): void {
    if (this.pending || this.stopped) return;
    this.pending = this.drain().finally(() => { this.pending = null; if (!this.stopped && this.store.jobs().some((job) => job.status === 'queued')) this.kick(); });
  }
  private async drain(): Promise<void> {
    while (!this.stopped) {
      const job = this.store.claim(); if (!job) return;
      try { this.store.finish(job.id, await this.execute(job)); }
      catch { this.store.fail(job.id, 'Job failed. Inspect the scoped progress events; private provider responses were not exposed.'); }
    }
  }
  async idle(): Promise<void> { while (this.pending) await this.pending; }
  async stop(): Promise<void> { this.stopped = true; await this.idle(); }
}
