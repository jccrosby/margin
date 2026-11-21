import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const dist = join(project, 'dist');
mkdirSync(dist, { recursive: true });
const options = { cwd: project, stdio: 'inherit' };
const headers = join(dirname(process.execPath), '..', 'include', 'node');

if (process.platform === 'darwin' && process.arch === 'arm64') {
  execFileSync('xcrun', ['clang', '-std=c17', '-D_DARWIN_C_SOURCE', '-O2', '-Wall', '-Wextra', '-Werror',
    '-mmacosx-version-min=26.0', '-bundle', '-undefined', 'dynamic_lookup', '-I', headers,
    '-o', 'dist/macos.node', 'native/macos.c'], options);
} else if (process.platform === 'win32' && process.arch === 'x64') {
  const npm = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  execFileSync(process.execPath, [npm, 'exec', '--yes', '--package=node-gyp@13.1.0', '--',
    'node-gyp', 'rebuild', '--directory', 'native'], options);
  copyFileSync(join(project, 'native', 'build', 'Release', 'windows.node'), join(dist, 'windows.node'));
} else if (process.platform === 'linux' && process.arch === 'x64') {
  execFileSync('cc', ['-std=c17', '-D_GNU_SOURCE', '-O2', '-Wall', '-Wextra', '-Werror', '-shared', '-fPIC',
    '-I', headers, '-o', 'dist/linux.node', 'native/linux.c'], options);
} else {
  throw new Error('Build Margin with native Node.js on macOS ARM64, Windows x64, or Ubuntu x64.');
}
