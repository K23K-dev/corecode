package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"log"
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

// One executor owns capacity for both temporary runs and future queued submissions.
type executor struct {
	ctx     context.Context
	docker  *client.Client
	mu      sync.Mutex
	images  map[string]string
	active  int
	blocked bool
	work    sync.WaitGroup
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

func (e *executor) execute(ctx context.Context, input executionInput) (result *judgev1.RunResult, err error) {
	e.mu.Lock()
	image := e.images[input.runtime]
	switch {
	case e.blocked || e.ctx.Err() != nil || image == "":
		err = status.Error(codes.Unavailable, "The execution runtime is unavailable.")
	case e.active == 2:
		err = status.Error(codes.ResourceExhausted, "Both execution slots are busy. Try again shortly.")
	default:
		e.active++
		e.work.Add(1)
	}
	e.mu.Unlock()
	if err != nil {
		return nil, err
	}

	started := time.Now()
	runCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	stop := context.AfterFunc(e.ctx, cancel)
	defer func() { stop(); cancel() }()
	name := "cp-job-" + rand.Text()
	containerID := name
	creationAttempted, creationUncertain := false, false
	defer func() {
		removed := !creationAttempted || e.removeContainer(containerID, name)
		e.mu.Lock()
		if removed && !creationUncertain {
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
	creationAttempted = true
	created, err := e.docker.ContainerCreate(runCtx, executionContainer(input.runtime, image, name))
	if err != nil {
		creationUncertain = true
		return failure(err)
	}
	containerID = created.ID
	attachment, err := e.attach(runCtx, containerID)
	if err != nil {
		return failure(err)
	}
	defer attachment.Close()
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
