/**
 * Response Normalization
 *
 * Fixes common LLM output issues when generating execution plan JSON.
 * Adapted from n8n-a2e's normalize.ts (RepoMemory v2 inspired).
 *
 * Handles:
 * - Reasoning/thinking tags wrapping the JSON
 * - Missing or extra code fences
 * - Trailing commas in JSON
 * - Single quotes instead of double quotes
 * - Unquoted keys
 * - Truncated JSON (auto-close brackets)
 * - Multiple JSON blocks (pick the best one)
 */

export interface NormalizeResult {
  /** The cleaned JSON string, or null if unfixable */
  json: string | null;
  /** Whether auto-fixes were applied */
  fixed: boolean;
  /** Description of fixes applied */
  fixes: string[];
}

/**
 * Normalize raw LLM response into clean JSON.
 * Returns the extracted + fixed JSON string, or null if unrecoverable.
 */
export function normalizeResponse(raw: string): NormalizeResult {
  const fixes: string[] = [];
  let text = raw;

  // Strip thinking/reasoning tags
  text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
  text = text.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  if (text !== raw) fixes.push('stripped reasoning tags');

  // Extract from code fences (try json first, then generic)
  const jsonFence = text.match(/```json\s*([\s\S]*?)```/);
  const genericFence = text.match(/```\s*([\s\S]*?)```/);
  let jsonStr = jsonFence?.[1]?.trim() ?? genericFence?.[1]?.trim() ?? null;

  // If no closed code fence, try unclosed (truncated response)
  if (!jsonStr) {
    const unclosedFence = text.match(/```(?:json)?\s*([\s\S]+)/);
    if (unclosedFence) {
      jsonStr = unclosedFence[1].trim();
      fixes.push('extracted JSON from unclosed code fence');
    }
  }

  // If no code fence, try to find raw JSON object
  if (!jsonStr) {
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      // Verify this is valid JSON or fixable — if not, try the truncated version
      try {
        JSON.parse(braceMatch[0]);
        jsonStr = braceMatch[0];
        fixes.push('extracted JSON from raw text');
      } catch {
        // Check if the full text extends beyond the last } (truncated response)
        const fullText = text.match(/\{[\s\S]*/);
        if (fullText && fullText[0].length > braceMatch[0].length) {
          // Use the full truncated version — autoCloseJson will handle it
          jsonStr = fullText[0];
          fixes.push('extracted truncated JSON from raw text');
        } else {
          jsonStr = braceMatch[0];
          fixes.push('extracted JSON from raw text');
        }
      }
    }
  }

  // Last resort: find opening brace without closing (truncated)
  if (!jsonStr) {
    const braceStart = text.match(/\{[\s\S]*/);
    if (braceStart) {
      jsonStr = braceStart[0];
      fixes.push('extracted truncated JSON from raw text');
    }
  }

  if (!jsonStr) {
    return { json: null, fixed: false, fixes: ['no JSON found in response'] };
  }

  // Try parsing as-is first
  try {
    JSON.parse(jsonStr);
    return { json: jsonStr, fixed: fixes.length > 0, fixes };
  } catch {
    // Continue with fixes
  }

  // Apply fixes
  let fixed = jsonStr;

  // Fix trailing commas before } or ]
  const beforeTrailing = fixed;
  fixed = fixed.replace(/,\s*([\]}])/g, '$1');
  if (fixed !== beforeTrailing) fixes.push('removed trailing commas');

  // Fix single quotes to double quotes (careful with content strings)
  // Only fix quotes around keys and simple values, not inside strings
  const beforeQuotes = fixed;
  fixed = fixQuotes(fixed);
  if (fixed !== beforeQuotes) fixes.push('fixed quotes');

  // Fix unquoted keys: { key: "value" } → { "key": "value" }
  const beforeKeys = fixed;
  fixed = fixed.replace(/([{,]\s*)([a-zA-Z_]\w*)(\s*:)/g, '$1"$2"$3');
  if (fixed !== beforeKeys) fixes.push('quoted unquoted keys');

  // Try parsing after fixes
  try {
    JSON.parse(fixed);
    return { json: fixed, fixed: true, fixes };
  } catch {
    // Try auto-closing truncated JSON
  }

  // Auto-close truncated JSON
  const autoClosed = autoCloseJson(fixed);
  if (autoClosed) {
    fixes.push('auto-closed truncated JSON');
    try {
      JSON.parse(autoClosed);
      return { json: autoClosed, fixed: true, fixes };
    } catch {
      // Give up
    }
  }

  return { json: null, fixed: false, fixes: [...fixes, 'unfixable JSON'] };
}

/**
 * Fix single quotes to double quotes in JSON-like strings.
 * Handles the common LLM mistake of using single quotes.
 */
function fixQuotes(str: string): string {
  // Simple state machine: track if we're inside a double-quoted string
  let result = '';
  let inDoubleQuote = false;
  let inSingleQuote = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const prev = i > 0 ? str[i - 1] : '';

    if (ch === '"' && prev !== '\\' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      result += ch;
    } else if (ch === "'" && prev !== '\\' && !inDoubleQuote) {
      // Replace single quote with double quote
      inSingleQuote = !inSingleQuote;
      result += '"';
    } else {
      result += ch;
    }
  }

  return result;
}

/**
 * Attempt to auto-close truncated JSON by counting brackets.
 * Also closes dangling strings and removes incomplete key-value pairs.
 */
function autoCloseJson(str: string): string | null {
  let braces = 0;
  let brackets = 0;
  let inString = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const prev = i > 0 ? str[i - 1] : '';

    if (ch === '"' && prev !== '\\') {
      inString = !inString;
    } else if (!inString) {
      if (ch === '{') braces++;
      else if (ch === '}') braces--;
      else if (ch === '[') brackets++;
      else if (ch === ']') brackets--;
    }
  }

  if (braces === 0 && brackets === 0 && !inString) return null; // Already balanced

  let result = str;

  // Close dangling string — truncate to last complete JSON element
  if (inString) {
    // Strategy: find the last step boundary — "},\n" indicates end of one array element
    // and start of another. This is more reliable than just "}," which can match
    // nested objects like "params": {},"
    let lastCompleteObj = result.lastIndexOf('},\n');
    if (lastCompleteObj < 0) lastCompleteObj = result.lastIndexOf('}\n');
    // Fallback: find a "}" followed by "," at the end of a line with description
    if (lastCompleteObj < 0) {
      // Look for complete step objects: "}," preceded by a quoted value end
      const stepBoundary = result.lastIndexOf('"},');
      if (stepBoundary > 0) lastCompleteObj = stepBoundary + 1; // Position after the }
    }
    if (lastCompleteObj > 0) {
      result = result.slice(0, lastCompleteObj + 1);
    } else {
      result += '"';
    }
    // Recount after truncation
    braces = 0; brackets = 0; inString = false;
    for (let i = 0; i < result.length; i++) {
      const ch = result[i];
      const prev = i > 0 ? result[i - 1] : '';
      if (ch === '"' && prev !== '\\') inString = !inString;
      else if (!inString) {
        if (ch === '{') braces++;
        else if (ch === '}') braces--;
        else if (ch === '[') brackets++;
        else if (ch === ']') brackets--;
      }
    }
    if (inString) result += '"';
  }

  // Remove trailing comma before closing
  result = result.replace(/,\s*$/, '');

  // Close open brackets/braces
  while (brackets > 0) { result += ']'; brackets--; }
  while (braces > 0) { result += '}'; braces--; }

  return result;
}

/**
 * Extract multiple JSON candidates from a response and return the best one.
 * Useful when LLM returns multiple code blocks.
 * Prefers blocks that look like an ExecutionPlan (has goal + steps).
 */
export function extractBestJson(raw: string): string | null {
  const blocks = [...raw.matchAll(/```json\s*([\s\S]*?)```/g)];

  if (blocks.length === 0) {
    const result = normalizeResponse(raw);
    return result.json;
  }

  // Try each block, return the first valid one that looks like an ExecutionPlan
  for (const block of blocks) {
    const result = normalizeResponse('```json\n' + block[1] + '\n```');
    if (result.json) {
      try {
        const parsed = JSON.parse(result.json);
        if (parsed.goal && parsed.steps) {
          return result.json;
        }
      } catch { /* skip */ }
    }
  }

  // Fall back to first parseable block
  for (const block of blocks) {
    const result = normalizeResponse('```json\n' + block[1] + '\n```');
    if (result.json) return result.json;
  }

  return null;
}
