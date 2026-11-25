#!/usr/bin/env node
// PreToolUse hook: blocks or asks before destructive git commands.
// stdin: Antigravity PreToolUse payload (camelCase JSON).
// stdout: one line of JSON { decision, reason? }. Always exits 0 and fails open to "allow".

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTECTED_BRANCH = /^(main|master)$/i;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'cmd', 'powershell', 'pwsh']);
const WRAPPERS = new Set(['sudo', 'command', 'env', 'exec', 'time', 'nohup']);
const SEPARATORS = new Set([';', '|', '&', '\n', '\r', '(', ')', '{', '}']);
const GIT_GLOBAL_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);
const PUSH_OPTS_WITH_VALUE = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec']);
const MAX_DEPTH = 3;

const SEVERITY = { allow: 0, ask: 1, force_ask: 2, deny: 3 };

export const REASONS = {
  forcePushProtected: 'Blocked force-push to main/master branch.',
  deleteProtected: 'Blocked deleting the main/master branch.',
  forcePush: 'Confirm force-push before rewriting remote history.',
  leasePushProtected: 'Confirm force-push with lease to main/master before rewriting its history.',
  leasePushUnknown: 'Confirm force-push with lease: the target branch could not be determined.',
  resetHard: 'Confirm hard reset: this discards uncommitted local changes.',
  clean: 'Confirm git clean: this permanently deletes untracked files.',
};

const ALLOW = Object.freeze({ decision: 'allow' });
const verdict = (decision, reason) => ({ decision, reason });

function stricter(a, b) {
  return SEVERITY[b.decision] > SEVERITY[a.decision] ? b : a;
}

// ---------------------------------------------------------------------------
// Tokenizer: splits a command line into segments of tokens, honoring quotes.
// ---------------------------------------------------------------------------

function tokenize(commandLine) {
  const segments = [];
  let tokens = [];
  let current = '';
  let inToken = false;
  let quoted = false;
  let quote = null;

  const endToken = () => {
    if (inToken) tokens.push({ value: current, quoted });
    current = '';
    inToken = false;
    quoted = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };

  const text = String(commandLine);
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && (text[i + 1] === '"' || text[i + 1] === '\\')) current += text[++i];
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      quoted = true;
    } else if (SEPARATORS.has(ch)) {
      endSegment();
    } else if (/\s/.test(ch)) {
      endToken();
    } else {
      current += ch;
      inToken = true;
    }
  }
  endSegment();
  return segments;
}

function basename(token) {
  return token.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
}

// ---------------------------------------------------------------------------
// git subcommand analysis.
// ---------------------------------------------------------------------------

function normalizeBranch(ref) {
  return String(ref || '').replace(/^refs\/heads\//, '');
}

function analyzePush(args, { cwd, getCurrentBranch }) {
  let force = false;
  let lease = false;
  let mirror = false;
  let all = false;
  let del = false;
  let expectValue = false;
  let rest = false;
  const positional = [];

  for (const arg of args) {
    if (expectValue) {
      expectValue = false;
      continue;
    }
    if (rest || !arg.startsWith('-') || arg === '-') {
      positional.push(arg);
      continue;
    }
    if (arg === '--') {
      rest = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const name = arg.split('=')[0];
      if (name === '--force') force = true;
      else if (name === '--force-with-lease' || name === '--force-if-includes') lease = true;
      else if (name === '--mirror') mirror = true;
      else if (name === '--all' || name === '--branches') all = true;
      else if (name === '--delete') del = true;
      else if (PUSH_OPTS_WITH_VALUE.has(name) && !arg.includes('=')) expectValue = true;
      continue;
    }
    const letters = arg.slice(1);
    if (letters.includes('f')) force = true;
    if (letters.includes('d')) del = true;
    if (letters.endsWith('o')) expectValue = true;
  }

  const refspecs = positional.slice(1);
  const targets = [];

  if (refspecs.length === 0) {
    if (mirror || all) {
      targets.push({ branch: 'main', force: force || mirror, delete: false });
    } else {
      targets.push({ branch: getCurrentBranch(cwd), force, delete: del });
    }
  }

  for (const spec of refspecs) {
    const plus = spec.startsWith('+');
    const body = plus ? spec.slice(1) : spec;
    if (body.startsWith(':')) {
      targets.push({ branch: normalizeBranch(body.slice(1)), force: false, delete: true });
      continue;
    }
    const colon = body.indexOf(':');
    const src = colon >= 0 ? body.slice(0, colon) : body;
    let dst = normalizeBranch(colon >= 0 ? body.slice(colon + 1) : body);
    if (dst === 'HEAD' || (!dst && src === 'HEAD')) dst = getCurrentBranch(cwd);
    targets.push({ branch: dst, force: force || plus || mirror, delete: del });
  }

  let result = ALLOW;
  for (const target of targets) {
    const known = typeof target.branch === 'string' && target.branch.length > 0;
    const isProtected = known && PROTECTED_BRANCH.test(target.branch);
    let next = ALLOW;
    if (target.delete && isProtected) next = verdict('deny', REASONS.deleteProtected);
    else if (target.force && isProtected) next = verdict('deny', REASONS.forcePushProtected);
    else if (target.force) next = verdict('force_ask', REASONS.forcePush);
    else if (lease && isProtected) next = verdict('force_ask', REASONS.leasePushProtected);
    else if (lease && !known) next = verdict('force_ask', REASONS.leasePushUnknown);
    result = stricter(result, next);
  }
  return result;
}

function analyzeBranch(args) {
  let forceDelete = false;
  let del = false;
  let force = false;
  const names = [];
  for (const arg of args) {
    if (arg === '--delete') del = true;
    else if (arg === '--force') force = true;
    else if (/^-[A-Za-z]+$/.test(arg)) {
      if (arg.includes('D')) forceDelete = true;
      if (arg.includes('d')) del = true;
      if (arg.includes('f')) force = true;
    } else if (!arg.startsWith('-')) names.push(arg);
  }
  if (del && force) forceDelete = true;
  if (forceDelete && names.some((name) => PROTECTED_BRANCH.test(normalizeBranch(name)))) {
    return verdict('deny', REASONS.deleteProtected);
  }
  return ALLOW;
}

function analyzeReset(args) {
  return args.includes('--hard') ? verdict('force_ask', REASONS.resetHard) : ALLOW;
}

function analyzeClean(args) {
  let force = false;
  let dryRun = false;
  for (const arg of args) {
    if (arg === '--force') force = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (/^-[A-Za-z]+$/.test(arg)) {
      if (arg.includes('f')) force = true;
      if (arg.includes('n')) dryRun = true;
    }
  }
  return force && !dryRun ? verdict('force_ask', REASONS.clean) : ALLOW;
}

function analyzeGit(args, options) {
  let cwd = options.cwd;
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const name = args[i].split('=')[0];
    if (GIT_GLOBAL_OPTS_WITH_VALUE.has(name) && !args[i].includes('=')) {
      if (name === '-C' && args[i + 1]) cwd = resolve(cwd || process.cwd(), args[i + 1]);
      i += 2;
    } else {
      i += 1;
    }
  }

  const subcommand = args[i];
  const rest = args.slice(i + 1);
  const ctx = { ...options, cwd };
  switch (subcommand) {
    case 'push':
      return analyzePush(rest, ctx);
    case 'branch':
      return analyzeBranch(rest);
    case 'reset':
      return analyzeReset(rest);
    case 'clean':
      return analyzeClean(rest);
    default:
      return ALLOW;
  }
}

