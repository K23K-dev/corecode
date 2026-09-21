package main

import (
	"context"
	"errors"
	"flag"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	judgev1 "github.com/K23K-dev/corecode/runner/judge/gen"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/moby/moby/client"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/health"
	healthv1 "google.golang.org/grpc/health/grpc_health_v1"
)

const judgeAddress = "127.0.0.1:50051"

type judgeServer struct {
	judgev1.UnimplementedJudgeServiceServer
	queue *jobQueue
}

func (s *judgeServer) Run(ctx context.Context, request *judgev1.RunRequest) (*judgev1.RunResult, error) {
	return s.queue.run(ctx, request)
}

func main() {
	parentStdin := flag.Bool("parent-stdin", false, "Stop when the launching process closes stdin.")
	flag.Parse()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if *parentStdin {
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			cancel()
		}()
	}
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
	listener, err := net.Listen("tcp4", judgeAddress)
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
	executor := newExecutor(workCtx, docker)
	leader, err := acquireLeadership(ctx, cfg.leader, docker, func() {
		executor.beginDrain()
		cancelWork()
	})
	if err != nil {
		pool.Close()
		return err
	}
	defer leader.close()
	queue := newJobQueue(workCtx, &jobStore{pool: pool}, executor)
	queueDone := make(chan struct{})
	go func() { defer close(queueDone); queue.serve() }()

	healthCheck := health.NewServer()
	for _, name := range []string{"", judgev1.JudgeService_ServiceDesc.ServiceName, "run", "submissions", "queue", "dependencies", "neon", "docker", "images"} {
		healthCheck.SetServingStatus(name, healthv1.HealthCheckResponse_NOT_SERVING)
	}
	options := append(authentication(token), grpc.MaxRecvMsgSize(1<<20), grpc.MaxSendMsgSize(1<<20))
	var lifecycleDone <-chan struct{}
	if !cfg.sandboxDeadline.IsZero() {
		lifecycle := newJudgeLifecycle(queue, 30*time.Second, time.Until(cfg.sandboxDeadline))
		options = append(options, lifecycle.interceptors()...)
		lifecycleDone = lifecycle.done
		go lifecycle.run(workCtx)
	}
	server := grpc.NewServer(options...)
	judgev1.RegisterJudgeServiceServer(server, &judgeServer{queue: queue})
	healthv1.RegisterHealthServer(server, healthCheck)
	serveDone := make(chan error, 2)
	if !cfg.sandboxDeadline.IsZero() {
		connection, err := grpc.NewClient(judgeAddress, grpc.WithTransportCredentials(insecure.NewCredentials()))
		if err != nil {
			return errors.New("Cannot connect the Sandbox gateway to the local judge.")
		}
		defer connection.Close()
		web := newWebServer("0.0.0.0:8080", connection)
		defer web.Close()
		go func() { serveDone <- web.ListenAndServe() }()
	}

	monitorCtx, stopMonitor := context.WithCancel(workCtx)
	monitorDone := make(chan struct{})
	go func() {
		defer close(monitorDone)
		monitorDependencies(monitorCtx, cfg, pool, docker, executor, healthCheck)
	}()
	defer func() {
		shutdownCtx, stopShutdown := context.WithTimeout(context.Background(), 30*time.Second)
		defer stopShutdown()
		stopMonitor()
		healthCheck.Shutdown()
		drained := make(chan struct{})
		go func() {
			queue.beginDrain()
			queue.wait()
			close(drained)
		}()
		// Ownership loss cancels immediately; ordinary shutdown gives accepted work
		// a short completion window while the leader connection retains its lock.
		if workCtx.Err() == nil {
			select {
			case <-drained:
			case <-leader.lost:
			case <-time.After(5 * time.Second):
			}
		}
		cancelWork()
		closed := make(chan struct{})
		go func() {
			<-drained
			<-queueDone
			<-monitorDone
			// Keep the listener's ownership lock until container cleanup has finished.
			serverStopped := make(chan struct{})
			go func() { server.GracefulStop(); close(serverStopped) }()
			// Flush final RPC replies, then close watches that can remain open forever.
			select {
			case <-serverStopped:
			case <-time.After(time.Second):
				server.Stop()
				<-serverStopped
			}
			pool.Close()
			close(closed)
		}()
		select {
		case <-closed:
		case <-shutdownCtx.Done():
			go server.Stop()
			result = errors.New("Judge shutdown could not finish within 30 seconds; recorded jobs will recover on restart.")
		}
	}()

	go func() { serveDone <- server.Serve(listener) }()
	log.Printf("Judge listening on %s; check 'run' or 'submissions' health. Submissions save history and progress atomically.", judgeAddress)
	select {
	case err := <-serveDone:
		if err != nil && !errors.Is(err, grpc.ErrServerStopped) {
			return errors.New("The judge listener stopped unexpectedly.")
		}
	case <-ctx.Done():
	case <-lifecycleDone:
	case <-leader.lost:
		return errors.New("Judge database ownership was lost; execution stopped. Restart after checking Neon.")
	}
	return nil
}
