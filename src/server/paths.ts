import { homedir } from 'node:os';
import { join } from 'node:path';

/** Shared between the Electron app and the standalone server so they see the same state. */
export const DATA_DIR = process.env.WHAMMING_HOME || join(homedir(), '.whamming');
export const STATE_FILE = join(DATA_DIR, 'state.json');
/** Written while a Whamming server runs, so the CLI and hooks can find it (and know when it isn't running). */
export const STATUS_FILE = join(DATA_DIR, 'status.json');
