import { health } from '#/routes/health.js'
import { peopleRoutes } from '#/routes/people.js'

export const router = {
  plugin: {
    name: 'router',
    register: (server, _options) => {
      server.route([health].concat(peopleRoutes))
    }
  }
}
