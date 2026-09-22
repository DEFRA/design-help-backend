# design-help-backend

The data API for [design-help](https://github.com/DEFRA/design-help), Defra DDTS's internal design-community directory. Hapi + MongoDB on Defra's Core Delivery Platform; internal-only (reachable from the frontend, the API gateway or the CDP terminal — direct external requests get a 403 from the platform).

It stores everything in a single `people` collection: identity/allow-list (email + approved), profile fields, admin and line-manager flags, manager allocation, long-term helping, and embedded GDaD evidence/scores per skill. This replaces the prototype's eight Postgres tables; authentication (magic links, sessions) lives entirely in the frontend — this API holds no passwords or tokens.

## API summary

| Route                                                             | Purpose                                                                                  |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET /people?filter=&sort=`                                       | List people (case-insensitive filter over name/role/tags/free text; sort `a-z`/`z-a`)    |
| `POST /people`                                                    | Create a person — a bare `{email}` is an allow-list entry; profile fields optional       |
| `GET /people/{idOrSlug}` · `GET /people/by-email/{email}`         | Fetch one person                                                                         |
| `PATCH /people/{id}`                                              | Update profile fields / email / approval                                                 |
| `DELETE /people/{id}?mode=full\|profile\|access`                  | Delete entirely (with reference cleanup), clear the profile only, or revoke sign-in only |
| `POST /people/{id}/activate`                                      | Record first sign-in                                                                     |
| `POST /people/{id}/admin`                                         | Grant/revoke the dynamic admin flag                                                      |
| `PUT /people/{id}/helping`                                        | Replace availability + long-term helpee list                                             |
| `PUT /people/{id}/manager`                                        | Allocate a line manager (must hold the line-manager flag)                                |
| `PUT /line-managers`                                              | Replace the whole line-manager set (prunes stale allocations)                            |
| `GET /helping-pairs`                                              | All helper→helpee pairs                                                                  |
| `PUT /people/{id}/gdad/evidence` · `PUT /people/{id}/gdad/scores` | Upsert GDaD evidence / official scores per skill                                         |

Config: `APPROVED_EMAILS` (comma-separated) is seeded idempotently at startup under a mongo-lock, so a fresh environment is usable immediately.

- [Requirements](#requirements)
  - [Node.js](#nodejs)
- [Local development](#local-development)
  - [Setup](#setup)
  - [Development](#development)
  - [Testing](#testing)
  - [Production](#production)
  - [Npm scripts](#npm-scripts)
  - [Update dependencies](#update-dependencies)
  - [Formatting](#formatting)
    - [Windows prettier issue](#windows-prettier-issue)
- [API endpoints](#api-endpoints)
- [Development helpers](#development-helpers)
  - [MongoDB Locks](#mongodb-locks)
  - [Proxy](#proxy)
- [Docker](#docker)
  - [Development image](#development-image)
  - [Production image](#production-image)
  - [Docker Compose](#docker-compose)
  - [Dependabot](#dependabot)
  - [SonarCloud](#sonarcloud)
- [Licence](#licence)
  - [About the licence](#about-the-licence)

## Requirements

### Node.js

Please install [Node.js](http://nodejs.org/) `>= v24` and [npm](https://nodejs.org/) `>= v11`. You will find it
easier to use the Node Version Manager [nvm](https://github.com/creationix/nvm)

To use the correct version of Node.js for this application, via nvm:

```bash
cd design-help-backend
nvm use
```

## Local development

### Setup

Install application dependencies:

```bash
npm install
```

### Git hooks

Install git hooks (optional)

```bash
npm run git:hooks
```

### Development

To run the application in `development` mode run:

```bash
npm run dev
```

### Testing

To test the application run:

```bash
npm run test
```

### Production

To mimic the application running in `production` mode locally run:

```bash
npm start
```

### Npm scripts

All available Npm scripts can be seen in [package.json](./package.json).
To view them in your command line run:

```bash
npm run
```

### Update dependencies

To update dependencies use [npm-check-updates](https://github.com/raineorshine/npm-check-updates):

> The following script is a good start. Check out all the options on
> the [npm-check-updates](https://github.com/raineorshine/npm-check-updates)

```bash
ncu --interactive --format group
```

### Formatting

#### Windows prettier issue

If you are having issues with formatting of line breaks on Windows update your global git config by running:

```bash
git config --global core.autocrlf false
```

## API endpoints

`GET /health` is the platform health check. The service's own routes are listed in the [API summary](#api-summary) above and defined in `src/routes/people.js`.

## Development helpers

### MongoDB Locks

If you require a write lock for Mongo you can acquire it via `server.locker` or `request.locker`:

```javascript
async function doStuff(server) {
  const lock = await server.locker.lock('unique-resource-name')

  if (!lock) {
    // Lock unavailable
    return
  }

  try {
    // do stuff
  } finally {
    await lock.free()
  }
}
```

Keep it small and atomic.

You may use **using** for the lock resource management.
Note test coverage reports do not like that syntax.

```javascript
async function doStuff(server) {
  await using lock = await server.locker.lock('unique-resource-name')

  if (!lock) {
    // Lock unavailable
    return
  }

  // do stuff

  // lock automatically released
}
```

Helper methods are also available in `/src/helpers/mongo-lock.js`.

### Proxy

We are using forward-proxy which is set up by default. Services are automatically configured with the proxy environment variables when deployed.

Node.js 24 uses these variables to route outbound HTTP(S) requests through the proxy:

NODE_USE_ENV_PROXY=1
HTTPS_PROXY=...
NO_PROXY=...

No additional proxy configuration is required in the service.

## Docker

Build:

```bash
docker build --no-cache --tag design-help-backend .
```

Run:

```bash
docker run -e PORT=3001 -p 3001:3001 design-help-backend
```

### Docker Compose

A local environment with:

- Floci for AWS services (S3, SQS, SNS etc)
- Redis
- MongoDB
- This service.
- A commented out frontend example.

```bash
docker compose up --build -d
```

Mock AWS resources can be created when Floci starts up by editing the scripts in `./compose/floci/start.d/`.
MongoDB records can also be created when Mongo starts by editing the scripts in `./compose/mongo/`.

### Dependabot

We have added an example dependabot configuration file to the repository. You can enable it by renaming
the [.github/example.dependabot.yml](.github/example.dependabot.yml) to `.github/dependabot.yml`

### SonarCloud

Instructions for setting up SonarCloud can be found in [sonar-project.properties](./sonar-project.properties)

## Licence

THIS INFORMATION IS LICENSED UNDER THE CONDITIONS OF THE OPEN GOVERNMENT LICENCE found at:

<http://www.nationalarchives.gov.uk/doc/open-government-licence/version/3>

The following attribution statement MUST be cited in your products and applications when using this information.

> Contains public sector information licensed under the Open Government license v3

### About the licence

The Open Government Licence (OGL) was developed by the Controller of Her Majesty's Stationery Office (HMSO) to enable
information providers in the public sector to license the use and re-use of their information under a common open
licence.

It is designed to encourage use and re-use of information freely and flexibly, with only a few conditions.
