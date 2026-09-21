package main

import (
	"errors"
	"net"
	"net/url"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type config struct {
	database        *pgxpool.Config
	leader          *pgx.ConnConfig
	dockerHost      string
	pythonImage     string
	javascriptImage string
	sandboxDeadline time.Time
}

func loadConfig() (config, error) {
	database, err := databaseConfig(os.Getenv("POSTGRES_URL"))
	if err != nil {
		return config{}, err
	}
	leader, err := leaderDatabaseConfig(os.Getenv("POSTGRES_URL"))
	if err != nil {
		return config{}, err
	}
	dockerHost := "unix:///var/run/docker.sock"
	if runtime.GOOS == "windows" {
		dockerHost = "npipe:////./pipe/dockerDesktopLinuxEngine"
	}
	dockerHost = configuredValue("DOCKER_HOST", dockerHost)
	if !localDockerHost(dockerHost) {
		return config{}, errors.New("DOCKER_HOST must address this computer's Docker engine; remote Docker engines are not supported.")
	}
	var deadline time.Time
	if value := os.Getenv("JUDGE_SANDBOX_DEADLINE"); value != "" {
		milliseconds, err := strconv.ParseInt(value, 10, 64)
		deadline = time.UnixMilli(milliseconds)
		if err != nil || time.Until(deadline) < 5*time.Second || time.Until(deadline) > 3*time.Minute {
			return config{}, errors.New("The Sandbox drain deadline must be within the next three minutes.")
		}
	}
	return config{
		database:        database,
		leader:          leader,
		dockerHost:      dockerHost,
		pythonImage:     configuredValue("JUDGE_PYTHON_IMAGE", "cp-practice-python:2"),
		javascriptImage: configuredValue("JUDGE_JAVASCRIPT_IMAGE", "coding-practice-js:2"),
		sandboxDeadline: deadline,
	}, nil
}

// Session advisory locks require a direct connection. Reparse the normalized
// URL so TLS server names and SSL fallback configuration match that endpoint.
func leaderDatabaseConfig(value string) (*pgx.ConnConfig, error) {
	u, err := url.Parse(strings.TrimSpace(value))
	if err != nil {
		return nil, errors.New("Cannot configure the judge's direct Neon connection.")
	}
	u.Host = net.JoinHostPort(strings.Replace(strings.ToLower(u.Hostname()), "-pooler.", ".", 1), "5432")
	direct, err := databaseConfig(u.String())
	if err != nil {
		return nil, err
	}
	return direct.ConnConfig, nil
}

// The fixed local listener excludes a second judge before any Docker cleanup.
// That ownership guarantee does not extend to engines shared by other hosts.
func localDockerHost(value string) bool {
	u, err := url.Parse(value)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	switch u.Scheme {
	case "unix":
		return u.Host == "" && strings.HasPrefix(u.Path, "/") && len(u.Path) > 1
	case "npipe":
		return u.Host == "" && strings.HasPrefix(u.Path, "//./pipe/") && len(u.Path) > len("//./pipe/")
	case "tcp":
		ip := net.ParseIP(u.Hostname())
		return (u.Hostname() == "localhost" || ip != nil && ip.IsLoopback()) && u.Port() != "" && u.Path == ""
	default:
		return false
	}
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
