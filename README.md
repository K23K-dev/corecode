# Code Practice

A Next.js coding-practice website with a TypeScript frontend and API, plus a Go judge.
Problems, grading cases, and progress live in Neon.

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
live in Neon and save history and progress together. Local Sandbox authentication
comes from the existing Vercel project's `.env.local`.

Run `npm run check` and `npm run judge:check` to verify changes. Go 1.27+ is needed
for judge builds; `npm run judge:images` rebuilds the local Docker grading images.

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

The app uses the existing Neon schema and hosted judge. Database changes are applied
manually when needed; starting or deploying the website does not provision either.
Never commit credentials.
