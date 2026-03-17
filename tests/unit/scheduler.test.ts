/**
 * Tests for Scheduler: cron parser + task scheduler.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseCron, cronMatches, validateCron, describeCron, nextRun } from '../../src/scheduler/cron-parser.js';
import { Scheduler, type TaskRunner } from '../../src/scheduler/scheduler.js';

// ─── Cron Parser ──────────────────────────────────────────────────────────────

describe('parseCron', () => {
  it('parses wildcard fields', () => {
    const fields = parseCron('* * * * *');
    assert.equal(fields.minute.size, 60);
    assert.equal(fields.hour.size, 24);
    assert.equal(fields.dayOfMonth.size, 31);
    assert.equal(fields.month.size, 12);
    assert.equal(fields.dayOfWeek.size, 7);
  });

  it('parses exact values', () => {
    const fields = parseCron('30 9 15 6 3');
    assert.deepEqual([...fields.minute], [30]);
    assert.deepEqual([...fields.hour], [9]);
    assert.deepEqual([...fields.dayOfMonth], [15]);
    assert.deepEqual([...fields.month], [6]);
    assert.deepEqual([...fields.dayOfWeek], [3]);
  });

  it('parses ranges', () => {
    const fields = parseCron('0-5 9-17 * * 1-5');
    assert.equal(fields.minute.size, 6); // 0,1,2,3,4,5
    assert.equal(fields.hour.size, 9);   // 9..17
    assert.equal(fields.dayOfWeek.size, 5); // Mon-Fri
    assert.ok(fields.dayOfWeek.has(1));
    assert.ok(fields.dayOfWeek.has(5));
    assert.ok(!fields.dayOfWeek.has(0)); // no Sunday
  });

  it('parses lists', () => {
    const fields = parseCron('0,15,30,45 * * * *');
    assert.equal(fields.minute.size, 4);
    assert.ok(fields.minute.has(0));
    assert.ok(fields.minute.has(15));
    assert.ok(fields.minute.has(30));
    assert.ok(fields.minute.has(45));
  });

  it('parses intervals (*/N)', () => {
    const fields = parseCron('*/15 */6 * * *');
    assert.equal(fields.minute.size, 4); // 0,15,30,45
    assert.equal(fields.hour.size, 4);   // 0,6,12,18
    assert.ok(fields.minute.has(0));
    assert.ok(fields.minute.has(45));
    assert.ok(fields.hour.has(0));
    assert.ok(fields.hour.has(18));
  });

  it('parses range with step (N-M/S)', () => {
    const fields = parseCron('0-30/10 * * * *');
    assert.equal(fields.minute.size, 4); // 0,10,20,30
    assert.ok(fields.minute.has(0));
    assert.ok(fields.minute.has(10));
    assert.ok(fields.minute.has(20));
    assert.ok(fields.minute.has(30));
  });

  it('treats day-of-week 7 as Sunday (0)', () => {
    const fields = parseCron('0 0 * * 7');
    assert.ok(fields.dayOfWeek.has(0));
    assert.equal(fields.dayOfWeek.size, 1);
  });

  it('parses @daily shortcut', () => {
    const fields = parseCron('@daily');
    assert.deepEqual([...fields.minute], [0]);
    assert.deepEqual([...fields.hour], [0]);
    assert.equal(fields.dayOfMonth.size, 31);
    assert.equal(fields.month.size, 12);
    assert.equal(fields.dayOfWeek.size, 7);
  });

  it('parses @hourly shortcut', () => {
    const fields = parseCron('@hourly');
    assert.deepEqual([...fields.minute], [0]);
    assert.equal(fields.hour.size, 24);
  });

  it('parses @weekly shortcut', () => {
    const fields = parseCron('@weekly');
    assert.deepEqual([...fields.minute], [0]);
    assert.deepEqual([...fields.hour], [0]);
    assert.deepEqual([...fields.dayOfWeek], [0]); // Sunday
  });

  it('parses @monthly shortcut', () => {
    const fields = parseCron('@monthly');
    assert.deepEqual([...fields.dayOfMonth], [1]);
  });

  it('parses @yearly shortcut', () => {
    const fields = parseCron('@yearly');
    assert.deepEqual([...fields.month], [1]);
    assert.deepEqual([...fields.dayOfMonth], [1]);
  });

  it('throws on invalid field count', () => {
    assert.throws(() => parseCron('* * *'), /must have 5 fields/);
    assert.throws(() => parseCron('* * * * * *'), /must have 5 fields/);
  });

  it('throws on out-of-range values', () => {
    assert.throws(() => parseCron('60 * * * *'), /out of range/);
    assert.throws(() => parseCron('* 25 * * *'), /out of range/);
    assert.throws(() => parseCron('* * 32 * *'), /out of range/);
    assert.throws(() => parseCron('* * * 13 *'), /out of range/);
    assert.throws(() => parseCron('* * * * 8'), /out of range/);
  });

  it('throws on invalid syntax', () => {
    assert.throws(() => parseCron('abc * * * *'), /Invalid value/);
  });
});

