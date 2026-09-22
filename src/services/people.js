import { ObjectId } from 'mongodb'

import {
  GDAD_SKILL_KEYS,
  MAX_EVIDENCE_LENGTH,
  MAX_HELPING_ROWS
} from '#/common/constants.js'

const COLLECTION = 'people'

export const PROFILE_FIELDS = [
  'name',
  'role',
  'location',
  'experience',
  'bio',
  'canHelpWith',
  'canHelpWithText',
  'developmentGoalsText',
  'projectTeam',
  'deliveryGroup',
  'linkedinProfile',
  'availabilityStatus',
  'contactEmail'
]

export class PeopleError extends Error {
  constructor(code, detail) {
    super(code)
    this.code = code
    this.detail = detail
  }
}

export function people(db) {
  return db.collection(COLLECTION)
}

export function normaliseEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : null
}

export function slugify(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function toId(value) {
  if (value instanceof ObjectId) {
    return value
  }
  if (typeof value === 'string' && ObjectId.isValid(value)) {
    return new ObjectId(value)
  }
  return null
}

export function toApiPerson(doc) {
  if (!doc) {
    return null
  }
  const { _id, managerId, helping, gdad, ...rest } = doc
  return {
    id: _id.toString(),
    managerId: managerId ? managerId.toString() : null,
    helping: (helping ?? []).map((id) => id.toString()),
    gdad: apiGdad(gdad),
    ...rest
  }
}

function apiGdad(gdad) {
  const result = {}
  for (const key of Object.keys(gdad ?? {})) {
    const { scoredById, ...entry } = gdad[key]
    result[key] = {
      ...entry,
      scoredById: scoredById ? scoredById.toString() : null
    }
  }
  return result
}

function emptyProfileFields() {
  return {
    name: null,
    role: null,
    location: null,
    experience: null,
    bio: null,
    canHelpWith: [],
    canHelpWithText: null,
    developmentGoalsText: null,
    projectTeam: null,
    deliveryGroup: null,
    linkedinProfile: null,
    availabilityStatus: 'Some capacity',
    contactEmail: null
  }
}

/**
 * The prototype's slug generation collided on duplicate names; suffix with a
 * counter so every person keeps a stable, unique URL.
 */
async function ensureUniqueSlug(db, name, excludeId) {
  const base = slugify(name)
  if (!base) {
    return null
  }
  let candidate = base
  for (let n = 2; ; n++) {
    const clash = await people(db).findOne({
      slug: candidate,
      ...(excludeId ? { _id: { $ne: excludeId } } : {})
    })
    if (!clash) {
      return candidate
    }
    candidate = `${base}-${n}`
  }
}

function pickProfileFields(payload) {
  const fields = {}
  for (const key of PROFILE_FIELDS) {
    if (key in payload) {
      fields[key] = payload[key] ?? (key === 'canHelpWith' ? [] : null)
    }
  }
  return fields
}

export async function createPerson(db, payload) {
  const now = new Date()
  const email = normaliseEmail(payload.email)

  if (email) {
    const existing = await people(db).findOne({ email })
    if (existing) {
      throw new PeopleError('duplicate_email', email)
    }
  }

  const doc = {
    ...emptyProfileFields(),
    ...pickProfileFields(payload),
    email,
    slug: null,
    approved: payload.approved ?? true,
    isAdmin: false,
    isLineManager: false,
    managerId: null,
    helping: [],
    gdad: {},
    activatedAt: null,
    createdAt: now,
    updatedAt: now
  }
  doc.slug = await ensureUniqueSlug(db, doc.name)

  const { insertedId } = await people(db).insertOne(doc)
  return toApiPerson({ _id: insertedId, ...doc })
}

export async function getPerson(db, idOrSlug) {
  const id = toId(idOrSlug)
  const doc = id
    ? await people(db).findOne({ _id: id })
    : await people(db).findOne({ slug: idOrSlug })
  return toApiPerson(doc)
}

export async function getPersonByEmail(db, email) {
  const doc = await people(db).findOne({ email: normaliseEmail(email) })
  return toApiPerson(doc)
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export async function listPeople(db, { filter, sort } = {}) {
  const query = {}
  if (filter) {
    const pattern = new RegExp(escapeRegex(filter.trim()), 'i')
    query.$or = [
      { name: pattern },
      { role: pattern },
      { canHelpWith: pattern },
      { canHelpWithText: pattern },
      { developmentGoalsText: pattern }
    ]
  }

  const direction = sort === 'z-a' ? -1 : 1
  const docs = await people(db)
    .find(query)
    .collation({ locale: 'en', strength: 2 })
    .sort({ name: direction, _id: 1 })
    .toArray()
  return docs.map(toApiPerson)
}

export async function updatePerson(db, idOrSlug, payload) {
  const current = await requirePerson(db, idOrSlug)
  const $set = { ...pickProfileFields(payload), updatedAt: new Date() }

  if ('email' in payload) {
    const email = normaliseEmail(payload.email)
    if (email) {
      const clash = await people(db).findOne({
        email,
        _id: { $ne: new ObjectId(current.id) }
      })
      if (clash) {
        throw new PeopleError('duplicate_email', email)
      }
    }
    $set.email = email
  }
  if ('approved' in payload) {
    $set.approved = Boolean(payload.approved)
  }

  // A person gets a slug the first time they gain a name; it then stays
  // stable so profile URLs never break on rename.
  if (!current.slug && $set.name) {
    $set.slug = await ensureUniqueSlug(db, $set.name, new ObjectId(current.id))
  }

  await people(db).updateOne({ _id: new ObjectId(current.id) }, { $set })
  return getPerson(db, current.id)
}

async function requirePerson(db, idOrSlug) {
  const person = await getPerson(db, idOrSlug)
  if (!person) {
    throw new PeopleError('not_found', idOrSlug)
  }
  return person
}

export async function deletePerson(db, idOrSlug, mode = 'full') {
  const person = await requirePerson(db, idOrSlug)
  const id = new ObjectId(person.id)

  if (mode === 'access') {
    await people(db).updateOne(
      { _id: id },
      { $set: { approved: false, updatedAt: new Date() } }
    )
    return getPerson(db, person.id)
  }

  if (mode === 'profile') {
    await people(db).updateOne(
      { _id: id },
      { $set: { ...emptyProfileFields(), slug: null, updatedAt: new Date() } }
    )
    return getPerson(db, person.id)
  }

  await people(db).deleteOne({ _id: id })
  await people(db).updateMany({ helping: id }, { $pull: { helping: id } })
  await people(db).updateMany({ managerId: id }, { $set: { managerId: null } })
  return null
}

export async function activatePerson(db, idOrSlug) {
  const person = await requirePerson(db, idOrSlug)
  await people(db).updateOne(
    { _id: new ObjectId(person.id), activatedAt: null },
    { $set: { activatedAt: new Date() } }
  )
  return getPerson(db, person.id)
}

export async function setAdmin(db, idOrSlug, isAdmin) {
  const person = await requirePerson(db, idOrSlug)
  await people(db).updateOne(
    { _id: new ObjectId(person.id) },
    { $set: { isAdmin: Boolean(isAdmin), updatedAt: new Date() } }
  )
  return getPerson(db, person.id)
}

export async function setHelping(
  db,
  idOrSlug,
  { availabilityStatus, helpeeIds }
) {
  const person = await requirePerson(db, idOrSlug)
  const selfId = new ObjectId(person.id)

  let helping = []
  if (availabilityStatus !== 'Free to help') {
    const ids = [...new Set((helpeeIds ?? []).map(String))]
      .map(toId)
      .filter(Boolean)
      .filter((id) => !id.equals(selfId))
      .slice(0, MAX_HELPING_ROWS)
    const found = await people(db)
      .find({ _id: { $in: ids } }, { projection: { _id: 1 } })
      .toArray()
    helping = found.map((doc) => doc._id)
  }

  await people(db).updateOne(
    { _id: selfId },
    { $set: { availabilityStatus, helping, updatedAt: new Date() } }
  )
  return getPerson(db, person.id)
}

export async function listHelpingPairs(db) {
  const docs = await people(db)
    .find({ 'helping.0': { $exists: true } })
    .sort({ name: 1 })
    .toArray()
  const byId = new Map(docs.map((doc) => [doc._id.toString(), doc]))

  // Helpees may not be helpers themselves; fetch any missing docs
  const missing = new Set()
  for (const doc of docs) {
    for (const helpeeId of doc.helping) {
      if (!byId.has(helpeeId.toString())) {
        missing.add(helpeeId.toString())
      }
    }
  }
  if (missing.size > 0) {
    const extra = await people(db)
      .find({ _id: { $in: [...missing].map((id) => new ObjectId(id)) } })
      .toArray()
    for (const doc of extra) {
      byId.set(doc._id.toString(), doc)
    }
  }

  const pairs = []
  for (const doc of docs) {
    for (const helpeeId of doc.helping) {
      const helpee = byId.get(helpeeId.toString())
      if (helpee) {
        pairs.push({
          helper: toApiPerson(doc),
          helpee: toApiPerson(helpee),
          since: doc.updatedAt ?? null
        })
      }
    }
  }
  return pairs
}

export async function replaceLineManagers(db, personIds) {
  const ids = (personIds ?? []).map(toId).filter(Boolean)
  await people(db).updateMany(
    { _id: { $nin: ids }, isLineManager: true },
    { $set: { isLineManager: false } }
  )
  if (ids.length > 0) {
    await people(db).updateMany(
      { _id: { $in: ids } },
      { $set: { isLineManager: true } }
    )
  }
  // Allocations must always point at a current line manager
  await people(db).updateMany(
    { managerId: { $nin: ids, $ne: null } },
    { $set: { managerId: null } }
  )
  return listPeople(db)
}

export async function setManager(db, idOrSlug, managerIdValue) {
  const person = await requirePerson(db, idOrSlug)
  let managerId = null
  if (managerIdValue) {
    const manager = await people(db).findOne({
      _id: toId(managerIdValue),
      isLineManager: true
    })
    if (!manager || manager._id.toString() === person.id) {
      throw new PeopleError('invalid_manager', managerIdValue)
    }
    managerId = manager._id
  }
  await people(db).updateOne(
    { _id: new ObjectId(person.id) },
    { $set: { managerId, updatedAt: new Date() } }
  )
  return getPerson(db, person.id)
}

export async function upsertGdadEvidence(db, idOrSlug, evidenceBySkill) {
  const person = await requirePerson(db, idOrSlug)
  const $set = {}
  const now = new Date()
  for (const [skillKey, text] of Object.entries(evidenceBySkill)) {
    if (!GDAD_SKILL_KEYS.includes(skillKey)) {
      throw new PeopleError('invalid_skill', skillKey)
    }
    const value = String(text ?? '').trim()
    if (value.length > MAX_EVIDENCE_LENGTH) {
      throw new PeopleError('evidence_too_long', skillKey)
    }
    $set[`gdad.${skillKey}.evidenceText`] = value || null
    $set[`gdad.${skillKey}.evidenceUpdatedAt`] = value ? now : null
  }
  await people(db).updateOne({ _id: new ObjectId(person.id) }, { $set })
  return getPerson(db, person.id)
}

export async function upsertGdadScores(
  db,
  idOrSlug,
  scoresBySkill,
  scoredById
) {
  const person = await requirePerson(db, idOrSlug)
  const scorerId = toId(scoredById)
  const $set = {}
  const now = new Date()
  for (const [skillKey, score] of Object.entries(scoresBySkill)) {
    if (!GDAD_SKILL_KEYS.includes(skillKey)) {
      throw new PeopleError('invalid_skill', skillKey)
    }
    if (score === null) {
      $set[`gdad.${skillKey}.officialScore`] = null
      $set[`gdad.${skillKey}.scoredById`] = null
      $set[`gdad.${skillKey}.scoredAt`] = null
    } else {
      $set[`gdad.${skillKey}.officialScore`] = score
      $set[`gdad.${skillKey}.scoredById`] = scorerId
      $set[`gdad.${skillKey}.scoredAt`] = now
    }
  }
  await people(db).updateOne({ _id: new ObjectId(person.id) }, { $set })
  return getPerson(db, person.id)
}

export async function seedApprovedEmails(db, emails) {
  for (const raw of emails ?? []) {
    const email = normaliseEmail(raw)
    if (!email) {
      continue
    }
    const existing = await people(db).findOne({ email })
    if (!existing) {
      await createPerson(db, { email })
    }
  }
}
