# Code Practice

A personal coding-practice website with an editor, tests, and saved progress.
Problems, grading cases, and progress live in Neon; startup does not seed content.

## Run locally

Requires Node.js 22.12+, Docker Desktop running, and the existing Neon connection
in private `.env` as `POSTGRES_URL` with `sslmode=require`. See [.env.example](.env.example).

```sh
npm install
npm run runner:setup
npm run build
npm start
```

Open [localhost:5173](http://127.0.0.1:5173). After setup, start with `npm start`.
For development, use `npm run dev`.

## Vercel

The included configuration deploys Vite and the Express API together. Keep this
personal app behind **Vercel Authentication → All Deployments**; it has one shared
progress profile, not public user accounts.

Production variables: `POSTGRES_URL`, `VERCEL_AUTHENTICATION_CONFIRMED=1`, and
`RUNNER_SANDBOX_SNAPSHOT` after runner preparation and verification. Preview builds
cannot use the personal data API. No schema migration runs during deployment.

Hosted execution uses Vercel Sandbox; Docker Desktop is only for local execution.
After Vercel CLI login/link and pulling development credentials to a separate,
ignored `.env.vercel.local`, prepare the clean runner snapshot with:

```sh
node --env-file=.env.vercel.local runner/setup.mjs --sandbox --confirm-cloud-usage
```

This consumes Sandbox quota. Verify the graders before enabling the snapshot in
production. See [Deployment setup](docs/deployment.md) for the remaining checks.

Details: [Database](docs/database.md) · [Code runners](docs/runner.md) · [Problem authoring](docs/manual-authoring.md).
