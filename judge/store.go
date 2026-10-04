package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	judgev1 "github.com/K23K-dev/corecode/judge/gen"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/encoding/protojson"
)

// jobStore holds every query the judge runs.
type jobStore struct{ pool *pgxpool.Pool }

var (
	errProblemNotFound  = errors.New("Problem not found.")
	errProblemChanged   = errors.New("This problem changed. Refresh before submitting.")
	errInvalidSpec      = errors.New("The grading spec is missing or invalid.")
	errSubmissionReused = errors.New("That submission ID was already used for different input.")
	errJobNotFound      = errors.New("Job not found.")
	errDatabase         = errors.New("The database is temporarily unavailable.")
	// Another judge took the job over after this one's lease expired.
	errJobOwnership = errors.New("job lease is no longer owned")
)

// databaseError hides a failed query's details; only a canceled request keeps its own error.
func databaseError(ctx context.Context) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return errDatabase
}

type submission struct{ id, problemID, version, code string }

// fingerprint identifies a submission's input, so a retry of its UUID can be told apart from reuse.
func (s submission) fingerprint() string {
	data, _ := json.Marshal(struct{ ProblemID, ProblemVersion, Code string }{s.problemID, s.version, s.code})
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

type storedJob struct {
	id, problemID, state, fingerprint string
	result                            *judgev1.RunResult
	failure                           *string
	revision                          uint64
}

type claimedJob struct {
	id, problemID, problemVersion, code string
	ownerToken, containerName           string
	cancelRequested, exhausted          bool
}

const jobColumns = `id::text, problem_id, state, result, error, revision, request_fingerprint`

func scanJob(row pgx.Row) (*storedJob, error) {
	job := &storedJob{}
	var result []byte
	err := row.Scan(&job.id, &job.problemID, &job.state, &result, &job.failure, &job.revision, &job.fingerprint)
	if err != nil {
		return nil, err
	}
	if len(result) != 0 {
		job.result = &judgev1.RunResult{}
		if err := protojson.Unmarshal(result, job.result); err != nil {
			return nil, err
		}
	}
	return job, nil
}

// currentSpec returns the grading spec of a problem's current version, the only one Run grades.
func (s *jobStore) currentSpec(ctx context.Context, problemID, version string) ([]byte, error) {
	var current string
	var spec []byte
	err := s.pool.QueryRow(ctx, `
		SELECT p.current_version, s.content
		FROM problems p
		LEFT JOIN grading_specs s ON s.problem_id = p.id AND s.problem_version = p.current_version
		WHERE p.id = $1 AND p.active`, problemID).Scan(&current, &spec)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return nil, errProblemNotFound
	case err != nil:
		return nil, databaseError(ctx)
	case current != version:
		return nil, errProblemChanged
	case spec == nil:
		return nil, errInvalidSpec
	}
	return spec, nil
}

// storedSpec returns the exact spec a submission was accepted with, even after its problem changed.
func (s *jobStore) storedSpec(ctx context.Context, problemID, version string) ([]byte, error) {
	var spec []byte
	err := s.pool.QueryRow(ctx, `SELECT content FROM grading_specs WHERE problem_id = $1 AND problem_version = $2`,
		problemID, version).Scan(&spec)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return nil, errInvalidSpec
	case err != nil:
		return nil, databaseError(ctx)
	}
	return spec, nil
}

func (s *jobStore) find(ctx context.Context, id string) (*storedJob, error) {
	job, err := scanJob(s.pool.QueryRow(ctx, `SELECT `+jobColumns+` FROM jobs WHERE id = $1`, id))
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return nil, errJobNotFound
	case err != nil:
		return nil, databaseError(ctx)
	}
	return job, nil
}

