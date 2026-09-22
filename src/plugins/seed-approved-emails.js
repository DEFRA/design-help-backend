import { config } from '#/config.js'
import { seedApprovedEmails } from '#/services/people.js'

/**
 * Idempotent startup seed: every address in APPROVED_EMAILS gets a person
 * document with sign-in approval, so the service is usable on a fresh
 * database. Runs inside the service because the CDP Terminal has neither
 * app code nor an authenticated DB connection.
 */
export const seedApprovedEmailsPlugin = {
  plugin: {
    name: 'seed-approved-emails',
    dependencies: ['mongodb'],
    register: async function (server) {
      const emails = config
        .get('approvedEmails')
        .split(',')
        .map((email) => email.trim())
        .filter(Boolean)

      if (emails.length === 0) {
        return
      }

      const lock = await server.locker.lock('seed-approved-emails')
      if (!lock) {
        server.logger.info('Seed already running on another instance')
        return
      }
      try {
        await seedApprovedEmails(server.db, emails)
        server.logger.info(
          `Seeded ${emails.length} approved email(s) if missing`
        )
      } finally {
        await lock.free()
      }
    }
  }
}
