/** Only a fixed print command and known shell wrappers may be approved by a live probe. */
export function matchesPrintCommand(actual, expected) {
  if (!/^python3 -I -S -c 'print\("BRIDGE_SUITE_[a-f0-9]+_APPROVED"\)'$/.test(expected))
    return false;
  if (actual === expected) return true;
  const quoted = expected.replaceAll('"', '\\"');
  return ['/bin/zsh', '/bin/bash', '/bin/sh'].some((shell) =>
    ['-c', '-lc'].some((flag) => actual === `${shell} ${flag} "${quoted}"`),
  );
}
