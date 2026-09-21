package main

import (
	"context"
	"log"
	"time"

	judgev1 "github.com/K23K-dev/corecode/runner/judge/gen"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/moby/moby/client"
	"google.golang.org/grpc/health"
	healthv1 "google.golang.org/grpc/health/grpc_health_v1"
)

func monitorDependencies(ctx context.Context, cfg config, pool *pgxpool.Pool, docker *client.Client, executor *executor, healthCheck *health.Server) {
	previous := make(map[string]bool)
	update := func(name string, ready bool) {
		status := healthv1.HealthCheckResponse_NOT_SERVING
		if ready {
			status = healthv1.HealthCheckResponse_SERVING
		}
		healthCheck.SetServingStatus(name, status)
		if old, known := previous[name]; !known || old != ready {
			// Driver errors can contain private URLs, so only report fixed status names.
			log.Printf("%s: %s", name, status)
			previous[name] = ready
		}
	}
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		probe, cancel := context.WithTimeout(ctx, 5*time.Second)
		neonReady := pool.Ping(probe) == nil
		cancel()
		update("neon", neonReady)

		probe, cancel = context.WithTimeout(ctx, 5*time.Second)
		ping, err := docker.Ping(probe, client.PingOptions{NegotiateAPIVersion: true})
		dockerReady := err == nil && ping.OSType == "linux"
		imagesReady := dockerReady && executor.refreshImages(probe, cfg)
		cancel()
		update("docker", dockerReady)
		update("images", imagesReady)
		probe, cancel = context.WithTimeout(ctx, 5*time.Second)
		var queueReady bool
		schemaErr := pool.QueryRow(probe, "SELECT "+queueSchemaReady).Scan(&queueReady)
		cancel()
		queueReady = queueReady && schemaErr == nil
		update("queue", queueReady)
		dependenciesReady := neonReady && dockerReady && imagesReady && queueReady
		cleanupReady := false
		if dependenciesReady {
			probe, cancel = context.WithTimeout(ctx, 15*time.Second)
			cleanupReady = executor.reconcile(probe, pool)
			cancel()
		} else {
			executor.mu.Lock()
			executor.reconciled = false
			executor.mu.Unlock()
		}
		update("recovery", cleanupReady)
		dependenciesReady = dependenciesReady && cleanupReady
		update("dependencies", dependenciesReady)
		update("run", dependenciesReady && executor.ready())
		update("submissions", dependenciesReady && executor.ready())
		update("", dependenciesReady && executor.ready())
		update(judgev1.JudgeService_ServiceDesc.ServiceName, dependenciesReady && executor.ready())
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
