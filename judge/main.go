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

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/moby/moby/client"
)

// Caddy forwards here. Binding this port also stops a second judge on the machine before
// it can touch Docker.
const judgeAddress = "127.0.0.1:8080"

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
	docker, err := client.New(client.FromEnv)
	if err != nil {
		pool.Close() // No connections have been acquired yet.
		return errors.New("Cannot configure Docker; check DOCKER_HOST and Docker TLS settings.")
	}
	defer docker.Close()
	workCtx, cancelWork := context.WithCancel(context.Background())
	defer cancelWork()
	executor := newExecutor(workCtx, docker, cfg)
	queue := newJobQueue(workCtx, &jobStore{pool: pool}, executor)

	// Caddy forwards gRPC as HTTP/2 without TLS (h2c); HTTP/1.1 still serves gRPC-Web and Connect.
	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	protocols.SetUnencryptedHTTP2(true)
	server := &http.Server{
		Handler:           newHandler(token, &judgeServer{queue: queue}),
		Protocols:         protocols,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       75 * time.Second,
	}
	queueDone := make(chan struct{})
	// Until Docker is ready and leftover containers are gone, calls get Unavailable.
	go func() {
		defer close(queueDone)
		if executor.prepare(workCtx) {
			queue.serve()
		}
	}()

	// Shutdown stops new work, gives running work five seconds, then cancels it.
	// Interrupted jobs return to the queue for one more attempt.
	defer func() {
		shutdownCtx, stopShutdown := context.WithTimeout(context.Background(), 30*time.Second)
		defer stopShutdown()
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
			// Give final RPC replies a second to flush, then close the server.
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
			result = errors.New("Shutdown took over 30 seconds; unfinished jobs retry when their leases expire.")
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
	}
	return nil
}
