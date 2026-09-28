package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"connectrpc.com/connect"
	judgev1 "github.com/K23K-dev/corecode/judge/gen"
)

// jobQueue claims queued jobs into free execution slots and keeps each running job's cancel
// function, so Stop can reach it.
type jobQueue struct {
	ctx      context.Context
	store    *jobStore
	executor *executor
	mu       sync.Mutex
	active   map[string]context.CancelFunc
	wake     chan struct{}
	workers  sync.WaitGroup
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

func (q *jobQueue) beginDrain() {
	q.executor.beginDrain()
}

func (q *jobQueue) wait() {
	q.workers.Wait()
	q.executor.work.Wait()
}

// run grades the first case right away in a free slot. Nothing is saved.
func (q *jobQueue) run(ctx context.Context, request *judgev1.RunRequest) (*judgev1.RunResult, error) {
	input, err := prepareExecution(ctx, q.store.pool, request, "example")
	if err != nil {
		return nil, err
	}
	if err := q.executor.acquire(); err != nil {
		return nil, err
	}
	defer q.notify()
	defer q.executor.release()
	return q.executor.run(ctx, input)
}

func (q *jobQueue) serve() {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	defer q.workers.Wait()
	for {
		for q.ctx.Err() == nil && q.executor.available() {
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

// dispatch claims one job into a free slot and grades it in the background.
func (q *jobQueue) dispatch() bool {
	if q.executor.acquire() != nil {
		return false
	}
	token := newJobID()
	ctx, cancel := context.WithTimeout(q.ctx, 5*time.Second)
	job, err := q.store.claim(ctx, token, "cp-job-"+token, q.activeIDs())
	cancel()
	if err != nil || job == nil {
		q.executor.release()
		return false
	}
	ctx, cancel = context.WithCancel(q.ctx)
	q.mu.Lock()
	q.active[job.id] = cancel
	q.mu.Unlock()
	q.workers.Add(1)
	go func() {
		defer q.workers.Done()
		defer q.notify()
		defer func() {
			q.mu.Lock()
			delete(q.active, job.id)
			q.mu.Unlock()
		}()
		defer cancel()
		defer q.executor.release()
		q.work(ctx, job)
	}()
	return true
}

// work grades one claimed job and saves the outcome. The 60-second lease outlasts any run
// (containers die at 25 s), so it only expires if this judge stops.
func (q *jobQueue) work(ctx context.Context, job *claimedJob) {
	var result *judgev1.RunResult
	failure, retry := "", false
	switch {
	case job.cancelRequested:
		// Stop arrived first; finishing without a result records the cancellation.
	case job.exhausted:
		failure = "Execution was interrupted twice. Submit again to retry."
	default:
		input, err := prepareStoredExecution(ctx, q.store.pool, job.problemID, job.problemVersion, job.specVersion, job.code, job.runtime)
		if err == nil {
			input.name = job.containerName
			result, err = q.executor.run(ctx, input)
		}
		if err != nil {
			retry = retryableExecution(err)
			failure = "The execution runtime was interrupted."
			if !retry {
				failure = "The grading specification or result was invalid."
			}
		}
	}
	// Save even after a cancel: the SQL rejects a stale owner, and a saved Stop beats the result.
	finishCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := q.store.finish(finishCtx, job.id, job.ownerToken, result, failure, retry); err != nil && !errors.Is(err, errJobOwnership) {
		log.Print("Could not save a job's result; it retries when its lease expires.")
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
	switch connect.CodeOf(err) {
	case connect.CodeUnavailable, connect.CodeCanceled, connect.CodeDeadlineExceeded:
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
