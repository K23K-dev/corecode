package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"connectrpc.com/connect"
	judgev1 "github.com/K23K-dev/corecode/judge/gen"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/encoding/protojson"
)

var errJobOwnership = errors.New("job lease is no longer owned")

type jobStore struct{ pool *pgxpool.Pool }

type storedJob struct {
	snapshot    *judgev1.JobSnapshot
	fingerprint string
}

type claimedJob struct {
	id, problemID, problemVersion, specVersion, code, runtime string
	containerName, ownerToken                                 string
	cancelRequested, exhausted                                bool
}

const jobColumns = `id::text, problem_id, state, result, error, revision, request_fingerprint`

func submissionFingerprint(request *judgev1.SubmitRequest) string {
	data, _ := json.Marshal(struct{ ProblemID, ProblemVersion, Code string }{request.ProblemId, request.ProblemVersion, request.Code})
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func scanJob(row pgx.Row) (*storedJob, error) {
	job := &storedJob{snapshot: &judgev1.JobSnapshot{}}
	var state string
	var result []byte
	err := row.Scan(&job.snapshot.JobId, &job.snapshot.ProblemId, &state, &result,
		&job.snapshot.Error, &job.snapshot.Revision, &job.fingerprint)
	if err != nil {
		return nil, err
	}
	job.snapshot.State = map[string]judgev1.JobState{
		"queued": judgev1.JobState_JOB_STATE_QUEUED, "running": judgev1.JobState_JOB_STATE_RUNNING,
		"canceling": judgev1.JobState_JOB_STATE_CANCELING, "completed": judgev1.JobState_JOB_STATE_COMPLETED,
		"failed": judgev1.JobState_JOB_STATE_FAILED, "canceled": judgev1.JobState_JOB_STATE_CANCELED,
	}[state]
	if len(result) != 0 {
		job.snapshot.Result = &judgev1.RunResult{}
		if err := protojson.Unmarshal(result, job.snapshot.Result); err != nil {
			return nil, err
		}
	}
	return job, nil
}

func jobDatabaseError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return contextError(ctx.Err())
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return errJobOwnership
	}
	return rpcError(connect.CodeUnavailable, "The submission queue is temporarily unavailable.")
}

