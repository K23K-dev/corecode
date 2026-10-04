# Code Practice

A Next.js coding-practice website with a TypeScript frontend and API, plus a Go judge.
Problems, grading cases, and progress live in Neon.

## Project layout

- `src/app/`: Next.js pages: `page.tsx` is the problem list (`/`) and `problems/[id]/page.tsx`
  is a problem. `api/[...path]/route.ts` hands every `/api` request to `server/router.ts`.
- `src/components/`: React components, built from Mantine components.
- `src/hooks/`: `useProblemList` (search and open decks) and `useRunner` (Run, Submit, Stop).
- `src/lib/`: browser helpers: `api.ts` (fetch), `progress-store.ts` (saved progress and
  autosave), and `theme.ts` (the Mantine theme).
- `src/schemas/`: Zod schemas both sides use: `catalog.ts`, `progress.ts`, and `submissions.ts`.
- `src/server/`: the backend.
  - `router.ts`: every endpoint and its handler in one file (a Hono router), plus what runs
    before each one.
  - `db/`: the SQL, one file per area.
  - `middleware.ts`: request checks, JSON parsing, and error responses.
  - `config.ts`: environment, database pool, and judge setup.
  - `judge-client/`: the Go judge's gRPC client.
- `judge/`: the Go gRPC judge (durable queue, Docker executor, grading). `graders/` holds
  the Python and JavaScript grader images, and `deploy/` the VM's systemd unit and Caddyfile.
- `proto/`: the judge's gRPC contract. `npm run judge:generate` rebuilds the Go and
  TypeScript code from it, as set in `buf.gen.yaml`.

Names: a *problem* is one coding question; the *catalog* is every deck and problem;
*progress* is saved drafts, stars, and solved problems (only an accepted submission marks one
solved); a *run* checks the first example; a *submission* is graded on every case and saved.

## Run locally

Requires Node.js 22.12+ and a private `.env` with `POSTGRES_URL`, `JUDGE_URL`, and
`JUDGE_TOKEN`. Use [.env.example](.env.example) as the template.

```sh
npm install
npm run dev
```

Open [localhost:5173](http://127.0.0.1:5173). For a built version, run
`npm run build` followed by `npm start`.

Both websites use the same Go judge, on its VM (see [Judge VM](#judge-vm)). Submissions
live in Neon and save history and progress together.

Run `npm run check` and `npm run judge:check` to verify changes. The judge commands need
Go 1.27+ on your PATH (on Windows, `winget install GoLang.Go`). `npm run judge:images`
rebuilds the Docker grading images, and `npm run judge:build-linux` builds the judge for the VM.

## Vercel

Use the **Next.js** framework preset with default build/output settings.
Keep **Vercel Authentication → All Deployments** enabled: this app shares one
personal profile. Set these variables in Production only:

- `POSTGRES_URL`: the existing Neon connection.
- `APP_ORIGIN=https://corecode-alpha.vercel.app`: update and redeploy if the domain changes.
- `VERCEL_AUTHENTICATION_CONFIRMED=1`: only after enabling protection.
- `JUDGE_URL`: the judge's HTTPS address, the same one used locally.
- `JUDGE_TOKEN`: the same private token configured on the judge.

The website calls the judge with gRPC over HTTPS. A job whose judge stops is retried once
its 60-second lease expires. Preview deployments cannot use the personal data API.

## Judge VM

The judge runs on one always-on Linux VM with Docker. Caddy, on the same VM, terminates HTTPS
and forwards gRPC to the judge, which listens only on `127.0.0.1:8080`.

1. Create an Ubuntu 24.04 x86-64 VM with at least 4 GB of RAM (two 1 GiB grading slots plus
   Chromium). Point a DNS name such as `judge.example.com` at it, and allow only ports 22, 80,
   and 443 in its firewall.
2. On the VM, install Docker and Caddy, and add a user for the judge:
   ```sh
   curl -fsSL https://get.docker.com | sudo sh
   sudo apt-get install -y caddy
   sudo useradd --system --no-create-home judge
   ```
3. From this repo, send the grader images, the judge binary, and the two deploy files:
   ```sh
   npm run judge:images && npm run judge:build-linux
   docker save cp-practice-python:3 coding-practice-js:4 | ssh you@VM sudo docker load
   scp build/judge-linux-amd64 judge/deploy/* you@VM:
   ```
4. On the VM, install them. Put your judge's DNS name in the Caddyfile, and `POSTGRES_URL` and
   `JUDGE_TOKEN` in the environment file:
   ```sh
   sudo install -m 755 judge-linux-amd64 /usr/local/bin/code-practice-judge
   sudo install -m 644 code-practice-judge.service /etc/systemd/system/
   sudo install -m 644 Caddyfile /etc/caddy/Caddyfile && sudoedit /etc/caddy/Caddyfile
   sudo mkdir -p /etc/code-practice && sudoedit /etc/code-practice/judge.env
   sudo chmod 600 /etc/code-practice/judge.env
   sudo systemctl daemon-reload && sudo systemctl enable --now code-practice-judge
   sudo systemctl reload caddy
   ```
5. `journalctl -u code-practice-judge` should show "Judge listening on 127.0.0.1:8080". Then set
   `JUDGE_URL=https://judge.example.com` in `.env` and in Vercel.

To update the judge, repeat steps 3 and 4 for what changed, then
`sudo systemctl restart code-practice-judge`. Queued submissions wait in Neon meanwhile.

The schema lives in Neon, and database changes are applied by hand; starting or deploying the
website doesn't change it. Never commit credentials.