function analyzeSegment(tokens, options, depth) {
  let start = 0;
  while (start < tokens.length) {
    const value = tokens[start].value;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value) || WRAPPERS.has(basename(value)) || value === '$') start += 1;
    else break;
  }
  if (start >= tokens.length) return ALLOW;

  const program = basename(tokens[start].value);
  const args = tokens.slice(start + 1);

  if (program === 'git') return analyzeGit(args.map((t) => t.value), options);

  // Shell wrappers such as `bash -c "git push -f origin main"`: inspect quoted scripts.
  if (SHELLS.has(program) && depth < MAX_DEPTH) {
    let result = ALLOW;
    for (const token of args) {
      if (token.quoted || /\bgit\b/.test(token.value)) {
        result = stricter(result, evaluate(token.value, options, depth + 1));
      }
    }
    return result;
  }
  return ALLOW;
}

function evaluate(commandLine, options, depth) {
  let result = ALLOW;
  for (const tokens of tokenize(commandLine)) {
    result = stricter(result, analyzeSegment(tokens, options, depth));
    if (result.decision === 'deny') break;
  }
  return result;
}

// Returns { decision: "allow" | "force_ask" | "deny", reason? } for a command line.
// options.getCurrentBranch(cwd) resolves the checked-out branch when a push has no refspec.
export function evaluateCommand(commandLine, { cwd, getCurrentBranch = () => null } = {}) {
  if (typeof commandLine !== 'string' || !commandLine.trim()) return { ...ALLOW };
  const result = evaluate(commandLine, { cwd, getCurrentBranch }, 0);
  return result.reason ? { decision: result.decision, reason: result.reason } : { decision: result.decision };
}

// ---------------------------------------------------------------------------
// Hook entry point.
// ---------------------------------------------------------------------------

export function detectCurrentBranch(cwd) {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: cwd || undefined,
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

export function decide(payload, { getCurrentBranch = detectCurrentBranch } = {}) {
  const args = payload?.toolCall?.args || {};
  const commandLine = args.CommandLine ?? args.command ?? '';
  const cwd = args.Cwd ?? args.cwd ?? payload?.cwd ?? payload?.workspacePaths?.[0];
  return evaluateCommand(typeof commandLine === 'string' ? commandLine : '', { cwd, getCurrentBranch });
}

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  let output = { decision: 'allow' };
  try {
    // String.prototype.trim also strips a leading UTF-8 BOM (U+FEFF) added by some shells.
    const raw = (await readStdin()).trim();
    if (raw) output = decide(JSON.parse(raw));
  } catch {
    output = { decision: 'allow' };
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const entry = resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === entry.toLowerCase() : self === entry;
}

if (isMainModule()) {
  main();
}
