import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { runInDirectory, windows } from './filesystem.ts';

export function git(directory: number, ...args: string[]) {
  const { PATH, HOME, XDG_CONFIG_HOME, SystemRoot, WINDIR, USERPROFILE } = process.env;
  const directories = PATH?.split(delimiter).map(path => path.replace(/^"(.*)"$/, '$1')).filter(isAbsolute) ?? [];
  const searchPath = directories.join(delimiter) || '/usr/bin:/bin';
  const executable = windows
    ? directories.map(path => join(path, 'git.exe')).find(path => statSync(path, { throwIfNoEntry: false })?.isFile())
    : 'git';
  if (!executable) throw new Error('Git could not complete the source scan.');
  const options = [
    '--no-pager', '--no-optional-locks', '--literal-pathspecs',
    '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'
  ];
  const result = runInDirectory(directory, cwd => spawnSync(executable, [...options, ...args], {
    cwd,
    env: { PATH: searchPath, HOME, XDG_CONFIG_HOME, LC_ALL: 'C',
      ...(windows ? { SystemRoot, WINDIR, USERPROFILE, TMP: process.env.TMP, TEMP: process.env.TEMP } : {}) },
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
