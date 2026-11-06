import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, realpath, symlink, rm, watch } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWorker, parseRun, runProcess } from '../src/worker.js';

const exec = promisify(execFile);
const nodeCommand = (code) => [process.execPath, '--input-type=module', '-e', code, '--'];
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('completion requires both a successful process and a completed final turn', () => {
  const completed = JSON.stringify({ type: 'final', sessionId: 's', text: 'done', reason: { kind: 'completed' } });
  assert.equal(parseRun(completed, 0).status, 'completed');
  assert.equal(parseRun(completed, 1).status, 'failed');
  assert.equal(parseRun('{"type":"session","sessionId":"s"}', 0).status, 'failed');
  assert.equal(parseRun('{"type":"final","reason":{"kind":"aborted"}}', 0).status, 'failed');
  assert.throws(() => parseRun('not JSON', 0), /NDJSON/);
});

test('project_root rejects missing, relative, absent and file paths before starting a worker', async (t) => {
  const base = await workspace(t);
  const marker = join(base, 'launched');
  const file = join(base, 'not-a-directory');
  await writeFile(file, 'file');
  const worker = createWorker({ home: join(base, 'home'), command: nodeCommand(`
    import { writeFile } from 'node:fs/promises';
    process.stdin.resume();
    await writeFile(${JSON.stringify(marker)}, 'launched');
    console.log(JSON.stringify({ type: 'final', reason: { kind: 'completed' } }));
  `) });
  await assert.rejects(worker.delegate({ task: 'read' }), /project_root.*absolute/);
  await assert.rejects(worker.delegate({ project_root: 'relative-project', task: 'read' }), /project_root.*absolute/);
  await assert.rejects(worker.delegate({ project_root: join(base, 'missing'), task: 'read' }), { code: 'ENOENT' });
  await assert.rejects(worker.delegate({ project_root: file, task: 'read' }), /project_root.*directory/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('one worker edits two projects sequentially with a separate canonical project_root per call', async (t) => {
  const base = await workspace(t);
  const roots = [join(base, 'first'), join(base, 'second')];
  for (const [index, root] of roots.entries()) {
    await mkdir(root);
    await exec('git', ['init', '-q'], { cwd: root });
    await writeFile(join(root, 'project.txt'), `project ${index + 1}`);
    await exec('git', ['add', '.'], { cwd: root });
  }
  const alias = join(base, 'first-alias');
  await symlink(roots[0], alias);
  const worker = createWorker({ home: join(base, 'home'), command: nodeCommand(`
    import { readFile, writeFile } from 'node:fs/promises';
    process.stdin.resume();
    await writeFile('project.txt', (await readFile('project.txt', 'utf8')) + ' edited');
    console.log(JSON.stringify({ type: 'final', sessionId: 's', text: 'edited', reason: { kind: 'completed' } }));
  `) });
  const first = await worker.delegate({ project_root: alias, task: 'edit first', permission_mode: 'workspace-write' });
  assert.equal(first.status, 'completed');
  assert.equal(first.project_root, await realpath(roots[0]));
  assert.equal(first.cwd, first.project_root);
  assert.deepEqual(first.changed_files, ['project.txt']);
  assert.equal(await readFile(join(roots[0], 'project.txt'), 'utf8'), 'project 1 edited');
  assert.equal(await readFile(join(roots[1], 'project.txt'), 'utf8'), 'project 2');

  const second = await worker.delegate({ project_root: roots[1], task: 'edit second', permission_mode: 'workspace-write' });
  assert.equal(second.status, 'completed');
  assert.equal(second.project_root, await realpath(roots[1]));
  assert.equal(second.cwd, second.project_root);
  assert.deepEqual(second.changed_files, ['project.txt']);
  assert.equal(await readFile(join(roots[0], 'project.txt'), 'utf8'), 'project 1 edited');
  assert.equal(await readFile(join(roots[1], 'project.txt'), 'utf8'), 'project 2 edited');
});

test('cwd rejects traversal and symlink escapes before starting a worker', async (t) => {
  const base = await workspace(t);
  const root = join(base, 'repo');
  await mkdir(root);
  await symlink(base, join(root, 'escape'));
  const marker = join(base, 'launched');
  const worker = createWorker({ home: join(base, 'home'), command: nodeCommand(`
    import { writeFile } from 'node:fs/promises';
    process.stdin.resume();
    await writeFile(${JSON.stringify(marker)}, 'launched');
    console.log(JSON.stringify({ type: 'final', reason: { kind: 'completed' } }));
  `) });
  await assert.rejects(worker.delegate({ project_root: root, task: 'read', cwd: '..' }), /outside/);
  await assert.rejects(worker.delegate({ project_root: root, task: 'read', cwd: 'escape' }), /outside/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('file changes include edits to already-dirty files, new files and deletions, not untouched user changes', async (t) => {
  const root = await workspace(t);
  await exec('git', ['init', '-q'], { cwd: root });
  await writeFile(join(root, 'modified.txt'), 'base');
  await writeFile(join(root, 'deleted.txt'), 'base');
  await exec('git', ['add', '.'], { cwd: root });
  await writeFile(join(root, 'modified.txt'), 'user change');
  await writeFile(join(root, 'untouched.txt'), 'keep user change');
  const worker = createWorker({ home: join(root, 'home'), command: nodeCommand(`
    import { writeFile, unlink } from 'node:fs/promises';
    process.stdin.resume();
    await writeFile('modified.txt', 'worker change');
    await writeFile('new\\nname.txt', 'new');
    await unlink('deleted.txt');
    console.log(JSON.stringify({ type: 'final', sessionId: 's', text: 'edited', reason: { kind: 'completed' } }));
  `) });
  const result = await worker.delegate({ project_root: root, task: 'edit', permission_mode: 'workspace-write' });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.changed_files, ['deleted.txt', 'modified.txt', 'new\nname.txt']);
});

test('concurrent calls are refused; timeout stops the worker and releases the slot', async (t) => {
  const base = await workspace(t);
  const roots = [join(base, 'first'), join(base, 'second')];
  await Promise.all(roots.map((root) => mkdir(root)));
  const worker = createWorker({ home: join(base, 'home'), command: nodeCommand('process.stdin.resume(); setInterval(() => {}, 1000);') });
  const first = worker.delegate({ project_root: roots[0], task: 'wait', timeout_seconds: 0.1 });
  await assert.rejects(worker.delegate({ project_root: roots[1], task: 'overlap' }), /busy/);
  assert.equal((await first).status, 'timed_out');
  assert.equal((await worker.delegate({ project_root: roots[1], task: 'again', timeout_seconds: 0.1 })).status, 'timed_out');
});

test('cancellation kills descendants even when they ignore SIGTERM', async (t) => {
  const root = await workspace(t);
  const controller = new AbortController();
  const watcher = watch(root, { signal: AbortSignal.timeout(5000) });
  const ready = (async () => {
    for await (const event of watcher) {
      if (event.filename === 'ready') return Number(await readFile(join(root, 'ready'), 'utf8'));
    }
    throw new Error('Child never became ready');
  })();
  const run = runProcess(nodeCommand(`
    import { spawn } from 'node:child_process';
    spawn(process.execPath, ['-e', 'const fs = require("node:fs"); process.on("SIGTERM", () => {}); fs.writeFileSync("ready.tmp", String(process.pid)); fs.renameSync("ready.tmp", "ready"); setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    process.stdin.resume();
    setInterval(() => {}, 1000);
  `), { cwd: root, env: process.env, input: 'wait', timeoutMs: 5000, signal: controller.signal });
  const pid = await ready;
  await watcher.return();
  controller.abort();
  const result = await run;
  assert.equal(result.failure, 'cancelled');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('an overlarge event stream fails rather than silently reporting truncated success', async (t) => {
  const root = await workspace(t);
  const result = await runProcess(nodeCommand('process.stdin.resume(); setInterval(() => process.stdout.write("x".repeat(65536)), 1);'), {
    cwd: root, env: process.env, input: '', timeoutMs: 5000,
  });
  assert.equal(result.failure, 'output_limit');
});
