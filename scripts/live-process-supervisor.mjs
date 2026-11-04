// Test-only process-group anchor. It outlives the command so its PGID stays reserved
// until the controller finishes cleanup, even if the command exits before helpers.
import { spawn } from 'node:child_process';
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
const keepAlive = setInterval(() => {}, 60000);
const controllerGone = () => {
  clearInterval(keepAlive);
  // We are still the live group leader; a dead controller must not leave this group behind.
  process.kill(-process.pid, 'SIGKILL');
};
process.on('disconnect', controllerGone);
if (!process.connected) controllerGone();
process.send({ ready: true });
const command = spawn(process.argv[2], process.argv.slice(3), {
  stdio: ['ignore', 'inherit', 'inherit'],
  shell: false,
});
command.on('error', (error) => {
  if (process.connected) process.send({ error: error.message });
});
command.on('exit', (code, signal) => {
  if (process.connected) process.send({ code, signal });
});
