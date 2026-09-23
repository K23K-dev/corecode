package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"slices"
	"time"

	judgev1 "github.com/K23K-dev/corecode/judge/gen"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
)

var errJobOwnership = errors.New("job lease is no longer owned")

type jobStore struct{ pool *pgxpool.Pool }

type storedJob struct {
	snapshot    *judgev1.JobSnapshot
	fingerprint string
}

type claimedJob struct {
	id, problemID, problemVersion, specVersion, code string
	runtime, imageID, containerName, ownerToken      string
	completionIntentIDs                              []string
	attempts                                         int
	recovery                                         bool
}

const jobColumns = `id::text, problem_id, problem_version, state, created_at,
	started_at, finished_at, result, error, revision, request_fingerprint`

const queueSchemaReady = `to_regprocedure('cp_finish_execution(uuid,uuid,jsonb,text,boolean)') IS NOT NULL
	AND EXISTS (SELECT 1 FROM cp_schema_migrations WHERE version = 8)`

func submissionFingerprint(request *judgev1.SubmitRequest) string {
	data, _ := json.Marshal(struct {
		ProblemID, ProblemVersion, Code string
		CompletionIntentIDs             []string
	}{request.ProblemId, request.ProblemVersion, request.Code, sortedIntentIDs(request.CompletionIntentIds)})
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func sortedIntentIDs(ids []string) []string {
	result := append([]string{}, ids...)
	slices.Sort(result)
	return slices.Compact(result)
}

func scanJob(row pgx.Row) (*storedJob, error) {
	job := &storedJob{snapshot: &judgev1.JobSnapshot{}}
	var state string
	var created time.Time
	var started, finished *time.Time
	var result []byte
	err := row.Scan(&job.snapshot.JobId, &job.snapshot.ProblemId, &job.snapshot.ProblemVersion,
		&state, &created, &started, &finished, &result, &job.snapshot.Error,
		&job.snapshot.Revision, &job.fingerprint)
	if err != nil {
		return nil, err
	}
	job.snapshot.State = map[string]judgev1.JobState{
		"queued": judgev1.JobState_JOB_STATE_QUEUED, "running": judgev1.JobState_JOB_STATE_RUNNING,
		"canceling": judgev1.JobState_JOB_STATE_CANCELING, "completed": judgev1.JobState_JOB_STATE_COMPLETED,
		"failed": judgev1.JobState_JOB_STATE_FAILED, "canceled": judgev1.JobState_JOB_STATE_CANCELED,
	}[state]
	job.snapshot.CreatedAt = created.UTC().Format(time.RFC3339Nano)
	if started != nil {
		value := started.UTC().Format(time.RFC3339Nano)
		job.snapshot.StartedAt = &value
	}
	if finished != nil {
		value := finished.UTC().Format(time.RFC3339Nano)
		job.snapshot.FinishedAt = &value
	}
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
		return status.FromContextError(ctx.Err()).Err()
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return errJobOwnership
	}
	return status.Error(codes.Unavailable, "The submission queue is temporarily unavailable.")
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

func (s *jobStore) accept(ctx context.Context, request *judgev1.SubmitRequest, specVersion, runtime, imageID string) (*judgev1.JobSnapshot, error) {
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
			return nil, status.Error(codes.AlreadyExists, "This submission ID already belongs to different input.")
		}
		return existing.snapshot, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, jobDatabaseError(ctx, err)
	}
	var current string
	err = tx.QueryRow(ctx, `SELECT current_version FROM cp_problems WHERE id = $1 AND active FOR SHARE`, request.ProblemId).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, status.Error(codes.NotFound, "Problem not found.")
	}
	if err != nil {
		return nil, jobDatabaseError(ctx, err)
	}
	if current != request.ProblemVersion {
		return nil, status.Error(codes.FailedPrecondition, "This problem changed. Refresh before submitting.")
	}
	job, err := scanJob(tx.QueryRow(ctx, `INSERT INTO cp_execution_jobs
		(id, problem_id, problem_version, spec_version, code, runtime, image_id, completion_intent_ids, request_fingerprint, completion_choice_id)
		SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9,
			(SELECT completion_choices->>$2 FROM cp_state WHERE profile_id = 1) FROM cp_grading_specs
		WHERE exercise_id = $2 AND problem_version = $3 AND spec_version = $4 AND content->>'runtime' = $6
		RETURNING `+jobColumns, request.SubmissionId, request.ProblemId, request.ProblemVersion,
		specVersion, request.Code, runtime, imageID, sortedIntentIDs(request.CompletionIntentIds), fingerprint))
	if err != nil {
		return nil, status.Error(codes.Unavailable, "Grading is temporarily unavailable for this problem.")
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, jobDatabaseError(ctx, err)
	}
	return job.snapshot, nil
}

