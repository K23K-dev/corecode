package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	judgev1 "github.com/K23K-dev/corecode/runner/judge/gen"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Admission serializes queue acceptance, claims, and temporary Run reservations.
// Execution and lease renewal happen outside that lock.
type jobQueue struct {
	ctx       context.Context
	store     *jobStore
	executor  *executor
	admission sync.Mutex
	mu        sync.Mutex
	active    map[string]context.CancelFunc
	wake      chan struct{}
	workers   sync.WaitGroup
}

func newJobQueue(ctx context.Context, store *jobStore, executor *executor) *jobQueue {
	return &jobQueue{ctx: ctx, store: store, executor: executor, active: make(map[string]context.CancelFunc), wake: make(chan struct{}, 1)}
}

func (q *jobQueue) notify() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *jobQueue) run(ctx context.Context, request *judgev1.RunRequest) (*judgev1.RunResult, error) {
	input, err := prepareExecution(ctx, q.store.pool, request, "example")
	if err != nil {
		return nil, err
	}
	q.admission.Lock()
	pending, err := q.store.hasPending(ctx, q.activeIDs())
	var slot *executionSlot
	if err == nil {
		if pending {
			err = status.Error(codes.ResourceExhausted, "Submissions are waiting. Try Run again shortly.")
		} else {
			slot, err = q.executor.reserve()
		}
	}
	q.admission.Unlock()
	if err != nil {
		return nil, err
	}
	defer q.notify()
	return slot.execute(ctx, input)
}

func (q *jobQueue) serve() {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	defer q.workers.Wait()
	for {
		for q.ctx.Err() == nil && q.executor.ready() {
			if !q.dispatch() {
				break
			}
		}
		select {
		case <-q.ctx.Done():
			return
		case <-ticker.C:
		case <-q.wake:
		}
	}
}

func (q *jobQueue) dispatch() bool {
	q.admission.Lock()
	defer q.admission.Unlock()
	slot, err := q.executor.reserve()
	if err != nil {
		return false
	}
	token := newJobID()
	ctx, cancel := context.WithTimeout(q.ctx, 5*time.Second)
	job, err := q.store.claim(ctx, token, "cp-job-"+token, q.activeIDs())
	cancel()
	if err != nil || job == nil {
		slot.release()
		return false
	}
	ctx, cancel = context.WithCancel(q.ctx)
	q.mu.Lock()
	q.active[job.id] = cancel
	q.mu.Unlock()
	q.workers.Add(1)
	go func() {
		defer q.workers.Done()
		defer cancel()
		defer func() {
			q.mu.Lock()
			delete(q.active, job.id)
			q.mu.Unlock()
			q.notify()
		}()
		q.work(ctx, cancel, slot, job)
	}()
	return true
}

func (q *jobQueue) work(ctx context.Context, cancel context.CancelFunc, slot *executionSlot, job *claimedJob) {
	renew := func() error {
		probe, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		canceled, err := q.store.renew(probe, job.id, job.ownerToken)
		if err != nil || canceled {
			cancel()
		}
		return err
	}
	// Check ownership before any Docker side effect, including after a restart.
	if err := renew(); err != nil {
		slot.release()
		return // Expiration recovery will inspect the recorded attempt.
	}
	heartbeatStopped := make(chan struct{})
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-heartbeatStopped:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				if renew() != nil {
					return
				}
			}
		}
	}()

	var result *judgev1.RunResult
	var executionErr error
	if job.recovery {
		if q.executor.recoverCleanup(job.containerName) {
			slot.release()
		} else {
			slot.hold()
		}
	} else {
		input, err := prepareStoredExecution(ctx, q.store.pool, job.problemID, job.problemVersion, job.specVersion, job.code, job.runtime)
		if err != nil {
			slot.release()
			executionErr = err
		} else {
			input.imageID, input.name = job.imageID, job.containerName
			result, executionErr = slot.execute(ctx, input)
		}
	}
	close(heartbeatStopped)
	<-heartbeatDone
	if !slot.cleaned {
		// Keep the persisted attempt and its container name for explicit recovery.
		log.Print("Job remains unfinished because Docker cleanup could not be confirmed.")
		return
	}

	// Finishing is independent of the RPC and cancellation context. SQL fencing
	// rejects stale owners and gives persisted cancellation precedence over results.
	finishCtx, finishCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer finishCancel()
	var err error
	if job.recovery {
		_, err = q.store.finishRecovery(finishCtx, job.id, job.ownerToken)
	} else {
		failure, retry := "", false
		if executionErr != nil {
			retry = retryableExecution(executionErr)
			failure = "The execution runtime was interrupted."
			if !retry {
				failure = "The grading specification or result was invalid."
			}
		}
		_, err = q.store.finish(finishCtx, job.id, job.ownerToken, result, failure, retry)
	}
	if err != nil && !errors.Is(err, errJobOwnership) {
		log.Print("Job completion could not be saved; its lease will make it eligible for recovery.")
	}
}

func (q *jobQueue) cancelActive(id string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if cancel := q.active[id]; cancel != nil {
		cancel()
	}
	q.notify()
}

func (q *jobQueue) activeIDs() []string {
	q.mu.Lock()
	defer q.mu.Unlock()
	ids := make([]string, 0, len(q.active))
	for id := range q.active {
		ids = append(ids, id)
	}
	return ids
}

func retryableExecution(err error) bool {
	switch status.Code(err) {
	case codes.Unavailable, codes.Canceled, codes.DeadlineExceeded:
		return true
	default:
		return false
	}
}

func newJobID() string {
	var id [16]byte
	_, _ = rand.Read(id[:])
	id[6], id[8] = id[6]&0x0f|0x40, id[8]&0x3f|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
}
