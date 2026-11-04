import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesPrintCommand } from '../scripts/live-safety.mjs';

const command = `python3 -I -S -c 'print("BRIDGE_SUITE_abc123_APPROVED")'`;
const wrapped = `/bin/zsh -lc "${command.replaceAll('"', '\\"')}"`;

test('live approval accepts the exact print command including Codex shell wrapping', () => {
  assert.equal(matchesPrintCommand(command, command), true);
  assert.equal(matchesPrintCommand(wrapped, command), true);
});

test('live approval refuses appended commands, substitutions and unrelated executables', () => {
  for (const actual of [
    command + '; touch unsafe',
    wrapped + ' && touch unsafe',
    wrapped.replace('print(', 'eval('),
    wrapped.replace('/bin/zsh', '/tmp/unknown'),
    wrapped.replace('BRIDGE_SUITE', '$(touch unsafe)'),
  ]) {
    assert.equal(matchesPrintCommand(actual, command), false);
  }
});

test('the expected command itself must be the isolated fixed-marker print', () => {
  for (const unsafe of [
    'touch unsafe',
    `python3 -I -S -c 'print("$(touch unsafe)")'`,
    `python3 -I -S -c 'print("ok");open("bad","w")'`,
  ]) {
    assert.equal(matchesPrintCommand(unsafe, unsafe), false);
  }
});
