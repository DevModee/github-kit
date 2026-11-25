import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { evaluateCommand, decide, REASONS } from '../hooks/git-guard.mjs';

const HOOK_PATH = fileURLToPath(new URL('../hooks/git-guard.mjs', import.meta.url));
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));

function expectDecision(commands, decision, reason, options) {
  for (const command of commands) {
    const result = evaluateCommand(command, options);
    assert.equal(result.decision, decision, `${command} -> ${JSON.stringify(result)}`);
    if (reason) assert.equal(result.reason, reason, command);
    if (decision === 'allow') assert.equal(result.reason, undefined, command);
  }
}

describe('evaluateCommand: deny', () => {
  test('force-push to main or master', () => {
    expectDecision(
      [
        'git push --force origin main',
        'git push -f origin master',
        'git push origin main --force',
        'git push -uf origin main',
        'git push origin +main',
        'git push origin +feature:main',
        'git push --force origin feature:refs/heads/main',
        'git push --force origin refs/heads/master',
        'git push --force origin MAIN',
        'git push --force-with-lease -f origin main',
      ],
      'deny',
      REASONS.forcePushProtected,
    );
  });

  test('force-push that rewrites every branch', () => {
    expectDecision(['git push --mirror', 'git push --mirror origin', 'git push --force --all origin'], 'deny', REASONS.forcePushProtected);
  });

  test('deleting main or master', () => {
    expectDecision(
      [
        'git push origin --delete main',
        'git push origin -d master',
        'git push origin :main',
        'git branch -D main',
        'git branch -D feature master',
        'git branch --delete --force main',
        'git branch -df main',
      ],
      'deny',
      REASONS.deleteProtected,
    );
  });

  test('finds git through global options, wrappers, chains, and shells', () => {
    expectDecision(
      [
        'git -C ../repo push -f origin main',
        'git -c push.default=current --no-pager push --force origin main',
        'GIT_TRACE=1 git push -f origin main',
        'sudo git push -f origin main',
        'cd repo && git push --force origin main',
        'git status; git push --force origin main',
        'git fetch | git push -f origin main',
        'echo $(git push -f origin main)',
        'bash -c "git push --force origin main"',
        "sh -c 'cd app && git push -f origin master'",
        'powershell -Command "git push --force origin main"',
        'cmd /c "git push -f origin main"',
        '"C:\\Program Files\\Git\\cmd\\git.exe" push -f origin main',
        '& "C:\\Program Files\\Git\\cmd\\git.exe" push -f origin main',
        '/usr/bin/git push -f origin main',
      ],
      'deny',
    );
  });

  test('force-push without refspec uses the current branch', () => {
    const onMain = { getCurrentBranch: () => 'main' };
    expectDecision(['git push --force', 'git push -f origin', 'git push -f origin HEAD'], 'deny', REASONS.forcePushProtected, onMain);
  });

  test('the strictest decision wins across a chain', () => {
    expectDecision(['git reset --hard && git push -f origin main', 'git clean -fd; git branch -D master'], 'deny');
  });
});

describe('evaluateCommand: force_ask', () => {
  test('force-push to other branches', () => {
    expectDecision(
      [
        'git push --force origin feature',
        'git push -f origin fix/login',
        'git push origin +feature',
        'git push -f origin mainline',
        'git push --force origin main-backup',
        'git push origin --force feature:release',
      ],
      'force_ask',
      REASONS.forcePush,
    );
  });

  test('force-push without refspec on a feature or unknown branch', () => {
    expectDecision(['git push --force', 'git push -f origin'], 'force_ask', REASONS.forcePush, { getCurrentBranch: () => 'feature' });
    expectDecision(['git push --force'], 'force_ask', REASONS.forcePush);
  });

  test('force-with-lease to main or to an unknown branch', () => {
    expectDecision(['git push --force-with-lease origin main', 'git push --force-with-lease=main:abc123 origin main'], 'force_ask', REASONS.leasePushProtected);
    expectDecision(['git push --force-with-lease'], 'force_ask', REASONS.leasePushUnknown);
    expectDecision(['git push --force-with-lease'], 'force_ask', REASONS.leasePushProtected, { getCurrentBranch: () => 'master' });
  });

  test('hard reset', () => {
    expectDecision(['git reset --hard', 'git reset --hard HEAD~1', 'git reset --hard origin/main'], 'force_ask', REASONS.resetHard);
  });

  test('git clean with force', () => {
    expectDecision(['git clean -f', 'git clean -fd', 'git clean -xdf', 'git clean -d --force'], 'force_ask', REASONS.clean);
  });
});

