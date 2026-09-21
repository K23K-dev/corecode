package main

import (
	"context"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/moby/moby/client"
	"google.golang.org/grpc/health"
	healthv1 "google.golang.org/grpc/health/grpc_health_v1"
)

func monitorDependencies(ctx context.Context, cfg config, pool *pgxpool.Pool, docker *client.Client, healthCheck *health.Server) {
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
		probe, cancel := context.WithTimeout(ctx, 5*time.Second)
		neonReady := pool.Ping(probe) == nil
		cancel()
		update("neon", neonReady)

		probe, cancel = context.WithTimeout(ctx, 5*time.Second)
		ping, err := docker.Ping(probe, client.PingOptions{NegotiateAPIVersion: true})
		dockerReady := err == nil && ping.OSType == "linux"
		imagesReady := dockerReady
		if dockerReady {
			for _, name := range []string{cfg.pythonImage, cfg.javascriptImage} {
				image, err := docker.ImageInspect(probe, name)
				if err != nil || image.ID == "" || image.Os != "linux" {
					imagesReady = false
				}
			}
		}
		cancel()
		update("docker", dockerReady)
		update("images", imagesReady)
		update("dependencies", neonReady && dockerReady && imagesReady)
		// The overall judge stays NOT_SERVING until execution and recovery exist.
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