// accept stores a submission once. Retrying its UUID with the same input returns the same job,
// even after the problem changes. canAccept vets the problem's runtime before a new job is stored.
func (s *jobStore) accept(ctx context.Context, request submission, canAccept func(runtime string) error) (*storedJob, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, databaseError(ctx)
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	// Serialize retries of one UUID, so two at once can't both insert it.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, request.id); err != nil {
		return nil, databaseError(ctx)
	}
	existing, err := scanJob(tx.QueryRow(ctx, `SELECT `+jobColumns+` FROM jobs WHERE id = $1`, request.id))
	switch {
	case err == nil && existing.fingerprint != request.fingerprint():
		return nil, errSubmissionReused
	case err == nil:
		return existing, nil
	case !errors.Is(err, pgx.ErrNoRows):
		return nil, databaseError(ctx)
	}
	// FOR SHARE: a content update can't switch the problem's current version until this commits.
	var current string
	var runtime *string
	err = tx.QueryRow(ctx, `
		SELECT p.current_version, s.content->>'runtime'
		FROM problems p
		LEFT JOIN grading_specs s ON s.problem_id = p.id AND s.problem_version = p.current_version
		WHERE p.id = $1 AND p.active
		FOR SHARE OF p`, request.problemID).Scan(&current, &runtime)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return nil, errProblemNotFound
	case err != nil:
		return nil, databaseError(ctx)
	case current != request.version:
		return nil, errProblemChanged
	case runtime == nil:
		return nil, errInvalidSpec
	}
	if err := canAccept(*runtime); err != nil {
		return nil, err
	}
	// A foreign key ties the job to the exact grading spec it will be graded with.
	job, err := scanJob(tx.QueryRow(ctx, `
		INSERT INTO jobs (id, problem_id, problem_version, code, request_fingerprint)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING `+jobColumns, request.id, request.problemID, request.version, request.code, request.fingerprint()))
	if err != nil {
		return nil, databaseError(ctx)
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, databaseError(ctx)
	}
	return job, nil
}

// claim takes the oldest queued job, or one whose judge stopped (its lease expired), under a new
// owner token that fences out any earlier owner. A job interrupted twice is claimed only to fail it.
func (s *jobStore) claim(ctx context.Context, running []string) (*claimedJob, error) {
	job := &claimedJob{}
	err := s.pool.QueryRow(ctx, `
		WITH next AS MATERIALIZED (
			SELECT id, state <> 'queued' AND attempts >= 2 AS exhausted
			FROM jobs
			WHERE id <> ALL($1::uuid[])
			  AND (state = 'queued'
			       -- A started job whose lease ran out: its judge stopped.
			       OR (state IN ('running', 'canceling') AND lease_until <= clock_timestamp()))
			ORDER BY created_at, id
			LIMIT 1
			-- Another judge claiming at the same moment skips this row instead of waiting.
			FOR UPDATE SKIP LOCKED
		), owner AS (SELECT gen_random_uuid() AS token)
		UPDATE jobs j
		SET state          = CASE WHEN j.cancel_requested THEN 'canceling' ELSE 'running' END,
		    owner_token    = owner.token,
		    lease_until    = clock_timestamp() + interval '60 seconds',
		    container_name = 'cp-job-' || owner.token,
		    attempts       = LEAST(j.attempts + 1, 2),
		    started_at     = COALESCE(j.started_at, clock_timestamp()),
		    revision       = j.revision + 1
		FROM next, owner
		WHERE j.id = next.id
		RETURNING j.id::text, j.problem_id, j.problem_version, j.code, j.owner_token::text,
		          j.container_name, j.cancel_requested, next.exhausted`, running).
		Scan(&job.id, &job.problemID, &job.problemVersion, &job.code, &job.ownerToken,
			&job.containerName, &job.cancelRequested, &job.exhausted)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return nil, nil
	case err != nil:
		return nil, databaseError(ctx)
	}
	return job, nil
}

// finish saves a job's outcome with finish_execution, which also writes its history row, but only
// while this judge still owns the job's lease.
func (s *jobStore) finish(ctx context.Context, job *claimedJob, result *judgev1.RunResult, failure string, retry bool) error {
	var encoded []byte
	if result != nil {
		var err error
		if encoded, err = protojson.Marshal(result); err != nil {
			return err
		}
	}
	var id string
	err := s.pool.QueryRow(ctx, `SELECT id::text FROM finish_execution($1::uuid, $2::uuid, $3::jsonb, $4::text, $5::boolean)`,
		job.id, job.ownerToken, encoded, failure, retry).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return errJobOwnership
	}
	return err
}

// cancel ends a queued job at once and marks a running one canceling, so its judge stops it.
// A finished job is returned unchanged.
func (s *jobStore) cancel(ctx context.Context, id string) (*storedJob, error) {
	job, err := scanJob(s.pool.QueryRow(ctx, `
		UPDATE jobs
		SET state            = CASE state WHEN 'queued' THEN 'canceled' WHEN 'running' THEN 'canceling' ELSE state END,
		    cancel_requested = cancel_requested OR state IN ('queued', 'running', 'canceling'),
		    finished_at      = CASE WHEN state = 'queued' THEN clock_timestamp() ELSE finished_at END,
		    revision         = revision + CASE WHEN state IN ('queued', 'running') THEN 1 ELSE 0 END
		WHERE id = $1
		RETURNING `+jobColumns, id))
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return nil, errJobNotFound
	case err != nil:
		return nil, databaseError(ctx)
	}
	return job, nil
}
