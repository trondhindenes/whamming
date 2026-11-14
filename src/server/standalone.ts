import { resolve } from 'node:path';
import { createApi, findBundledCli } from './api';
import { STATE_FILE, STATUS_FILE } from './paths';
import { removeStatus, startOrReuse } from './status';
import { Store } from './store';

// Headless mode: same API + dashboard in the browser, no Electron.
const store = new Store(STATE_FILE);
const listen = createApi(store, { staticDir: resolve(__dirname, '../renderer'), bundledCli: findBundledCli(resolve(__dirname, '..')) });

startOrReuse(listen)
  .then((r) => {
    if ('reuse' in r) {
      console.log(`whamming is already running on ${r.reuse} for this data folder; not starting a second server.`);
      process.exit(0);
    }
    store.startReaper();
    console.log(`whamming listening on ${r.api.url}  (state: ${STATE_FILE}, status: ${STATUS_FILE})`);
    const stop = async () => {
      store.flush();
      removeStatus();
      await r.api.close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.on('exit', removeStatus);
  })
  .catch((err) => {
    console.error(`whamming: could not start: ${err.message}`);
    process.exit(1);
  });