type jobPage struct {
	ProblemID string    `json:"problem"`
	Created   time.Time `json:"created"`
	ID        string    `json:"id"`
}

func (s *jobStore) list(ctx context.Context, problemID string, limit int, pageToken string) (*judgev1.ListJobsResponse, error) {
	if limit < 1 {
		limit = 20
	}
	if limit > 50 {
		limit = 50
	}
	var page jobPage
	if pageToken != "" {
		data, err := base64.RawURLEncoding.DecodeString(pageToken)
		if err != nil || json.Unmarshal(data, &page) != nil || page.ProblemID != problemID || page.Created.IsZero() || page.ID == "" {
			return nil, status.Error(codes.InvalidArgument, "Invalid job page token.")
		}
	}
	// Lists carry status metadata. Fetch an individual job for its bounded but
	// potentially large result, keeping pages within the gRPC response limit.
	rows, err := s.pool.Query(ctx, `SELECT id::text, problem_id, problem_version, state, created_at,
		started_at, finished_at, NULL::jsonb, error, revision, request_fingerprint
		FROM cp_execution_jobs WHERE ($1 = '' OR problem_id = $1)
		AND ($2::timestamptz IS NULL OR (created_at, id::text) < ($2, $3))
		ORDER BY created_at DESC, id DESC LIMIT $4`, problemID, optionalPageTime(page), page.ID, limit+1)
	if err != nil {
		return nil, jobDatabaseError(ctx, err)
	}
	defer rows.Close()
	response := &judgev1.ListJobsResponse{}
	for rows.Next() {
		job, err := scanJob(rows)
		if err != nil {
			return nil, jobDatabaseError(ctx, err)
		}
		if len(response.Jobs) == limit {
			last := response.Jobs[limit-1]
			created, _ := time.Parse(time.RFC3339Nano, last.CreatedAt)
			data, _ := json.Marshal(jobPage{problemID, created, last.JobId})
			response.NextPageToken = base64.RawURLEncoding.EncodeToString(data)
			break
		}
		response.Jobs = append(response.Jobs, job.snapshot)
	}
	if rows.Err() != nil {
		return nil, jobDatabaseError(ctx, rows.Err())
	}
	return response, nil
}

func optionalPageTime(page jobPage) *time.Time {
	if page.Created.IsZero() {
		return nil
	}
	return &page.Created
}

