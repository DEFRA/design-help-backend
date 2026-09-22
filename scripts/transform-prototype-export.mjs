/**
 * Transforms the Heroku prototype's Postgres CSV exports into a
 * self-contained, idempotent import script for the people API.
 *
 * Export the tables from Heroku with:
 *   for t in users profiles approved_emails app_administrators \
 *            profile_line_manager profile_manager_allocation \
 *            profile_long_term_helping gdad_evidence_items; do
 *     heroku pg:psql -a <app> -c "\\copy $t TO '$t.csv' CSV HEADER"
 *   done
 *
 * Usage:
 *   node scripts/transform-prototype-export.mjs <csv-dir> [--out <dir>]
 *     [--include-seed] [--scorer-fallback <email>]
 *
 * Outputs <out>/import.py (run it inside the CDP Terminal, or locally
 * against a dev backend) and <out>/report.md (what was excluded, mapped
 * or skipped — read it before running the import).
 */
import { parse } from 'csv-parse/sync'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { buildImportPlan } from './transform-lib.mjs'

const TABLES = [
  'users',
  'profiles',
  'approved_emails',
  'app_administrators',
  'profile_line_manager',
  'profile_manager_allocation',
  'profile_long_term_helping',
  'gdad_evidence_items'
]

function parseArgs(argv) {
  const args = { out: 'migration', includeSeed: false, scorerFallback: null }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out') {
      args.out = argv[++i]
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

export function loadTables(csvDir) {
  const tables = {}
  for (const table of TABLES) {
    const path = join(csvDir, `${table}.csv`)
    if (!existsSync(path)) {
      console.warn(`warning: ${path} missing — treating ${table} as empty`)
      tables[table] = []
      continue
    }
    tables[table] = parse(readFileSync(path, 'utf8'), {
      columns: true,
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true
    })
  }
  return tables
}

export function renderImportScript(plan) {
  // Embedded as a JSON string literal (JSON string escapes are valid
  // Python string escapes) and parsed at runtime — JSON booleans/nulls
  // are not Python literals.
  const planJson = `json.loads(${JSON.stringify(JSON.stringify(plan))})`
  return `#!/usr/bin/env python3
"""Idempotent importer for the design-help prototype migration.

Run where the backend is reachable (the CDP Terminal for a deployed
environment, or locally against http://localhost:3198):

    BACKEND_URL=https://design-help-backend.<env>.cdp-int.defra.cloud python3 import.py
    python3 import.py --dry-run   # print what would happen, change nothing

Progress is checkpointed to import-state.json next to this script, so a
re-run continues where it left off without duplicating people.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("BACKEND_URL", "http://localhost:3198").rstrip("/")
DRY_RUN = "--dry-run" in sys.argv
STATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "import-state.json")

PLAN = ${planJson}


def call(method, path, payload=None):
    url = BASE + path
    if DRY_RUN and method != "GET":
        print(f"[dry-run] {method} {path} {json.dumps(payload) if payload else ''}"[:200])
        return {}
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            body = res.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return None
        detail = err.read().decode(errors="replace")[:300]
        raise SystemExit(f"FAILED {method} {path}: {err.code} {detail}")


def load_state():
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH) as fh:
            return json.load(fh)
    return {"ids": {}, "done": []}


def save_state(state):
    if not DRY_RUN:
        with open(STATE_PATH, "w") as fh:
            json.dump(state, fh, indent=1)


def find_existing(person):
    if person.get("email"):
        found = call("GET", "/people/by-email/" + urllib.parse.quote(person["email"]))
        if found:
            return found
    if person.get("slugHint"):
        return call("GET", "/people/" + urllib.parse.quote(person["slugHint"]))
    return None


def main():
    state = load_state()
    ids = state["ids"]
    done = set(state["done"])

    def step(name, fn):
        if name in done:
            return
        fn()
        done.add(name)
        state["done"] = sorted(done)
        save_state(state)

    # 1. People
    for person in PLAN["people"]:
        key = person["key"]
        if key in ids:
            continue
        existing = find_existing(person)
        payload = {}
        if person.get("email"):
            payload["email"] = person["email"]
        if person.get("approved"):
            payload["approved"] = True
        if person.get("profile"):
            payload.update({k: v for k, v in person["profile"].items()})
        if existing:
            ids[key] = existing["id"]
            if person.get("profile"):
                call("PATCH", "/people/" + existing["id"], payload)
            print(f"= {key} (already present)")
        else:
            created = call("POST", "/people", payload)
            ids[key] = created.get("id", f"dry-{key}")
            print(f"+ {key}")
        save_state(state)

    def person_id(key):
        return ids[key]

    # 2. Flags
    def apply_flags():
        for person in PLAN["people"]:
            if person.get("isAdmin"):
                call("POST", f"/people/{person_id(person['key'])}/admin", {"isAdmin": True})
            if person.get("activate"):
                call("POST", f"/people/{person_id(person['key'])}/activate")
    step("flags", apply_flags)

    # 3. Line managers (whole-set replace)
    def apply_line_managers():
        if PLAN["lineManagers"]:
            call("PUT", "/line-managers",
                 {"personIds": [person_id(k) for k in PLAN["lineManagers"]]})
    step("line-managers", apply_line_managers)

    # 4. Allocations
    def apply_allocations():
        for alloc in PLAN["allocations"]:
            call("PUT", f"/people/{person_id(alloc['staff'])}/manager",
                 {"managerId": person_id(alloc["manager"])})
    step("allocations", apply_allocations)

    # 5. Long-term helping (needs each helper's availability)
    availability = {p["key"]: (p.get("profile") or {}).get("availabilityStatus") or "Some capacity"
                    for p in PLAN["people"]}

    def apply_helping():
        for entry in PLAN["helping"]:
            call("PUT", f"/people/{person_id(entry['helper'])}/helping",
                 {"availabilityStatus": availability.get(entry["helper"], "Some capacity"),
                  "helpeeIds": [person_id(k) for k in entry["helpees"]]})
    step("helping", apply_helping)

    # 6. GDaD evidence, then scores grouped per scorer
    def apply_gdad():
        for person in PLAN["people"]:
            if person.get("evidence"):
                call("PUT", f"/people/{person_id(person['key'])}/gdad/evidence",
                     {"evidence": person["evidence"]})
            by_scorer = {}
            for skill, entry in (person.get("scores") or {}).items():
                by_scorer.setdefault(entry["scorer"], {})[skill] = entry["score"]
            for scorer, scores in by_scorer.items():
                call("PUT", f"/people/{person_id(person['key'])}/gdad/scores",
                     {"scores": scores, "scoredById": person_id(scorer)})
    step("gdad", apply_gdad)

    print(f"Done. {len(PLAN['people'])} people processed against {BASE}.")


if __name__ == "__main__":
    main()
`
}

export function renderReport(report, options) {
  const lines = [
    '# Prototype migration report',
    '',
    `Generated ${new Date().toISOString()}. Seed/demo data ${options.includeSeed ? 'INCLUDED (--include-seed)' : 'excluded'}.`,
    '',
    '## Counts',
    ''
  ]
  for (const [name, value] of Object.entries(report.counts)) {
    lines.push(`- ${name}: ${value}`)
  }
  lines.push('', '## Excluded as seed/demo data', '')
  lines.push(
    ...(report.excluded.length
      ? report.excluded.map((entry) => `- ${entry}`)
      : ['- none'])
  )
  lines.push('', '## Warnings (review before importing)', '')
  lines.push(
    ...(report.warnings.length
      ? report.warnings.map((entry) => `- ${entry}`)
      : ['- none'])
  )
  lines.push('')
  return lines.join('\n')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.csvDir) {
    console.error(
      'Usage: node scripts/transform-prototype-export.mjs <csv-dir> [--out <dir>] [--include-seed] [--scorer-fallback <email>]'
    )
    process.exit(1)
  }

  const tables = loadTables(args.csvDir)
  const { plan, report } = buildImportPlan(tables, {
    includeSeed: args.includeSeed,
    scorerFallbackEmail: args.scorerFallback
  })

  mkdirSync(args.out, { recursive: true })
  writeFileSync(join(args.out, 'import.py'), renderImportScript(plan))
  writeFileSync(
    join(args.out, 'report.md'),
    renderReport(report, { includeSeed: args.includeSeed })
  )

  console.log(`Wrote ${join(args.out, 'import.py')} and report.md`)
  console.log(JSON.stringify(report.counts, null, 2))
  if (report.warnings.length) {
    console.log(`\n${report.warnings.length} warning(s) — read report.md`)
  }
}

const invokedDirectly = process.argv[1]?.endsWith(
  'transform-prototype-export.mjs'
)
if (invokedDirectly) {
  main()
}
