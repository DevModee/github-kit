import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTools } from '../src/tools.mjs';
import { SERVER_INFO } from '../src/server.mjs';
import { USER_AGENT } from '../src/github.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TOOL_NAMES = new Set(createTools({}).map((t) => t.name));

// Keys allowed by https://antigravity.google/schemas/v1/plugin.json (additionalProperties: false).
const PLUGIN_KEYS = new Set([
  '$schema', 'name', 'displayName', 'description', 'version', 'disabled', 'logo', 'suggestedPrompts',
  'skills', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions',
]);
const HOOK_EVENTS = new Set(['SessionStart', 'PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop']);

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match) return null;
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) data[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return { data, body: text.slice(match[0].length) };
}

describe('plugin.json', () => {
  const plugin = readJson('plugin.json');
  const pkg = readJson('package.json');

  test('only uses keys allowed by the v1 schema', () => {
    for (const key of Object.keys(plugin)) assert.ok(PLUGIN_KEYS.has(key), `unexpected key "${key}"`);
    assert.equal(plugin.$schema, 'https://antigravity.google/schemas/v1/plugin.json');
  });

  test('has a valid lowercase kebab-case name', () => {
    assert.match(plugin.name, /^[a-zA-Z0-9_-]+$/);
    assert.match(plugin.name, KEBAB);
  });

  test('uses the documented value types', () => {
    for (const key of ['displayName', 'description', 'version', 'homepage', 'repository', 'license', 'logo']) {
      assert.equal(typeof plugin[key], 'string', `${key} must be a string`);
    }
    assert.match(plugin.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    assert.ok(Array.isArray(plugin.keywords) && plugin.keywords.every((k) => typeof k === 'string'));
    if (plugin.disabled !== undefined) assert.equal(typeof plugin.disabled, 'boolean');
  });

  test('author is a string or an object with name, email, url only', () => {
    if (typeof plugin.author === 'string') return;
    assert.ok(isPlainObject(plugin.author));
    for (const key of Object.keys(plugin.author)) assert.ok(['name', 'email', 'url'].includes(key), `author.${key}`);
    for (const value of Object.values(plugin.author)) assert.equal(typeof value, 'string');
  });

  test('has at most 3 suggested prompts', () => {
    assert.ok(Array.isArray(plugin.suggestedPrompts));
    assert.ok(plugin.suggestedPrompts.length <= 3);
    for (const prompt of plugin.suggestedPrompts) assert.ok(typeof prompt === 'string' && prompt.trim());
  });

  test('logo is a relative image path inside the plugin', () => {
    assert.match(plugin.logo, /^(?!\/)(?!.*\.\.)[^\\]+\.(png|svg|jpg|jpeg|webp)$/i);
    assert.ok(existsSync(join(ROOT, plugin.logo)), 'logo file is missing');
  });

  test('name and version match package.json and the server', () => {
    assert.equal(plugin.name, pkg.name);
    assert.equal(plugin.version, pkg.version);
    assert.equal(SERVER_INFO.name, plugin.name);
    assert.equal(SERVER_INFO.version, plugin.version);
    assert.ok(USER_AGENT.endsWith(`/${plugin.version}`), 'User-Agent version is out of date');
  });
});

describe('package.json', () => {
  const pkg = readJson('package.json');

  test('has zero runtime dependencies and targets Node 20+ ESM', () => {
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.devDependencies, undefined);
    assert.equal(pkg.type, 'module');
    assert.match(pkg.engines.node, /^>=\s*20/);
    assert.equal(pkg.license, 'MIT');
  });

  test('ships an MIT LICENSE and ignores private files', () => {
    assert.match(read('LICENSE'), /^MIT License/);
    const ignore = read('.gitignore').split(/\r?\n/);
    for (const entry of ['ROADMAP_*.md', 'CLAUDE.md', '.env', '.env.*', 'node_modules/']) {
      assert.ok(ignore.includes(entry), `.gitignore must include ${entry}`);
    }
  });
});

describe('mcp_config.json', () => {
  test('starts the stdio server from PLUGIN_ROOT', () => {
    const config = readJson('mcp_config.json');
    assert.ok(isPlainObject(config.mcpServers));
    const server = config.mcpServers['github-kit'];
    assert.ok(server, 'github-kit server entry is missing');
    assert.equal(server.command, 'node');
    assert.ok(Array.isArray(server.args) && server.args.length > 0);
    for (const arg of server.args.filter((a) => a.includes('${PLUGIN_ROOT}'))) {
      const rel = arg.replace('${PLUGIN_ROOT}/', '');
      assert.ok(existsSync(join(ROOT, rel)), `${rel} does not exist`);
    }
    assert.ok(server.args[0].startsWith('${PLUGIN_ROOT}/'), 'server path must be relative to PLUGIN_ROOT');
  });
});

