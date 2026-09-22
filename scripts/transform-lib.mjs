/**
 * Pure transform logic for migrating the Heroku prototype's Postgres CSV
 * exports into an import plan for the people API. Kept side-effect free so
 * it can be unit tested; the CLI wrapper lives in
 * transform-prototype-export.mjs.
 */

export const SEED_TEAM_MEMBER_EMAILS = new Set([
  'alex.thompson@defra.gov.uk',
  'alice.harrison@defra.gov.uk',
  'amelia.russell@defra.gov.uk',
  'archie.foster@defra.gov.uk',
  'ava.hughes@defra.gov.uk',
  'charlie.powell@defra.gov.uk',
  'chloe.simpson@defra.gov.uk',
  'dylan.murray@defra.gov.uk',
  'ella.reed@defra.gov.uk',
  'emma.davies@defra.gov.uk',
  'ethan.green@defra.gov.uk',
  'eva.knight@defra.gov.uk',
  'freddie.hunter@defra.gov.uk',
  'george.bennett@defra.gov.uk',
  'grace.hall@defra.gov.uk',
  'hannah.ford@defra.gov.uk',
  'harry.morgan@defra.gov.uk',
  'henry.ward@defra.gov.uk',
  'isla.scott@defra.gov.uk',
  'ivy.lawson@defra.gov.uk',
  'jack.turner@defra.gov.uk',
  'james.chen@defra.gov.uk',
  'leo.owen@defra.gov.uk',
  'liam.walker@defra.gov.uk',
  'lily.adams@defra.gov.uk',
  'marcus.williams@defra.gov.uk',
  'mason.webb@defra.gov.uk',
  'mia.clarke@defra.gov.uk',
  'nic.price@defra.gov.uk',
  'noah.evans@defra.gov.uk',
  'olivia.brown@defra.gov.uk',
  'oscar.baker@defra.gov.uk',
  'peter.smith@defra.gov.uk',
  'poppy.holmes@defra.gov.uk',
  'priya.patel@defra.gov.uk',
  'ruby.ellis@defra.gov.uk',
  'sarah.johnson@defra.gov.uk',
  'sophie.mills@defra.gov.uk',
  'theo.fisher@defra.gov.uk'
])

export const GDAD_DUMMY_EMAIL_PATTERN = /^gdad\.dummy\.[a-z0-9-]+@defra\.gov\.uk$/

export const ALLOWED_ROLES = [
  'Interaction Designer',
  'Senior Interaction Designer',
  'Service Designer',
  'Senior Service Designer',
  'Principal Service Designer',
  'Head of Design',
  'Design Manager',
  'Senior Resource Manager',
  'Accessibility Specialist (SEO)',
  'Senior Accessibility Specialist (Grade 7)'
]

// From the prototype's init-db.js legacyRoleMap
const LEGACY_ROLE_MAP = {
  'Lead Designer': 'Principal Service Designer',
  'Lead Service Designer': 'Principal Service Designer',
  'User Researcher': 'Service Designer',
  'Resource Manager': 'Senior Resource Manager'
}

const ALLOWED_AVAILABILITY = ['Busy', 'Some capacity', 'Free to help']

export const GDAD_SKILL_KEYS = new Set([
  'design_communication',
  'designing_for_everyone',
  'designing_strategically',
  'designing_together',
  'evidence_based_design',
  'iterative_design',
  'leading_design'
])

export function normaliseEmail(value) {
  const email = String(value ?? '')
    .trim()
    .toLowerCase()
  return email.includes('@') ? email : null
}

export function isSeedEmail(email) {
  return (
    SEED_TEAM_MEMBER_EMAILS.has(email) || GDAD_DUMMY_EMAIL_PATTERN.test(email)
  )
}

/**
 * profiles.can_help_with was a Postgres TEXT[]; legacy rows also stored a
 * JSON array string or a Postgres literal inside a text value (the
 * prototype's sanitiseTagArray handled all three). The `_unchecked`
 * checkbox sentinel is dropped.
 */
