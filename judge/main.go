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

func serve(ctx context.Context) error {
	database, err := databaseConfig(os.Getenv("POSTGRES_URL"))
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

	pool, err := pgxpool.NewWithConfig(ctx, database)
	if err != nil {
		return errors.New("Cannot configure the judge's Neon connection.")
	}
	docker, err := client.New(client.FromEnv)
	if err != nil {
		pool.Close() // No connections have been acquired yet.
		return errors.New("Cannot configure Docker; check DOCKER_HOST and Docker TLS settings.")
	}
	defer docker.Close()
	store := &jobStore{pool: pool}
	queue := newJobQueue(store, &executor{docker: docker})
	go queue.start()

	// Caddy forwards gRPC as HTTP/2 without TLS (h2c); HTTP/1.1 still serves gRPC-Web and Connect.
	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	protocols.SetUnencryptedHTTP2(true)
	server := &http.Server{
		Handler:           newHandler(token, &rpcServer{queue: queue, store: store}),
		Protocols:         protocols,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       75 * time.Second,
	}
	served := make(chan error, 1)
	go func() { served <- server.Serve(listener) }()
	log.Printf("Judge listening on %s.", judgeAddress)

	var stopped error
	select {
	case err := <-served:
		if !errors.Is(err, http.ErrServerClosed) {
			stopped = errors.New("The judge listener stopped unexpectedly.")
		}
	case <-ctx.Done():
	}
	if err := shutdown(server, queue, pool); err != nil {
		return err
	}
	return stopped
}

// shutdown stops new work, gives running work five seconds, then cancels it; interrupted jobs
// return to the queue for one more attempt. It gives up after 30 seconds.
func shutdown(server *http.Server, queue *jobQueue, pool *pgxpool.Pool) error {
	done := make(chan struct{})
	go func() {
		queue.drain(5 * time.Second)
		// Give final RPC replies a second to flush, then close the server.
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if server.Shutdown(ctx) != nil {
			server.Close()
		}
		pool.Close()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-time.After(30 * time.Second):
		go server.Close()
		return errors.New("Shutdown took over 30 seconds; unfinished jobs retry when their leases expire.")
	}
}
