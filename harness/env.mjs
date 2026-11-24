// Paths come from the environment; nothing is hardcoded.
//   CHROME_BIN   path to the patched Chromium/Chrome executable
//   PROFILE_DIR  directory for throwaway --user-data-dir profiles
import fs from 'node:fs';
export const CHROME_BIN = process.env.CHROME_BIN || '';
export const PROFILE_DIR = process.env.PROFILE_DIR || '';
export function requireEnv({needBinary = true} = {}) {
  const missing = [];
  if (needBinary && !CHROME_BIN) missing.push('CHROME_BIN');
  if (!PROFILE_DIR) missing.push('PROFILE_DIR');
  if (missing.length) {
    console.error('Set ' + missing.join(' and ') + ' (see README.md).');
    process.exit(2);
  }
  if (needBinary && !fs.existsSync(CHROME_BIN)) {
    console.error('CHROME_BIN does not exist: ' + CHROME_BIN);
    process.exit(2);
  }
}
