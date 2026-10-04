package main

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"

	judgev1 "github.com/K23K-dev/corecode/judge/gen"
)

const (
	slotCount = 2
	// The claim query's lease. Runs end within 25 s, so a lease only runs out when its judge stopped.
	leaseDuration = 60 * time.Second
)

var (
	errSlotsBusy          = errors.New("Both execution slots are busy. Try again shortly.")
	errRuntimeUnavailable = errors.New("The execution runtime is unavailable.")
	errShuttingDown       = errors.New("The judge is shutting down.")
)

// jobQueue owns the two execution slots that Run and queued submissions share. It claims a job
// whenever a slot is free and keeps each running job's cancel function, so Stop can reach it.
type jobQueue struct {
	store      *jobStore
	executor   *executor
	ctx        context.Context // canceled at shutdown, which stops all running work
	cancelWork context.CancelFunc
	wake       chan struct{}
	stopped    chan struct{}  // closed when the claim loop ends
	running    sync.WaitGroup // one per occupied slot

	mu       sync.Mutex
	ready    bool // Docker and the grader images are available
	draining bool
	slots    int
	active   map[string]context.CancelFunc // jobs running here, by ID
}

func newJobQueue(store *jobStore, executor *executor) *jobQueue {
	ctx, cancel := context.WithCancel(context.Background())
	return &jobQueue{
		store: store, executor: executor, ctx: ctx, cancelWork: cancel,
		wake: make(chan struct{}, 1), stopped: make(chan struct{}), active: make(map[string]context.CancelFunc),
	}
}

// start claims jobs once Docker and the grader images are ready; before that, work is refused.
func (q *jobQueue) start() {
	defer close(q.stopped)
	if !q.executor.prepare(q.ctx) {
		return
	}
	q.mu.Lock()
	q.ready = true
	q.mu.Unlock()
	q.claimJobs()
}

// claimJobs fills free slots each time something wakes it: a submission, a slot freeing up, or
// a timer. Nothing polls in between, so Neon can scale to zero while the judge is idle.
func (q *jobQueue) claimJobs() {
	// Jobs that a stopped judge left running become claimable when their leases run out.
	time.AfterFunc(leaseDuration+time.Second, q.notify)
	// Catches jobs left by another judge machine.
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		for q.claimOne() {
		}
		select {
		case <-q.ctx.Done():
			return
		case <-ticker.C:
		case <-q.wake:
		}
	}
}

func (q *jobQueue) claimOne() bool {
	if q.acquire() != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(q.ctx, 5*time.Second)
	job, err := q.store.claim(ctx, q.activeIDs())
	cancel()
	if err != nil || job == nil {
		q.release()
		if err != nil && q.ctx.Err() == nil {
			time.AfterFunc(5*time.Second, q.notify) // Neon was unreachable; try again soon.
		}
		return false
	}
	ctx, cancel = context.WithCancel(q.ctx)
	q.mu.Lock()
	q.active[job.id] = cancel
	q.mu.Unlock()
	go func() {
		q.work(ctx, job)
		cancel()
		q.mu.Lock()
		delete(q.active, job.id)
		q.mu.Unlock()
		q.release()
		q.notify()
	}()
	return true
}

func (q *jobQueue) work(ctx context.Context, job *claimedJob) {
	var result *judgev1.RunResult
	failure, retry := "", false
	switch {
	case job.cancelRequested:
		// Stop arrived first; finishing without a result records the cancellation.
	case job.exhausted:
		failure = "Execution was interrupted twice. Submit again to retry."
	default:
		var err error
		if result, err = q.gradeJob(ctx, job); err != nil {
			// A broken spec or result fails for good; Docker, Neon, or a shutdown gets one more try.
			retry = !errors.Is(err, errInvalidSpec) && !errors.Is(err, errInvalidResult)
			failure = "The execution runtime was interrupted."
			if !retry {
				failure = "The grading specification or result was invalid."
			}
		}
	}
	// Save even after a cancel: the SQL rejects a stale owner, and a saved Stop beats the result.
	saveCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := q.store.finish(saveCtx, job, result, failure, retry); err != nil && !errors.Is(err, errJobOwnership) {
		log.Print("Could not save a job's result; it retries when its lease expires.")
		time.AfterFunc(leaseDuration, q.notify)
	}
}

func (q *jobQueue) gradeJob(ctx context.Context, job *claimedJob) (*judgev1.RunResult, error) {
	spec, err := q.store.storedSpec(ctx, job.problemID, job.problemVersion)
	if err != nil {
		return nil, err
	}
	input, err := newExecution(job.problemID, job.problemVersion, job.code, "submit", spec)
	if err != nil {
		return nil, err
	}
	input.container = job.containerName
	return grade(ctx, q.executor, input)
}

// run grades the first case right away in a free slot. Nothing is saved.
func (q *jobQueue) run(ctx context.Context, problemID, version, code string) (*judgev1.RunResult, error) {
	spec, err := q.store.currentSpec(ctx, problemID, version)
	if err != nil {
		return nil, err
	}
	input, err := newExecution(problemID, version, code, "example", spec)
	if err != nil {
		return nil, err
	}
	if err := q.acquire(); err != nil {
		return nil, err
	}
	defer q.notify()
	defer q.release()
	// Shutdown stops a Run too, and is reported as the reason.
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(q.ctx, cancel)
	defer stop()
	result, err := grade(runCtx, q.executor, input)
	if err != nil && ctx.Err() == nil && q.ctx.Err() != nil {
		return nil, errShuttingDown
	}
	return result, err
}

func (q *jobQueue) submit(ctx context.Context, request submission) (*storedJob, error) {
	job, err := q.store.accept(ctx, request, q.canAccept)
	if err == nil {
		q.notify()
	}
	return job, err
}

func (q *jobQueue) canAccept(runtime string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if !q.ready || q.draining || !q.executor.supports(runtime) {
		return errRuntimeUnavailable
	}
	return nil
}

func (q *jobQueue) cancel(ctx context.Context, id string) (*storedJob, error) {
	job, err := q.store.cancel(ctx, id)
	if err != nil {
		return nil, err
	}
	q.mu.Lock()
	if stop := q.active[id]; stop != nil {
		stop()
	}
	q.mu.Unlock()
	return job, nil
}

// acquire takes a free slot; every successful acquire needs one release.
func (q *jobQueue) acquire() error {
	q.mu.Lock()
	defer q.mu.Unlock()
	switch {
	case !q.ready || q.draining:
		return errRuntimeUnavailable
	case q.slots >= slotCount:
		return errSlotsBusy
	}
	q.slots++
	q.running.Add(1)
	return nil
}

func (q *jobQueue) release() {
	q.mu.Lock()
	q.slots--
	q.mu.Unlock()
	q.running.Done()
}

func (q *jobQueue) notify() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

// activeIDs is never nil: pgx would send NULL, and id <> ALL(NULL) matches nothing.
func (q *jobQueue) activeIDs() []string {
	q.mu.Lock()
	defer q.mu.Unlock()
	ids := make([]string, 0, len(q.active))
	for id := range q.active {
		ids = append(ids, id)
	}
	return ids
}

// drain stops taking new work, gives running work up to grace to finish, then cancels it and
// waits for every slot and the claim loop. Canceled jobs return to the queue for one more try.
func (q *jobQueue) drain(grace time.Duration) {
	q.mu.Lock()
	q.draining = true
	q.mu.Unlock()
	finished := make(chan struct{})
	go func() {
		q.running.Wait()
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(grace):
	}
	q.cancelWork()
	<-finished
	<-q.stopped
}