// ─── cronMatches ──────────────────────────────────────────────────────────────

describe('cronMatches', () => {
  it('matches exact time', () => {
    const fields = parseCron('30 9 * * *');
    // 2026-03-17 09:30
    assert.ok(cronMatches(fields, new Date(2026, 2, 17, 9, 30)));
    assert.ok(!cronMatches(fields, new Date(2026, 2, 17, 9, 31)));
    assert.ok(!cronMatches(fields, new Date(2026, 2, 17, 10, 30)));
  });

  it('matches every minute', () => {
    const fields = parseCron('* * * * *');
    assert.ok(cronMatches(fields, new Date()));
  });

  it('matches day of week', () => {
    const fields = parseCron('0 9 * * 1'); // Monday at 9:00
    // 2026-03-16 is Monday
    assert.ok(cronMatches(fields, new Date(2026, 2, 16, 9, 0)));
    // 2026-03-17 is Tuesday
    assert.ok(!cronMatches(fields, new Date(2026, 2, 17, 9, 0)));
  });

  it('matches month', () => {
    const fields = parseCron('0 0 1 1 *'); // Jan 1 midnight
    assert.ok(cronMatches(fields, new Date(2026, 0, 1, 0, 0)));
    assert.ok(!cronMatches(fields, new Date(2026, 1, 1, 0, 0))); // Feb
  });

  it('matches interval pattern', () => {
    const fields = parseCron('*/15 * * * *');
    assert.ok(cronMatches(fields, new Date(2026, 0, 1, 0, 0)));
    assert.ok(cronMatches(fields, new Date(2026, 0, 1, 0, 15)));
    assert.ok(cronMatches(fields, new Date(2026, 0, 1, 0, 30)));
    assert.ok(cronMatches(fields, new Date(2026, 0, 1, 0, 45)));
    assert.ok(!cronMatches(fields, new Date(2026, 0, 1, 0, 10)));
  });
});

// ─── validateCron ─────────────────────────────────────────────────────────────

describe('validateCron', () => {
  it('returns null for valid expressions', () => {
    assert.equal(validateCron('* * * * *'), null);
    assert.equal(validateCron('0 9 * * 1-5'), null);
    assert.equal(validateCron('@daily'), null);
    assert.equal(validateCron('*/15 * * * *'), null);
  });

  it('returns error string for invalid expressions', () => {
    assert.ok(validateCron('invalid') !== null);
    assert.ok(validateCron('60 * * * *') !== null);
    assert.ok(validateCron('* * *') !== null);
  });
});

// ─── describeCron ─────────────────────────────────────────────────────────────

describe('describeCron', () => {
  it('describes shortcuts', () => {
    assert.ok(describeCron('@daily').includes('midnight'));
    assert.ok(describeCron('@hourly').includes('hour'));
    assert.ok(describeCron('@weekly').includes('week'));
  });

  it('describes specific times', () => {
    const desc = describeCron('30 9 * * *');
    assert.ok(desc.includes('30'));
    assert.ok(desc.includes('9'));
  });

  it('describes weekday filters', () => {
    const desc = describeCron('0 9 * * 1-5');
    assert.ok(desc.includes('Mon'));
    assert.ok(desc.includes('Fri'));
  });
});

// ─── nextRun ──────────────────────────────────────────────────────────────────

describe('nextRun', () => {
  it('finds next matching time', () => {
    const fields = parseCron('0 9 * * *'); // daily at 9:00
    const after = new Date(2026, 2, 17, 8, 0); // 8:00 AM
    const next = nextRun(fields, after);
    assert.ok(next);
    assert.equal(next.getHours(), 9);
    assert.equal(next.getMinutes(), 0);
  });

  it('wraps to next day if time has passed', () => {
    const fields = parseCron('0 9 * * *');
    const after = new Date(2026, 2, 17, 10, 0); // 10:00 AM (past 9)
    const next = nextRun(fields, after);
    assert.ok(next);
    assert.equal(next.getDate(), 18); // next day
    assert.equal(next.getHours(), 9);
  });

  it('returns null for impossible expression', () => {
    // Feb 31 doesn't exist, but the loop should still terminate
    const fields = parseCron('0 0 31 2 *');
    const next = nextRun(fields, new Date(2026, 0, 1));
    assert.equal(next, null);
  });
});

// ─── Scheduler ────────────────────────────────────────────────────────────────

