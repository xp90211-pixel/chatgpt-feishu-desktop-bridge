import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export async function findBundledServer(env = process.env) {
  if (env.CHATGPT_BRIDGE_MCP_SERVER) {
    const explicit = path.resolve(env.CHATGPT_BRIDGE_MCP_SERVER);
    await access(explicit);
    return explicit;
  }
  const base = path.join(env.CODEX_HOME || path.join(homedir(), '.codex'),
    'plugins', 'cache', 'openai-bundled', 'codex-app-tools');
  const versions = (await readdir(base, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(base, version, 'server.mjs');
    try { await access(candidate); return candidate; } catch { /* next version */ }
  }
  throw new Error('Bundled ChatGPT App Tools MCP server was not found.');
}

export class DesktopMcpClient {
  constructor({ serverPath, env = process.env, timeoutMs = 25000 } = {}) {
    if (!env.CODEX_APP_TOOLS_PIPE_PATH || !env.CODEX_THREAD_ID) {
      throw new Error('APP_CONTEXT_REQUIRED: launch from an authorized desktop task with its inherited pipe and thread context.');
    }
    this.serverPath = serverPath;
    this.env = { ...env };
    this.callerThreadId = env.CODEX_THREAD_ID;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.sequence = 0;
    this.stderr = '';
  }

  async start() {
    this.serverPath ||= await findBundledServer(this.env);
    const executable = this.env.CODEX_MCP_NODE_PATH || process.execPath;
    const child = spawn(executable, [this.serverPath], {
      env: this.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => { this.stderr = (this.stderr + text).slice(-4000); });
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch {
        this.failAll(new Error('MCP_INVALID_JSON'));
        return;
      }
      if (message.method) {
        // This client offers no sampling or automatic approval capability.
        if (message.id !== undefined) this.write({
          jsonrpc: '2.0', id: message.id,
          error: { code: -32601, message: 'Client capability not supported.' },
        });
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || 'MCP request failed.');
        error.code = message.error.code;
        request.reject(error);
      } else request.resolve(message.result);
    });
    child.on('error', error => this.failAll(error));
    child.on('exit', (code, signal) => this.failAll(new Error(`MCP_EXIT: ${code ?? signal}`)));
    child.stdin.on('error', error => this.failAll(error));
    const initialized = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'chatgpt-feishu-mcp-prototype', version: '0.1.0' },
    });
    if (initialized.protocolVersion !== '2025-06-18') {
      throw new Error(`Unsupported negotiated MCP protocol: ${initialized.protocolVersion}`);
    }
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this.serverInfo = initialized.serverInfo;
    return initialized;
  }

  write(message) {
    if (!this.child?.stdin.writable) throw new Error('MCP_NOT_CONNECTED');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method, params, timeoutMs = this.timeoutMs) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`MCP_TIMEOUT: ${method}; outcome may be unknown, do not automatically repeat writes.`);
        error.code = 'MCP_TIMEOUT';
        reject(error);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async listTools() {
    const result = await this.request('tools/list', {});
    this.tools = result.tools ?? [];
    return this.tools;
  }

  async callTool(name, args, timeoutMs) {
    const result = await this.request('tools/call', {
      name,
      arguments: args,
      _meta: { 'openai/threadId': this.callerThreadId },
    }, timeoutMs);
    return unwrapToolResult(result);
  }

  failAll(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  async close() {
    this.failAll(new Error('MCP_CLIENT_CLOSED'));
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
    this.lines?.close();
  }
}

export function unwrapToolResult(result) {
  const chunks = (result?.content ?? []).filter(x => x.type === 'text').map(x => x.text);
  let parsed;
  if (chunks.length === 1) {
    try { parsed = JSON.parse(chunks[0]); } catch { /* plain text */ }
  }
  if (result?.isError) {
    const error = new Error(parsed?.error?.message || parsed?.message || chunks.join('\n') || 'MCP_TOOL_ERROR');
    error.code = 'MCP_TOOL_ERROR';
    throw error;
  }
  return parsed ?? result?.structuredContent ?? { text: chunks.join('\n') };
}
