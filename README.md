# Code Practice

A Next.js coding-practice website. Problems, grading cases, and progress live in Neon.

## Run locally

Requires Node.js 22.12+, Docker Desktop running, and a private `.env` containing
`POSTGRES_URL` with `sslmode=require`. Use [.env.example](.env.example) as the template.

```sh
npm install
npm run runner:setup
npm run dev
```

Open [localhost:5173](http://127.0.0.1:5173). For a built version, run
`npm run build` followed by `npm start`.

The Go judge is being built separately; website grading still uses the existing
runner. With Go 1.27+ installed, run `npm run judge:dev` in another terminal.
It reads `.env` and exposes runs and durable submissions on `127.0.0.1:50051`.
Submissions save history and progress together; website integration comes next.
Use `npm run judge:check` to format-check, vet, and build it. Regenerating bindings
with `npm run judge:generate` also requires protoc 36.2.

## Vercel

Use the **Next.js** framework preset with default build/output settings.
Keep **Vercel Authentication → All Deployments** enabled: this app shares one
personal profile. Set these variables in Production only:

- `POSTGRES_URL`: the existing Neon connection.
- `APP_ORIGIN=https://corecode-alpha.vercel.app`: update and redeploy if the domain changes.
- `VERCEL_AUTHENTICATION_CONFIRMED=1`: only after enabling protection.
- `RUNNER_SANDBOX_SNAPSHOT`: a prepared and verified runner snapshot.

Hosted execution uses Vercel Sandbox, not your Docker Desktop. Snapshot preparation
uses cloud quota. Preview deployments cannot use the personal data API.

Apply approved Neon schema updates with `initializeDatabase` in
`server/repository.mjs` before deploying code that needs them. Vercel deployment
does not run migrations or seed content. Never commit credentials.
