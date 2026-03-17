/**
 * Cron Expression Parser — zero dependencies.
 *
 * Supports standard 5-field cron expressions:
 *   minute hour day-of-month month day-of-week
 *
 * Field syntax:
 *   *        — every value
 *   N        — exact value (e.g., 5)
 *   N-M      — range (e.g., 1-5)
 *   N,M,O    — list (e.g., 1,3,5)
 *   * /N      — interval (e.g., * /15 = every 15 minutes) [no space, shown for escaping]
 *   N-M/S    — range with step (e.g., 0-30/10 = 0,10,20,30)
 *
 * Day of week: 0=Sunday, 1=Monday, ..., 6=Saturday (also 7=Sunday)
 * Month: 1=January, ..., 12=December
 *
 * Named shortcuts:
 *   @yearly   / @annually  → 0 0 1 1 *
 *   @monthly               → 0 0 1 * *
 *   @weekly                → 0 0 * * 0
 *   @daily    / @midnight  → 0 0 * * *
 *   @hourly                → 0 * * * *
 */

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}

const SHORTCUTS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const FIELD_RANGES: Array<{ name: string; min: number; max: number }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 },
];

/**
 * Parse a single cron field (e.g., "1,3,5", "0-30/10", "* /15", "*").
 * Returns a Set of matching integer values.
 */
function parseField(field: string, min: number, max: number, fieldName: string): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const trimmed = part.trim();

    // Wildcard with step: */N
    if (trimmed.startsWith('*/')) {
      const step = parseInt(trimmed.slice(2), 10);
      if (isNaN(step) || step <= 0) throw new Error(`Invalid step in ${fieldName}: "${trimmed}"`);
      for (let i = min; i <= max; i += step) values.add(i);
      continue;
    }

    // Plain wildcard: *
    if (trimmed === '*') {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }

    // Range with optional step: N-M or N-M/S
    if (trimmed.includes('-')) {
      const [rangePart, stepPart] = trimmed.split('/');
      const [startStr, endStr] = rangePart.split('-');
      const start = parseInt(startStr, 10);
      let end = parseInt(endStr, 10);
      const step = stepPart ? parseInt(stepPart, 10) : 1;

      // Day of week: treat 7 as 0 (Sunday)
      if (fieldName === 'dayOfWeek' && end === 7) end = 6;

      if (isNaN(start) || isNaN(end) || isNaN(step)) {
        throw new Error(`Invalid range in ${fieldName}: "${trimmed}"`);
      }
      if (start < min || end > max || start > end || step <= 0) {
        throw new Error(`Range out of bounds in ${fieldName}: "${trimmed}" (valid: ${min}-${max})`);
      }
      for (let i = start; i <= end; i += step) values.add(i);
      continue;
    }

    // Single value
    let val = parseInt(trimmed, 10);
    if (isNaN(val)) throw new Error(`Invalid value in ${fieldName}: "${trimmed}"`);
    // Day of week: treat 7 as 0 (Sunday)
    if (fieldName === 'dayOfWeek' && val === 7) val = 0;
    if (val < min || val > max) {
      throw new Error(`Value out of range in ${fieldName}: ${val} (valid: ${min}-${max})`);
    }
    values.add(val);
  }

  return values;
}

/**
 * Parse a cron expression string into structured fields.
 * @throws Error if the expression is invalid
 */
export function parseCron(expression: string): CronFields {
  const trimmed = expression.trim();

  // Check for named shortcuts
  const shortcut = SHORTCUTS[trimmed.toLowerCase()];
  if (shortcut) return parseCron(shortcut);

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron expression must have 5 fields (minute hour day month weekday), got ${parts.length}: "${expression}"`);
  }

  return {
    minute: parseField(parts[0], FIELD_RANGES[0].min, FIELD_RANGES[0].max, 'minute'),
    hour: parseField(parts[1], FIELD_RANGES[1].min, FIELD_RANGES[1].max, 'hour'),
    dayOfMonth: parseField(parts[2], FIELD_RANGES[2].min, FIELD_RANGES[2].max, 'dayOfMonth'),
    month: parseField(parts[3], FIELD_RANGES[3].min, FIELD_RANGES[3].max, 'month'),
    dayOfWeek: parseField(parts[4], FIELD_RANGES[4].min, FIELD_RANGES[4].max, 'dayOfWeek'),
  };
}

/**
 * Check if a Date matches a parsed cron expression.
 */
export function cronMatches(fields: CronFields, date: Date): boolean {
  return (
    fields.minute.has(date.getMinutes()) &&
    fields.hour.has(date.getHours()) &&
    fields.dayOfMonth.has(date.getDate()) &&
    fields.month.has(date.getMonth() + 1) && // JS months are 0-based
    fields.dayOfWeek.has(date.getDay())
  );
}

/**
 * Validate a cron expression string.
 * Returns null if valid, or an error message string.
 */
export function validateCron(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Get a human-readable description of a cron expression.
 */
export function describeCron(expression: string): string {
  const trimmed = expression.trim().toLowerCase();
  if (trimmed in SHORTCUTS) {
    const labels: Record<string, string> = {
      '@yearly': 'Once a year (Jan 1, midnight)',
      '@annually': 'Once a year (Jan 1, midnight)',
      '@monthly': 'Once a month (1st, midnight)',
      '@weekly': 'Once a week (Sunday, midnight)',
      '@daily': 'Once a day (midnight)',
      '@midnight': 'Once a day (midnight)',
      '@hourly': 'Once an hour (minute 0)',
    };
    return labels[trimmed] || trimmed;
  }

  try {
    const fields = parseCron(expression);
    const parts: string[] = [];

    if (fields.minute.size === 1) {
      parts.push(`at minute ${[...fields.minute][0]}`);
    } else if (fields.minute.size < 60) {
      parts.push(`at minutes ${[...fields.minute].sort((a, b) => a - b).join(',')}`);
    }

    if (fields.hour.size === 1) {
      parts.push(`hour ${[...fields.hour][0]}`);
    } else if (fields.hour.size < 24) {
      parts.push(`hours ${[...fields.hour].sort((a, b) => a - b).join(',')}`);
    }

    if (fields.dayOfMonth.size < 31) {
      parts.push(`day(s) ${[...fields.dayOfMonth].sort((a, b) => a - b).join(',')}`);
    }

    if (fields.month.size < 12) {
      const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      parts.push([...fields.month].sort((a, b) => a - b).map(m => names[m - 1]).join(','));
    }

    if (fields.dayOfWeek.size < 7) {
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      parts.push([...fields.dayOfWeek].sort((a, b) => a - b).map(d => names[d]).join(','));
    }

    return parts.join(', ') || 'Every minute';
  } catch {
    return expression;
  }
}

/**
 * Calculate the next Date that matches the cron expression, starting from `after`.
 * Searches up to 366 days ahead. Returns null if no match found.
 */
export function nextRun(fields: CronFields, after: Date = new Date()): Date | null {
  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1); // Start from next minute

  const limit = 366 * 24 * 60; // Max iterations (1 year of minutes)
  for (let i = 0; i < limit; i++) {
    if (cronMatches(fields, candidate)) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}