export function parseTagArray(raw) {
  const value = String(raw ?? '').trim()
  if (!value || value === '{}' || value === '[]') {
    return []
  }
  let items = []
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value)
      items = Array.isArray(parsed) ? parsed : []
    } catch {
      items = []
    }
  } else if (value.startsWith('{') && value.endsWith('}')) {
    items = parsePgArrayLiteral(value)
  } else {
    items = [value]
  }
  return items
    .map((item) => String(item ?? '').trim())
    .filter((item) => item && item !== '_unchecked')
}

function parsePgArrayLiteral(literal) {
  const inner = literal.slice(1, -1)
  const items = []
  let current = ''
  let inQuotes = false
  let i = 0
  while (i < inner.length) {
    const char = inner[i]
    if (inQuotes) {
      if (char === '\\') {
        current += inner[i + 1] ?? ''
        i += 2
        continue
      }
      if (char === '"') {
        inQuotes = false
        i += 1
        continue
      }
      current += char
      i += 1
      continue
    }
    if (char === '"') {
      inQuotes = true
      i += 1
      continue
    }
    if (char === ',') {
      items.push(current)
      current = ''
      i += 1
      continue
    }
    current += char
    i += 1
  }
  if (current !== '' || items.length > 0) {
    items.push(current)
  }
  return items.filter((item) => item !== 'NULL')
}

export function mapRole(raw, warnings, who) {
  const role = String(raw ?? '').trim()
  if (!role) {
    return null
  }
  if (ALLOWED_ROLES.includes(role)) {
    return role
  }
  if (LEGACY_ROLE_MAP[role]) {
    warnings.push(`${who}: legacy role "${role}" mapped to "${LEGACY_ROLE_MAP[role]}"`)
    return LEGACY_ROLE_MAP[role]
  }
  warnings.push(`${who}: unknown role "${role}" dropped — set it by hand after import`)
  return null
}

export function mapAvailability(raw, warnings, who) {
  const value = String(raw ?? '').trim()
  if (ALLOWED_AVAILABILITY.includes(value)) {
    return value
  }
  if (value === 'Available') {
    warnings.push(`${who}: availability "Available" mapped to "Free to help"`)
    return 'Free to help'
  }
  if (/^busy/i.test(value)) {
    warnings.push(`${who}: availability "${value}" mapped to "Busy"`)
    return 'Busy'
  }
  if (value) {
    warnings.push(`${who}: availability "${value}" mapped to "Some capacity"`)
  }
  return 'Some capacity'
}

function cleanText(value) {
  const text = String(value ?? '').trim()
  return text || null
}

function isTrue(value) {
  return value === true || value === 't' || value === 'true' || value === 'TRUE'
}

/**
 * Builds the import plan from the eight table exports (arrays of row
 * objects keyed by CSV header). Returns { plan, report }.
 *
 * The plan's people are keyed by a stable `key` (their email, or
 * `profile:<slug>` for profile-only rows) that the relationship steps
 * reference; the import runner resolves keys to real ids at run time.
 */
