# Code Practice

A Next.js coding-practice website. Problems, grading cases, and progress live in Neon.

## Run locally

Requires Node.js 22.12+ and a private `.env` with `POSTGRES_URL`, `JUDGE_SANDBOX_NAME`,
and `JUDGE_TOKEN`. Use [.env.example](.env.example) as the template.

```sh
npm install
npm run dev
```

Open [localhost:5173](http://127.0.0.1:5173). For a built version, run
`npm run build` followed by `npm start`.

Both websites use one Go judge in Vercel Sandbox, waking it when needed. Submissions
live in Neon and save history and progress together. Link the existing Vercel project,
pull `.env.local` for local Sandbox authentication, then prepare the judge once with
Go 1.27+ and `npm run judge:setup`. Setup creates the runtime without connecting to Neon.
Run `npm run check` and `npm run judge:check` to verify changes.

## Vercel

Use the **Next.js** framework preset with default build/output settings.
Keep **Vercel Authentication → All Deployments** enabled: this app shares one
personal profile. Set these variables in Production only:

- `POSTGRES_URL`: the existing Neon connection.
- `APP_ORIGIN=https://corecode-alpha.vercel.app`: update and redeploy if the domain changes.
- `VERCEL_AUTHENTICATION_CONFIRMED=1`: only after enabling protection.
- `JUDGE_SANDBOX_NAME`: the same prepared sandbox used locally.
- `JUDGE_TOKEN`: the same private token configured on the judge.

Vercel provides project-scoped Sandbox authentication automatically. The Go judge
uses gRPC-Web through Vercel's HTTPS proxy and native gRPC inside the VM. It drains
after 30 idle seconds; sessions have a four-minute fallback timeout. Interrupted jobs
recover on the next execution request. Free-tier quotas apply. Preview deployments
cannot use the personal data API. Never delete/recreate the sandbox while jobs remain.

Apply approved Neon schema updates with `initializeDatabase` in
`server/repository.mjs` before deploying code that needs them. Vercel deployment
does not run migrations or seed content. Never commit credentials.
