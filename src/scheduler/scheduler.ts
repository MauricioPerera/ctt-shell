/**
 * Task Scheduler — persistent scheduled tasks with cron expressions.
 *
 * Stores tasks as JSON in .ctt-shell/store/schedule/.
 * Runs as a daemon loop (setInterval every 60s) checking cron matches.
 * Executes matched tasks via the AutonomousAgent pipeline.
 * Logs execution history to .ctt-shell/logs/scheduler.jsonl.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseCron, cronMatches, validateCron, describeCron, nextRun, type CronFields } from './cron-parser.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ScheduledTask {
  id: string;
  cron: string;
  goal: string;
  domainId?: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastResult?: 'success' | 'failure';
  lastError?: string;
  nextRunAt?: string;
  runCount: number;
  failCount: number;
}

export interface ScheduleLogEntry {
  taskId: string;
  goal: string;
  domainId?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  success: boolean;
  error?: string;
  stepCount?: number;
}

export interface TaskRunner {
  run(goal: string, domainId?: string): Promise<{ success: boolean; error?: string; steps?: number }>;
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

export class Scheduler {
  private scheduleDir: string;
  private logPath: string;
  private tasks: Map<string, ScheduledTask> = new Map();
  private parsedCrons: Map<string, CronFields> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private runner: TaskRunner | null = null;
  private running = false;

  constructor(rootDir: string) {
    this.scheduleDir = join(rootDir, 'store', 'schedule');
    this.logPath = join(rootDir, 'logs', 'scheduler.jsonl');
    mkdirSync(this.scheduleDir, { recursive: true });
    mkdirSync(join(rootDir, 'logs'), { recursive: true });
    this.loadTasks();
  }

  // ─── Task CRUD ──────────────────────────────────────────────────────────

  /** Add a new scheduled task */
  add(cron: string, goal: string, domainId?: string): ScheduledTask {
    const error = validateCron(cron);
    if (error) throw new Error(`Invalid cron expression: ${error}`);

    const id = randomBytes(6).toString('hex');
    const fields = parseCron(cron);
    const next = nextRun(fields);

    const task: ScheduledTask = {
      id,
      cron,
      goal,
      domainId,
      enabled: true,
      createdAt: new Date().toISOString(),
      nextRunAt: next?.toISOString(),
      runCount: 0,
      failCount: 0,
    };

    this.tasks.set(id, task);
    this.parsedCrons.set(id, fields);
    this.saveTask(task);
    return task;
  }

  /** Remove a scheduled task */
  remove(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;

    this.tasks.delete(id);
    this.parsedCrons.delete(id);

    const filePath = join(this.scheduleDir, `${id}.json`);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    return true;
  }

  /** Enable or disable a task */
  setEnabled(id: string, enabled: boolean): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;

    task.enabled = enabled;
    if (enabled) {
      const fields = this.parsedCrons.get(id) || parseCron(task.cron);
      task.nextRunAt = nextRun(fields)?.toISOString();
    } else {
      task.nextRunAt = undefined;
    }
    this.saveTask(task);
    return true;
  }

  /** Get a task by ID */
  get(id: string): ScheduledTask | undefined {
    return this.tasks.get(id);
  }

  /** List all tasks */
  list(): ScheduledTask[] {
    return [...this.tasks.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  /** Get task count */
  get size(): number {
    return this.tasks.size;
  }

  // ─── Daemon ─────────────────────────────────────────────────────────────

  /** Start the scheduler daemon loop (checks every 60s) */
  start(runner: TaskRunner): void {
    if (this.timer) return; // Already running

    this.runner = runner;
    this.running = true;

    // Check every 60 seconds (call tick() manually for immediate execution)
    this.timer = setInterval(() => this.tick(), 60_000);

    // Prevent timer from keeping the process alive if it's the only thing running
    if (this.timer.unref) this.timer.unref();
  }

  /** Stop the scheduler daemon */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.runner = null;
  }

  /** Check current time against all tasks and execute matches */
  async tick(now: Date = new Date()): Promise<ScheduleLogEntry[]> {
    const entries: ScheduleLogEntry[] = [];

    for (const [id, task] of this.tasks) {
      if (!task.enabled) continue;

      const fields = this.parsedCrons.get(id);
      if (!fields) continue;

      if (cronMatches(fields, now)) {
        const entry = await this.executeTask(task);
        entries.push(entry);
      }
    }

    return entries;
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private async executeTask(task: ScheduledTask): Promise<ScheduleLogEntry> {
    const startedAt = new Date().toISOString();
    const start = Date.now();

    let success = false;
    let error: string | undefined;
    let stepCount: number | undefined;

    try {
      if (!this.runner) throw new Error('No task runner configured');

      const result = await this.runner.run(task.goal, task.domainId);
      success = result.success;
      error = result.error;
      stepCount = result.steps;
    } catch (e) {
      success = false;
      error = e instanceof Error ? e.message : String(e);
    }

    const durationMs = Date.now() - start;
    const finishedAt = new Date().toISOString();

    // Update task stats
    task.lastRunAt = startedAt;
    task.lastResult = success ? 'success' : 'failure';
    task.lastError = error;
    task.runCount++;
    if (!success) task.failCount++;

    // Calculate next run
    const fields = this.parsedCrons.get(task.id);
    if (fields) {
      task.nextRunAt = nextRun(fields)?.toISOString();
    }

    this.saveTask(task);

    // Log entry
    const entry: ScheduleLogEntry = {
      taskId: task.id,
      goal: task.goal,
      domainId: task.domainId,
      startedAt,
      finishedAt,
      durationMs,
      success,
      error,
      stepCount,
    };

    this.appendLog(entry);
    return entry;
  }

  private loadTasks(): void {
    if (!existsSync(this.scheduleDir)) return;

    for (const file of readdirSync(this.scheduleDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = readFileSync(join(this.scheduleDir, file), 'utf-8');
        const task = JSON.parse(raw) as ScheduledTask;
        this.tasks.set(task.id, task);
        this.parsedCrons.set(task.id, parseCron(task.cron));
      } catch { /* skip corrupt files */ }
    }
  }

  private saveTask(task: ScheduledTask): void {
    const filePath = join(this.scheduleDir, `${task.id}.json`);
    writeFileSync(filePath, JSON.stringify(task, null, 2));
  }

  private appendLog(entry: ScheduleLogEntry): void {
    try {
      appendFileSync(this.logPath, JSON.stringify(entry) + '\n');
    } catch { /* non-critical */ }
  }
}