func (s *jobStore) hasPending(ctx context.Context, excludeIDs []string) (bool, error) {
	var pending bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM cp_execution_jobs WHERE state = 'queued'
		OR (state IN ('running', 'canceling') AND id <> ALL($1::uuid[])))`, excludeIDs).Scan(&pending)
	if err != nil {
		return false, jobDatabaseError(ctx, err)
	}
	return pending, nil
}

func (s *jobStore) claim(ctx context.Context, ownerToken, newContainerName string, excludeIDs []string) (*claimedJob, error) {
	job := &claimedJob{ownerToken: ownerToken}
	// Previous-process leases may still own live containers. Wait for expiry,
	// then clean recorded attempts before admitting fresh queued work.
	err := s.pool.QueryRow(ctx, `WITH next AS MATERIALIZED (
		SELECT id, state <> 'queued' AS recovery FROM cp_execution_jobs
		WHERE `+queueSchemaReady+` AND id <> ALL($3::uuid[]) AND
			(state = 'queued' OR (state IN ('running', 'canceling') AND lease_until <= clock_timestamp()))
			AND NOT EXISTS (SELECT 1 FROM cp_execution_jobs
				WHERE state IN ('running', 'canceling') AND id <> ALL($3::uuid[]) AND lease_until > clock_timestamp())
		ORDER BY (state <> 'queued') DESC, created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
	)
	UPDATE cp_execution_jobs j SET state = CASE WHEN j.cancel_requested THEN 'canceling' ELSE 'running' END,
		owner_token = $1, lease_until = clock_timestamp() + interval '60 seconds',
		container_name = CASE WHEN next.recovery THEN j.container_name ELSE $2 END,
		attempts = j.attempts + CASE WHEN next.recovery THEN 0 ELSE 1 END,
		started_at = COALESCE(j.started_at, clock_timestamp()), revision = j.revision + 1
	FROM next WHERE j.id = next.id
	RETURNING j.id::text, j.problem_id, j.problem_version, j.spec_version, j.code, j.runtime,
		j.image_id, j.container_name, j.completion_intent_ids, j.attempts, next.recovery`, ownerToken, newContainerName, excludeIDs).
		Scan(&job.id, &job.problemID, &job.problemVersion, &job.specVersion, &job.code, &job.runtime,
			&job.imageID, &job.containerName, &job.completionIntentIDs, &job.attempts, &job.recovery)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, jobDatabaseError(ctx, err)
	}
	return job, nil
}

func (s *jobStore) renew(ctx context.Context, id, token string) (bool, error) {
	var cancelRequested bool
	err := s.pool.QueryRow(ctx, `UPDATE cp_execution_jobs SET lease_until = clock_timestamp() + interval '60 seconds'
		WHERE id = $1 AND owner_token = $2 AND lease_until > clock_timestamp() AND state IN ('running', 'canceling')
		RETURNING cancel_requested`, id, token).Scan(&cancelRequested)
	if err != nil {
		return false, jobDatabaseError(ctx, err)
	}
	return cancelRequested, nil
}

func (s *jobStore) finish(ctx context.Context, id, token string, result *judgev1.RunResult, failure string, retry bool) (*judgev1.JobSnapshot, error) {
	var encoded []byte
	if result != nil {
		var err error
		encoded, err = protojson.Marshal(result)
		if err != nil {
			return nil, status.Error(codes.Internal, "Unable to save the grading result.")
		}
	}
	job, err := scanJob(s.pool.QueryRow(ctx, `SELECT `+jobColumns+
		` FROM cp_finish_execution($1::uuid, $2::uuid, $3::jsonb, $4::text, $5::boolean)`,
		id, token, encoded, failure, retry))
	if err != nil {
		return nil, jobDatabaseError(ctx, err)
	}
	return job.snapshot, nil
}

// Called only after the previous attempt's container is confirmed removed.
func (s *jobStore) finishRecovery(ctx context.Context, id, token string) (*judgev1.JobSnapshot, error) {
	return s.finish(ctx, id, token, nil, "Execution was interrupted twice. Submit again to retry.", true)
}

func (s *jobStore) cancel(ctx context.Context, id string) (*judgev1.JobSnapshot, error) {
	job, err := scanJob(s.pool.QueryRow(ctx, `UPDATE cp_execution_jobs SET
		state = CASE WHEN state = 'queued' THEN 'canceled' WHEN state = 'running' THEN 'canceling' ELSE state END,
		cancel_requested = CASE WHEN state IN ('queued', 'running', 'canceling') THEN true ELSE cancel_requested END,
		finished_at = CASE WHEN state = 'queued' THEN clock_timestamp() ELSE finished_at END,
		revision = revision + CASE WHEN state IN ('queued', 'running') THEN 1 ELSE 0 END
		WHERE id = $1 RETURNING `+jobColumns, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, status.Error(codes.NotFound, "Submission not found.")
	}
	if err != nil {
		return nil, jobDatabaseError(ctx, err)
	}
	return job.snapshot, nil
}
