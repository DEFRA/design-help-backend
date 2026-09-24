import { decryptJson, encryptJson, generateKeyHex } from './migration-crypto.js'

describe('migration crypto', () => {
  test('round-trips JSON through AES-256-GCM', () => {
    const key = generateKeyHex()
    const value = { people: [{ key: 'a@b.c', profile: { bio: 'Line\ntwo' } }] }
    expect(decryptJson(encryptJson(value, key), key)).toEqual(value)
  })

  test('rejects a wrong key', () => {
    const payload = encryptJson({ ok: true }, generateKeyHex())
    expect(() => decryptJson(payload, generateKeyHex())).toThrow()
  })

  test('rejects tampered ciphertext', () => {
    const key = generateKeyHex()
    const payload = Buffer.from(encryptJson({ ok: true }, key), 'base64')
    payload[payload.length - 1] ^= 0xff
    expect(() => decryptJson(payload.toString('base64'), key)).toThrow()
  })
})
