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

Folders: `src/` frontend · `server/` API and database · `runner/` code execution · `tests/` checks.

Public hosting needs a Docker-capable execution server and production security/configuration;
this local app is not ready to expose unchanged.

Details: [Database](docs/database.md) · [Code runners](docs/runner.md) · [Problem authoring](docs/manual-authoring.md).
