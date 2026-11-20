import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('Build Margin on Apple silicon with macOS.');
}

const project = fileURLToPath(new URL('..', import.meta.url));
const headers = join(dirname(process.execPath), '..', 'include', 'node');
mkdirSync(join(project, 'dist'), { recursive: true });
execFileSync('xcrun', ['clang', '-std=c17', '-D_DARWIN_C_SOURCE', '-O2', '-Wall', '-Wextra', '-Werror',
  '-mmacosx-version-min=26.0', '-bundle', '-undefined', 'dynamic_lookup', '-I', headers,
  '-o', 'dist/macos.node', 'native/macos.c'], { cwd: project, stdio: 'inherit' });
