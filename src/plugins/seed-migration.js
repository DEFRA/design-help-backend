import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { config } from '#/config.js'
import { decryptJson } from '#/common/helpers/migration-crypto.js'
import { runMigrationSeed } from '#/services/migration-seed.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const SEED_FILE = path.resolve(dirname, '../data/migration-seed.enc')
const MARKER_ID = 'prototype-migration'

/**
 * One-shot import of the Heroku prototype's data. The plan ships in the
 * image as an AES-256-GCM encrypted blob (the repo is public); the key is
 * the MIGRATION_SEED_KEY secret. With no key configured, or once the
 * marker document exists, boots skip this entirely. Remove the blob and
 * the secret once the migration is confirmed.
 */
export const seedMigrationPlugin = {
  plugin: {
    name: 'seed-migration',
    dependencies: ['mongodb'],
    register: async function (server) {
      const keyHex = config.get('migrationSeedKey')
      if (!keyHex || !existsSync(SEED_FILE)) {
        return
      }

      const markers = server.db.collection('migrations')
      if (await markers.findOne({ _id: MARKER_ID })) {
        server.logger.info('Migration seed already applied; skipping')
        return
      }

      const lock = await server.locker.lock('seed-migration')
      if (!lock) {
        server.logger.info('Migration seed running on another instance')
        return
      }
      try {
        if (await markers.findOne({ _id: MARKER_ID })) {
          return
        }
        const plan = decryptJson(readFileSync(SEED_FILE, 'utf8'), keyHex)
        const { created, skipped } = await runMigrationSeed(
          server.db,
          plan,
          server.logger
        )
        await markers.insertOne({ _id: MARKER_ID, appliedAt: new Date() })
        server.logger.info(
          `Migration seed applied: ${created} people created, ${skipped} already present`
        )
      } catch (error) {
        server.logger.error(error, 'Migration seed failed')
        throw error
      } finally {
        await lock.free()
      }
    }
  }
}
