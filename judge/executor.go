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

	"connectrpc.com/connect"
	judgev1 "github.com/K23K-dev/corecode/judge/gen"
	"github.com/containerd/errdefs"
	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"
)

const maxExecutionOutput = 512000

var errOutputLimit = errors.New("Execution output exceeded 512 KB.")

// Every grading container carries this label, so the next judge start can remove leftovers.
const judgeLabel = "code-practice.judge"

// One executor owns two execution slots shared by temporary runs and queued submissions.
type executor struct {
	ctx      context.Context
	docker   *client.Client
	images   map[string]string // runtime → grader image
	mu       sync.Mutex
	ready    bool
	draining bool
	active   int
	work     sync.WaitGroup
}

func newExecutor(ctx context.Context, docker *client.Client, cfg config) *executor {
	return &executor{ctx: ctx, docker: docker, images: map[string]string{
		"python": cfg.pythonImage, "sql": cfg.pythonImage, "javascript": cfg.javascriptImage,
	}}
}

// prepare waits for Docker and both grader images, then removes leftover containers.
// It returns false if the judge stops first.
func (e *executor) prepare(ctx context.Context) bool {
	for waiting := false; ; waiting = true {
		if err := e.removeLeftovers(ctx); err == nil {
			e.mu.Lock()
			e.ready = true
			e.mu.Unlock()
			return true
		} else if !waiting {
			log.Print("Waiting for Docker and the grader images.")
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(2 * time.Second):
		}
	}
}

func (e *executor) removeLeftovers(ctx context.Context) error {
	for _, image := range e.images {
		if inspected, err := e.docker.ImageInspect(ctx, image); err != nil || inspected.Os != "linux" {
			return errors.New("a grader image is unavailable")
		}
	}
	listed, err := e.docker.ContainerList(ctx, client.ContainerListOptions{
		All: true, Filters: make(client.Filters).Add("label", judgeLabel+"=1"),
	})
	if err != nil {
		return err
	}
	for _, item := range listed.Items {
		_, err := e.docker.ContainerRemove(ctx, item.ID, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true})
		if err != nil && !errdefs.IsNotFound(err) {
			return err
		}
	}
	return nil
}

func (e *executor) available() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.ready && !e.draining && e.ctx.Err() == nil
}

func (e *executor) beginDrain() {
	e.mu.Lock()
	e.draining = true
	e.mu.Unlock()
}

func (e *executor) imageFor(runtime string) (string, error) {
	if image := e.images[runtime]; image != "" && e.available() {
		return image, nil
	}
	return "", rpcError(connect.CodeUnavailable, "The execution runtime is unavailable.")
}

// acquire takes one of the two execution slots; every successful acquire needs one release.
func (e *executor) acquire() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	switch {
	case !e.ready || e.draining || e.ctx.Err() != nil:
		return rpcError(connect.CodeUnavailable, "The execution runtime is unavailable.")
	case e.active >= 2:
		return rpcError(connect.CodeResourceExhausted, "Both execution slots are busy. Try again shortly.")
	}
	e.active++
	e.work.Add(1)
	return nil
}

func (e *executor) release() {
	e.mu.Lock()
	e.active--
	e.mu.Unlock()
	e.work.Done()
}

// run grades one payload in a fresh, locked-down container and always removes it.
func (e *executor) run(ctx context.Context, input executionInput) (*judgev1.RunResult, error) {
	started := time.Now()
	runCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	stop := context.AfterFunc(e.ctx, cancel)
	defer func() { stop(); cancel() }()
	failure := func(cause error) (*judgev1.RunResult, error) {
		if ctx.Err() != nil {
			return nil, contextError(ctx.Err())
		}
		if e.ctx.Err() != nil {
			return nil, rpcError(connect.CodeUnavailable, "The judge is shutting down.")
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
		return nil, rpcError(connect.CodeUnavailable, "The execution container failed. Try again shortly.")
	}

	image := e.images[input.runtime]
	inspected, err := e.docker.ImageInspect(runCtx, image)
	if err != nil || inspected.Config == nil || len(inspected.Config.Entrypoint) == 0 {
		return failure(err)
	}
	name := input.name
	if name == "" {
		name = "cp-job-" + rand.Text()
	}
	// Removing by name also covers a create that finished in Docker after timing out here.
	defer e.remove(name)
	// Finish Docker's setup handshake even if Stop arrives, so no half-made container remains.
	setupCtx, finishSetup := context.WithTimeout(context.WithoutCancel(runCtx), 10*time.Second)
	defer finishSetup()
	created, err := e.docker.ContainerCreate(setupCtx, executionContainer(image, name, inspected.Config.Entrypoint))
	if err != nil {
		return failure(err)
	}
	attachment, err := e.docker.ContainerAttach(setupCtx, created.ID, client.ContainerAttachOptions{
		Stream: true, Stdin: true, Stdout: true, Stderr: true,
	})
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
	if _, err = e.docker.ContainerStart(runCtx, created.ID, client.ContainerStartOptions{}); err != nil {
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
	// Always receive the SDK's unbuffered wait result, even after a cancel, or its goroutine leaks.
	wait := e.docker.ContainerWait(runCtx, created.ID, client.ContainerWaitOptions{Condition: container.WaitConditionNotRunning})
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
		inspected, inspectErr := e.docker.ContainerInspect(runCtx, created.ID, client.ContainerInspectOptions{})
		if inspectErr == nil && inspected.Container.State != nil && inspected.Container.State.OOMKilled {
			message := "Execution exceeded its memory limit."
			return &judgev1.RunResult{Error: &message, DurationMs: float64(time.Since(started).Milliseconds())}, nil
		}
		return failure(nil)
	}
	return parseExecutionResult(output.stdout.Bytes(), input.caseCount)
}

func (e *executor) remove(name string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := e.docker.ContainerRemove(ctx, name, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true})
	if err != nil && !errdefs.IsNotFound(err) {
		log.Print("A grading container could not be removed; the next judge start removes it.")
	}
}

// No network, read-only root, no capabilities, 1 GiB memory, 2 CPUs, 256 processes,
// and a hard kill at 25 s even if the judge itself stops watching.
func executionContainer(image, name string, command []string) client.ContainerCreateOptions {
	processLimit := int64(256)
	return client.ContainerCreateOptions{
		Name: name,
		Config: &container.Config{
			Image: image, User: "65534:65534", WorkingDir: "/work",
			OpenStdin: true, StdinOnce: true, AttachStdin: true, AttachStdout: true, AttachStderr: true,
			NetworkDisabled: true, Env: []string{"HOME=/work", "TMPDIR=/tmp"},
			Entrypoint: append([]string{"/usr/bin/timeout", "--signal=KILL", "25s"}, command...),
			Labels:     map[string]string{judgeLabel: "1"},
		},
		HostConfig: &container.HostConfig{
			NetworkMode: "none", ReadonlyRootfs: true, CapDrop: []string{"ALL"},
			SecurityOpt: []string{"no-new-privileges"}, LogConfig: container.LogConfig{Type: "none"},
			Resources: container.Resources{Memory: 1 << 30, MemorySwap: 1 << 30, NanoCPUs: 2e9, PidsLimit: &processLimit},
			Tmpfs: map[string]string{
				"/work": "rw,nosuid,size=256m,mode=1777",
				"/tmp":  "rw,nosuid,size=128m,mode=1777",
			},
		},
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
