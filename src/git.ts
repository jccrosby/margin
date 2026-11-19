import { spawnSync } from 'node:child_process';

export function git(path: string, ...args: string[]) {
  const { PATH, HOME, XDG_CONFIG_HOME } = process.env;
  const options = [
    '--no-pager', '--no-optional-locks', '--literal-pathspecs',
    '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'
  ];
  const result = spawnSync('git', [...options, '-C', path, ...args], {
    env: { PATH, HOME, XDG_CONFIG_HOME, LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // shortcut: Buffer 32 MiB of Git paths. Stream paths if an inventory exceeds this cap.
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || (args[0] === 'ls-files' && result.stderr.length)) {
    throw new Error('Git could not complete the source scan.');
  }
  return result.stdout;
}

export function requireGitCheckout(path: string) {
  if (git(path, 'rev-parse', '--show-prefix').toString().trim() ||
      git(path, 'rev-parse', '--is-inside-work-tree').toString().trim() !== 'true') {
    throw new Error('Choose a Git checkout root.');
  }
}
