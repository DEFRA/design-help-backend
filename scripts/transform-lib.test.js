import {
  buildImportPlan,
  isSeedEmail,
  mapAvailability,
  mapRole,
  parseTagArray
} from './transform-lib.mjs'

describe('parseTagArray', () => {
  test('parses a Postgres array literal with quoting and escapes', () => {
    expect(parseTagArray('{"Design crits","Figma support"}')).toEqual([
      'Design crits',
      'Figma support'
    ])
    expect(parseTagArray('{"Says \\"hi\\"",plain}')).toEqual([
      'Says "hi"',
      'plain'
    ])
  })

  test('parses legacy JSON-string rows', () => {
    expect(parseTagArray('["Design crits","Mural support"]')).toEqual([
      'Design crits',
      'Mural support'
    ])
  })

  test('handles empties and drops the _unchecked sentinel', () => {
    expect(parseTagArray('{}')).toEqual([])
    expect(parseTagArray('')).toEqual([])
    expect(parseTagArray(null)).toEqual([])
    expect(parseTagArray('{_unchecked,"Design crits"}')).toEqual([
      'Design crits'
    ])
  })
})

describe('mapRole / mapAvailability', () => {
  test('passes valid values through without warnings', () => {
    const warnings = []
    expect(mapRole('Service Designer', warnings, 'x')).toBe('Service Designer')
    expect(mapAvailability('Busy', warnings, 'x')).toBe('Busy')
    expect(warnings).toEqual([])
  })

  test('maps legacy roles and warns', () => {
    const warnings = []
    expect(mapRole('Lead Designer', warnings, 'x')).toBe(
      'Principal Service Designer'
    )
    expect(mapRole('User Researcher', warnings, 'x')).toBe('Service Designer')
    expect(warnings).toHaveLength(2)
  })

  test('drops unknown roles with a warning', () => {
    const warnings = []
    expect(mapRole('Wizard', warnings, 'x')).toBeNull()
    expect(warnings[0]).toContain('Wizard')
  })

  test('maps invalid availability values', () => {
    const warnings = []
    expect(mapAvailability('Available', warnings, 'x')).toBe('Free to help')
    expect(mapAvailability('Busy until Jan', warnings, 'x')).toBe('Busy')
    expect(mapAvailability('???', warnings, 'x')).toBe('Some capacity')
    expect(warnings).toHaveLength(3)
  })
})

describe('isSeedEmail', () => {
  test('matches the 39 fake team members and gdad dummies, not real people', () => {
    expect(isSeedEmail('sarah.johnson@defra.gov.uk')).toBe(true)
    expect(isSeedEmail('peter.smith@defra.gov.uk')).toBe(true)
    expect(isSeedEmail('gdad.dummy.full@defra.gov.uk')).toBe(true)
    expect(isSeedEmail('pete.smith@defra.gov.uk')).toBe(false)
  })
})

