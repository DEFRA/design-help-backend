describe('people API', () => {
  let server

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')
    server = await createServer()
    await server.initialize()
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  beforeEach(async () => {
    await server.db.collection('people').deleteMany({})
  })

  async function createPerson(payload) {
    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: '/people',
      payload
    })
    expect(statusCode).toBe(201)
    return result
  }

  describe('create and fetch', () => {
    test('creates a person with profile and unique slug', async () => {
      const person = await createPerson({
        email: 'Jane.Smith@defra.gov.uk',
        name: 'Jane Smith',
        role: 'Service Designer'
      })

      expect(person.email).toBe('jane.smith@defra.gov.uk')
      expect(person.slug).toBe('jane-smith')
      expect(person.approved).toBe(true)
      expect(person.availabilityStatus).toBe('Some capacity')
      expect(person.activatedAt).toBeNull()
    })

    test('suffixes the slug on duplicate names', async () => {
      await createPerson({ name: 'Jane Smith' })
      const second = await createPerson({ name: 'Jane Smith' })
      expect(second.slug).toBe('jane-smith-2')
    })

    test('creates an allow-list only person with just an email', async () => {
      const person = await createPerson({ email: 'new@defra.gov.uk' })
      expect(person.slug).toBeNull()
      expect(person.name).toBeNull()
      expect(person.approved).toBe(true)
    })

    test('refuses a duplicate email regardless of case', async () => {
      await createPerson({ email: 'dup@defra.gov.uk' })
      const { statusCode } = await server.inject({
        method: 'POST',
        url: '/people',
        payload: { email: 'DUP@defra.gov.uk' }
      })
      expect(statusCode).toBe(409)
    })

    test('fetches by id, slug and email', async () => {
      const person = await createPerson({
        email: 'fetch@defra.gov.uk',
        name: 'Fetch Me'
      })

      const byId = await server.inject({ url: `/people/${person.id}` })
      expect(byId.result.id).toBe(person.id)

      const bySlug = await server.inject({ url: '/people/fetch-me' })
      expect(bySlug.result.id).toBe(person.id)

      const byEmail = await server.inject({
        url: '/people/by-email/fetch@defra.gov.uk'
      })
      expect(byEmail.result.id).toBe(person.id)

      const missing = await server.inject({ url: '/people/nope' })
      expect(missing.statusCode).toBe(404)
    })

    test('rejects an invalid role', async () => {
      const { statusCode } = await server.inject({
        method: 'POST',
        url: '/people',
        payload: { name: 'Bad Role', role: 'Wizard' }
      })
      expect(statusCode).toBe(400)
    })
  })

  describe('list, filter and sort', () => {
    beforeEach(async () => {
      await createPerson({
        name: 'Alice Adams',
        role: 'Service Designer',
        canHelpWith: ['Design critiques'],
        canHelpWithText: 'Accessibility audits'
      })
      await createPerson({
        name: 'Zoe Zhang',
        role: 'Interaction Designer',
        developmentGoalsText: 'Wants help with prototyping'
      })
    })

    test('lists people a-z by default', async () => {
      const { result } = await server.inject({ url: '/people' })
      expect(result.map((p) => p.name)).toEqual(['Alice Adams', 'Zoe Zhang'])
    })

    test('sorts z-a', async () => {
      const { result } = await server.inject({ url: '/people?sort=z-a' })
      expect(result.map((p) => p.name)).toEqual(['Zoe Zhang', 'Alice Adams'])
    })

    test('filters across help fields, names and roles', async () => {
      const byTag = await server.inject({ url: '/people?filter=critiques' })
      expect(byTag.result.map((p) => p.name)).toEqual(['Alice Adams'])

      const byGoal = await server.inject({ url: '/people?filter=prototyping' })
      expect(byGoal.result.map((p) => p.name)).toEqual(['Zoe Zhang'])

      const byRole = await server.inject({ url: '/people?filter=interaction' })
      expect(byRole.result.map((p) => p.name)).toEqual(['Zoe Zhang'])
    })
  })

  describe('update', () => {
    test('updates profile fields and keeps the slug stable on rename', async () => {
      const person = await createPerson({ name: 'Old Name' })
      const { result } = await server.inject({
        method: 'PATCH',
        url: `/people/${person.id}`,
        payload: { name: 'New Name', bio: 'Hello' }
      })
      expect(result.name).toBe('New Name')
      expect(result.bio).toBe('Hello')
      expect(result.slug).toBe('old-name')
    })

    test('assigns a slug when a profile-less person gains a name', async () => {
      const person = await createPerson({ email: 'noname@defra.gov.uk' })
      const { result } = await server.inject({
        method: 'PATCH',
        url: `/people/${person.id}`,
        payload: { name: 'Now Named' }
      })
      expect(result.slug).toBe('now-named')
    })
  })

  describe('delete modes', () => {
    test('full delete removes the person and cleans references', async () => {
      const manager = await createPerson({ name: 'The Manager' })
      const helper = await createPerson({ name: 'The Helper' })
      const target = await createPerson({ name: 'Delete Me' })

      await server.inject({
        method: 'PUT',
        url: '/line-managers',
        payload: { personIds: [target.id] }
      })
      await server.inject({
        method: 'PUT',
        url: `/people/${manager.id}/manager`,
        payload: { managerId: target.id }
      })
      await server.inject({
        method: 'PUT',
        url: `/people/${helper.id}/helping`,
        payload: { availabilityStatus: 'Busy', helpeeIds: [target.id] }
      })

      const del = await server.inject({
        method: 'DELETE',
        url: `/people/${target.id}`
      })
      expect(del.statusCode).toBe(200)

      const managerAfter = await server.inject({ url: `/people/${manager.id}` })
      expect(managerAfter.result.managerId).toBeNull()

      const helperAfter = await server.inject({ url: `/people/${helper.id}` })
      expect(helperAfter.result.helping).toEqual([])
    })

    test('profile delete keeps email and approval', async () => {
      const person = await createPerson({
        email: 'keep@defra.gov.uk',
        name: 'Keep Access'
      })
      const { result } = await server.inject({
        method: 'DELETE',
        url: `/people/${person.id}?mode=profile`
      })
      expect(result.name).toBeNull()
      expect(result.slug).toBeNull()
      expect(result.email).toBe('keep@defra.gov.uk')
      expect(result.approved).toBe(true)
    })

    test('access delete keeps the profile but revokes sign-in', async () => {
      const person = await createPerson({
        email: 'revoke@defra.gov.uk',
        name: 'Keep Profile'
      })
      const { result } = await server.inject({
        method: 'DELETE',
        url: `/people/${person.id}?mode=access`
      })
      expect(result.name).toBe('Keep Profile')
      expect(result.approved).toBe(false)
    })
  })

  describe('activation and admin', () => {
    test('activation is recorded once', async () => {
      const person = await createPerson({ email: 'act@defra.gov.uk' })
      const first = await server.inject({
        method: 'POST',
        url: `/people/${person.id}/activate`
      })
      expect(first.result.activatedAt).not.toBeNull()

      const second = await server.inject({
        method: 'POST',
        url: `/people/${person.id}/activate`
      })
      expect(second.result.activatedAt).toEqual(first.result.activatedAt)
    })

    test('grants and revokes admin', async () => {
      const person = await createPerson({ email: 'adm@defra.gov.uk' })
      const granted = await server.inject({
        method: 'POST',
        url: `/people/${person.id}/admin`,
        payload: { isAdmin: true }
      })
      expect(granted.result.isAdmin).toBe(true)

      const revoked = await server.inject({
        method: 'POST',
        url: `/people/${person.id}/admin`,
        payload: { isAdmin: false }
      })
      expect(revoked.result.isAdmin).toBe(false)
    })
  })

  describe('helping', () => {
    test('replaces the helpee list, excluding self and unknown ids', async () => {
      const helper = await createPerson({ name: 'Helper One' })
      const helpee = await createPerson({ name: 'Helpee One' })

      const { result } = await server.inject({
        method: 'PUT',
        url: `/people/${helper.id}/helping`,
        payload: {
          availabilityStatus: 'Busy',
          helpeeIds: [helpee.id, helper.id, '64b000000000000000000000']
        }
      })
      expect(result.availabilityStatus).toBe('Busy')
      expect(result.helping).toEqual([helpee.id])
    })

    test('Free to help forces an empty helpee list', async () => {
      const helper = await createPerson({ name: 'Helper Two' })
      const helpee = await createPerson({ name: 'Helpee Two' })

      const { result } = await server.inject({
        method: 'PUT',
        url: `/people/${helper.id}/helping`,
        payload: {
          availabilityStatus: 'Free to help',
          helpeeIds: [helpee.id]
        }
      })
      expect(result.helping).toEqual([])
    })

    test('lists helper-helpee pairs', async () => {
      const helper = await createPerson({ name: 'Pair Helper' })
      const helpee = await createPerson({ name: 'Pair Helpee' })
      await server.inject({
        method: 'PUT',
        url: `/people/${helper.id}/helping`,
        payload: { availabilityStatus: 'Busy', helpeeIds: [helpee.id] }
      })

      const { result } = await server.inject({ url: '/helping-pairs' })
      expect(result).toHaveLength(1)
      expect(result[0].helper.name).toBe('Pair Helper')
      expect(result[0].helpee.name).toBe('Pair Helpee')
    })
  })

  describe('line managers and allocations', () => {
    test('replacing line managers prunes stale allocations', async () => {
      const managerA = await createPerson({ name: 'Manager A' })
      const managerB = await createPerson({ name: 'Manager B' })
      const staff = await createPerson({ name: 'Staff One' })

      await server.inject({
        method: 'PUT',
        url: '/line-managers',
        payload: { personIds: [managerA.id, managerB.id] }
      })
      await server.inject({
        method: 'PUT',
        url: `/people/${staff.id}/manager`,
        payload: { managerId: managerA.id }
      })

      // Remove manager A from the line-manager set
      await server.inject({
        method: 'PUT',
        url: '/line-managers',
        payload: { personIds: [managerB.id] }
      })

      const staffAfter = await server.inject({ url: `/people/${staff.id}` })
      expect(staffAfter.result.managerId).toBeNull()

      const managerAAfter = await server.inject({
        url: `/people/${managerA.id}`
      })
      expect(managerAAfter.result.isLineManager).toBe(false)
    })

    test('refuses allocation to a non-line-manager or self', async () => {
      const notManager = await createPerson({ name: 'Not Manager' })
      const staff = await createPerson({ name: 'Staff Two' })

      const invalid = await server.inject({
        method: 'PUT',
        url: `/people/${staff.id}/manager`,
        payload: { managerId: notManager.id }
      })
      expect(invalid.statusCode).toBe(400)

      await server.inject({
        method: 'PUT',
        url: '/line-managers',
        payload: { personIds: [staff.id] }
      })
      const self = await server.inject({
        method: 'PUT',
        url: `/people/${staff.id}/manager`,
        payload: { managerId: staff.id }
      })
      expect(self.statusCode).toBe(400)
    })
  })

  describe('GDaD evidence and scores', () => {
    test('saves and clears evidence per skill', async () => {
      const person = await createPerson({ name: 'Designer One' })

      const saved = await server.inject({
        method: 'PUT',
        url: `/people/${person.id}/gdad/evidence`,
        payload: { evidence: { iterative_design: 'Situation: did a thing' } }
      })
      expect(saved.result.gdad.iterative_design.evidenceText).toBe(
        'Situation: did a thing'
      )
      expect(saved.result.gdad.iterative_design.evidenceUpdatedAt).toBeTruthy()

      const cleared = await server.inject({
        method: 'PUT',
        url: `/people/${person.id}/gdad/evidence`,
        payload: { evidence: { iterative_design: '' } }
      })
      expect(cleared.result.gdad.iterative_design.evidenceText).toBeNull()
    })

    test('rejects an unknown skill key', async () => {
      const person = await createPerson({ name: 'Designer Two' })
      const { statusCode } = await server.inject({
        method: 'PUT',
        url: `/people/${person.id}/gdad/evidence`,
        payload: { evidence: { juggling: 'irrelevant' } }
      })
      expect(statusCode).toBe(400)
    })

    test('saves and clears scores with the scorer recorded', async () => {
      const person = await createPerson({ name: 'Designer Three' })
      const scorer = await createPerson({ name: 'The Scorer' })

      const scored = await server.inject({
        method: 'PUT',
        url: `/people/${person.id}/gdad/scores`,
        payload: {
          scores: { leading_design: 3, iterative_design: 1 },
          scoredById: scorer.id
        }
      })
      expect(scored.result.gdad.leading_design.officialScore).toBe(3)
      expect(scored.result.gdad.leading_design.scoredById).toBe(scorer.id)

      const cleared = await server.inject({
        method: 'PUT',
        url: `/people/${person.id}/gdad/scores`,
        payload: {
          scores: { leading_design: null },
          scoredById: scorer.id
        }
      })
      expect(cleared.result.gdad.leading_design.officialScore).toBeNull()
      expect(cleared.result.gdad.leading_design.scoredById).toBeNull()
    })

    test('rejects an out-of-range score', async () => {
      const person = await createPerson({ name: 'Designer Four' })
      const scorer = await createPerson({ name: 'Scorer Two' })
      const { statusCode } = await server.inject({
        method: 'PUT',
        url: `/people/${person.id}/gdad/scores`,
        payload: { scores: { leading_design: 5 }, scoredById: scorer.id }
      })
      expect(statusCode).toBe(400)
    })
  })
})