export function buildImportPlan(tables, options = {}) {
  const includeSeed = Boolean(options.includeSeed)
  const scorerFallbackEmail = normaliseEmail(options.scorerFallbackEmail)
  const warnings = []
  const excluded = []

  const users = tables.users ?? []
  const profiles = tables.profiles ?? []
  const approvedEmails = tables.approved_emails ?? []
  const administrators = tables.app_administrators ?? []
  const lineManagers = tables.profile_line_manager ?? []
  const allocations = tables.profile_manager_allocation ?? []
  const helping = tables.profile_long_term_helping ?? []
  const evidence = tables.gdad_evidence_items ?? []

  const shouldExclude = (email) => !includeSeed && email && isSeedEmail(email)

  // --- users: dedupe case-insensitively (the prototype's UNIQUE index was
  // case-sensitive while lookups were not, so shadow rows can exist)
  const usersByEmail = new Map()
  const userIdToEmail = new Map()
  for (const user of users) {
    const email = normaliseEmail(user.email)
    if (!email) {
      continue
    }
    userIdToEmail.set(String(user.id), email)
    const existing = usersByEmail.get(email)
    if (
      !existing ||
      (isTrue(user.is_verified) && !isTrue(existing.is_verified)) ||
      (isTrue(user.is_verified) === isTrue(existing.is_verified) &&
        String(user.created_at) > String(existing.created_at))
    ) {
      if (existing) {
        warnings.push(
          `users: duplicate rows for ${email} differing in case — kept the ${isTrue(user.is_verified) ? 'verified' : 'newest'} one`
        )
      }
      usersByEmail.set(email, user)
    }
  }

  // --- people assembly
  const people = new Map() // key -> person plan entry
  const slugToKey = new Map()

  const ensurePerson = (key) => {
    if (!people.has(key)) {
      people.set(key, {
        key,
        email: key.startsWith('profile:') ? null : key,
        approved: false,
        isAdmin: false,
        activate: false,
        profile: null,
        slugHint: null,
        evidence: {},
        scores: {}
      })
    }
    return people.get(key)
  }

  // Profiles first (they carry the display data). Latest row wins per key.
  const profilesSorted = [...profiles].sort((a, b) =>
    String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))
  )
  for (const profile of profilesSorted) {
    const slug = String(profile.id ?? '').trim()
    const ownerEmail = profile.user_id
      ? userIdToEmail.get(String(profile.user_id))
      : null
    const contactEmail = normaliseEmail(profile.contact_email)
    const email = ownerEmail ?? contactEmail
    const key = email ?? `profile:${slug}`

    if (shouldExclude(email)) {
      excluded.push(`profile ${slug} (${email})`)
      continue
    }

    const who = `profile ${slug}`
    const person = ensurePerson(key)
    if (person.profile) {
      warnings.push(
        `${who}: ${key} already has profile ${person.slugHint} — this newer row replaced it`
      )
    }
    person.slugHint = slug
    slugToKey.set(slug, key)
    person.profile = {
      name: cleanText(profile.name),
      role: mapRole(profile.role, warnings, who),
      location: cleanText(profile.location),
      experience: cleanText(profile.experience),
      bio: cleanText(profile.bio),
      canHelpWith: parseTagArray(profile.can_help_with),
      canHelpWithText: cleanText(profile.can_help_with_text),
      developmentGoalsText: cleanText(profile.development_goals_text),
      projectTeam: cleanText(profile.project_team),
      deliveryGroup: cleanText(profile.delivery_group),
      linkedinProfile: cleanText(profile.linkedin_profile),
      availabilityStatus: mapAvailability(
        profile.availability_status,
        warnings,
        who
      ),
      contactEmail
    }
  }

  // Users: everyone with an account keeps sign-in access; verified users
  // are marked activated so they do not show as pending.
  for (const [email, user] of usersByEmail) {
    if (shouldExclude(email)) {
      excluded.push(`user ${email}`)
      continue
    }
    const person = ensurePerson(email)
    person.approved = true
    if (isTrue(user.is_verified)) {
      person.activate = true
    }
  }

  // Allow-list rows that never registered
  for (const row of approvedEmails) {
    const email = normaliseEmail(row.email)
    if (!email) {
      continue
    }
    if (shouldExclude(email)) {
      excluded.push(`approved email ${email}`)
      continue
    }
    ensurePerson(email).approved = true
  }

  // Dynamic admins
  for (const row of administrators) {
    const email = normaliseEmail(row.email)
    if (!email || shouldExclude(email)) {
      continue
    }
    const person = people.get(email)
    if (person) {
      person.isAdmin = true
    } else {
      warnings.push(
        `app_administrators: ${email} has no user/profile/allow-list row — skipped`
      )
    }
  }

  const resolveSlug = (slug, context) => {
    const key = slugToKey.get(String(slug ?? '').trim())
    if (!key) {
      warnings.push(`${context}: profile "${slug}" not migrated — skipped`)
    }
    return key ?? null
  }

  // Line managers (flat set)
  const lineManagerKeys = []
  for (const row of lineManagers) {
    const key = resolveSlug(row.profile_id, 'line manager')
    if (key) {
      lineManagerKeys.push(key)
    }
  }

  // Manager allocations
  const allocationSteps = []
  for (const row of allocations) {
    const staffKey = resolveSlug(row.staff_profile_id, 'allocation staff')
    const managerKey = row.manager_profile_id
      ? resolveSlug(row.manager_profile_id, 'allocation manager')
      : null
    if (staffKey && managerKey) {
      allocationSteps.push({ staff: staffKey, manager: managerKey })
    }
  }

  // Long-term helping, grouped per helper
  const helpingByHelper = new Map()
  for (const row of helping) {
    const helperKey = resolveSlug(row.helper_profile_id, 'helping helper')
    const helpeeKey = resolveSlug(row.helpee_profile_id, 'helping helpee')
    if (helperKey && helpeeKey) {
      if (!helpingByHelper.has(helperKey)) {
        helpingByHelper.set(helperKey, [])
      }
      helpingByHelper.get(helperKey).push(helpeeKey)
    }
  }

  // GDaD evidence and scores (keyed on user id in the old model)
  for (const row of evidence) {
    const email = userIdToEmail.get(String(row.user_id))
    if (!email) {
      warnings.push(
        `gdad_evidence_items: user id ${row.user_id} has no user row — skipped`
      )
      continue
    }
    if (shouldExclude(email)) {
      continue
    }
    const skillKey = String(row.skill_key ?? '').trim()
    if (!GDAD_SKILL_KEYS.has(skillKey)) {
      warnings.push(`gdad_evidence_items: unknown skill "${skillKey}" — skipped`)
      continue
    }
    const person = people.get(email)
    if (!person) {
      continue
    }
    const evidenceText = cleanText(row.evidence_text)
    if (evidenceText) {
      person.evidence[skillKey] = evidenceText
    }
    const score = Number.parseInt(row.official_score, 10)
    if ([1, 2, 3].includes(score)) {
      let scorerKey = row.scored_by_user_id
        ? userIdToEmail.get(String(row.scored_by_user_id))
        : null
      if (scorerKey && (shouldExclude(scorerKey) || !people.has(scorerKey))) {
        scorerKey = null
      }
      if (!scorerKey) {
        scorerKey = scorerFallbackEmail
      }
      if (scorerKey && people.has(scorerKey)) {
        person.scores[skillKey] = { score, scorer: scorerKey }
      } else {
        warnings.push(
          `gdad_evidence_items: score for ${email}/${skillKey} has no migratable scorer and no --scorer-fallback — score skipped (evidence kept)`
        )
      }
    }
  }

  const plan = {
    generatedAt: new Date().toISOString(),
    people: [...people.values()].map((person) => ({
      ...person,
      // Only meaningful people: an email (access) or a profile
      skip: !person.email && !person.profile
    })),
    lineManagers: lineManagerKeys,
    allocations: allocationSteps,
    helping: [...helpingByHelper.entries()].map(([helper, helpees]) => ({
      helper,
      helpees
    }))
  }
  plan.people = plan.people.filter((person) => !person.skip)

  return {
    plan,
    report: {
      warnings,
      excluded,
      counts: {
        people: plan.people.length,
        withProfiles: plan.people.filter((p) => p.profile).length,
        approved: plan.people.filter((p) => p.approved).length,
        admins: plan.people.filter((p) => p.isAdmin).length,
        activated: plan.people.filter((p) => p.activate).length,
        lineManagers: plan.lineManagers.length,
        allocations: plan.allocations.length,
        helpingRelationships: plan.helping.reduce(
          (sum, entry) => sum + entry.helpees.length,
          0
        ),
        evidenceItems: plan.people.reduce(
          (sum, p) => sum + Object.keys(p.evidence).length,
          0
        ),
        scores: plan.people.reduce(
          (sum, p) => sum + Object.keys(p.scores).length,
          0
        ),
        excluded: excluded.length
      }
    }
  }
}
