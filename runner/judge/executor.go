package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"log"
	"regexp"
	"sync"
	"time"

	judgev1 "github.com/K23K-dev/corecode/runner/judge/gen"
	"github.com/containerd/errdefs"
	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const maxExecutionOutput = 512000

var errOutputLimit = errors.New("Execution output exceeded 512 KB.")

var imageIDPattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var executionNamePattern = regexp.MustCompile(`^cp-job-[A-Za-z0-9-]{16,64}$`)

// One executor owns capacity for both temporary runs and queued submissions.
type executor struct {
	ctx     context.Context
	docker  *client.Client
	mu      sync.Mutex
	images  map[string]string
	active  int
	blocked bool
	work    sync.WaitGroup
}

type executionSlot struct {
	executor *executor
	mu       sync.Mutex
	consumed bool
	cleaned  bool // Read after execute, release, or hold returns.
}

func newExecutor(ctx context.Context, docker *client.Client) *executor {
	return &executor{ctx: ctx, docker: docker, images: make(map[string]string)}
}

func (e *executor) refreshImages(ctx context.Context, cfg config) bool {
	e.mu.Lock()
	python, javascript := e.images["python"], e.images["javascript"]
	e.mu.Unlock()
	if python == "" {
		python, javascript = cfg.pythonImage, cfg.javascriptImage
	}
	p, err := e.docker.ImageInspect(ctx, python)
	if err != nil || p.ID == "" || p.Os != "linux" {
		return false
	}
	j, err := e.docker.ImageInspect(ctx, javascript)
	if err != nil || j.ID == "" || j.Os != "linux" {
		return false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	// Once resolved, retagging an image cannot change this process's runtime.
	if e.images["python"] == "" {
		e.images = map[string]string{"python": p.ID, "sql": p.ID, "shell": p.ID, "javascript": j.ID}
	}
	return true
}

func (e *executor) ready() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return !e.blocked && e.ctx.Err() == nil && len(e.images) != 0
}

func (e *executor) shutdown() {
	e.mu.Lock()
	e.blocked = true
	e.mu.Unlock()
	e.work.Wait()
}

func (e *executor) imageFor(runtime string) (string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	image := e.images[runtime]
	if e.blocked || e.ctx.Err() != nil || image == "" {
		return "", status.Error(codes.Unavailable, "The execution runtime is unavailable.")
	}
	return image, nil
}

func (e *executor) reserve() (*executionSlot, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	switch {
	case e.blocked || e.ctx.Err() != nil || len(e.images) == 0:
		return nil, status.Error(codes.Unavailable, "The execution runtime is unavailable.")
	case e.active >= 2:
		return nil, status.Error(codes.ResourceExhausted, "Both execution slots are busy. Try again shortly.")
	default:
		e.active++
		e.work.Add(1)
	}
	return &executionSlot{executor: e}, nil
}

// Release an unused reservation (for example, when a queue claim finds no job).
func (s *executionSlot) release() {
	s.finishUnused(true)
}

// Retain capacity when recovery could not confirm the old container is gone.
func (s *executionSlot) hold() {
	s.finishUnused(false)
}

func (s *executionSlot) finishUnused(cleaned bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.consumed {
		s.consumed = true
		s.cleaned = cleaned
		s.executor.mu.Lock()
		if cleaned {
			s.executor.active--
		} else {
			s.executor.blocked = true
		}
		s.executor.mu.Unlock()
		s.executor.work.Done()
	}
}

func (e *executor) execute(ctx context.Context, input executionInput) (*judgev1.RunResult, error) {
	slot, err := e.reserve()
	if err != nil {
		return nil, err
	}
	return slot.execute(ctx, input)
}

