package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"

	"connectrpc.com/connect"
	judgev1 "github.com/K23K-dev/corecode/judge/gen"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/encoding/protojson"
)

var problemVersionPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type executionInput struct {
	runtime     string
	specVersion string
	name        string
	payload     []byte
	caseCount   int
}

func prepareExecution(ctx context.Context, pool *pgxpool.Pool, request *judgev1.RunRequest, mode string) (executionInput, error) {
	id := request.GetProblemId()
	if strings.TrimSpace(id) == "" || len(id) > 800 || !problemVersionPattern.MatchString(request.GetProblemVersion()) {
		return executionInput{}, rpcError(connect.CodeInvalidArgument, "Provide a valid problem ID and version.")
	}
	if len(request.Code) > 51200 {
		return executionInput{}, rpcError(connect.CodeInvalidArgument, "Keep code under 50 KiB.")
	}

	var version string
	var rawSpec []byte
	var specVersion *string
	err := pool.QueryRow(ctx, `SELECT p.current_version, s.content, s.spec_version
		FROM cp_problems p
		LEFT JOIN cp_grading_specs s ON s.exercise_id = p.id AND s.problem_version = p.current_version
		WHERE p.id = $1 AND p.active`, id).Scan(&version, &rawSpec, &specVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return executionInput{}, rpcError(connect.CodeNotFound, "Problem not found.")
	}
	if err != nil {
		if ctx.Err() != nil {
			return executionInput{}, contextError(ctx.Err())
		}
		return executionInput{}, rpcError(connect.CodeUnavailable, "The problem catalog is temporarily unavailable.")
	}
	if version != request.ProblemVersion {
		return executionInput{}, rpcError(connect.CodeFailedPrecondition, "This problem changed. Refresh before submitting.")
	}

	if specVersion == nil {
		return executionInput{}, invalidGradingSpec()
	}
	return makeExecutionInput(id, version, *specVersion, request.Code, mode, rawSpec)
}

// Accepted submissions retain their exact immutable spec even after the public
// problem changes or is retired. Only acceptance checks the current version.
func prepareStoredExecution(ctx context.Context, pool *pgxpool.Pool, problemID, version, specVersion, code, runtime string) (executionInput, error) {
	var rawSpec []byte
	err := pool.QueryRow(ctx, `SELECT content FROM cp_grading_specs
		WHERE exercise_id = $1 AND problem_version = $2 AND spec_version = $3`,
		problemID, version, specVersion).Scan(&rawSpec)
	if errors.Is(err, pgx.ErrNoRows) {
		return executionInput{}, invalidGradingSpec()
	}
	if err != nil {
		if ctx.Err() != nil {
			return executionInput{}, contextError(ctx.Err())
		}
		return executionInput{}, rpcError(connect.CodeUnavailable, "The problem catalog is temporarily unavailable.")
	}
	input, err := makeExecutionInput(problemID, version, specVersion, code, "submit", rawSpec)
	if err == nil && input.runtime != runtime {
		return executionInput{}, invalidGradingSpec()
	}
	return input, err
}

func invalidGradingSpec() error {
	return rpcError(connect.CodeFailedPrecondition, "The grading spec is missing or invalid.")
}

// makeExecutionInput builds the grader's stdin. A CHECK constraint on cp_grading_specs
// already guarantees each spec has a known runtime and 1–32 cases.
func makeExecutionInput(problemID, version, specVersion, code, mode string, rawSpec []byte) (executionInput, error) {
	var spec struct {
		Runtime string            `json:"runtime"`
		Cases   []json.RawMessage `json:"cases"`
	}
	if json.Unmarshal(rawSpec, &spec) != nil {
		return executionInput{}, invalidGradingSpec()
	}
	payload := new(bytes.Buffer)
	encoder := json.NewEncoder(payload)
	encoder.SetEscapeHTML(false)
	err := encoder.Encode(map[string]any{
		"protocolVersion": 2, "problemId": problemID, "problemVersion": version,
		"spec": json.RawMessage(rawSpec), "code": code, "mode": mode,
	})
	if err != nil {
		return executionInput{}, invalidGradingSpec()
	}
	caseCount := len(spec.Cases)
	if mode == "example" {
		caseCount = 1
	}
	return executionInput{runtime: spec.Runtime, specVersion: specVersion, payload: payload.Bytes(), caseCount: caseCount}, nil
}

// parseExecutionResult reads the grader's JSON output. Unless the grader reports an
// error, it must return one result per case.
func parseExecutionResult(data []byte, expectedCases int) (*judgev1.RunResult, error) {
	result := &judgev1.RunResult{}
	if (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(data, result) != nil ||
		(result.GetError() == "" && len(result.Cases) != expectedCases) {
		return nil, rpcError(connect.CodeFailedPrecondition, "The grader returned an invalid result.")
	}
	return result, nil
}