describe('evaluateCommand: allow', () => {
  test('normal git and non-git commands', () => {
    expectDecision(
      [
        'git status',
        'git diff --stat',
        'git commit -m "Update docs"',
        'git push',
        'git push origin main',
        'git push -u origin feature',
        'git push origin --delete feature',
        'git push --force-with-lease origin feature',
        'git push --force-with-lease',
        'git branch -d main',
        'git branch -D feature',
        'git reset --soft HEAD~1',
        'git reset HEAD file.txt',
        'git clean -n',
        'git clean -fn',
        'git clean -f --dry-run',
        'git log --grep=force',
        'npm test',
        'node --test',
        '',
        '   ',
      ],
      'allow',
      undefined,
      { getCurrentBranch: () => 'feature' },
    );
  });

  test('dangerous text inside messages or echo is not a command', () => {
    expectDecision(
      [
        'git commit -m "git push --force origin main"',
        'echo git push --force origin main',
        'echo "git reset --hard"',
        'gh pr create --title "Avoid git push -f origin main"',
      ],
      'allow',
    );
  });

  test('non-string input is allowed', () => {
    assert.deepEqual(evaluateCommand(undefined), { decision: 'allow' });
    assert.deepEqual(evaluateCommand(42), { decision: 'allow' });
  });
});

describe('decide', () => {
  test('reads CommandLine or command from the PreToolUse payload', () => {
    const base = { hookEventName: 'PreToolUse', toolCall: { id: 't1', name: 'run_command' } };
    assert.equal(decide({ ...base, toolCall: { ...base.toolCall, args: { CommandLine: 'git push -f origin main' } } }).decision, 'deny');
    assert.equal(decide({ ...base, toolCall: { ...base.toolCall, args: { command: 'git reset --hard' } } }).decision, 'force_ask');
    assert.equal(decide({ ...base, toolCall: { ...base.toolCall, args: {} } }).decision, 'allow');
    assert.equal(decide({}).decision, 'allow');
    assert.equal(decide(null).decision, 'allow');
  });

  test('passes the payload cwd to branch detection', () => {
    let seen;
    const getCurrentBranch = (cwd) => {
      seen = cwd;
      return 'main';
    };
    const payload = { cwd: '/work/app', toolCall: { name: 'run_command', args: { CommandLine: 'git push --force' } } };
    assert.equal(decide(payload, { getCurrentBranch }).decision, 'deny');
    assert.equal(seen, '/work/app');
  });
});

function runHook(stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_PATH], { cwd: PLUGIN_ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function preToolUse(commandLine) {
  return JSON.stringify({
    conversationId: 'conv-1',
    workspacePaths: [PLUGIN_ROOT],
    cwd: PLUGIN_ROOT,
    hookEventName: 'PreToolUse',
    stepIdx: 12,
    toolCall: { id: 'toolu_01', name: 'run_command', args: { CommandLine: commandLine } },
  });
}

describe('hook CLI contract', () => {
  const cases = [
    ['denies force-push to main', preToolUse('git push --force origin main'), { decision: 'deny', reason: REASONS.forcePushProtected }],
    ['asks before hard reset', preToolUse('git reset --hard'), { decision: 'force_ask', reason: REASONS.resetHard }],
    ['allows normal commands', preToolUse('git status'), { decision: 'allow' }],
    ['fails open on malformed JSON', '{not json', { decision: 'allow' }],
    ['fails open on empty stdin', '', { decision: 'allow' }],
    ['accepts a UTF-8 BOM', String.fromCharCode(0xfeff) + preToolUse('git clean -fd'), { decision: 'force_ask', reason: REASONS.clean }],
  ];

  for (const [label, stdin, expected] of cases) {
    test(label, { timeout: 10000 }, async () => {
      const { code, stdout, stderr } = await runHook(stdin);
      assert.equal(code, 0);
      assert.equal(stderr, '');
      assert.ok(stdout.endsWith('\n'));
      assert.equal(stdout.trim().split('\n').length, 1, 'stdout must be a single line');
      assert.deepEqual(JSON.parse(stdout), expected);
    });
  }
});
