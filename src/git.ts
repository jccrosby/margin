import { spawnSync } from 'node:child_process';
import { delimiter, isAbsolute } from 'node:path';
import { runInDirectory } from './macos.ts';

export function git(directory: number, ...args: string[]) {
  const { PATH, HOME, XDG_CONFIG_HOME } = process.env;
  const searchPath = PATH?.split(delimiter).filter(isAbsolute).join(delimiter) || '/usr/bin:/bin';
  const options = [
    '--no-pager', '--no-optional-locks', '--literal-pathspecs',
    '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'
  ];
  const result = runInDirectory(directory, () => spawnSync('git', [...options, ...args], {
    env: { PATH: searchPath, HOME, XDG_CONFIG_HOME, LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // shortcut: Buffer 32 MiB of Git paths. Stream paths if an inventory exceeds this cap.
    maxBuffer: 32 * 1024 * 1024
  }));
  if (result.error) throw result.error;
  if (result.status !== 0 || (args[0] === 'ls-files' && result.stderr.length)) {
    throw new Error('Git could not complete the source scan.');
  }
  return result.stdout;
}

export function requireGitCheckout(directory: number) {
  if (git(directory, 'rev-parse', '--show-prefix').toString().trim() ||
      git(directory, 'rev-parse', '--is-inside-work-tree').toString().trim() !== 'true') {
    throw new Error('Choose a Git checkout root.');
  }
}
