/**
 * Builds the encrypted migration seed shipped in the image.
 *
 * Usage:
 *   node scripts/encrypt-migration-data.mjs <csv-dir> [--key <64-hex>]
 *     [--include-seed] [--scorer-fallback <email>]
 *
 * Reads the prototype's CSV exports (see transform-prototype-export.mjs
 * for the export commands), builds the import plan and writes
 * src/data/migration-seed.enc. If no --key is given a fresh one is
 * generated and written to migration-seed.key ALONGSIDE THE CSVs — never
 * commit that file; its value becomes the MIGRATION_SEED_KEY Portal
 * secret.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  encryptJson,
  generateKeyHex
} from '../src/common/helpers/migration-crypto.js'
import { buildImportPlan } from './transform-lib.mjs'
import { loadTables } from './transform-prototype-export.mjs'

function parseArgs(argv) {
  const args = { includeSeed: false, scorerFallback: null, key: null }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--key') {
      args.key = argv[++i]
    } else if (arg === '--include-seed') {
      args.includeSeed = true
    } else if (arg === '--scorer-fallback') {
      args.scorerFallback = argv[++i]
    } else {
      positional.push(arg)
    }
  }
  args.csvDir = positional[0]
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!args.csvDir) {
  console.error(
    'Usage: node scripts/encrypt-migration-data.mjs <csv-dir> [--key <64-hex>] [--include-seed] [--scorer-fallback <email>]'
  )
  process.exit(1)
}

const { plan, report } = buildImportPlan(loadTables(args.csvDir), {
  includeSeed: args.includeSeed,
  scorerFallbackEmail: args.scorerFallback
})

let keyHex = args.key
if (!keyHex) {
  keyHex = generateKeyHex()
  const keyPath = join(args.csvDir, 'migration-seed.key')
  writeFileSync(keyPath, keyHex)
  console.log(`Generated a new key: ${keyPath} (do NOT commit this file)`)
}

mkdirSync('src/data', { recursive: true })
writeFileSync('src/data/migration-seed.enc', encryptJson(plan, keyHex))
console.log('Wrote src/data/migration-seed.enc')
console.log(JSON.stringify(report.counts, null, 2))
if (report.warnings.length) {
  console.log(`${report.warnings.length} warning(s):`)
  for (const warning of report.warnings) {
    console.log(`- ${warning}`)
  }
}
