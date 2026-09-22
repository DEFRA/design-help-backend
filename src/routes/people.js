import Boom from '@hapi/boom'
import Joi from 'joi'

import {
  ALLOWED_AVAILABILITY_STATUSES,
  ALLOWED_ROLES,
  GDAD_SCORES,
  GDAD_SKILL_KEYS,
  MAX_EVIDENCE_LENGTH,
  MAX_HELPING_ROWS
} from '#/common/constants.js'
import {
  PeopleError,
  activatePerson,
  createPerson,
  deletePerson,
  getPerson,
  getPersonByEmail,
  listHelpingPairs,
  listPeople,
  replaceLineManagers,
  setAdmin,
  setHelping,
  setManager,
  updatePerson,
  upsertGdadEvidence,
  upsertGdadScores
} from '#/services/people.js'

const objectIdSchema = Joi.string().hex().length(24)

const profileFieldsSchema = {
  name: Joi.string().trim().max(255).allow(null, ''),
  role: Joi.string()
    .valid(...ALLOWED_ROLES)
    .allow(null, ''),
  location: Joi.string().trim().max(255).allow(null, ''),
  experience: Joi.string().trim().max(5000).allow(null, ''),
  bio: Joi.string().trim().max(5000).allow(null, ''),
  canHelpWith: Joi.array().items(Joi.string().trim().max(255)).max(50),
  canHelpWithText: Joi.string().trim().max(5000).allow(null, ''),
  developmentGoalsText: Joi.string().trim().max(5000).allow(null, ''),
  projectTeam: Joi.string().trim().max(255).allow(null, ''),
  deliveryGroup: Joi.string().trim().max(255).allow(null, ''),
  linkedinProfile: Joi.string().trim().max(1000).allow(null, ''),
  availabilityStatus: Joi.string().valid(...ALLOWED_AVAILABILITY_STATUSES),
  contactEmail: Joi.string().trim().email().max(255).allow(null, '')
}

function mapPeopleError(error) {
  if (!(error instanceof PeopleError)) {
    throw error
  }
  switch (error.code) {
    case 'not_found':
      return Boom.notFound('Person not found')
    case 'duplicate_email':
      return Boom.conflict('A person with that email already exists')
    case 'invalid_manager':
      return Boom.badRequest('Manager must be a current line manager')
    case 'invalid_skill':
      return Boom.badRequest(`Unknown GDaD skill: ${error.detail}`)
    case 'evidence_too_long':
      return Boom.badRequest(
        `Evidence for ${error.detail} is over ${MAX_EVIDENCE_LENGTH} characters`
      )
    default:
      return Boom.badImplementation(error.message)
  }
}

async function respond(h, fn, statusCode = 200) {
  try {
    const result = await fn()
    return h.response(result ?? {}).code(statusCode)
  } catch (error) {
    return mapPeopleError(error)
  }
}

