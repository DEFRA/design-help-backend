import { ObjectId } from 'mongodb'

import {
  createPerson,
  getPerson,
  getPersonByEmail,
  people,
  replaceLineManagers,
  setAdmin,
  setHelping,
  setManager,
  upsertGdadEvidence,
  upsertGdadScores
} from '#/services/people.js'

/**
 * Applies a migration plan (the shape produced by
 * scripts/transform-lib.mjs) directly against the database using the
 * people service. People already present (by email, or slug for
 * email-less profiles) are left untouched, so a re-run is safe.
 */
export async function runMigrationSeed(db, plan, logger) {
  const ids = new Map()
  let created = 0
  let skipped = 0

  for (const person of plan.people ?? []) {
    const existing = person.email
      ? await getPersonByEmail(db, person.email)
      : person.slugHint
        ? await getPerson(db, person.slugHint)
        : null

    if (existing) {
      ids.set(person.key, existing.id)
      skipped++
      continue
    }

    const payload = {
      ...(person.email ? { email: person.email } : {}),
      ...(person.approved ? { approved: true } : {}),
      ...(person.profile ?? {})
    }
    const createdPerson = await createPerson(db, payload)
    ids.set(person.key, createdPerson.id)
    created++

    if (person.isAdmin) {
      await setAdmin(db, createdPerson.id, true)
    }
    if (person.activate) {
      await people(db).updateOne(
        { _id: new ObjectId(createdPerson.id), activatedAt: null },
        { $set: { activatedAt: new Date() } }
      )
    }
  }

  const resolvedIds = (keys) =>
    (keys ?? []).map((key) => ids.get(key)).filter(Boolean)

  if ((plan.lineManagers ?? []).length > 0) {
    await replaceLineManagers(db, resolvedIds(plan.lineManagers))
  }

  for (const alloc of plan.allocations ?? []) {
    const staffId = ids.get(alloc.staff)
    const managerId = ids.get(alloc.manager)
    if (staffId && managerId) {
      await setManager(db, staffId, managerId)
    }
  }

  const availabilityByKey = new Map(
    (plan.people ?? []).map((person) => [
      person.key,
      person.profile?.availabilityStatus ?? 'Some capacity'
    ])
  )
  for (const entry of plan.helping ?? []) {
    const helperId = ids.get(entry.helper)
    if (helperId) {
      await setHelping(db, helperId, {
        availabilityStatus: availabilityByKey.get(entry.helper),
        helpeeIds: resolvedIds(entry.helpees)
      })
    }
  }

  for (const person of plan.people ?? []) {
    const personId = ids.get(person.key)
    if (!personId) {
      continue
    }
    if (Object.keys(person.evidence ?? {}).length > 0) {
      await upsertGdadEvidence(db, personId, person.evidence)
    }
    const byScorer = new Map()
    for (const [skillKey, entry] of Object.entries(person.scores ?? {})) {
      const scorerId = ids.get(entry.scorer)
      if (!scorerId) {
        logger?.warn(
          `Migration seed: no scorer for ${person.key}/${skillKey} — score skipped`
        )
        continue
      }
      if (!byScorer.has(scorerId)) {
        byScorer.set(scorerId, {})
      }
      byScorer.get(scorerId)[skillKey] = entry.score
    }
    for (const [scorerId, scores] of byScorer) {
      await upsertGdadScores(db, personId, scores, scorerId)
    }
  }

  return { created, skipped }
}
