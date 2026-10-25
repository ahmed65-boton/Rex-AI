/* Web Crypto AES-GCM encryption for API keys at rest.
   Passphrase is held in a module-scoped variable only — never persisted. */
let sessionKey = null;
let sessionSalt = null;

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function fromB64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase, salt) {
  const base = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function initCryptoKey(passphrase, saltB64) {
  sessionSalt = saltB64 ? fromB64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  sessionKey = await deriveKey(passphrase, sessionSalt);
  return toB64(sessionSalt);
}

export function hasSessionKey() {
  return sessionKey !== null;
}

export function clearSessionKey() {
  sessionKey = null;
  sessionSalt = null;
}

export async function encryptJSON(obj) {
  if (!sessionKey) throw new Error('No encryption key — enter your passphrase.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, sessionKey, enc.encode(JSON.stringify(obj))
  );
  return { iv: toB64(iv), ct: toB64(ct) };
}

export async function decryptJSON(payload) {
  if (!sessionKey) throw new Error('No encryption key — enter your passphrase.');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(payload.iv) }, sessionKey, fromB64(payload.ct)
  );
  return JSON.parse(dec.decode(pt));
}
