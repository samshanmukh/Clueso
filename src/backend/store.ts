import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type JobType = 'audit' | 'learn' | 'evaluate' | 'references';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
export type Project = { id: string; name: string; url: string; createdAt: string; updatedAt: string };
export type Job = { id: string; type: JobType; projectId: string | null; status: JobStatus; input: Record<string, unknown>; result: unknown; error: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null };
export type StoredEvent = { id: number; jobId: string; type: string; at: string; data: unknown };
type Row = Record<string, unknown>;

export class BackendStore {
  readonly db: DatabaseSync;
  readonly changes = new EventEmitter();
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,type TEXT NOT NULL,project_id TEXT REFERENCES projects(id),status TEXT NOT NULL,input TEXT NOT NULL,result TEXT,error TEXT,created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,idempotency_key TEXT UNIQUE,request_hash TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status,created_at);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL REFERENCES jobs(id),type TEXT NOT NULL,at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_job ON events(job_id,id);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),path TEXT NOT NULL,mime TEXT NOT NULL,name TEXT NOT NULL);
    `);
    this.changes.setMaxListeners(100);
  }
  project(row: Row): Project { return { id: String(row.id), name: String(row.name), url: String(row.url), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
  createProject(name: string, url: string): Project {
    const now = new Date().toISOString(); const id = randomUUID();
    this.db.prepare('INSERT INTO projects VALUES(?,?,?,?,?)').run(id, name, url, now, now);
    return this.getProject(id)!;
  }
  getProject(id: string): Project | null { const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id); return row ? this.project(row) : null; }
  projects(): Project[] { return this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC LIMIT 100').all().map((r) => this.project(r)); }
  decodeJob(row: Row): Job {
    return { id: String(row.id), type: row.type as JobType, projectId: row.project_id == null ? null : String(row.project_id), status: row.status as JobStatus,
      input: JSON.parse(String(row.input)), result: row.result == null ? null : JSON.parse(String(row.result)), error: row.error == null ? null : String(row.error),
      createdAt: String(row.created_at), startedAt: row.started_at == null ? null : String(row.started_at), finishedAt: row.finished_at == null ? null : String(row.finished_at) };
  }
  createJob(type: JobType, input: Record<string, unknown>, projectId: string | null = null, idempotencyKey?: string): { job: Job; reused: boolean } {
    const requestHash = createHash('sha256').update(JSON.stringify({ type, input, projectId })).digest('hex');
    if (idempotencyKey) {
      const previous = this.db.prepare('SELECT * FROM jobs WHERE idempotency_key=?').get(idempotencyKey);
      if (previous) {
        if (previous.request_hash !== requestHash) throw new Error('Idempotency key was already used for different input.');
        return { job: this.decodeJob(previous), reused: true };
      }
    }
    const id = randomUUID(); const now = new Date().toISOString();
    this.db.prepare('INSERT INTO jobs(id,type,project_id,status,input,created_at,idempotency_key,request_hash) VALUES(?,?,?,?,?,?,?,?)').run(id, type, projectId, 'queued', JSON.stringify(input), now, idempotencyKey ?? null, requestHash);
    const job = this.job(id)!; this.event(id, 'job.queued', { type }); return { job, reused: false };
  }
  job(id: string): Job | null { const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); return row ? this.decodeJob(row) : null; }
  jobs(projectId?: string): Job[] {
    const rows = projectId ? this.db.prepare('SELECT * FROM jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 100').all(projectId) : this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100').all();
    return rows.map((row) => this.decodeJob(row));
  }
  claim(): Job | null {
    this.db.exec('BEGIN IMMEDIATE');
    let job: Job | null = null;
    try {
      const row = this.db.prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1").get();
      if (row) { this.db.prepare("UPDATE jobs SET status='running',started_at=? WHERE id=? AND status='queued'").run(new Date().toISOString(), String(row.id)); job = this.job(String(row.id)); }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (job) this.event(job.id, 'job.running', {});
    return job;
  }
  finish(id: string, result: unknown): void {
    const changed = this.db.prepare("UPDATE jobs SET status='completed',result=?,finished_at=? WHERE id=? AND status='running'").run(JSON.stringify(result ?? null), new Date().toISOString(), id);
    if (changed.changes) this.event(id, 'job.completed', {});
  }
  fail(id: string, message: string): void {
    const changed = this.db.prepare("UPDATE jobs SET status='failed',error=?,finished_at=? WHERE id=? AND status='running'").run(message, new Date().toISOString(), id);
    if (changed.changes) this.event(id, 'job.failed', { message });
  }
  cancel(id: string): boolean {
    const result = this.db.prepare("UPDATE jobs SET status='cancelled',finished_at=? WHERE id=? AND status='queued'").run(new Date().toISOString(), id);
    if (result.changes) this.event(id, 'job.cancelled', {});
    return Boolean(result.changes);
  }
  recoverInterrupted(): number {
    const jobs = this.db.prepare("SELECT id FROM jobs WHERE status='running'").all();
    for (const row of jobs) {
      this.db.prepare("UPDATE jobs SET status='interrupted',error=?,finished_at=? WHERE id=?").run('Worker stopped before completion; not automatically retried.', new Date().toISOString(), String(row.id));
      this.event(String(row.id), 'job.interrupted', {});
    }
    return jobs.length;
  }
  event(jobId: string, type: string, data: unknown): StoredEvent {
    const at = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO events(job_id,type,at,data) VALUES(?,?,?,?)').run(jobId, type, at, JSON.stringify(data ?? null));
    const event = { id: Number(result.lastInsertRowid), jobId, type, at, data };
    this.changes.emit('event', event); return event;
  }
  events(jobId: string, after = 0): StoredEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE job_id=? AND id>? ORDER BY id LIMIT 500').all(jobId, after).map((row) => ({ id: Number(row.id), jobId, type: String(row.type), at: String(row.at), data: JSON.parse(String(row.data)) }));
  }
  addArtifact(jobId: string, path: string, mime: string, name: string): string {
    const previous = this.db.prepare('SELECT id FROM artifacts WHERE job_id=? AND path=?').get(jobId, path);
    if (previous) return String(previous.id);
    const id = randomUUID(); this.db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?)').run(id, jobId, path, mime, name); return id;
  }
  artifacts(jobId: string): { id: string; name: string; mime: string; url: string }[] {
    return this.db.prepare('SELECT id,name,mime FROM artifacts WHERE job_id=? ORDER BY name').all(jobId).map((row) => ({ id: String(row.id), name: String(row.name), mime: String(row.mime), url: `/api/jobs/${jobId}/artifacts/${row.id}` }));
  }
  artifact(jobId: string, id: string): { path: string; mime: string; name: string } | null {
    const row = this.db.prepare('SELECT path,mime,name FROM artifacts WHERE job_id=? AND id=?').get(jobId, id);
    return row ? { path: String(row.path), mime: String(row.mime), name: String(row.name) } : null;
  }
  close(): void { this.db.close(); }
}
