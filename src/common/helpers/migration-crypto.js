import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * AES-256-GCM envelope for the bundled migration seed. The repository is
 * public, so the personal data in the seed is committed only as
 * ciphertext; the key lives in the CDP Portal Secrets tab
 * (MIGRATION_SEED_KEY) and is removed once the migration has run.
 *
 * File format (base64 of): 12-byte IV || 16-byte auth tag || ciphertext
 */
export function encryptJson(value, keyHex) {
  const key = Buffer.from(keyHex, 'hex')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final()
  ])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')
}

export function decryptJson(payloadBase64, keyHex) {
  const key = Buffer.from(keyHex, 'hex')
  const payload = Buffer.from(payloadBase64, 'base64')
  const iv = payload.subarray(0, 12)
  const tag = payload.subarray(12, 28)
  const ciphertext = payload.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ])
  return JSON.parse(plaintext.toString('utf8'))
}

export function generateKeyHex() {
  return randomBytes(32).toString('hex')
}
