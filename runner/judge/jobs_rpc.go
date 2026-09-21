package main

import (
	"context"
	"regexp"
	"strings"
	"time"

	judgev1 "github.com/K23K-dev/corecode/runner/judge/gen"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

var jobIDPattern = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)

func jobID(value string) (string, error) {
	if !jobIDPattern.MatchString(value) {
		return "", status.Error(codes.InvalidArgument, "Provide a UUID job ID.")
	}
	return strings.ToLower(value), nil
}

func (s *judgeServer) Submit(ctx context.Context, request *judgev1.SubmitRequest) (*judgev1.JobSnapshot, error) {
	id, err := jobID(request.GetSubmissionId())
	if err != nil {
		return nil, err
	}
	request.SubmissionId = id
	if len(request.CompletionIntentIds) > 256 {
		return nil, status.Error(codes.InvalidArgument, "Too many completion intent IDs.")
	}
	for _, value := range request.CompletionIntentIds {
		if !validProblemID(value) {
			return nil, status.Error(codes.InvalidArgument, "Invalid completion intent ID.")
		}
	}
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
			return nil, status.Error(codes.AlreadyExists, "That submission ID was already used for different input.")
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
		return nil, status.Error(codes.NotFound, "Job not found.")
	}
	return job.snapshot, nil
}

// Listing omits potentially large grading results; GetJob and WatchJob include them.
func (s *judgeServer) ListJobs(ctx context.Context, request *judgev1.ListJobsRequest) (*judgev1.ListJobsResponse, error) {
	if request.GetProblemId() != "" && !validProblemID(request.GetProblemId()) {
		return nil, status.Error(codes.InvalidArgument, "Invalid problem ID.")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return s.queue.store.list(ctx, request.GetProblemId(), int(request.GetPageSize()), request.GetPageToken())
}

func (s *judgeServer) WatchJob(request *judgev1.JobRequest, stream grpc.ServerStreamingServer[judgev1.JobSnapshot]) error {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	var revision uint64
	for {
		job, err := s.GetJob(stream.Context(), request)
		if err != nil {
			return err
		}
		if job.Revision != revision {
			if err := stream.Send(job); err != nil {
				return err
			}
			revision = job.Revision
		}
		switch job.State {
		case judgev1.JobState_JOB_STATE_COMPLETED, judgev1.JobState_JOB_STATE_FAILED, judgev1.JobState_JOB_STATE_CANCELED:
			return nil
		}
		select {
		case <-stream.Context().Done():
			return status.FromContextError(stream.Context().Err()).Err()
		case <-s.queue.ctx.Done():
			return status.Error(codes.Unavailable, "The judge is shutting down.")
		case <-ticker.C:
		}
	}
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
