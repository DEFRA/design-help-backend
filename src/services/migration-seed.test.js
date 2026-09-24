import { runMigrationSeed } from './migration-seed.js'

const PLAN = {
  people: [
    {
      key: 'manager@defra.gov.uk',
      email: 'manager@defra.gov.uk',
      approved: true,
      isAdmin: true,
      activate: true,
      slugHint: 'the-manager',
      profile: {
        name: 'The Manager',
        role: 'Design Manager',
        availabilityStatus: 'Some capacity'
      },
      evidence: {},
      scores: {}
    },
    {
      key: 'designer@defra.gov.uk',
      email: 'designer@defra.gov.uk',
      approved: true,
      isAdmin: false,
      activate: false,
      slugHint: 'the-designer',
      profile: {
        name: 'The Designer',
        role: 'Service Designer',
        availabilityStatus: 'Busy'
      },
      evidence: { iterative_design: 'Situation: iterated' },
      scores: {
        iterative_design: { score: 2, scorer: 'manager@defra.gov.uk' }
      }
    },
    {
      key: 'allowlist@defra.gov.uk',
      email: 'allowlist@defra.gov.uk',
      approved: true,
      isAdmin: false,
      activate: false,
      slugHint: null,
      profile: null,
      evidence: {},
      scores: {}
    }
  ],
  lineManagers: ['manager@defra.gov.uk'],
  allocations: [
    { staff: 'designer@defra.gov.uk', manager: 'manager@defra.gov.uk' }
  ],
  helping: [
    { helper: 'manager@defra.gov.uk', helpees: ['designer@defra.gov.uk'] }
  ]
}

describe('runMigrationSeed', () => {
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

  test('applies a full plan', async () => {
    const result = await runMigrationSeed(server.db, PLAN)
    expect(result).toEqual({ created: 3, skipped: 0 })

    const { result: manager } = await server.inject({
      url: '/people/by-email/manager@defra.gov.uk'
    })
    expect(manager.isAdmin).toBe(true)
    expect(manager.isLineManager).toBe(true)
    expect(manager.activatedAt).not.toBeNull()
    expect(manager.helping).toHaveLength(1)

    const { result: designer } = await server.inject({
      url: '/people/by-email/designer@defra.gov.uk'
    })
    expect(designer.managerId).toBe(manager.id)
    expect(designer.gdad.iterative_design.evidenceText).toBe(
      'Situation: iterated'
    )
    expect(designer.gdad.iterative_design.officialScore).toBe(2)
    expect(designer.gdad.iterative_design.scoredById).toBe(manager.id)

    const { result: allowlist } = await server.inject({
      url: '/people/by-email/allowlist@defra.gov.uk'
    })
    expect(allowlist.approved).toBe(true)
    expect(allowlist.name).toBeNull()
  })

  test('is idempotent: existing people are skipped untouched', async () => {
    await runMigrationSeed(server.db, PLAN)

    // Simulate post-migration drift: the designer edits their bio
    const { result: designerBefore } = await server.inject({
      url: '/people/by-email/designer@defra.gov.uk'
    })
    await server.inject({
      method: 'PATCH',
      url: `/people/${designerBefore.id}`,
      payload: { bio: 'Edited after migration' }
    })

    const rerun = await runMigrationSeed(server.db, PLAN)
    expect(rerun).toEqual({ created: 0, skipped: 3 })

    const { result: designerAfter } = await server.inject({
      url: '/people/by-email/designer@defra.gov.uk'
    })
    expect(designerAfter.bio).toBe('Edited after migration')
  })
})
