import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { Session, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { readSessionOutput } from '../src/session-output.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-session-output-')));
  const home = join(root, 'home');
  await mkdir(home);
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await ctx.plugin(JsonlSessionPersistence, { root: join(home, 'sessions') }).await();
  return {
    root,
    home,
    persistence: ctx.sessionPersistence,
    create(sessionId = 'session', cwd = root) {
      const session = Session.create(sessionId, undefined, {
        version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, cwd, isSeeded: false,
      });
      let created = false;
      return {
        session,
        args: { home, sessionId, cwd },
        async persist(build = () => {}) {
          const handle = created
            ? await ctx.sessionPersistence.open(sessionId, 'write')
            : await ctx.sessionPersistence.create(session.header);
          try {
            const offset = session.seq;
            build(session);
            await handle.append(session.snapshotEvents(offset));
            await handle.flush();
            created = true;
          } finally {
            await handle.close();
          }
          return (await ctx.sessionPersistence.stat(sessionId)).location.path;
        },
      };
    },
  };
}

const text = (value) => ({ type: 'text', text: value });
const reasoning = (value) => ({ type: 'reasoning', text: value });
function assistant(session, turn, step, content, surfaceOp = 'append') {
  return session.append('assistant/message', {
    turn,
    step,
    message: {
      id: `assistant-${session.seq}`,
      role: 'assistant',
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      content,
    },
    stream: content.flatMap((block, index) => ['text', 'reasoning'].includes(block.type) ? [{
      type: `${block.type}-chunks`, time0: 0, index, dt: [], texts: [block.text],
    }] : []),
  }, { surfaceOp });
}
function complete(session, turn, value) {
  session.append('turn/start', { turn });
  session.append('step/start', { turn, step: 1 });
  const event = assistant(session, turn, 1, [text(value)]);
  session.append('step/end', { turn, step: 1 });
  session.append('turn/end', { turn, reason: { kind: 'completed' } });
  return event;
}

test('reads the final assistant text from library-written default zstd without changing the log', async (t) => {
  const f = await fixture(t);
  const saved = f.create();
  let final;
  const path = await saved.persist((session) => {
    session.append('turn/start', { turn: 1 });
    session.append('step/start', { turn: 1, step: 1 });
    assistant(session, 1, 1, [text('first response')]);
    session.append('step/end', { turn: 1, step: 1 });
    session.append('step/start', { turn: 1, step: 2 });
    final = assistant(session, 1, 2, [reasoning('private thinking'), text('last '), text('answer')]);
    session.append('assistant/attempt', {
      turn: 1, step: 2,
      stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [], texts: ['discarded attempt'] }],
    });
    session.append('step/end', { turn: 1, step: 2 });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  });
  assert.match(path, /\.zstd$/);
  const before = await readFile(path);
  assert.deepEqual(await readSessionOutput(saved.args), {
    session_id: 'session', text: 'last answer', session_file: path,
    assistant_seq: final.seq, turn: 1, terminal_reason: { kind: 'completed' },
  });
  assert.deepEqual(await readFile(path), before);
});

test('a resumed session returns only its newest durable turn and leaves another live writer usable', async (t) => {
  const f = await fixture(t);
  const saved = f.create();
  await saved.persist((session) => complete(session, 1, 'previous success'));
  assert.equal((await readSessionOutput(saved.args)).text, 'previous success');
  let latest;
  await saved.persist((session) => { latest = complete(session, 2, 'resumed answer'); });
  const writer = await f.persistence.open('session', 'write');
  try {
    const result = await readSessionOutput(saved.args);
    assert.equal(result.text, 'resumed answer');
    assert.equal(result.turn, 2);
    assert.equal(result.assistant_seq, latest.seq);
    const offset = saved.session.seq;
    complete(saved.session, 3, 'writer still works');
    await writer.append(saved.session.snapshotEvents(offset));
    await writer.flush();
    assert.equal((await readSessionOutput(saved.args)).text, 'writer still works');
  } finally {
    await writer.close();
  }
});

for (const reason of [null, { kind: 'interrupted' }, { kind: 'aborted', reason: { kind: 'user' } },
  { kind: 'error', error: { code: 'FIXTURE_ERROR', message: 'failed request' } }]) {
  test(`a latest ${reason?.kind ?? 'unclosed'} turn with no text never returns a previous success`, async (t) => {
    const f = await fixture(t);
    const saved = f.create();
    await saved.persist((session) => complete(session, 1, 'must not return this'));
    const path = await saved.persist((session) => {
      session.append('turn/start', { turn: 2 });
      if (reason) session.append('turn/end', { turn: 2, reason });
    });
    const before = await readFile(path);
    const result = await readSessionOutput(saved.args);
    assert.equal(result.text, '');
    assert.equal(result.assistant_seq, null);
    assert.equal(result.turn, 2);
    assert.deepEqual(result.terminal_reason, reason);
    assert.deepEqual(await readFile(path), before);
  });
}

