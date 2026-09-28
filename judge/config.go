package main

import (
	"errors"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type config struct {
	database        *pgxpool.Config
	pythonImage     string
	javascriptImage string
}

func loadConfig() (config, error) {
	database, err := databaseConfig(os.Getenv("POSTGRES_URL"))
	if err != nil {
		return config{}, err
	}
	return config{
		database:        database,
		pythonImage:     configuredValue("JUDGE_PYTHON_IMAGE", "cp-practice-python:3"),
		javascriptImage: configuredValue("JUDGE_JAVASCRIPT_IMAGE", "coding-practice-js:4"),
	}, nil
}

func judgeToken() (string, error) {
	token := os.Getenv("JUDGE_TOKEN")
	if len(token) < 32 {
		return "", errors.New("JUDGE_TOKEN must be at least 32 characters.")
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
	u, err := url.Parse(value)
	if err == nil && u.Port() == "" {
		// Without an explicit port, pgx would use this machine's PGPORT.
		u.Host = net.JoinHostPort(u.Hostname(), "5432")
	}
	var database *pgxpool.Config
	if err == nil {
		database, err = pgxpool.ParseConfig(u.String())
	}
	if err != nil {
		// Parser errors may include the password, so they are never shown.
		return nil, errors.New("POSTGRES_URL must be a PostgreSQL connection string.")
	}
	connection := database.ConnConfig
	database.MaxConns, database.MinConns, database.MinIdleConns = 4, 0, 0
	database.MaxConnIdleTime = 10 * time.Second
	connection.ConnectTimeout = 5 * time.Second
	connection.RuntimeParams["statement_timeout"] = "15000"
	connection.RuntimeParams["application_name"] = "code-practice-judge"
	return database, nil
}