describe('buildImportPlan', () => {
  const tables = {
    users: [
      {
        id: '1',
        email: 'Real.Person@defra.gov.uk',
        is_verified: 't',
        created_at: '2026-01-01'
      },
      {
        id: '2',
        email: 'real.person@defra.gov.uk',
        is_verified: 'f',
        created_at: '2026-02-01'
      },
      {
        id: '3',
        email: 'sarah.johnson@defra.gov.uk',
        is_verified: 't',
        created_at: '2026-01-01'
      },
      {
        id: '4',
        email: 'manager.person@defra.gov.uk',
        is_verified: 't',
        created_at: '2026-01-01'
      }
    ],
    profiles: [
      {
        id: 'real-person',
        user_id: '1',
        name: 'Real Person',
        role: 'Lead Designer',
        location: 'York',
        experience: '10 years',
        bio: 'Line one\nLine two',
        can_help_with: '{"Design crits"}',
        can_help_with_text: 'Happy to help',
        development_goals_text: 'Coaching',
        availability_status: 'Available',
        contact_email: ''
      },
      {
        id: 'manager-person',
        user_id: '4',
        name: 'Manager Person',
        role: 'Design Manager',
        availability_status: 'Some capacity'
      },
      {
        id: 'orphan-profile',
        user_id: '',
        name: 'Orphan Profile',
        role: 'Service Designer',
        availability_status: 'Some capacity',
        contact_email: 'Orphan.Profile@defra.gov.uk'
      },
      {
        id: 'sarah-johnson',
        user_id: '3',
        name: 'Sarah Johnson',
        role: 'Service Designer',
        availability_status: 'Some capacity'
      }
    ],
    approved_emails: [
      { email: 'never.registered@defra.gov.uk' },
      { email: 'real.person@defra.gov.uk' }
    ],
    app_administrators: [
      { email: 'manager.person@defra.gov.uk' },
      { email: 'ghost@defra.gov.uk' }
    ],
    profile_line_manager: [{ profile_id: 'manager-person' }],
    profile_manager_allocation: [
      { staff_profile_id: 'real-person', manager_profile_id: 'manager-person' },
      {
        staff_profile_id: 'sarah-johnson',
        manager_profile_id: 'manager-person'
      }
    ],
    profile_long_term_helping: [
      { helper_profile_id: 'manager-person', helpee_profile_id: 'real-person' },
      {
        helper_profile_id: 'manager-person',
        helpee_profile_id: 'sarah-johnson'
      }
    ],
    gdad_evidence_items: [
      {
        user_id: '1',
        skill_key: 'iterative_design',
        evidence_text: 'Situation: shipped things',
        official_score: '2',
        scored_by_user_id: '4'
      },
      {
        user_id: '1',
        skill_key: 'leading_design',
        evidence_text: 'More evidence',
        official_score: '3',
        scored_by_user_id: '99'
      },
      {
        user_id: '1',
        skill_key: 'nonsense_skill',
        evidence_text: 'x'
      }
    ]
  }

  test('builds a filtered, deduplicated plan', () => {
    const { plan, report } = buildImportPlan(tables, {
      scorerFallbackEmail: 'manager.person@defra.gov.uk'
    })

    const keys = plan.people.map((p) => p.key).sort()
    expect(keys).toEqual([
      'manager.person@defra.gov.uk',
      'never.registered@defra.gov.uk',
      'orphan.profile@defra.gov.uk',
      'real.person@defra.gov.uk'
    ])

    const real = plan.people.find((p) => p.key === 'real.person@defra.gov.uk')
    // Case-duplicate users merged, verified row won
    expect(real.activate).toBe(true)
    expect(real.approved).toBe(true)
    expect(real.profile.role).toBe('Principal Service Designer')
    expect(real.profile.availabilityStatus).toBe('Free to help')
    expect(real.profile.canHelpWith).toEqual(['Design crits'])
    expect(real.profile.bio).toBe('Line one\nLine two')
    // Scored by user 4; the unknown scorer 99 fell back to the fallback
    expect(real.scores.iterative_design).toEqual({
      score: 2,
      scorer: 'manager.person@defra.gov.uk'
    })
    expect(real.scores.leading_design.scorer).toBe(
      'manager.person@defra.gov.uk'
    )
    expect(Object.keys(real.evidence)).toEqual([
      'iterative_design',
      'leading_design'
    ])

    const manager = plan.people.find(
      (p) => p.key === 'manager.person@defra.gov.uk'
    )
    expect(manager.isAdmin).toBe(true)

    const orphan = plan.people.find(
      (p) => p.key === 'orphan.profile@defra.gov.uk'
    )
    expect(orphan.profile.name).toBe('Orphan Profile')

    // Seed person excluded everywhere
    expect(report.excluded.join(' ')).toContain('sarah.johnson@defra.gov.uk')
    expect(plan.lineManagers).toEqual(['manager.person@defra.gov.uk'])
    expect(plan.allocations).toEqual([
      {
        staff: 'real.person@defra.gov.uk',
        manager: 'manager.person@defra.gov.uk'
      }
    ])
    expect(plan.helping).toEqual([
      {
        helper: 'manager.person@defra.gov.uk',
        helpees: ['real.person@defra.gov.uk']
      }
    ])

    // Ghost admin and unknown skill warned about
    expect(report.warnings.join(' ')).toContain('ghost@defra.gov.uk')
    expect(report.warnings.join(' ')).toContain('nonsense_skill')
  })

  test('--include-seed keeps everything', () => {
    const { plan } = buildImportPlan(tables, { includeSeed: true })
    expect(
      plan.people.some((p) => p.key === 'sarah.johnson@defra.gov.uk')
    ).toBe(true)
    expect(plan.allocations).toHaveLength(2)
  })
})
