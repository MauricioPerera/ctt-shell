/**
 * Shell Policy — RBAC for command execution.
 *
 * Defines what an agent is allowed to do:
 * - Which commands are permitted
 * - Which paths are accessible
 * - Which patterns are blocked (rm -rf, sudo, etc.)
 * - Timeout and resource limits
 */

export type ShellRole = 'readonly' | 'dev' | 'admin';

export interface ShellPolicy {
  /** Role name */
  role: ShellRole;
  /** Allowed command binaries (e.g., ["git", "ls", "cat", "node"]) */
  allowedCommands: string[];
  /** Regex patterns that block execution if matched against full command string */
  deniedPatterns: RegExp[];
  /** Allowed working directories (glob-like). Empty = cwd only */
  allowedPaths: string[];
  /** Max execution time in ms per command */
  maxTimeout: number;
  /** Max output size in bytes */
  maxOutputBytes: number;
  /** Allow piping commands */
  allowPipes: boolean;
}

/** Built-in policies */
export const POLICIES: Record<ShellRole, ShellPolicy> = {
  readonly: {
    role: 'readonly',
    allowedCommands: [
      'ls', 'cat', 'head', 'tail', 'wc', 'find', 'grep', 'which', 'echo',
      'pwd', 'whoami', 'date', 'env', 'printenv',
      'git status', 'git log', 'git diff', 'git branch', 'git show', 'git remote',
      'node --version', 'npm --version', 'npx --version',
    ],
    deniedPatterns: [
      /rm\b/i, /del\b/i, /rmdir\b/i,
      /sudo\b/i, /su\b/i, /chmod\b/i, /chown\b/i,
      /mv\b/i, /cp\b/i,
      />\s*\//, // redirect to absolute path
      /\|\s*sh\b/, /\|\s*bash\b/, // pipe to shell
      /curl\b.*\|\s*sh/, // curl | sh
      /eval\b/, /exec\b/,
    ],
    allowedPaths: [],
    maxTimeout: 10_000,
    maxOutputBytes: 1_048_576, // 1MB
    allowPipes: true,
  },

  dev: {
    role: 'dev',
    allowedCommands: [
      // Everything from readonly
      'ls', 'cat', 'head', 'tail', 'wc', 'find', 'grep', 'which', 'echo',
      'pwd', 'whoami', 'date', 'env', 'printenv',
      'git', 'node', 'npm', 'npx', 'tsc', 'tsx',
      'mkdir', 'touch', 'cp', 'mv',
      'curl', 'wget',
      'tar', 'unzip', 'gzip',
      'diff', 'sort', 'uniq', 'cut', 'tr', 'sed', 'awk', 'jq',
    ],
    deniedPatterns: [
      /rm\s+-rf\s+\//i,        // rm -rf / (root)
      /rm\s+-rf\s+~\//i,       // rm -rf ~/ (home)
      /rm\s+-rf\s+\.\.\//i,    // rm -rf ../ (parent)
      /sudo\b/i, /su\s+-\b/i,
      /chmod\s+777/i,
      />\s*\/etc\//i,           // write to /etc
      />\s*\/usr\//i,           // write to /usr
      /\|\s*sh\s*$/, /\|\s*bash\s*$/, // pipe to shell
      /curl\b.*\|\s*sh/, /wget\b.*\|\s*sh/,
      /git\s+push\s+.*--force/i,
      /git\s+reset\s+--hard/i,
      /npm\s+publish/i,
    ],
    allowedPaths: [],
    maxTimeout: 60_000,
    maxOutputBytes: 10_485_760, // 10MB
    allowPipes: true,
  },

  admin: {
    role: 'admin',
    allowedCommands: ['*'], // All commands allowed
    deniedPatterns: [
      /rm\s+-rf\s+\//i,        // Still block rm -rf /
      /:(){ :\|:& };:/,        // Fork bomb
      /mkfs\b/i,               // Format disk
      /dd\s+.*of=\/dev/i,      // Write to device
    ],
    allowedPaths: ['*'],
    maxTimeout: 300_000,
    maxOutputBytes: 52_428_800, // 50MB
    allowPipes: true,
  },
};

/**
 * Validate a command against a policy.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
export function validateCommand(
  command: string,
  policy: ShellPolicy,
): { allowed: boolean; reason?: string } {
  const trimmed = command.trim();
  if (!trimmed) return { allowed: false, reason: 'Empty command' };

  // Extract the binary name (first word)
  const binary = trimmed.split(/\s+/)[0].replace(/^.*[/\\]/, ''); // strip path

  // Check allowed commands
  if (!policy.allowedCommands.includes('*')) {
    // Check exact match first, then binary-only match
    const allowed = policy.allowedCommands.some(cmd => {
      if (cmd === binary) return true;
      // Check if the full command starts with an allowed prefix (e.g., "git status")
      if (trimmed.startsWith(cmd)) return true;
      return false;
    });
    if (!allowed) {
      return { allowed: false, reason: `Command "${binary}" not in allowed list for role "${policy.role}"` };
    }
  }

  // Check denied patterns
  for (const pattern of policy.deniedPatterns) {
    if (pattern.test(trimmed)) {
      return { allowed: false, reason: `Command matches denied pattern: ${pattern.source}` };
    }
  }

  // Check pipes
  if (!policy.allowPipes && trimmed.includes('|')) {
    return { allowed: false, reason: 'Pipes not allowed for this role' };
  }

  return { allowed: true };
}
