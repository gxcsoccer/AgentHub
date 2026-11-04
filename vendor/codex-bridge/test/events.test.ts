import test from 'node:test';
import assert from 'node:assert/strict';
import { EventLog } from '../src/events.js';

test('event replay preserves order and filters sessions without renumbering', () => {
  const log = new EventLog(10);
  const start = log.cursor;
  const first = log.publish('response.delta', { text: 'a' }, 'session-a');
  log.publish('response.delta', { text: 'b' }, 'session-b');
  const third = log.publish('turn.completed', {}, 'session-a');
  assert.deepEqual(
    log.replay(start, 'session-a').map((e) => e.id),
    [first.id, third.id],
  );
  assert.deepEqual(
    log.replay(first.id).map((e) => e.type),
    ['response.delta', 'turn.completed'],
  );
  assert.equal(log.cursor, third.id);
});

test('event buffers reject stale, future and other-process cursors instead of hiding gaps', () => {
  const log = new EventLog(2);
  const old = log.cursor;
  const first = log.publish('one', {});
  log.publish('two', {});
  log.publish('three', {});
  assert.throws(() => log.replay(old), /expired/);
  assert.equal(log.replay(first.id).length, 2);
  assert.throws(() => log.replay(new EventLog().cursor), /different bridge/);
  assert.throws(() => log.replay(log.cursor.replace(/:\d+$/, ':999')), /future/);
});

test('event retention is bounded by bytes as well as item count', () => {
  const log = new EventLog(100, 400);
  const before = log.cursor;
  log.publish('large', { text: 'x'.repeat(500) });
  assert.throws(() => log.replay(before), /expired/);
});