export const peopleRoutes = [
  {
    method: 'GET',
    path: '/people',
    options: {
      validate: {
        query: Joi.object({
          filter: Joi.string().trim().max(255).allow(''),
          sort: Joi.string().valid('a-z', 'z-a')
        })
      }
    },
    handler: (request, h) =>
      respond(h, () => listPeople(request.db, request.query))
  },
  {
    method: 'POST',
    path: '/people',
    options: {
      validate: {
        payload: Joi.object({
          email: Joi.string().trim().email().max(255).allow(null, ''),
          approved: Joi.boolean(),
          ...profileFieldsSchema
        })
      }
    },
    handler: (request, h) =>
      respond(h, () => createPerson(request.db, request.payload), 201)
  },
  {
    method: 'GET',
    path: '/people/by-email/{email}',
    options: {
      validate: {
        params: Joi.object({
          email: Joi.string().trim().email().max(255)
        })
      }
    },
    handler: async (request, h) => {
      const person = await getPersonByEmail(request.db, request.params.email)
      return person ? h.response(person) : Boom.notFound()
    }
  },
  {
    method: 'GET',
    path: '/people/{id}',
    handler: async (request, h) => {
      const person = await getPerson(request.db, request.params.id)
      return person ? h.response(person) : Boom.notFound()
    }
  },
  {
    method: 'PATCH',
    path: '/people/{id}',
    options: {
      validate: {
        payload: Joi.object({
          email: Joi.string().trim().email().max(255).allow(null, ''),
          approved: Joi.boolean(),
          ...profileFieldsSchema
        })
      }
    },
    handler: (request, h) =>
      respond(h, () =>
        updatePerson(request.db, request.params.id, request.payload)
      )
  },
  {
    method: 'DELETE',
    path: '/people/{id}',
    options: {
      validate: {
        query: Joi.object({
          mode: Joi.string().valid('full', 'profile', 'access').default('full')
        })
      }
    },
    handler: (request, h) =>
      respond(h, () =>
        deletePerson(request.db, request.params.id, request.query.mode)
      )
  },
  {
    method: 'POST',
    path: '/people/{id}/activate',
    handler: (request, h) =>
      respond(h, () => activatePerson(request.db, request.params.id))
  },
  {
    method: 'POST',
    path: '/people/{id}/admin',
    options: {
      validate: {
        payload: Joi.object({
          isAdmin: Joi.boolean().required()
        })
      }
    },
    handler: (request, h) =>
      respond(h, () =>
        setAdmin(request.db, request.params.id, request.payload.isAdmin)
      )
  },
  {
    method: 'PUT',
    path: '/people/{id}/helping',
    options: {
      validate: {
        payload: Joi.object({
          availabilityStatus: Joi.string()
            .valid(...ALLOWED_AVAILABILITY_STATUSES)
            .required(),
          helpeeIds: Joi.array()
            .items(objectIdSchema)
            .max(MAX_HELPING_ROWS)
            .default([])
        })
      }
    },
    handler: (request, h) =>
      respond(h, () =>
        setHelping(request.db, request.params.id, request.payload)
      )
  },
  {
    method: 'PUT',
    path: '/people/{id}/manager',
    options: {
      validate: {
        payload: Joi.object({
          managerId: objectIdSchema.allow(null).required()
        })
      }
    },
    handler: (request, h) =>
      respond(h, () =>
        setManager(request.db, request.params.id, request.payload.managerId)
      )
  },
  {
    method: 'PUT',
    path: '/people/{id}/gdad/evidence',
    options: {
      validate: {
        payload: Joi.object({
          evidence: Joi.object()
            .pattern(
              Joi.string().valid(...GDAD_SKILL_KEYS),
              Joi.string().allow(null, '').max(MAX_EVIDENCE_LENGTH)
            )
            .min(1)
            .required()
        })
      }
    },
    handler: (request, h) =>
      respond(h, () =>
        upsertGdadEvidence(
          request.db,
          request.params.id,
          request.payload.evidence
        )
      )
  },
  {
    method: 'PUT',
    path: '/people/{id}/gdad/scores',
    options: {
      validate: {
        payload: Joi.object({
          scores: Joi.object()
            .pattern(
              Joi.string().valid(...GDAD_SKILL_KEYS),
              Joi.number()
                .valid(...GDAD_SCORES)
                .allow(null)
            )
            .min(1)
            .required(),
          scoredById: objectIdSchema.required()
        })
      }
    },
    handler: (request, h) =>
      respond(h, () =>
        upsertGdadScores(
          request.db,
          request.params.id,
          request.payload.scores,
          request.payload.scoredById
        )
      )
  },
  {
    method: 'GET',
    path: '/helping-pairs',
    handler: (request, h) => respond(h, () => listHelpingPairs(request.db))
  },
  {
    method: 'PUT',
    path: '/line-managers',
    options: {
      validate: {
        payload: Joi.object({
          personIds: Joi.array().items(objectIdSchema).required()
        })
      }
    },
    handler: (request, h) =>
      respond(h, () =>
        replaceLineManagers(request.db, request.payload.personIds)
      )
  }
]
