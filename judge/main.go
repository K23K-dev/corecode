package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"connectrpc.com/grpchealth"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/moby/moby/client"
)

// The Sandbox's HTTPS endpoint forwards to this port. Binding it also stops a
// second judge process on the same machine before it can touch Docker.
const judgeAddress = "0.0.0.0:8080"

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := serve(ctx); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

func serve(ctx context.Context) (result error) {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	token, err := judgeToken()
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", judgeAddress)
	if err != nil {
		return errors.New("Cannot listen on " + judgeAddress + "; check whether another judge is running.")
	}
	defer listener.Close()

	pool, err := pgxpool.NewWithConfig(ctx, cfg.database)
	if err != nil {
		return errors.New("Cannot configure the judge's Neon connection.")
	}
	docker, err := client.New(client.FromEnv, client.WithHost(cfg.dockerHost))
	if err != nil {
		pool.Close() // No connections have been acquired yet.
		return errors.New("Cannot configure Docker; check DOCKER_HOST and Docker TLS settings.")
	}
	defer docker.Close()
	workCtx, cancelWork := context.WithCancel(context.Background())
	defer cancelWork()
	executor := newExecutor(workCtx, docker, cfg)
	queue := newJobQueue(workCtx, &jobStore{pool: pool}, executor)

	// Health reports SERVING once Docker is ready and leftover containers are gone.
	health := grpchealth.NewStaticChecker()
	health.SetStatus("", grpchealth.StatusNotServing)
	var lifecycle *judgeLifecycle
	var lifecycleDone <-chan struct{}
	if !cfg.sandboxDeadline.IsZero() {
		lifecycle = newJudgeLifecycle(queue, 30*time.Second, time.Until(cfg.sandboxDeadline))
		lifecycleDone = lifecycle.done
		go lifecycle.run(workCtx)
	}
	// gRPC clients use HTTP/2 without TLS; the Sandbox proxy sends gRPC-Web over HTTP/1.1.
	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	protocols.SetUnencryptedHTTP2(true)
	server := &http.Server{
		Handler:           newHandler(token, &judgeServer{queue: queue}, health, lifecycle),
		Protocols:         protocols,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       75 * time.Second,
	}
	queueDone := make(chan struct{})
	go func() {
		defer close(queueDone)
		if executor.prepare(workCtx) {
			if executor.available() { // not already shutting down
				health.SetStatus("", grpchealth.StatusServing)
			}
			queue.serve()
		}
	}()

	// Shutdown stops admission, gives running work five seconds, then cancels it.
	// Interrupted jobs return to the queue for one more attempt.
	defer func() {
		shutdownCtx, stopShutdown := context.WithTimeout(context.Background(), 30*time.Second)
		defer stopShutdown()
		health.SetStatus("", grpchealth.StatusNotServing)
		drained := make(chan struct{})
		go func() {
			queue.beginDrain()
			queue.wait()
			close(drained)
		}()
		select {
		case <-drained:
		case <-time.After(5 * time.Second):
		}
		cancelWork()
		closed := make(chan struct{})
		go func() {
			<-drained
			<-queueDone
			// Flush final RPC replies, then close health watches that can remain open forever.
			stopCtx, cancelStop := context.WithTimeout(context.Background(), time.Second)
			if server.Shutdown(stopCtx) != nil {
				server.Close()
			}
			cancelStop()
			pool.Close()
			close(closed)
		}()
		select {
		case <-closed:
		case <-shutdownCtx.Done():
			go server.Close()
			result = errors.New("Judge shutdown could not finish within 30 seconds; unfinished jobs retry after their leases expire.")
		}
	}()

	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()
	log.Printf("Judge listening on %s.", judgeAddress)
	select {
	case err := <-serveDone:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return errors.New("The judge listener stopped unexpectedly.")
		}
	case <-ctx.Done():
	case <-lifecycleDone:
	}
	return nil
}
