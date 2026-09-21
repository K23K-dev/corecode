package main

import (
	"errors"
	"net"
	"net/url"
	"os"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type config struct {
	database        *pgxpool.Config
	dockerHost      string
	pythonImage     string
	javascriptImage string
}

func loadConfig() (config, error) {
	database, err := databaseConfig(os.Getenv("POSTGRES_URL"))
	if err != nil {
		return config{}, err
	}
	dockerHost := "unix:///var/run/docker.sock"
	if runtime.GOOS == "windows" {
		dockerHost = "npipe:////./pipe/dockerDesktopLinuxEngine"
	}
	return config{
		database:        database,
		dockerHost:      configuredValue("DOCKER_HOST", dockerHost),
		pythonImage:     configuredValue("JUDGE_PYTHON_IMAGE", "cp-practice-python:2"),
		javascriptImage: configuredValue("JUDGE_JAVASCRIPT_IMAGE", "coding-practice-js:2"),
	}, nil
}

func configuredValue(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func databaseConfig(value string) (*pgxpool.Config, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, errors.New("POSTGRES_URL is required. Add your Neon connection string to .env.")
	}
	invalid := errors.New("POSTGRES_URL must use a Neon PostgreSQL endpoint with SSL enabled.")
	u, err := url.Parse(value)
	if err != nil {
		return nil, invalid
	}
	password, hasPassword := u.User.Password()
	host := strings.ToLower(u.Hostname())
	neonHost := regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+neon\.tech$`)
	if (u.Scheme != "postgres" && u.Scheme != "postgresql") || !neonHost.MatchString(host) ||
		(u.Port() != "" && u.Port() != "5432") || u.User.Username() == "" ||
		!hasPassword || password == "" || len(u.Path) <= 1 || u.Fragment != "" {
		return nil, invalid
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return nil, invalid
	}
	seen := make(map[string]bool)
	for key, values := range query {
		key = strings.ToLower(key)
		if seen[key] || len(values) != 1 {
			return nil, invalid
		}
		seen[key] = true
		switch key {
		case "host", "hostaddr", "port", "user", "password", "database", "dbname", "ssl", "service", "servicefile":
			return nil, invalid
		}
	}
	switch query.Get("sslmode") {
	case "require", "verify-ca", "verify-full":
	default:
		return nil, invalid
	}
	// A URL without a port must not inherit PGPORT; service files may override URLs.
	if os.Getenv("PGSERVICE") != "" || os.Getenv("PGSERVICEFILE") != "" {
		return nil, errors.New("Configure the judge with POSTGRES_URL instead of PostgreSQL service files.")
	}
	u.Host = net.JoinHostPort(host, "5432")
	database, err := pgxpool.ParseConfig(u.String())
	if err != nil {
		return nil, invalid // Parser errors may include the private connection string.
	}
	connection := database.ConnConfig
	if connection.Host != host || connection.Port != 5432 || connection.TLSConfig == nil {
		return nil, invalid
	}
	for _, fallback := range connection.Fallbacks {
		if fallback.Host != host || fallback.Port != 5432 || fallback.TLSConfig == nil {
			return nil, invalid
		}
	}
	database.MaxConns, database.MinConns, database.MinIdleConns = 4, 0, 0
	database.MaxConnIdleTime = 10 * time.Second
	connection.ConnectTimeout = 5 * time.Second
	connection.RuntimeParams["statement_timeout"] = "15000"
	connection.RuntimeParams["application_name"] = "code-practice-judge"
	return database, nil
}