func (s *executionSlot) execute(ctx context.Context, input executionInput) (result *judgev1.RunResult, err error) {
	s.mu.Lock()
	if s.consumed {
		s.mu.Unlock()
		return nil, status.Error(codes.Internal, "The execution slot was already used.")
	}
	s.consumed = true
	s.mu.Unlock()
	e := s.executor

	started := time.Now()
	runCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	stop := context.AfterFunc(e.ctx, cancel)
	defer func() { stop(); cancel() }()
	name := input.name
	if name == "" {
		name = "cp-job-" + rand.Text()
	}
	containerID := name
	creationAttempted, creationUncertain := false, false
	defer func() {
		removed := !creationAttempted || e.removeContainer(containerID, name)
		e.mu.Lock()
		s.cleaned = removed && !creationUncertain
		if s.cleaned {
			e.active--
		} else {
			// A timed-out create can still finish inside Docker after our request ends.
			e.blocked = true
			result, err = nil, status.Error(codes.Unavailable, "Docker cleanup could not be confirmed. Restart the judge after checking Docker.")
			log.Print("Execution disabled: container creation or cleanup could not be confirmed.")
		}
		e.mu.Unlock()
		e.work.Done()
	}()

	failure := func(cause error) (*judgev1.RunResult, error) {
		if ctx.Err() != nil {
			return nil, status.FromContextError(ctx.Err()).Err()
		}
		if e.ctx.Err() != nil {
			return nil, status.Error(codes.Unavailable, "The judge is shutting down.")
		}
		message := ""
		if errors.Is(cause, errOutputLimit) {
			message = errOutputLimit.Error()
		} else if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			message = "Execution timed out after 20 seconds."
		}
		if message != "" {
			return &judgev1.RunResult{Error: &message, DurationMs: float64(time.Since(started).Milliseconds())}, nil
		}
		return nil, status.Error(codes.Unavailable, "The execution container failed. Try again shortly.")
	}
	if runCtx.Err() != nil {
		return failure(runCtx.Err())
	}
	if !e.ready() {
		return nil, status.Error(codes.Unavailable, "The execution runtime is unavailable.")
	}
	image := input.imageID
	if image == "" {
		image, err = e.imageFor(input.runtime)
		if err != nil {
			return nil, err
		}
	}
	if !imageIDPattern.MatchString(image) || !executionNamePattern.MatchString(name) {
		return nil, status.Error(codes.FailedPrecondition, "The saved execution configuration is invalid.")
	}
	// Queued work may use an older accepted image after this process's configured
	// tag changes. Inspect and execute that immutable ID, without pulling images.
	inspected, inspectErr := e.docker.ImageInspect(runCtx, image)
	if inspectErr != nil || inspected.ID != image || inspected.Os != "linux" {
		return failure(inspectErr)
	}
	if runCtx.Err() != nil {
		return failure(runCtx.Err())
	}
	// Finish Docker's setup handshake even if Stop arrives. Abandoning create
	// can leave a late container behind; interrupted attach can lose its socket.
	setupCtx, finishSetup := context.WithTimeout(context.WithoutCancel(runCtx), 10*time.Second)
	defer finishSetup()
	creationAttempted = true
	created, err := e.docker.ContainerCreate(setupCtx, executionContainer(input.runtime, image, name))
	if err != nil {
		creationUncertain = true
		return failure(err)
	}
	containerID = created.ID
	if runCtx.Err() != nil {
		return failure(runCtx.Err())
	}
	attachment, err := e.attach(setupCtx, containerID)
	if err != nil {
		return failure(err)
	}
	defer attachment.Close()
	finishSetup()
	if runCtx.Err() != nil {
		return failure(runCtx.Err())
	}
	closeOnCancel := context.AfterFunc(runCtx, attachment.Close)
	defer closeOnCancel()

	output := &executionOutput{}
	drained := make(chan error, 1)
	go func() {
		_, copyErr := stdcopy.StdCopy(output, outputCounter{output}, attachment.Reader)
		drained <- copyErr
	}()
	if _, err = e.docker.ContainerStart(runCtx, containerID, client.ContainerStartOptions{}); err != nil {
		return failure(err)
	}
	sent := make(chan error, 1)
	go func() {
		_, sendErr := io.Copy(attachment.Conn, bytes.NewReader(input.payload))
		if sendErr == nil {
			sendErr = attachment.CloseWrite()
		}
		sent <- sendErr
	}()
	// The SDK's result channel is unbuffered. Always receive it, even if the RPC
	// is canceled first, so its wait goroutine cannot remain blocked on delivery.
	wait := e.docker.ContainerWait(runCtx, containerID, client.ContainerWaitOptions{Condition: container.WaitConditionNotRunning})
	type exit struct {
		response container.WaitResponse
		err      error
	}
	exited := make(chan exit, 1)
	go func() {
		select {
		case response := <-wait.Result:
			exited <- exit{response: response}
		case waitErr := <-wait.Error:
			exited <- exit{err: waitErr}
		}
	}()
	var state container.WaitResponse
	for remaining := 3; remaining > 0; remaining-- {
		select {
		case <-runCtx.Done():
			return failure(runCtx.Err())
		case sendErr := <-sent:
			sent = nil
			if sendErr != nil {
				return failure(sendErr)
			}
		case copyErr := <-drained:
			drained = nil
			if copyErr != nil {
				return failure(copyErr)
			}
		case stopped := <-exited:
			exited = nil
			if stopped.err != nil || stopped.response.Error != nil {
				return failure(stopped.err)
			}
			state = stopped.response
		}
	}
	if runCtx.Err() != nil {
		return failure(runCtx.Err())
	}
	if state.StatusCode != 0 {
		inspected, inspectErr := e.docker.ContainerInspect(runCtx, containerID, client.ContainerInspectOptions{})
		if inspectErr == nil && inspected.Container.State != nil && inspected.Container.State.OOMKilled {
			message := "Execution exceeded its memory limit."
			return &judgev1.RunResult{Error: &message, DurationMs: float64(time.Since(started).Milliseconds())}, nil
		}
		return failure(nil)
	}
	return parseExecutionResult(output.stdout.Bytes(), input.caseCount)
}

