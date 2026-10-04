package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"connectrpc.com/connect"
	judgev1 "github.com/K23K-dev/corecode/judge/gen"
	"github.com/K23K-dev/corecode/judge/gen/judgev1connect"
)

const maxMessageBytes = 1 << 20

// newHandler serves the judge to gRPC, gRPC-Web, and Connect clients. Every call must carry the
// shared token.
func newHandler(token string, judge judgev1connect.JudgeServiceHandler) http.Handler {
	limits := []connect.HandlerOption{connect.WithReadMaxBytes(maxMessageBytes), connect.WithSendMaxBytes(maxMessageBytes)}
	mux := http.NewServeMux()
	mux.Handle(judgev1connect.NewJudgeServiceHandler(judge, limits...))
	return http.MaxBytesHandler(authenticate(token, mux), maxMessageBytes+1024)
}

// TLS terminates at the hosting proxy, so the token is checked here. The browser never gets it.
func authenticate(token string, next http.Handler) http.Handler {
	expected := sha256.Sum256([]byte("Bearer " + token))
	errorWriter := connect.NewErrorWriter()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		values := r.Header.Values("Authorization")
		if len(values) == 1 {
			actual := sha256.Sum256([]byte(values[0]))
			if subtle.ConstantTimeCompare(actual[:], expected[:]) == 1 {
				next.ServeHTTP(w, r)
				return
			}
		}
		_ = errorWriter.Write(w, r, connect.NewError(connect.CodeUnauthenticated, errors.New("Judge authentication is required.")))
	})
}

// rpcServer implements JudgeService: it checks input and turns errors into gRPC statuses.
type rpcServer struct {
	judgev1connect.UnimplementedJudgeServiceHandler
	queue *jobQueue
	store *jobStore
}

func (s *rpcServer) Run(ctx context.Context, request *judgev1.RunRequest) (*judgev1.RunResult, error) {
	if err := checkProblem(request.ProblemId, request.ProblemVersion, request.Code); err != nil {
		return nil, err
	}
	result, err := s.queue.run(ctx, request.ProblemId, request.ProblemVersion, request.Code)
	return result, rpcError(err)
}

func (s *rpcServer) Submit(ctx context.Context, request *judgev1.SubmitRequest) (*judgev1.JobSnapshot, error) {
	id, err := jobID(request.SubmissionId)
	if err != nil {
		return nil, err
	}
	if err := checkProblem(request.ProblemId, request.ProblemVersion, request.Code); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	job, err := s.queue.submit(ctx, submission{id, request.ProblemId, request.ProblemVersion, request.Code})
	return snapshot(job), rpcError(err)
}

func (s *rpcServer) GetJob(ctx context.Context, request *judgev1.JobRequest) (*judgev1.JobSnapshot, error) {
	id, err := jobID(request.JobId)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	job, err := s.store.find(ctx, id)
	return snapshot(job), rpcError(err)
}

func (s *rpcServer) CancelJob(ctx context.Context, request *judgev1.JobRequest) (*judgev1.JobSnapshot, error) {
	id, err := jobID(request.JobId)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	job, err := s.queue.cancel(ctx, id)
	return snapshot(job), rpcError(err)
}

var (
	jobIDPattern          = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)
	problemVersionPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

func jobID(value string) (string, error) {
	if !jobIDPattern.MatchString(value) {
		return "", invalidArgument("Provide a UUID job ID.")
	}
	return strings.ToLower(value), nil
}

func checkProblem(id, version, code string) error {
	if strings.TrimSpace(id) == "" || len(id) > 800 || !problemVersionPattern.MatchString(version) {
		return invalidArgument("Provide a valid problem ID and version.")
	}
	if len(code) > 51200 {
		return invalidArgument("Keep code under 50 KiB.")
	}
	return nil
}

func invalidArgument(message string) error {
	return connect.NewError(connect.CodeInvalidArgument, errors.New(message))
}

// statusCodes gives each of the judge's errors its gRPC status.
var statusCodes = map[error]connect.Code{
	context.Canceled:         connect.CodeCanceled,
	context.DeadlineExceeded: connect.CodeDeadlineExceeded,
	errProblemNotFound:       connect.CodeNotFound,
	errJobNotFound:           connect.CodeNotFound,
	errSubmissionReused:      connect.CodeAlreadyExists,
	errProblemChanged:        connect.CodeFailedPrecondition,
	errInvalidSpec:           connect.CodeFailedPrecondition,
	errInvalidResult:         connect.CodeFailedPrecondition,
	errSlotsBusy:             connect.CodeResourceExhausted,
	errRuntimeUnavailable:    connect.CodeUnavailable,
	errShuttingDown:          connect.CodeUnavailable,
	errContainerFailed:       connect.CodeUnavailable,
	errDatabase:              connect.CodeUnavailable,
}

// rpcError gives an error its gRPC status. An unlisted error is reported without its details.
func rpcError(err error) error {
	if err == nil {
		return nil
	}
	for known, code := range statusCodes {
		if errors.Is(err, known) {
			return connect.NewError(code, known)
		}
	}
	return connect.NewError(connect.CodeUnavailable, errors.New("The judge is temporarily unavailable."))
}

var jobStates = map[string]judgev1.JobState{
	"queued": judgev1.JobState_JOB_STATE_QUEUED, "running": judgev1.JobState_JOB_STATE_RUNNING,
	"canceling": judgev1.JobState_JOB_STATE_CANCELING, "completed": judgev1.JobState_JOB_STATE_COMPLETED,
	"failed": judgev1.JobState_JOB_STATE_FAILED, "canceled": judgev1.JobState_JOB_STATE_CANCELED,
}

func snapshot(job *storedJob) *judgev1.JobSnapshot {
	if job == nil {
		return nil
	}
	return &judgev1.JobSnapshot{
		JobId: job.id, ProblemId: job.problemID, State: jobStates[job.state],
		Result: job.result, Error: job.failure, Revision: job.revision,
	}
}
