import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const common = { bundle: true, sourcemap: true, logLevel: 'info', define: { __WHAMMING_VERSION__: JSON.stringify(pkgVersion) } };

await Promise.all([
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/main/window-preload.ts'], outfile: 'dist/main/window-preload.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/main/popover-preload.ts'], outfile: 'dist/main/popover-preload.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/renderer/popover.ts'], outfile: 'dist/renderer/popover.js', platform: 'browser', format: 'iife' }),
  build({ ...common, entryPoints: ['src/server/standalone.ts'], outfile: 'dist/server/standalone.js', platform: 'node', format: 'cjs' }),
  build({ ...common, entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer/app.js', platform: 'browser', format: 'iife' }),
  // The pi extension, shipped next to the CLI (Contents/Resources/whamming-pi.js) and linked into ~/.pi/agent/extensions.
  build({ ...common, sourcemap: false, entryPoints: ['src/pi/extension.ts'], outfile: 'dist/cli/whamming-pi.js', platform: 'node', format: 'esm', target: 'node20' }),
]);

// The Go CLI (bundled into the .app as Contents/Resources/whamming).
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
try {
  execFileSync('go', ['build', '-trimpath', '-ldflags', `-s -w -X main.version=${version}`, '-o', '../dist/cli/whamming', '.'], {
    cwd: 'cli',
    env: { ...process.env, CGO_ENABLED: '0' },
    stdio: 'inherit',
  });
  console.log('  dist/cli/whamming (go)');
} catch {
  console.warn('  ! go build failed or Go is not installed: the app will run without a bundled CLI');
}

mkdirSync('dist/renderer', { recursive: true });
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/styles.css', 'dist/renderer/styles.css');
cpSync('src/renderer/popover.html', 'dist/renderer/popover.html');
cpSync('src/renderer/popover.css', 'dist/renderer/popover.css');
cpSync('assets/icon.png', 'dist/renderer/icon.png');
cpSync('docs/agent-instructions.md', 'dist/renderer/agent-instructions.md');
