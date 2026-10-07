// Generates a stable development extension key so the unpacked extension always gets the same ID.
// Only the PUBLIC key is kept (manifest.key.json). The private key is discarded on purpose.
import { generateKeyPairSync, createHash } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';

const out = new URL('../manifest.key.json', import.meta.url);
if (existsSync(out)) {
  console.log('manifest.key.json already exists - keeping it');
  process.exit(0);
}
const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = publicKey.export({ type: 'spki', format: 'der' });
const hash = createHash('sha256').update(der).digest().subarray(0, 16);
const id = [...hash].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join('');
writeFileSync(out, JSON.stringify({ key: der.toString('base64'), id }, null, 2) + '\n');
console.log('Extension id:', id);
