package main

import (
	"context"
	"net/http"
	"sync"
	"time"

	"connectrpc.com/connect"
	"github.com/K23K-dev/corecode/judge/gen/judgev1connect"
)

// Sandbox sessions stop after a quiet period, with a hard deadline that leaves
// time for the normal shutdown path to clean Docker before the VM expires.
type judgeLifecycle struct {
	queue       *jobQueue
	idleTimeout time.Duration
	deadline    time.Time
	done        chan struct{}
	mu          sync.Mutex
	calls       int
	draining    bool
	lastWork    time.Time
}

func newJudgeLifecycle(queue *jobQueue, idleTimeout, maxLifetime time.Duration) *judgeLifecycle {
	return &judgeLifecycle{
		queue: queue, idleTimeout: idleTimeout,
		deadline: time.Now().Add(maxLifetime), done: make(chan struct{}), lastWork: time.Now(),
	}
}

// track refuses calls once draining starts and records Run and Submit as work.
func (l *judgeLifecycle) track(next http.Handler) http.Handler {
	errorWriter := connect.NewErrorWriter()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		work := r.URL.Path == judgev1connect.JudgeServiceRunProcedure || r.URL.Path == judgev1connect.JudgeServiceSubmitProcedure
		if !l.enter(work) {
			_ = errorWriter.Write(w, r, rpcError(connect.CodeUnavailable, "The judge session is stopping. Try again shortly."))
			return
		}
		defer l.leave(work)
		next.ServeHTTP(w, r)
	})
}

func (l *judgeLifecycle) enter(work bool) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.draining {
		return false
	}
	l.calls++
	if work {
		l.lastWork = time.Now()
	}
	return true
}

func (l *judgeLifecycle) leave(work bool) {
	l.mu.Lock()
	l.calls--
	if work {
		l.lastWork = time.Now()
	}
	l.mu.Unlock()
}

func (l *judgeLifecycle) touch() {
	l.mu.Lock()
	l.lastWork = time.Now()
	l.mu.Unlock()
}

func (l *judgeLifecycle) run(ctx context.Context) {
	deadline := time.NewTimer(time.Until(l.deadline))
	defer deadline.Stop()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-deadline.C:
			l.queue.admission.Lock()
			l.drain()
			l.queue.admission.Unlock()
			return
		case <-ticker.C:
			if l.stopIfIdle(ctx) {
				return
			}
		}
	}
}

func (l *judgeLifecycle) stopIfIdle(ctx context.Context) bool {
	q := l.queue
	q.admission.Lock()
	defer q.admission.Unlock()
	ready := q.executor.available()
	q.executor.mu.Lock()
	active := q.executor.active
	q.executor.mu.Unlock()
	// Do not mistake startup or running work for an idle judge. The absolute
	// deadline still bounds a session that never becomes ready.
	if !ready || active != 0 {
		l.touch()
		return false
	}
	probe, cancel := context.WithTimeout(ctx, 2*time.Second)
	pending, err := q.store.hasPending(probe, []string{})
	cancel()
	if err != nil || pending {
		l.touch()
		return false
	}
	l.mu.Lock()
	idle := l.calls == 0 && time.Since(l.lastWork) >= l.idleTimeout
	if idle {
		// Admission is still locked, so no Run reservation or Submit acceptance
		// can appear between checking the queue and stopping new RPCs.
		l.draining = true
		q.executor.beginDrain()
		close(l.done)
	}
	l.mu.Unlock()
	return idle
}

// The caller holds queue.admission; keep this lock order in the idle path too.
func (l *judgeLifecycle) drain() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.draining {
		l.draining = true
		l.queue.executor.beginDrain()
		close(l.done)
	}
}
