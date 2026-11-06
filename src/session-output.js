import { realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { Session } from '@deepseek-ai/dsh-session';
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { currentSessionMessageProjections } from '@deepseek-ai/dsh-session-format-catalog/message-projections';

export async function readSessionOutput({ home, sessionId, cwd }) {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('A persisted DSH session ID is required');
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('The session cwd must be an absolute path');
  const physicalCwd = await realpath(cwd);
  const ctx = new Context();
  try {
    await ctx.plugin(JsonlSessionPersistence, { root: join(home, 'sessions') }).await();
    const persistence = ctx.sessionPersistence;
    const snapshot = await persistence.stat(sessionId);
    if (!snapshot?.location?.path) throw new Error('Persisted session log not found');
    const handle = await persistence.open(sessionId, 'read');
    let read;
    try {
      if (handle.header.id !== sessionId || snapshot.header.id !== sessionId) {
        throw new Error('Persisted session header ID does not match the requested session');
      }
      if (!handle.header.cwd || await realpath(handle.header.cwd) !== physicalCwd
        || snapshot.header.cwd !== handle.header.cwd) {
        throw new Error('Persisted session cwd does not match the requested physical cwd');
      }
      read = await handle.read();
    } finally {
      await handle.close();
    }

    // Restore only in memory: the storage backend owns decoding and migrations.
    const session = Session.fromRestore(sessionId, read.events, handle.header,
      handle.inheritedEventCount, read.eventState, currentSessionMessageProjections);
    const events = read.events;
    let start = events.length - 1;
    while (start >= 0 && events[start].type !== 'turn/start') start--;
    if (start < 0) throw new Error('Persisted session has no durable turn');
    const turn = events[start].data.turn;
    const current = new Set(session.surface.nodes);
    let text = '';
    let assistantSeq = null;
    let terminalReason = null;
    for (let index = events.length - 1; index > start; index--) {
      const event = events[index];
      if (event.type === 'turn/end' && event.data.turn === turn && terminalReason === null) {
        terminalReason = event.data.reason;
      }
      if (event.type !== 'assistant/message' || event.data.turn !== turn
        || assistantSeq !== null || !current.has(event.seq)) continue;
      const message = session.deriveEventMessage(event);
      const visibleText = message?.content.filter((block) => block.type === 'text').map((block) => block.text).join('') ?? '';
      if (visibleText) {
        text = visibleText;
        assistantSeq = event.seq;
      }
    }
    return {
      session_id: sessionId,
      text,
      session_file: snapshot.location.path,
      assistant_seq: assistantSeq,
      turn,
      terminal_reason: terminalReason,
    };
  } catch (error) {
    throw new Error(`Cannot read persisted DSH session "${sessionId}": ${error.message}`, { cause: error });
  } finally {
    await ctx.fiber.dispose();
  }
}
