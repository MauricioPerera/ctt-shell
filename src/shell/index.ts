/**
 * Shell Engine — barrel exports
 */

// Policy (RBAC)
export { POLICIES, validateCommand } from './policy.js';
export type { ShellPolicy, ShellRole } from './policy.js';

// Parser
export { parseCommand, flattenPipeline, commandToString } from './parser.js';
export type { ShellCommand, ParseResult } from './parser.js';

// Executor
export { ShellExecutor, createExecutor } from './executor.js';
export type { ExecutorConfig, ShellResult } from './executor.js';

// Audit
export { AuditLog } from './audit.js';
export type { AuditEntry } from './audit.js';
