package main

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/moby/moby/client"
)

// The fixed local listener is acquired before reconciliation. Scope also keeps
// another database/schema's containers separate, including isolated checks.
func (e *executor) reconcile(ctx context.Context, pool *pgxpool.Pool) (ready bool) {
	defer func() {
		e.mu.Lock()
		e.reconciled = ready
		e.mu.Unlock()
	}()
	if e.scope == "" {
		var database, schema string
		if err := pool.QueryRow(ctx, "SELECT current_database(), current_schema()").Scan(&database, &schema); err != nil {
			return false
		}
		host := strings.Replace(pool.Config().ConnConfig.Host, "-pooler.", ".", 1)
		e.scope = fmt.Sprintf("%x", sha256.Sum256([]byte(host+"\x00"+database+"\x00"+schema)))
	}
	// Recorded attempts retain their lease barrier and are cleaned by the queue
	// only after a fenced recovery claim. This also covers an in-flight create.
	var names []string
	if err := pool.QueryRow(ctx, `SELECT COALESCE(array_agg(container_name), ARRAY[]::text[])
		FROM cp_execution_jobs WHERE state IN ('running', 'canceling') AND container_name IS NOT NULL`).Scan(&names); err != nil {
		return false
	}
	recorded := make(map[string]bool, len(names))
	for _, name := range names {
		recorded[name] = true
	}
	listed, err := e.docker.ContainerList(ctx, client.ContainerListOptions{
		All:     true,
		Filters: make(client.Filters).Add("label", "code-practice.judge=1", "code-practice.scope="+e.scope),
	})
	if err != nil {
		return false
	}
	for _, item := range listed.Items {
		labels := item.Labels
		if labels["code-practice.scope"] != e.scope || labels["code-practice.judge"] != "1" || labels["code-practice.instance"] == e.instance {
			continue
		}
		name := labels["code-practice.execution"]
		if recorded[name] {
			continue
		}
		if !executionNamePattern.MatchString(name) || !e.removeContainer(ctx, item.ID, name, false) {
			return false
		}
	}
	return true
}