func (e *executor) attach(ctx context.Context, id string) (client.ContainerAttachResult, error) {
	type response struct {
		attachment client.ContainerAttachResult
		err        error
	}
	attached := make(chan response)
	go func() {
		a, err := e.docker.ContainerAttach(ctx, id, client.ContainerAttachOptions{
			Stream: true, Stdin: true, Stdout: true, Stderr: true,
		})
		select {
		case attached <- response{a, err}:
		case <-ctx.Done():
			if err == nil {
				a.Close()
			}
		}
	}()
	select {
	case result := <-attached:
		return result.attachment, result.err
	case <-ctx.Done():
		// The SDK's HTTP upgrade can ignore cancellation after dialing. Stop
		// admission so an unresponsive daemon cannot accumulate stuck attaches.
		e.mu.Lock()
		e.blocked = true
		e.mu.Unlock()
		log.Print("Execution disabled: Docker attachment was interrupted. Restart the judge.")
		return client.ContainerAttachResult{}, ctx.Err()
	}
}

func executionContainer(runtime, image, name string) client.ContainerCreateOptions {
	command := []string{"python", "/opt/runner/entrypoint.py"}
	if runtime == "javascript" {
		command = []string{"node", "/opt/runner/entrypoint.mjs"}
	}
	processLimit := int64(256)
	return client.ContainerCreateOptions{
		Name: name,
		Config: &container.Config{
			Image: image, User: "65534:65534", WorkingDir: "/work",
			OpenStdin: true, StdinOnce: true, AttachStdin: true, AttachStdout: true, AttachStderr: true,
			NetworkDisabled: true, Env: []string{"HOME=/work", "TMPDIR=/tmp"},
			Entrypoint: append([]string{"/usr/bin/timeout", "--signal=KILL", "25s"}, command...),
			Labels:     map[string]string{"code-practice.runner": "1", "code-practice.judge": "1", "code-practice.execution": name},
		},
		HostConfig: &container.HostConfig{
			NetworkMode: "none", ReadonlyRootfs: true, CapDrop: []string{"ALL"},
			SecurityOpt: []string{"no-new-privileges"}, LogConfig: container.LogConfig{Type: "none"},
			Resources: container.Resources{Memory: 1 << 30, MemorySwap: 1 << 30, NanoCPUs: 2e9, PidsLimit: &processLimit},
			Tmpfs: map[string]string{
				"/work": "rw,nosuid,size=256m,mode=1777",
				"/tmp":  "rw,nosuid,size=128m,mode=1777",
				"/srv":  "rw,noexec,nosuid,size=4m,mode=1777",
			},
		},
	}
}

func (e *executor) removeContainer(id, name string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for {
		inspected, err := e.docker.ContainerInspect(ctx, id, client.ContainerInspectOptions{})
		if errdefs.IsNotFound(err) {
			return true
		}
		if err == nil {
			c := inspected.Container
			if c.Config == nil || c.Config.Labels["code-practice.execution"] != name || c.Config.Labels["code-practice.judge"] != "1" {
				return false
			}
			// Remove the inspected ID, never a broad label selection or a reused name.
			_, _ = e.docker.ContainerRemove(ctx, c.ID, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true})
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (e *executor) recoverCleanup(name string) bool {
	removed := executionNamePattern.MatchString(name) && e.removeContainer(name, name)
	if !removed {
		e.mu.Lock()
		e.blocked = true
		e.mu.Unlock()
	}
	return removed
}

// StdCopy calls both writers sequentially. Count stderr but retain only stdout,
// since Docker diagnostics must not become part of the public grader result.
type executionOutput struct {
	stdout bytes.Buffer
	bytes  int
}

func (o *executionOutput) count(p []byte) (int, error) {
	if len(p) > maxExecutionOutput-o.bytes {
		return 0, errOutputLimit
	}
	o.bytes += len(p)
	return len(p), nil
}

func (o *executionOutput) Write(p []byte) (int, error) {
	if _, err := o.count(p); err != nil {
		return 0, err
	}
	return o.stdout.Write(p)
}

type outputCounter struct{ output *executionOutput }

func (w outputCounter) Write(p []byte) (int, error) { return w.output.count(p) }
