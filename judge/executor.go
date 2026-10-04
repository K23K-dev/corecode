package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"log"
	"time"

	"github.com/containerd/errdefs"
	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"
)

const maxExecutionOutput = 512000

// Every grading container carries this label, so the next judge start can remove leftovers.
const judgeLabel = "code-practice.judge"

// The grader image for each runtime; npm run judge:images builds them.
var graderImages = map[string]string{
	"python": "cp-practice-python:3", "sql": "cp-practice-python:3", "javascript": "coding-practice-js:4",
}

// limitError means the learner's code broke a limit. It becomes the result's error, not a failure.
type limitError string

func (e limitError) Error() string { return string(e) }

const (
	errTimedOut    = limitError("Execution timed out after 20 seconds.")
	errOutOfMemory = limitError("Execution exceeded its memory limit.")
	errOutputLimit = limitError("Execution output exceeded 512 KB.")
)

var errContainerFailed = errors.New("The execution container failed. Try again shortly.")

// executor runs each grader in a fresh Docker container and always removes it.
type executor struct{ docker *client.Client }

func (e *executor) supports(runtime string) bool { return graderImages[runtime] != "" }

// prepare waits for Docker and both grader images, then removes containers an earlier judge left.
// It returns false if the judge stops first.
func (e *executor) prepare(ctx context.Context) bool {
	for waiting := false; ; waiting = true {
		if e.removeLeftovers(ctx) == nil {
			return true
		}
		if !waiting {
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
	for _, image := range graderImages {
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

// run gives one payload to a grader with a 20-second limit and returns the grader's stdout.
// Errors are ctx's own (Stop, a canceled Run, or shutdown), a limitError, or errContainerFailed.
func (e *executor) run(ctx context.Context, runtime, name string, payload []byte) ([]byte, error) {
	runCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	failed := func(cause error) ([]byte, error) {
		switch {
		case ctx.Err() != nil:
			return nil, ctx.Err()
		case errors.Is(cause, errOutputLimit):
			return nil, errOutputLimit
		case runCtx.Err() != nil:
			return nil, errTimedOut
		}
		return nil, errContainerFailed
	}

	image := graderImages[runtime]
	inspected, err := e.docker.ImageInspect(runCtx, image)
	if err != nil || inspected.Config == nil || len(inspected.Config.Entrypoint) == 0 {
		return failed(err)
	}
	if name == "" {
		name = "cp-job-" + rand.Text()
	}
	// Removing by name also covers a create that finished in Docker after timing out here.
	defer e.remove(name)
	// Attach before starting, so no output is missed. Setup finishes even if Stop arrives, so no
	// half-made container remains.
	setupCtx, finishSetup := context.WithTimeout(context.WithoutCancel(runCtx), 10*time.Second)
	defer finishSetup()
	created, err := e.docker.ContainerCreate(setupCtx, executionContainer(image, name, inspected.Config.Entrypoint))
	if err != nil {
		return failed(err)
	}
	stream, err := e.docker.ContainerAttach(setupCtx, created.ID, client.ContainerAttachOptions{
		Stream: true, Stdin: true, Stdout: true, Stderr: true,
	})
	if err != nil {
		return failed(err)
	}
	defer stream.Close()
	finishSetup()
	// A cancel or the time limit closes the stream, which ends both copies below.
	stopClosing := context.AfterFunc(runCtx, stream.Close)
	defer stopClosing()
	if _, err = e.docker.ContainerStart(runCtx, created.ID, client.ContainerStartOptions{}); err != nil {
		return failed(err)
	}

	sent := make(chan error, 1)
	go func() {
		_, err := io.Copy(stream.Conn, bytes.NewReader(payload))
		if err == nil {
			err = stream.CloseWrite()
		}
		sent <- err
	}()
	// Read until the grader exits.
	output := &executionOutput{}
	if _, err = stdcopy.StdCopy(output, outputCounter{output}, stream.Reader); err != nil {
		return failed(err)
	}
	if err = <-sent; err != nil {
		return failed(err)
	}
	// Always receive the SDK's unbuffered wait result, or its goroutine leaks.
	wait := e.docker.ContainerWait(runCtx, created.ID, client.ContainerWaitOptions{Condition: container.WaitConditionNotRunning})
	var exit container.WaitResponse
	select {
	case exit = <-wait.Result:
	case err = <-wait.Error:
		return failed(err)
	}
	switch {
	case runCtx.Err() != nil || exit.Error != nil:
		return failed(runCtx.Err())
	case exit.StatusCode != 0 && e.oomKilled(runCtx, created.ID):
		return nil, errOutOfMemory
	case exit.StatusCode != 0:
		return failed(nil)
	}
	return output.stdout.Bytes(), nil
}

func (e *executor) oomKilled(ctx context.Context, id string) bool {
	inspected, err := e.docker.ContainerInspect(ctx, id, client.ContainerInspectOptions{})
	return err == nil && inspected.Container.State != nil && inspected.Container.State.OOMKilled
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
