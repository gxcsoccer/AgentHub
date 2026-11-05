import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { HubError } from '../validation.js';
import type { ProcessIdentity, ProcessInspector } from './types.js';

// libproc's public PROC_PIDTBSDINFO layout, including microsecond process start.
// -I prevents Python environment/site customization from affecting inspection.
const macProbe = `import ctypes,json,sys
class BSD(ctypes.Structure):
 _fields_=[(x,ctypes.c_uint32) for x in ['flags','status','xstatus','pid','ppid','uid','gid','ruid','rgid','svuid','svgid','rfu']]+[('comm',ctypes.c_char*16),('name',ctypes.c_char*32)]+[(x,ctypes.c_uint32) for x in ['nfiles','pgid','pjobc','tdev','tpgid']]+[('nice',ctypes.c_int32),('start_sec',ctypes.c_uint64),('start_usec',ctypes.c_uint64)]
lib=ctypes.CDLL('/usr/lib/libproc.dylib')
lib.proc_pidinfo.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_uint64,ctypes.c_void_p,ctypes.c_int]
lib.proc_pidinfo.restype=ctypes.c_int
b=BSD();n=lib.proc_pidinfo(int(sys.argv[1]),3,0,ctypes.byref(b),ctypes.sizeof(b))
if n!=ctypes.sizeof(b): raise RuntimeError('process unavailable')
print(json.dumps([{k:getattr(b,k) for k in ['pid','ppid','uid','start_sec','start_usec']}]))`;
const exec = promisify(execFile);
export function createProcessInspector(
  options: {
    platform?: NodeJS.Platform;
    execute?: (command: string, args: string[]) => Promise<string>;
    read?: (path: string) => Promise<string>;
  } = {},
): ProcessInspector {
  const platform = options.platform ?? process.platform;
  const execute =
    options.execute ??
    (async (command, args) =>
      (await exec(command, args, { timeout: 5000, maxBuffer: 65536 })).stdout);
  const read = options.read ?? ((path: string) => readFile(path, 'utf8'));
  return async (pid) => {
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647)
      throw new HubError('invalid_identity', 'PID must be a positive 32-bit integer');
    if (platform !== 'darwin' && platform !== 'linux')
      throw new HubError(
        'unsupported_platform',
        'Native connector identity requires a supported POSIX platform',
        501,
      );
    try {
      let result: ProcessIdentity;
      if (platform === 'darwin') {
        const rows = JSON.parse(await execute('python3', ['-I', '-c', macProbe, String(pid)]));
        if (!Array.isArray(rows) || rows.length !== 1) throw Error('shape');
        const r = rows[0];
        if (
          r.pid !== pid ||
          !Number.isSafeInteger(r.start_sec) ||
          r.start_sec < 1 ||
          !Number.isSafeInteger(r.start_usec) ||
          r.start_usec < 0 ||
          r.start_usec >= 1000000
        )
          throw Error('start');
        result = { pid, ppid: r.ppid, uid: r.uid, start: `darwin:${r.start_sec}:${r.start_usec}` };
      } else {
        const stat = await read(`/proc/${pid}/stat`);
        const end = stat.lastIndexOf(')');
        const values = stat
          .slice(end + 2)
          .trim()
          .split(/\s+/);
        const uid = /^Uid:\s+\d+\s+(\d+)/m.exec(await read(`/proc/${pid}/status`));
        const boot = (await read('/proc/sys/kernel/random/boot_id')).trim();
        if (
          end < 0 ||
          Number(stat.slice(0, stat.indexOf(' '))) !== pid ||
          !uid ||
          !/^\d+$/.test(values[19] ?? '') ||
          !boot ||
          boot.length > 128
        )
          throw Error('proc');
        result = {
          pid,
          ppid: Number(values[1]),
          uid: Number(uid[1]),
          start: `linux:${boot}:${values[19]}`,
        };
      }
      if (
        !Number.isSafeInteger(result.ppid) ||
        result.ppid < 1 ||
        !Number.isSafeInteger(result.uid) ||
        result.uid < 0
      )
        throw Error('owner');
      return result;
    } catch {
      throw new HubError(
        'identity_unavailable',
        'Cannot verify native process identity (macOS requires python3 with libproc)',
        409,
      );
    }
  };
}