describe('hooks.json', () => {
  test('lives at the plugin root', () => {
    assert.ok(existsSync(join(ROOT, 'hooks.json')));
    assert.ok(!existsSync(join(ROOT, 'hooks', 'hooks.json')), 'hooks.json must not be inside hooks/');
  });

  test('declares valid events, matchers, and existing command scripts', () => {
    const hooks = readJson('hooks.json');
    let commands = 0;
    for (const [hookName, events] of Object.entries(hooks)) {
      assert.ok(isPlainObject(events), `${hookName} must be an object`);
      for (const [event, groups] of Object.entries(events)) {
        assert.ok(HOOK_EVENTS.has(event), `${hookName}: unknown event ${event}`);
        assert.ok(Array.isArray(groups));
        for (const group of groups) {
          if (event === 'PreToolUse' || event === 'PostToolUse') {
            assert.equal(typeof group.matcher, 'string');
            assert.doesNotThrow(() => new RegExp(group.matcher));
          }
          for (const handler of group.hooks) {
            assert.equal(handler.type, 'command');
            assert.equal(typeof handler.timeout, 'number');
            const script = /^node\s+(\S+)/.exec(handler.command);
            assert.ok(script, `unexpected command: ${handler.command}`);
            assert.ok(existsSync(join(ROOT, script[1])), `${script[1]} does not exist`);
            commands += 1;
          }
        }
      }
    }
    assert.ok(commands > 0);
  });

  test('the git guard runs before run_command', () => {
    const group = readJson('hooks.json')['git-safety-guard'].PreToolUse[0];
    assert.match('run_command', new RegExp(group.matcher));
    assert.equal(group.hooks[0].command, 'node ./hooks/git-guard.mjs');
  });
});

describe('skills', () => {
  const dirs = readdirSync(join(ROOT, 'skills')).filter((d) => statSync(join(ROOT, 'skills', d)).isDirectory());

  test('ships the four documented skills', () => {
    assert.deepEqual(dirs.sort(), ['ci-triage', 'issue-triage', 'pr-review', 'release-notes']);
  });

  for (const dir of dirs) {
    test(`${dir}/SKILL.md has valid frontmatter and references real tools`, () => {
      const text = read(join('skills', dir, 'SKILL.md'));
      const parsed = parseFrontmatter(text);
      assert.ok(parsed, 'missing YAML frontmatter');
      const { name, description } = parsed.data;
      assert.equal(name, dir, 'name must match the directory');
      assert.match(name, KEBAB);
      assert.ok(description && description.length >= 40 && description.length <= 1024, 'description length');
      assert.match(description, /^[A-Z][a-z]+s\b/, 'description must start with a third-person verb');
      assert.match(description, /Use when/, 'description must say when to use the skill');
      assert.ok(parsed.body.includes('cwd'), 'skill must tell the agent to pass cwd');

      const referenced = new Set(text.match(/github_[a-z_]+/g) || []);
      assert.ok(referenced.size > 0, 'skill must use github-kit tools');
      for (const tool of referenced) assert.ok(TOOL_NAMES.has(tool), `unknown tool ${tool}`);
    });
  }
});

describe('rules/AGENTS.md', () => {
  test('exists, has no frontmatter, and stays under 2 KB', () => {
    const path = join(ROOT, 'rules', 'AGENTS.md');
    assert.ok(existsSync(path));
    const text = readFileSync(path, 'utf8');
    assert.ok(!text.startsWith('---'), 'rules must not have frontmatter');
    assert.ok(Buffer.byteLength(text) < 2048, `rules are ${Buffer.byteLength(text)} bytes`);
  });

  test('lists every state-changing tool that needs confirmation', () => {
    const text = read('rules/AGENTS.md');
    for (const tool of [
      'github_create_pr', 'github_review_pr', 'github_create_issue',
      'github_comment_issue', 'github_create_release', 'github_rerun_workflow',
    ]) {
      assert.ok(text.includes(tool), `${tool} missing from rules`);
      assert.ok(TOOL_NAMES.has(tool));
    }
  });
});