func (s *jobStore) find(ctx context.Context, id string) (*storedJob, error) {
	job, err := scanJob(s.pool.QueryRow(ctx, `SELECT `+jobColumns+` FROM cp_execution_jobs WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, jobDatabaseError(ctx, err)
	}
	return job, nil
}

// accept stores a submission once. Retrying its UUID with the same input returns the same job.
func (s *jobStore) accept(ctx context.Context, request *judgev1.SubmitRequest, specVersion, runtime, image string) (*judgev1.JobSnapshot, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, jobDatabaseError(ctx, err)
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	// Serialize retries of one UUID before checking the current catalog. An older
	// accepted version must still return the original job after catalog changes.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, request.SubmissionId); err != nil {
		return nil, jobDatabaseError(ctx, err)
	}
	fingerprint := submissionFingerprint(request)
	existing, err := scanJob(tx.QueryRow(ctx, `SELECT `+jobColumns+` FROM cp_execution_jobs WHERE id = $1`, request.SubmissionId))
	if err == nil {
		if existing.fingerprint != fingerprint {
			return nil, rpcError(connect.CodeAlreadyExists, "This submission ID already belongs to different input.")
		}
		return existing.snapshot, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, jobDatabaseError(ctx, err)
	}
	// FOR SHARE: a content update can't switch the problem's current version until this commits.
	var current string
	err = tx.QueryRow(ctx, `
		SELECT current_version
		FROM cp_problems
		WHERE id = $1 AND active
		FOR SHARE`, request.ProblemId).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, rpcError(connect.CodeNotFound, "Problem not found.")
	}
	if err != nil {
		return nil, jobDatabaseError(ctx, err)
	}
	if current != request.ProblemVersion {
		return nil, rpcError(connect.CodeFailedPrecondition, "This problem changed. Refresh before submitting.")
	}
	// A foreign key ties the job to the exact grading spec it will be graded with.
	job, err := scanJob(tx.QueryRow(ctx, `
		INSERT INTO cp_execution_jobs
			(id, problem_id, problem_version, spec_version, code, runtime, image_id, request_fingerprint)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING `+jobColumns, request.SubmissionId, request.ProblemId, request.ProblemVersion,
		specVersion, request.Code, runtime, image, fingerprint))
	if err != nil {
		return nil, rpcError(connect.CodeUnavailable, "Grading is temporarily unavailable for this problem.")
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, jobDatabaseError(ctx, err)
	}
	return job.snapshot, nil
}

// claim takes the oldest queued job, or one whose judge stopped (its lease expired).
// A job interrupted twice is claimed only to be failed.
func (s *jobStore) claim(ctx context.Context, ownerToken, containerName string, excludeIDs []string) (*claimedJob, error) {
	job := &claimedJob{ownerToken: ownerToken, containerName: containerName}
	err := s.pool.QueryRow(ctx, `
		WITH next AS MATERIALIZED (
			SELECT id, state <> 'queued' AND attempts >= 2 AS exhausted
			FROM cp_execution_jobs
			WHERE id <> ALL($3::uuid[])
			  AND (state = 'queued'
			       -- A started job whose lease ran out: its judge stopped.
			       OR (state IN ('running', 'canceling') AND lease_until <= clock_timestamp()))
			ORDER BY created_at, id
			LIMIT 1
			-- Another judge claiming at the same moment skips this row instead of waiting.
			FOR UPDATE SKIP LOCKED
		)
		UPDATE cp_execution_jobs j
		SET state          = CASE WHEN j.cancel_requested THEN 'canceling' ELSE 'running' END,
		    owner_token    = $1,
		    lease_until    = clock_timestamp() + interval '60 seconds',
		    container_name = $2,
		    attempts       = LEAST(j.attempts + 1, 2),
		    started_at     = COALESCE(j.started_at, clock_timestamp()),
		    revision       = j.revision + 1
		FROM next
		WHERE j.id = next.id
		RETURNING j.id::text, j.problem_id, j.problem_version, j.spec_version, j.code, j.runtime,
		          j.cancel_requested, next.exhausted`, ownerToken, containerName, excludeIDs).
		Scan(&job.id, &job.problemID, &job.problemVersion, &job.specVersion, &job.code, &job.runtime,
			&job.cancelRequested, &job.exhausted)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, jobDatabaseError(ctx, err)
	}
	return job, nil
}

func (s *jobStore) finish(ctx context.Context, id, token string, result *judgev1.RunResult, failure string, retry bool) (*judgev1.JobSnapshot, error) {
	var encoded []byte
	if result != nil {
		var err error
		encoded, err = protojson.Marshal(result)
		if err != nil {
			return nil, rpcError(connect.CodeInternal, "Unable to save the grading result.")
		}
	}
	// One database function saves the result, the history row, and progress together, and only
	// while this judge still owns the job's lease.
	job, err := scanJob(s.pool.QueryRow(ctx, `
		SELECT `+jobColumns+`
		FROM cp_finish_execution($1::uuid, $2::uuid, $3::jsonb, $4::text, $5::boolean)`,
		id, token, encoded, failure, retry))
	if err != nil {
		return nil, jobDatabaseError(ctx, err)
	}
	return job.snapshot, nil
}

// cancel ends a queued job at once and marks a running one canceling, so its judge stops it.
// A finished job is returned unchanged.
func (s *jobStore) cancel(ctx context.Context, id string) (*judgev1.JobSnapshot, error) {
	job, err := scanJob(s.pool.QueryRow(ctx, `
		UPDATE cp_execution_jobs
		SET state            = CASE state WHEN 'queued' THEN 'canceled' WHEN 'running' THEN 'canceling' ELSE state END,
		    cancel_requested = cancel_requested OR state IN ('queued', 'running', 'canceling'),
		    finished_at      = CASE WHEN state = 'queued' THEN clock_timestamp() ELSE finished_at END,
		    revision         = revision + CASE WHEN state IN ('queued', 'running') THEN 1 ELSE 0 END
		WHERE id = $1
		RETURNING `+jobColumns, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, rpcError(connect.CodeNotFound, "Submission not found.")
	}
	if err != nil {
		return nil, jobDatabaseError(ctx, err)
	}
	return job.snapshot, nil
}
