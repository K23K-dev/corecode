# Code Practice

A Next.js coding-practice website with a TypeScript frontend and API, plus a Go judge.
Problems, grading cases, and progress live in Neon.

## Project layout

- `src/app/`: Next.js pages: `page.tsx` is the problem list (`/`) and `problems/[id]/page.tsx`
  is a problem. `api/[...path]/route.ts` hands every `/api` request to `server/router.ts`.
- `src/components/`: React components, built from Mantine components.
- `src/hooks/`: `useProblemList` (filters, sorting, open decks) and `useRunner` (Run, Submit,
  Stop, reconnecting).
- `src/lib/`: browser helpers: `api.ts` (fetch), `progress-store.ts` (saved progress and
  autosave), `runner.ts` (Run and Submit requests), and `theme.ts` (the Mantine theme).
- `src/schemas/`: Zod schemas both sides use: `catalog.ts`, `progress.ts`, `activity.ts`, and
  `submissions.ts`.
- `src/server/`: the backend.
  - `router.ts`: every endpoint in one file (a Hono router), plus what runs before each one.
  - `controllers/`: one file per resource: catalog, progress, activity, submissions.
  - `db/`: the SQL, one file per area.
  - `middleware.ts`: request checks, JSON parsing, and error responses.
  - `config.ts`: environment, database pool, and judge setup.
  - `judge-client/`: the Go judge's gRPC client and the Sandbox waker.
- `judge/`: the Go gRPC judge (durable queue, Docker executor, grading) and, in
  `graders/`, the Python and JavaScript grader images.
- `proto/`: the judge's gRPC contract. `npm run judge:generate` rebuilds the Go and
  TypeScript code from it.

Names: a *problem* is one coding question; the *catalog* is every deck and problem;
*progress* is saved drafts, stars, and checkmarks; *activity* is accepted-submission history
for streaks; a *run* checks the first example; a *submission* is graded on every case and saved.

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
live in Neon and save history and progress together. Locally, the Sandbox SDK signs in
with your Vercel CLI login (`vercel login`) for the project linked in `.vercel/`.

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
serves gRPC and gRPC-Web from one server; the website reaches it with gRPC-Web through
the Sandbox's HTTPS endpoint. It drains after 30 idle seconds; sessions have a
four-minute fallback timeout. A job whose judge stops is retried once its 60-second
lease expires, on the next execution request. Free-tier quotas apply. Preview deployments
cannot use the personal data API. Never delete/recreate the sandbox while jobs remain.

The app uses the existing Neon schema and hosted judge. Database changes are applied
manually when needed; starting or deploying the website does not provision either.
Never commit credentials.
