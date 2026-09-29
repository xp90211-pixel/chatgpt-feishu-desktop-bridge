import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export class Store {
  constructor(directory) {
    this.directory = path.resolve(directory);
    this.queue = Promise.resolve();
    this.token = randomUUID();
  }

  async open() {
    await mkdir(this.directory, { recursive: true });
    this.lockPath = path.join(this.directory, 'bridge.lock');
    const lock = await open(this.lockPath, 'wx');
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, token: this.token, createdAt: new Date().toISOString() }));
      await lock.sync();
    } finally { await lock.close(); }
    this.ownsLock = true;
    this.statePath = path.join(this.directory, 'state.json');
    try { this.data = JSON.parse(await readFile(this.statePath, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = { version: 1, bindings: {}, inbox: {}, outbox: {} };
    }
    if (this.data.version !== 1) throw new Error('Unsupported bridge state version.');
    return this;
  }

  save() {
    const json = JSON.stringify(this.data, null, 2) + '\n';
    // Snapshot now, serialize disk writes, and flush before a network side effect.
    this.queue = this.queue.then(async () => {
      const temporary = path.join(this.directory, `state-${this.token}.tmp`);
      const file = await open(temporary, 'w');
      try { await file.writeFile(json); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.statePath);
    });
    return this.queue;
  }

  async close() {
    try { await this.queue; } finally {
      if (this.ownsLock) {
        const lock = JSON.parse(await readFile(this.lockPath, 'utf8'));
        if (lock.token === this.token) await unlink(this.lockPath);
        this.ownsLock = false;
      }
    }
  }
}
