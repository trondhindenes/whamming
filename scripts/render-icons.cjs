// Renders assets/*.svg to the PNGs/ICNS the app needs. Run with: npm run icons
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const ASSETS = join(__dirname, '..', 'assets');

const SOURCES = ['icon.svg', 'tray.svg'];
let sheet = null;

/**
 * Render every SVG side by side in ONE window at 1024px each, capture once, then crop + downscale.
 * (A single renderer process; spawning one per SVG trips macOS sandboxing in some environments.)
 */
async function render(svgFile, size) {
  if (!sheet) {
    const imgs = SOURCES.map((f) => {
      const b64 = Buffer.from(readFileSync(join(ASSETS, f), 'utf8')).toString('base64');
      return `<img src="data:image/svg+xml;base64,${b64}" style="display:block;width:1024px;height:1024px">`;
    }).join('');
    const html = `<html><body style="margin:0;background:transparent;overflow:hidden;display:flex">${imgs}</body></html>`;
    const win = new BrowserWindow({ width: 1024 * SOURCES.length, height: 1024, show: false, transparent: true, frame: false, useContentSize: true, enableLargerThanScreen: true });
    await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
    await new Promise((r) => setTimeout(r, 300));
    sheet = await win.webContents.capturePage();
    win.destroy();
  }
  // capturePage returns device pixels; on a Retina screen the sheet is 2x.
  const scale = sheet.getSize().width / (1024 * SOURCES.length);
  const i = SOURCES.indexOf(svgFile);
  return sheet
    .crop({ x: Math.round(i * 1024 * scale), y: 0, width: Math.round(1024 * scale), height: Math.round(1024 * scale) })
    .resize({ width: size, height: size, quality: 'best' })
    .toPNG();
}

app.whenReady().then(async () => {
  const iconset = join(ASSETS, 'icon.iconset');
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset);
  for (const base of [16, 32, 128, 256, 512]) {
    writeFileSync(join(iconset, `icon_${base}x${base}.png`), await render('icon.svg', base));
    writeFileSync(join(iconset, `icon_${base}x${base}@2x.png`), await render('icon.svg', base * 2));
  }
  writeFileSync(join(ASSETS, 'icon.png'), await render('icon.svg', 1024));
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(ASSETS, 'icon.icns')]);
  rmSync(iconset, { recursive: true, force: true });

  writeFileSync(join(ASSETS, 'trayTemplate.png'), await render('tray.svg', 16));
  writeFileSync(join(ASSETS, 'trayTemplate@2x.png'), await render('tray.svg', 32));
  console.log('icons written to assets/');
  app.quit();
});
