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
	"connectrpc.com/grpchealth"
	judgev1 "github.com/K23K-dev/corecode/judge/gen"
	"github.com/K23K-dev/corecode/judge/gen/judgev1connect"
)

const maxMessageBytes = 1 << 20

// newHandler serves the judge and the standard gRPC health service to gRPC,
// gRPC-Web, and Connect clients. Every call, including health, must carry the
// shared token; Sandbox sessions also count calls toward the idle timer.
func newHandler(token string, judge judgev1connect.JudgeServiceHandler, health grpchealth.Checker, lifecycle *judgeLifecycle) http.Handler {
	limits := []connect.HandlerOption{connect.WithReadMaxBytes(maxMessageBytes), connect.WithSendMaxBytes(maxMessageBytes)}
	mux := http.NewServeMux()
	mux.Handle(judgev1connect.NewJudgeServiceHandler(judge, limits...))
	mux.Handle(grpchealth.NewHandler(health, limits...))
	var handler http.Handler = mux
	if lifecycle != nil {
		handler = lifecycle.track(handler)
	}
	return http.MaxBytesHandler(authenticate(token, handler), maxMessageBytes+1024)
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
		_ = errorWriter.Write(w, r, rpcError(connect.CodeUnauthenticated, "Judge authentication is required."))
	})
}

// rpcError is a status error that Connect encodes for gRPC, gRPC-Web, and Connect clients.
func rpcError(code connect.Code, message string) error {
	return connect.NewError(code, errors.New(message))
}

// contextError reports a canceled or expired request with the matching status.
func contextError(err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return connect.NewError(connect.CodeDeadlineExceeded, err)
	}
	return connect.NewError(connect.CodeCanceled, err)
}

var jobIDPattern = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)

func jobID(value string) (string, error) {
	if !jobIDPattern.MatchString(value) {
		return "", rpcError(connect.CodeInvalidArgument, "Provide a UUID job ID.")
	}
	return strings.ToLower(value), nil
}

// judgeServer implements JudgeService; jobs live in Neon and run through the queue.
type judgeServer struct {
	judgev1connect.UnimplementedJudgeServiceHandler
	queue *jobQueue
}

func (s *judgeServer) Run(ctx context.Context, request *judgev1.RunRequest) (*judgev1.RunResult, error) {
	return s.queue.run(ctx, request)
}

func (s *judgeServer) Submit(ctx context.Context, request *judgev1.SubmitRequest) (*judgev1.JobSnapshot, error) {
	id, err := jobID(request.GetSubmissionId())
	if err != nil {
		return nil, err
	}
	request.SubmissionId = id
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	s.queue.admission.Lock()
	defer s.queue.admission.Unlock()
	// An acknowledged UUID remains usable when the catalog or runtime changes.
	existing, err := s.queue.store.find(ctx, id)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		if existing.fingerprint != submissionFingerprint(request) {
			return nil, rpcError(connect.CodeAlreadyExists, "That submission ID was already used for different input.")
		}
		return existing.snapshot, nil
	}
	input, err := prepareExecution(ctx, s.queue.store.pool, &judgev1.RunRequest{
		ProblemId: request.ProblemId, ProblemVersion: request.ProblemVersion, Code: request.Code,
	}, "submit")
	if err != nil {
		return nil, err
	}
	image, err := s.queue.executor.imageFor(input.runtime)
	if err != nil {
		return nil, err
	}
	accepted, err := s.queue.store.accept(ctx, request, input.specVersion, input.runtime, image)
	if err == nil {
		s.queue.notify()
	}
	return accepted, err
}

func (s *judgeServer) GetJob(ctx context.Context, request *judgev1.JobRequest) (*judgev1.JobSnapshot, error) {
	id, err := jobID(request.GetJobId())
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	job, err := s.queue.store.find(ctx, id)
	if err != nil {
		return nil, err
	}
	if job == nil {
		return nil, rpcError(connect.CodeNotFound, "Job not found.")
	}
	return job.snapshot, nil
}

// Preserve the RPC name while narrowing it to the website's recovery lookup.
func (s *judgeServer) ListJobs(ctx context.Context, request *judgev1.ListJobsRequest) (*judgev1.ListJobsResponse, error) {
	if !validProblemID(request.GetProblemId()) {
		return nil, rpcError(connect.CodeInvalidArgument, "Invalid problem ID.")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	job, err := s.queue.store.latest(ctx, request.GetProblemId())
	if err != nil {
		return nil, err
	}
	response := &judgev1.ListJobsResponse{}
	if job != nil {
		response.Jobs = []*judgev1.JobSnapshot{job}
	}
	return response, nil
}

func (s *judgeServer) CancelJob(ctx context.Context, request *judgev1.JobRequest) (*judgev1.JobSnapshot, error) {
	id, err := jobID(request.GetJobId())
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	job, err := s.queue.store.cancel(ctx, id)
	if err == nil {
		s.queue.cancelActive(id)
	}
	return job, err
}
