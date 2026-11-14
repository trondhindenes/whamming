// Builds release/Whamming-darwin-<arch>/Whamming.app with the real icon and name.
// (In dev, `electron .` runs inside Electron.app, so Cmd-Tab and the app menu say "Electron".)
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const [out] = await packager({
  dir: '.',
  name: 'Whamming',
  executableName: 'Whamming',
  appBundleId: 'app.whamming.desktop',
  appCategoryType: 'public.app-category.developer-tools',
  icon: 'assets/icon.icns',
  platform: 'darwin',
  arch: process.arch,
  out: 'release',
  overwrite: true,
  asar: true,
  prune: true,
  // Ship only what runs: the built bundle, icons and package.json.
  // The CLI binary goes next to app.asar (executables can't run from inside the archive).
  extraResource: ['dist/cli/whamming'],
  ignore: [/^\/(src|scripts|docs|bin|cli|release|\.git|\.claude)(\/|$)/, /^\/dist\/cli(\/|$)/, /^\/(tsconfig\.json|build\.mjs|README\.md|\.gitignore)$/, /\.map$/],
});

const app = join(out, 'Whamming.app');
// Changing Info.plist/icon invalidates Electron's signature; re-sign ad hoc so macOS will launch it locally.
execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
console.log(`built ${app}`);
