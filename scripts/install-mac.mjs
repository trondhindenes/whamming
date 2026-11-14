// Installs the packaged macOS bundle into the Applications folder.
//   npm run install-mac              build, then install
//   npm run install-mac -- --no-build   install whatever `npm run package` last left in release/
//   npm run install-mac -- --open       also launch it afterwards
// The ad hoc signed build installs fine locally: copying never sets the quarantine flag.
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const NAME = 'Whamming';
const APP_ID = 'app.whamming.desktop'; // keep in sync with scripts/package.mjs
const build = !process.argv.includes('--no-build');
const open = process.argv.includes('--open');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (process.platform !== 'darwin') fail('install-mac only runs on macOS.');

const bundleId = (app) => {
  try {
    return execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
};

if (build) {
  const res = spawnSync('npm', ['run', 'package'], { cwd: root, stdio: 'inherit' });
  if (res.status !== 0) fail('Build failed; nothing was installed.');
}

const source = join(root, 'release', `${NAME}-darwin-${process.arch}`, `${NAME}.app`);
if (!existsSync(source)) fail(`No ${source}. Run \`npm run package\` first.`);
if (bundleId(source) !== APP_ID) fail(`${source} is not ${APP_ID}; refusing to install it.`);

// Replacing a bundle that is running leaves the running copy broken.
if (spawnSync('pgrep', ['-x', NAME]).status === 0) fail(`${NAME} is running. Quit it (menu bar icon → Quit) and run this again.`);

const canWrite = (dir) => {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};
const dir = canWrite('/Applications') ? '/Applications' : join(homedir(), 'Applications');
mkdirSync(dir, { recursive: true });
const dest = join(dir, `${NAME}.app`);

if (existsSync(dest)) {
  if (!statSync(dest).isDirectory() || bundleId(dest) !== APP_ID) fail(`${dest} exists and is not ${APP_ID}; remove it yourself first.`);
  rmSync(dest, { recursive: true, force: true });
}

execFileSync('ditto', [source, dest]);
console.log(`Installed ${NAME} to ${dest}`);

// If the CLI was installed from another copy of the app (e.g. the one in release/), point it at this one.
// Only a link into some Whamming.app bundle is touched; anything else at that path is left alone.
const link = join(homedir(), '.local', 'bin', 'whamming');
const cli = join(dest, 'Contents', 'Resources', 'whamming');
try {
  if (lstatSync(link).isSymbolicLink()) {
    const target = resolve(dirname(link), readlinkSync(link));
    if (target !== cli && /\/Whamming\.app\/Contents\/Resources\/whamming$/.test(target)) {
      unlinkSync(link);
      symlinkSync(cli, link);
      console.log(`Pointed ${link} at ${cli}`);
    }
  }
} catch {
  // no CLI link yet: set it up from Agent setup in the app
}

if (open) execFileSync('open', [dest]);
