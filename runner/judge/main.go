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

// Execution and persistence arrive in the next checkpoints. Until then, every
// grading RPC returns UNIMPLEMENTED rather than accepting work it cannot finish.
type judgeServer struct {
	judgev1.UnimplementedJudgeServiceServer
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

	healthCheck := health.NewServer()
	for _, name := range []string{"", judgev1.JudgeService_ServiceDesc.ServiceName, "dependencies", "neon", "docker", "images"} {
		healthCheck.SetServingStatus(name, healthv1.HealthCheckResponse_NOT_SERVING)
	}
	server := grpc.NewServer(grpc.MaxRecvMsgSize(1<<20), grpc.MaxSendMsgSize(1<<20))
	judgev1.RegisterJudgeServiceServer(server, &judgeServer{})
	healthv1.RegisterHealthServer(server, healthCheck)

	monitorCtx, stopMonitor := context.WithCancel(ctx)
	monitorDone := make(chan struct{})
	go func() {
		defer close(monitorDone)
		monitorDependencies(monitorCtx, cfg, pool, docker, healthCheck)
	}()
	defer func() { stopMonitor(); <-monitorDone }()

	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()
	log.Printf("Judge listening on %s; grading RPCs are not enabled yet.", judgeAddress)
	select {
	case err := <-serveDone:
		if err != nil {
			return errors.New("The judge listener stopped unexpectedly.")
		}
	case <-ctx.Done():
		healthCheck.Shutdown()
		stopped := make(chan struct{})
		go func() { server.GracefulStop(); close(stopped) }()
		select {
		case <-stopped:
		case <-time.After(3 * time.Second):
			server.Stop()
			<-stopped
		}
	}
	return nil
}
