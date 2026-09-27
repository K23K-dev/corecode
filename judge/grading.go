package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"connectrpc.com/connect"
	judgev1 "github.com/K23K-dev/corecode/judge/gen"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const maxRunnerPayload = 1024 * 1024

var problemVersionPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type executionInput struct {
	runtime     string
	specVersion string
	name        string
	payload     []byte
	caseCount   int
}

func prepareExecution(ctx context.Context, pool *pgxpool.Pool, request *judgev1.RunRequest, mode string) (executionInput, error) {
	if request == nil || !validProblemID(request.GetProblemId()) || !problemVersionPattern.MatchString(request.GetProblemVersion()) {
		return executionInput{}, rpcError(connect.CodeInvalidArgument, "Provide a valid problem ID and version.")
	}
	if !utf8.ValidString(request.Code) || len(request.Code) > 51200 || len(utf16.Encode([]rune(request.Code))) > 32768 {
		return executionInput{}, rpcError(connect.CodeInvalidArgument, "Keep code under 32,768 characters and 50 KiB.")
	}
	if mode != "example" && mode != "submit" {
		return executionInput{}, rpcError(connect.CodeInvalidArgument, "Invalid run mode.")
	}

	var version string
	var rawSpec []byte
	var specVersion *string
	err := pool.QueryRow(ctx, `SELECT p.current_version, s.content, s.spec_version
		FROM cp_problems p
		LEFT JOIN cp_grading_specs s ON s.exercise_id = p.id AND s.problem_version = p.current_version
		WHERE p.id = $1 AND p.active`, request.ProblemId).Scan(&version, &rawSpec, &specVersion)
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
	return makeExecutionInput(request.ProblemId, version, *specVersion, request.Code, mode, rawSpec)
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
	return rpcError(connect.CodeFailedPrecondition, "The grading specification is unavailable or invalid. Nothing was marked solved.")
}

func makeExecutionInput(problemID, version, specVersion, code, mode string, rawSpec []byte) (executionInput, error) {
	unavailable := invalidGradingSpec()
	var spec map[string]any
	if len(rawSpec) > maxRunnerPayload || json.Unmarshal(rawSpec, &spec) != nil || !safeObject(spec) {
		return executionInput{}, unavailable
	}
	runtime, _ := spec["runtime"].(string)
	switch runtime {
	case "python", "sql", "shell", "javascript":
	default:
		return executionInput{}, unavailable
	}
	cases, ok := spec["cases"].([]any)
	if !ok || len(cases) < 1 || len(cases) > 32 {
		return executionInput{}, unavailable
	}
	for _, value := range cases {
		testCase, ok := value.(map[string]any)
		if !ok || !safeObject(testCase) {
			return executionInput{}, unavailable
		}
		if _, ok := testCase["name"].(string); !ok {
			return executionInput{}, unavailable
		}
		if _, ok := testCase["expected"].(string); !ok {
			return executionInput{}, unavailable
		}
	}
	payload := new(bytes.Buffer)
	encoder := json.NewEncoder(payload)
	encoder.SetEscapeHTML(false)
	err := encoder.Encode(map[string]any{
		"protocolVersion": 2, "problemId": problemID, "problemVersion": version,
		"spec": json.RawMessage(rawSpec), "code": code, "mode": mode,
	})
	if err != nil || payload.Len() > maxRunnerPayload {
		return executionInput{}, unavailable
	}
	caseCount := len(cases)
	if mode == "example" {
		caseCount = 1
	}
	return executionInput{runtime: runtime, specVersion: specVersion, payload: payload.Bytes(), caseCount: caseCount}, nil
}

func validProblemID(value string) bool {
	return utf8.ValidString(value) && !strings.ContainsRune(value, 0) && strings.TrimSpace(value) != "" &&
		len(value) <= 800 && len(utf16.Encode([]rune(value))) <= 200 &&
		value != "__proto__" && value != "prototype" && value != "constructor"
}

func safeObject(value map[string]any) bool {
	if value == nil {
		return false
	}
	for _, key := range []string{"__proto__", "prototype", "constructor"} {
		if _, exists := value[key]; exists {
			return false
		}
	}
	return true
}

func parseExecutionResult(data []byte, expectedCases int) (*judgev1.RunResult, error) {
	invalid := rpcError(connect.CodeFailedPrecondition, "The runner returned an invalid result. Nothing was marked solved.")
	if len(data) > maxExecutionOutput || !utf8.Valid(data) || expectedCases < 1 || expectedCases > 32 {
		return nil, invalid
	}
	var wire struct {
		Cases []struct {
			Name     *string `json:"name"`
			Input    *string `json:"input"`
			Expected *string `json:"expected"`
			Actual   *string `json:"actual"`
			Passed   *bool   `json:"passed"`
			Error    *string `json:"error"`
		} `json:"cases"`
		Stdout     *string  `json:"stdout"`
		DurationMS *float64 `json:"durationMs"`
		Error      *string  `json:"error"`
	}
	if json.Unmarshal(data, &wire) != nil || wire.Cases == nil || len(wire.Cases) > 32 ||
		wire.Stdout == nil || wire.DurationMS == nil || *wire.DurationMS < 0 ||
		math.IsNaN(*wire.DurationMS) || math.IsInf(*wire.DurationMS, 0) ||
		((wire.Error == nil || *wire.Error == "") && len(wire.Cases) != expectedCases) {
		return nil, invalid
	}
	result := &judgev1.RunResult{Stdout: *wire.Stdout, DurationMs: *wire.DurationMS, Error: wire.Error}
	for _, testCase := range wire.Cases {
		if testCase.Name == nil || testCase.Input == nil {
			return nil, invalid
		}
		result.Cases = append(result.Cases, &judgev1.CaseResult{
			Name: *testCase.Name, Input: *testCase.Input, Expected: testCase.Expected,
			Actual: testCase.Actual, Passed: testCase.Passed, Error: testCase.Error,
		})
	}
	return result, nil
}