describe('Scheduler', () => {
  let tmpDir: string;
  let scheduler: Scheduler;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ctt-sched-'));
    scheduler = new Scheduler(tmpDir);
  });

  afterEach(() => {
    scheduler.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds a task', () => {
    const task = scheduler.add('0 9 * * *', 'check emails', 'email');
    assert.ok(task.id);
    assert.equal(task.cron, '0 9 * * *');
    assert.equal(task.goal, 'check emails');
    assert.equal(task.domainId, 'email');
    assert.equal(task.enabled, true);
    assert.equal(task.runCount, 0);
    assert.ok(task.nextRunAt);
  });

  it('lists tasks', () => {
    scheduler.add('0 9 * * *', 'task 1');
    scheduler.add('0 18 * * *', 'task 2');
    assert.equal(scheduler.list().length, 2);
    assert.equal(scheduler.size, 2);
  });

  it('removes a task', () => {
    const task = scheduler.add('0 9 * * *', 'to remove');
    assert.equal(scheduler.size, 1);
    assert.ok(scheduler.remove(task.id));
    assert.equal(scheduler.size, 0);
    assert.equal(scheduler.get(task.id), undefined);
  });

  it('returns false for removing non-existent task', () => {
    assert.ok(!scheduler.remove('nonexistent'));
  });

  it('enables/disables a task', () => {
    const task = scheduler.add('0 9 * * *', 'toggleable');
    assert.equal(task.enabled, true);

    scheduler.setEnabled(task.id, false);
    assert.equal(scheduler.get(task.id)!.enabled, false);
    assert.equal(scheduler.get(task.id)!.nextRunAt, undefined);

    scheduler.setEnabled(task.id, true);
    assert.equal(scheduler.get(task.id)!.enabled, true);
    assert.ok(scheduler.get(task.id)!.nextRunAt);
  });

  it('rejects invalid cron expression', () => {
    assert.throws(() => scheduler.add('invalid', 'bad cron'), /Invalid cron/);
    assert.throws(() => scheduler.add('60 * * * *', 'bad minute'), /Invalid cron/);
  });

  it('persists tasks to disk and reloads', () => {
    scheduler.add('0 9 * * *', 'persistent task', 'email');
    scheduler.add('*/30 * * * *', 'frequent task');

    // Create a new scheduler from the same directory
    const scheduler2 = new Scheduler(tmpDir);
    assert.equal(scheduler2.size, 2);

    const tasks = scheduler2.list();
    assert.ok(tasks.some(t => t.goal === 'persistent task'));
    assert.ok(tasks.some(t => t.goal === 'frequent task'));
    scheduler2.stop();
  });

  it('tick() executes matching tasks', async () => {
    const results: string[] = [];
    const runner: TaskRunner = {
      async run(goal) {
        results.push(goal);
        return { success: true, steps: 2 };
      },
    };

    // Add task that matches every minute
    scheduler.add('* * * * *', 'always runs');
    scheduler.start(runner);

    // Manually tick at current time
    const entries = await scheduler.tick(new Date());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].success, true);
    assert.equal(results.length, 1);
    assert.equal(results[0], 'always runs');

    // Check task stats updated
    const task = scheduler.list()[0];
    assert.equal(task.runCount, 1);
    assert.equal(task.lastResult, 'success');
  });

  it('tick() skips disabled tasks', async () => {
    const results: string[] = [];
    const runner: TaskRunner = {
      async run(goal) {
        results.push(goal);
        return { success: true };
      },
    };

    const task = scheduler.add('* * * * *', 'disabled task');
    scheduler.setEnabled(task.id, false);
    scheduler.start(runner);

    await scheduler.tick(new Date());
    assert.equal(results.length, 0);
  });

  it('tick() handles task failures', async () => {
    const runner: TaskRunner = {
      async run() {
        return { success: false, error: 'Connection refused' };
      },
    };

    scheduler.add('* * * * *', 'failing task');
    scheduler.start(runner);

    const entries = await scheduler.tick(new Date());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].success, false);
    assert.equal(entries[0].error, 'Connection refused');

    const task = scheduler.list()[0];
    assert.equal(task.failCount, 1);
    assert.equal(task.lastResult, 'failure');
  });

  it('tick() handles runner exceptions', async () => {
    const runner: TaskRunner = {
      async run() {
        throw new Error('Unexpected crash');
      },
    };

    scheduler.add('* * * * *', 'crashing task');
    scheduler.start(runner);

    const entries = await scheduler.tick(new Date());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].success, false);
    assert.ok(entries[0].error?.includes('Unexpected crash'));
  });

  it('tick() only runs tasks matching the given time', async () => {
    const results: string[] = [];
    const runner: TaskRunner = {
      async run(goal) {
        results.push(goal);
        return { success: true };
      },
    };

    scheduler.add('0 9 * * *', 'morning task');
    scheduler.add('0 18 * * *', 'evening task');
    scheduler.start(runner);

    // Tick at 9:00
    await scheduler.tick(new Date(2026, 2, 17, 9, 0));
    assert.equal(results.length, 1);
    assert.equal(results[0], 'morning task');

    // Tick at 18:00
    await scheduler.tick(new Date(2026, 2, 17, 18, 0));
    assert.equal(results.length, 2);
    assert.equal(results[1], 'evening task');
  });
});
