package main

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/moby/moby/client"
)

// One physical database session owns the judge across all clients and hosts.
// The engine binding makes failover explicit: another host cannot prove that
// the first host's containers are gone merely by getting a local Docker 404.
type leadership struct {
	connection *pgx.Conn
	lost       chan struct{}
	done       chan struct{}
	stop       context.CancelFunc
}

func acquireLeadership(ctx context.Context, cfg *pgx.ConnConfig, docker *client.Client, onLoss func()) (*leadership, error) {
	probe, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	connection, err := pgx.ConnectConfig(probe, cfg)
	if err != nil {
		return nil, errors.New("Cannot connect directly to Neon for judge ownership.")
	}
	owned := false
	defer func() {
		if !owned {
			closeCtx, closeCancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer closeCancel()
			_ = connection.Close(closeCtx)
		}
	}()
	var locked bool
	err = connection.QueryRow(probe, `SELECT pg_try_advisory_lock(
		hashtextextended('corecode.judge:' || current_schema(), 0))`).Scan(&locked)
	if err != nil {
		return nil, errors.New("Cannot acquire database ownership for the judge.")
	}
	if !locked {
		return nil, errors.New("Another judge owns this database; stop it before starting a replacement.")
	}
	info, err := docker.Info(probe, client.InfoOptions{})
	if err != nil || info.Info.OSType != "linux" || info.Info.ID == "" || len(info.Info.ID) > 256 {
		return nil, errors.New("Cannot identify the local Linux Docker engine for judge ownership.")
	}
	_, err = connection.Exec(probe, `INSERT INTO cp_judge_runtime(id, engine_id)
		VALUES (1, $1) ON CONFLICT (id) DO NOTHING`, info.Info.ID)
	if err != nil {
		return nil, errors.New("Cannot register the judge runtime; apply database schema version 8 first.")
	}
	var engineID string
	if err := connection.QueryRow(probe, "SELECT engine_id FROM cp_judge_runtime WHERE id = 1").Scan(&engineID); err != nil {
		return nil, errors.New("Cannot read the judge's registered Docker engine.")
	}
	if engineID != info.Info.ID {
		return nil, errors.New("This database belongs to another Docker engine. Confirm the old host is stopped before migrating its runtime binding.")
	}
	watchCtx, stop := context.WithCancel(context.Background())
	leader := &leadership{connection: connection, lost: make(chan struct{}), done: make(chan struct{}), stop: stop}
	owned = true
	go leader.watch(watchCtx, onLoss)
	return leader, nil
}

func (l *leadership) watch(ctx context.Context, onLoss func()) {
	defer close(l.done)
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		probe, cancel := context.WithTimeout(ctx, 2*time.Second)
		err := l.connection.Ping(probe)
		cancel()
		if err != nil {
			if ctx.Err() == nil {
				onLoss()
				close(l.lost)
			}
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (l *leadership) close() {
	l.stop()
	<-l.done
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	// Closing the dedicated session releases its lock, including after a crash.
	_ = l.connection.Close(ctx)
}
