package main

import (
	"context"
	"errors"
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
	"google.golang.org/grpc/health"
	healthv1 "google.golang.org/grpc/health/grpc_health_v1"
)

const judgeAddress = "127.0.0.1:50051"

type judgeServer struct {
	judgev1.UnimplementedJudgeServiceServer
	pool     *pgxpool.Pool
	executor *executor
}

func (s *judgeServer) Run(ctx context.Context, request *judgev1.RunRequest) (*judgev1.RunResult, error) {
	input, err := prepareExecution(ctx, s.pool, request, "example")
	if err != nil {
		return nil, err
	}
	return s.executor.execute(ctx, input)
}

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := serve(ctx); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

func serve(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cfg, err := loadConfig()
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
	defer pool.Close()
	docker, err := client.New(client.FromEnv, client.WithHost(cfg.dockerHost))
	if err != nil {
		return errors.New("Cannot configure Docker; check DOCKER_HOST and Docker TLS settings.")
	}
	defer docker.Close()
	executor := newExecutor(ctx, docker)

	healthCheck := health.NewServer()
	for _, name := range []string{"", judgev1.JudgeService_ServiceDesc.ServiceName, "run", "dependencies", "neon", "docker", "images"} {
		healthCheck.SetServingStatus(name, healthv1.HealthCheckResponse_NOT_SERVING)
	}
	server := grpc.NewServer(grpc.MaxRecvMsgSize(1<<20), grpc.MaxSendMsgSize(1<<20))
	judgev1.RegisterJudgeServiceServer(server, &judgeServer{pool: pool, executor: executor})
	healthv1.RegisterHealthServer(server, healthCheck)

	monitorCtx, stopMonitor := context.WithCancel(ctx)
	monitorDone := make(chan struct{})
	go func() {
		defer close(monitorDone)
		monitorDependencies(monitorCtx, cfg, pool, docker, executor, healthCheck)
	}()
	defer func() {
		cancel()
		stopMonitor()
		<-monitorDone
		healthCheck.Shutdown()
		executionsStopped := make(chan struct{})
		go func() { executor.shutdown(); close(executionsStopped) }()
		serverStopped := make(chan struct{})
		go func() { server.GracefulStop(); close(serverStopped) }()
		select {
		case <-serverStopped:
		case <-time.After(12 * time.Second):
			server.Stop()
			<-serverStopped
		}
		<-executionsStopped
	}()

	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()
	log.Printf("Judge listening on %s; check 'run' health before running examples. Durable submissions are not enabled yet.", judgeAddress)
	select {
	case err := <-serveDone:
		if err != nil && !errors.Is(err, grpc.ErrServerStopped) {
			return errors.New("The judge listener stopped unexpectedly.")
		}
	case <-ctx.Done():
	}
	return nil
}
