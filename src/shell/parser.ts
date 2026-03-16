/**
 * Shell Parser — converts command strings into structured ShellCommand objects.
 *
 * Handles:
 * - Simple commands: "ls -la"
 * - Pipes: "cat file.txt | grep pattern | wc -l"
 * - Environment variables: "NODE_ENV=test node app.js"
 * - Quoted arguments: git commit -m "hello world"
 * - Redirects: "echo hello > file.txt" (detected but not executed — security)
 */

export interface ShellCommand {
  /** The binary to execute */
  binary: string;
  /** Arguments array */
  args: string[];
  /** Working directory override */
  cwd?: string;
  /** Timeout in ms */
  timeout?: number;
  /** Environment variable overrides */
  env?: Record<string, string>;
  /** Next command in pipeline */
  pipe?: ShellCommand;
  /** Raw original command string */
  raw: string;
}

export interface ParseResult {
  /** Parsed commands (first is the head, others are piped) */
  command: ShellCommand;
  /** Whether the command uses output redirection */
  hasRedirect: boolean;
  /** Whether the command has background operator & */
  hasBackground: boolean;
  /** Parse warnings */
  warnings: string[];
}

/**
 * Parse a shell command string into a ShellCommand structure.
 */
export function parseCommand(input: string, defaults?: { cwd?: string; timeout?: number }): ParseResult {
  const raw = input.trim();
  const warnings: string[] = [];

  // Detect redirects
  const hasRedirect = /[^|]>[^|]/.test(raw) || />>/.test(raw);
  if (hasRedirect) warnings.push('Output redirection detected — will be passed to shell');

  // Detect background
  const hasBackground = raw.endsWith('&') && !raw.endsWith('&&');
  if (hasBackground) warnings.push('Background operator detected');

  // Split by pipes (respecting quotes)
  const segments = splitByPipe(raw);

  // Parse each segment into a ShellCommand
  let head: ShellCommand | null = null;
  let current: ShellCommand | null = null;

  for (const segment of segments) {
    const cmd = parseSegment(segment.trim(), defaults);

    if (!head) {
      head = cmd;
      current = cmd;
    } else {
      current!.pipe = cmd;
      current = cmd;
    }
  }

  if (!head) {
    // Shouldn't happen but handle gracefully
    head = { binary: '', args: [], raw, ...defaults };
  }

  return { command: head, hasRedirect, hasBackground, warnings };
}

/**
 * Split a command string by pipe characters, respecting quotes.
 */
function splitByPipe(input: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === '\\') {
      escape = true;
      current += ch;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    if (ch === '|' && !inSingle && !inDouble) {
      // Check for || (logical OR) — don't split on that
      if (input[i + 1] === '|') {
        current += '||';
        i++;
        continue;
      }
      segments.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) segments.push(current);
  return segments;
}

/**
 * Parse a single command segment (no pipes) into a ShellCommand.
 */
function parseSegment(segment: string, defaults?: { cwd?: string; timeout?: number }): ShellCommand {
  const env: Record<string, string> = {};

  // Extract leading env vars: KEY=VALUE command args...
  let rest = segment;
  while (true) {
    const envMatch = rest.match(/^([A-Z_][A-Z0-9_]*)=(\S+)\s+/);
    if (envMatch) {
      env[envMatch[1]] = envMatch[2];
      rest = rest.slice(envMatch[0].length);
    } else {
      break;
    }
  }

  // Tokenize respecting quotes
  const tokens = tokenize(rest);
  const binary = tokens[0] || '';
  const args = tokens.slice(1);

  return {
    binary,
    args,
    raw: segment,
    ...(defaults?.cwd && { cwd: defaults.cwd }),
    ...(defaults?.timeout && { timeout: defaults.timeout }),
    ...(Object.keys(env).length > 0 && { env }),
  };
}

/**
 * Tokenize a command string, respecting single and double quotes.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === '\\' && !inSingle) {
      escape = true;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue; // Don't include the quote itself
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue; // Don't include the quote itself
    }

    if (ch === ' ' && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

/**
 * Flatten a ShellCommand pipeline into an array of commands.
 */
export function flattenPipeline(cmd: ShellCommand): ShellCommand[] {
  const result: ShellCommand[] = [cmd];
  let current = cmd.pipe;
  while (current) {
    result.push(current);
    current = current.pipe;
  }
  return result;
}

/**
 * Reconstruct a command string from a ShellCommand.
 */
export function commandToString(cmd: ShellCommand): string {
  const parts: string[] = [];

  if (cmd.env) {
    for (const [key, value] of Object.entries(cmd.env)) {
      parts.push(`${key}=${value}`);
    }
  }

  parts.push(cmd.binary);

  for (const arg of cmd.args) {
    // Re-quote if needed
    if (arg.includes(' ') || arg.includes('"') || arg.includes("'")) {
      parts.push(`"${arg.replace(/"/g, '\\"')}"`);
    } else {
      parts.push(arg);
    }
  }

  let result = parts.join(' ');

  if (cmd.pipe) {
    result += ' | ' + commandToString(cmd.pipe);
  }

  return result;
}