test('reasoning, tool requests/results and attempt text are never returned as assistant text', async (t) => {
  const f = await fixture(t);
  const saved = f.create();
  await saved.persist((session) => {
    complete(session, 1, 'old answer');
    session.append('turn/start', { turn: 2 });
    session.append('step/start', { turn: 2, step: 1 });
    assistant(session, 2, 1, [reasoning('hidden reasoning'), {
      type: 'tool-call', id: 'call', name: 'read', arguments: '{"secret":"tool arguments"}',
    }]);
    session.append('tool/call', { turn: 2, step: 1, callId: 'call', name: 'read', arguments: '{"secret":"tool arguments"}' });
    session.append('tool/result', {
      turn: 2, step: 1,
      message: {
        id: 'tool-result', role: 'tool', source: { kind: 'tool', callId: 'call' }, toolCallId: 'call',
        content: [text('tool result text')],
      },
    }, { surfaceOp: 'append' });
    session.append('assistant/attempt', {
      turn: 2, step: 1,
      stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [], texts: ['uncommitted text'] }],
    });
    session.append('step/end', { turn: 2, step: 1 });
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
  });
  const result = await readSessionOutput(saved.args);
  assert.equal(result.text, '');
  assert.equal(result.assistant_seq, null);
});

test('a later reasoning-only message cannot hide the latest visible assistant text', async (t) => {
  const f = await fixture(t);
  const saved = f.create();
  let visible;
  await saved.persist((session) => {
    session.append('turn/start', { turn: 1 });
    session.append('step/start', { turn: 1, step: 1 });
    visible = assistant(session, 1, 1, [text('visible answer')]);
    session.append('step/end', { turn: 1, step: 1 });
    session.append('step/start', { turn: 1, step: 2 });
    assistant(session, 1, 2, [reasoning('do not expose')]);
    session.append('step/end', { turn: 1, step: 2 });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  });
  const result = await readSessionOutput(saved.args);
  assert.equal(result.text, 'visible answer');
  assert.equal(result.assistant_seq, visible.seq);
});

test('canonical surface replacements exclude shadowed assistant text', async (t) => {
  const f = await fixture(t);
  const saved = f.create();
  await saved.persist((session) => {
    session.append('turn/start', { turn: 1 });
    session.append('step/start', { turn: 1, step: 1 });
    const discarded = assistant(session, 1, 1, [text('shadowed answer')]);
    session.append('step/end', { turn: 1, step: 1 });
    session.append('user/message', {
      id: 'replacement', role: 'user', source: { kind: 'user' }, content: [text('replacement user text')],
    }, {
      surfaceOp: { op: 'replace', startSeq: discarded.seq, endSeq: discarded.seq },
      sourceEventSeqs: [discarded.seq],
    });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  });
  const result = await readSessionOutput(saved.args);
  assert.equal(result.text, '');
  assert.equal(result.assistant_seq, null);
});

test('an interrupted turn can return its own committed partial text, not an older answer', async (t) => {
  const f = await fixture(t);
  const saved = f.create();
  await saved.persist((session) => {
    complete(session, 1, 'old answer');
    session.append('turn/start', { turn: 2 });
    session.append('step/start', { turn: 2, step: 1 });
    assistant(session, 2, 1, [reasoning('hidden'), text('partial current answer')]);
  });
  const result = await readSessionOutput(saved.args);
  assert.equal(result.text, 'partial current answer');
  assert.equal(result.turn, 2);
  assert.equal(result.terminal_reason, null);
});

test('rejects another physical cwd but accepts a symlink spelling of the requested cwd', async (t) => {
  const f = await fixture(t);
  const saved = f.create();
  await saved.persist((session) => complete(session, 1, 'answer'));
  const other = join(f.root, 'other-project');
  await mkdir(other);
  await assert.rejects(readSessionOutput({ ...saved.args, cwd: other }), /cwd does not match/);
  const alias = join(f.root, 'project-alias');
  await symlink(f.root, alias);
  assert.equal((await readSessionOutput({ ...saved.args, cwd: alias })).text, 'answer');
});

test('rejects a physical log whose saved header identifies another session', async (t) => {
  const f = await fixture(t);
  const requested = f.create('requested');
  const other = f.create('other');
  const requestedPath = await requested.persist((session) => complete(session, 1, 'requested answer'));
  const otherPath = await other.persist((session) => complete(session, 1, 'must not leak this'));
  await copyFile(otherPath, requestedPath);
  await assert.rejects(readSessionOutput(requested.args), /header id|header ID|requested id/i);
});

test('rejects a header-only session instead of inventing a turn', async (t) => {
  const f = await fixture(t);
  const saved = f.create();
  await saved.persist();
  await assert.rejects(readSessionOutput(saved.args), /no durable turn/);
});

test('rejects missing logs without creating a persistence root', async (t) => {
  const f = await fixture(t);
  await assert.rejects(readSessionOutput({ home: f.home, sessionId: 'absent', cwd: f.root }), /log not found/);
  await assert.rejects(stat(join(f.home, 'sessions')), { code: 'ENOENT' });
});

for (const corruption of ['header', 'checksum']) {
  test(`rejects a corrupt ${corruption} instead of returning any session text`, async (t) => {
    const f = await fixture(t);
    const saved = f.create();
    const path = await saved.persist((session) => complete(session, 1, 'must not return this'));
    if (corruption === 'header') {
      await writeFile(path, 'not a Zstandard log');
    } else {
      const bytes = await readFile(path);
      bytes[bytes.length - 1] ^= 1;
      await writeFile(path, bytes);
    }
    await assert.rejects(readSessionOutput(saved.args), /Cannot read persisted DSH session/);
  });
}
