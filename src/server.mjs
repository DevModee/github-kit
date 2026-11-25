#!/usr/bin/env node
// Zero-dependency MCP server for github-kit (JSON-RPC 2.0 over stdio).
// stdout carries only JSON-RPC messages; diagnostics go to stderr.

import readline from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDefaultClient } from './github.mjs';
import { createTools, runTool } from './tools.mjs';

export const SERVER_INFO = { name: 'github-kit', version: '1.0.0' };
export const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];
export const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

let defaultTools = null;

function getTools(deps) {
  if (deps && deps.tools) return deps.tools;
  if (!defaultTools) defaultTools = createTools(getDefaultClient());
  return defaultTools;
}

const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handleSingle(msg, deps) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    return error(null, INVALID_REQUEST, 'Invalid Request');
  }

  const isNotification = !('id' in msg);
  const id = isNotification ? null : msg.id;
  const { method, params } = msg;

  if (typeof method !== 'string') {
    return isNotification ? null : error(id, INVALID_REQUEST, 'Invalid Request');
  }
  if (isNotification) return null;

  switch (method) {
    case 'initialize': {
      const requested = params && params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
      return result(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }

    case 'ping':
      return result(id, {});

    case 'tools/list':
      return result(id, {
        tools: getTools(deps).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });

    case 'tools/call': {
      const name = params && params.name;
      if (typeof name !== 'string') return error(id, INVALID_PARAMS, 'tools/call requires a tool name');
      const tool = getTools(deps).find((t) => t.name === name);
      if (!tool) return error(id, INVALID_PARAMS, `Unknown tool: ${name}`);
      return result(id, await runTool(tool, params.arguments));
    }

    default:
      return error(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

// Returns the response object (or array for batches), or null when nothing must be sent.
export async function handleRpcMessage(msg, deps = {}) {
  if (Array.isArray(msg)) {
    if (msg.length === 0) return error(null, INVALID_REQUEST, 'Invalid Request');
    const responses = (await Promise.all(msg.map((m) => handleSingle(m, deps)))).filter(Boolean);
    return responses.length ? responses : null;
  }
  return handleSingle(msg, deps);
}

export function startServer({ input = process.stdin, output = process.stdout, deps = {} } = {}) {
  const send = (message) => output.write(`${JSON.stringify(message)}\n`);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) return;

    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      send(error(null, PARSE_ERROR, 'Parse error'));
      return;
    }

    try {
      const response = await handleRpcMessage(msg, deps);
      if (response) send(response);
    } catch (err) {
      process.stderr.write(`github-kit: internal error: ${err?.message || err}\n`);
      if (msg && typeof msg === 'object' && !Array.isArray(msg) && 'id' in msg) {
        send(error(msg.id, INTERNAL_ERROR, 'Internal error'));
      }
    }
  });

  return rl;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const entry = resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === entry.toLowerCase() : self === entry;
}

if (isMainModule()) {
  startServer();
}
