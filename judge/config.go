package main

import (
	"errors"
	"net"
	"net/url"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type config struct {
	database        *pgxpool.Config
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
		dockerHost:      dockerHost,
		pythonImage:     configuredValue("JUDGE_PYTHON_IMAGE", "cp-practice-python:3"),
		javascriptImage: configuredValue("JUDGE_JAVASCRIPT_IMAGE", "coding-practice-js:4"),
		sandboxDeadline: deadline,
	}, nil
}

// Startup removes this engine's leftover grading containers, so it must be local.
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

func judgeToken() (string, error) {
	token := os.Getenv("JUDGE_TOKEN")
	if len(token) < 32 || len(token) > 256 {
		return "", errors.New("JUDGE_TOKEN must contain 32–256 printable ASCII characters.")
	}
	for _, c := range token {
		if c < 33 || c > 126 {
			return "", errors.New("JUDGE_TOKEN must contain 32–256 printable ASCII characters.")
		}
	}
	return token, nil
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
	invalid := errors.New("POSTGRES_URL must be a PostgreSQL URL with SSL, for example sslmode=require.")
	u, err := url.Parse(value)
	if err != nil {
		return nil, invalid
	}
	switch u.Query().Get("sslmode") {
	case "require", "verify-ca", "verify-full":
	default:
		return nil, invalid
	}
	// Without an explicit port, pgx would use this machine's PGPORT.
	if u.Port() == "" {
		u.Host = net.JoinHostPort(u.Hostname(), "5432")
	}
	database, err := pgxpool.ParseConfig(u.String())
	if err != nil {
		return nil, invalid // Parser errors may include the private connection string.
	}
	connection := database.ConnConfig
	database.MaxConns, database.MinConns, database.MinIdleConns = 4, 0, 0
	database.MaxConnIdleTime = 10 * time.Second
	connection.ConnectTimeout = 5 * time.Second
	connection.RuntimeParams["statement_timeout"] = "15000"
	connection.RuntimeParams["application_name"] = "code-practice-judge"
	return database, nil
}
