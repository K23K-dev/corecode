package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"slices"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	judgev1 "github.com/K23K-dev/corecode/judge/gen"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const maxRunnerPayload = 1024 * 1024

var problemVersionPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type executionInput struct {
	runtime     string
	specVersion string
	imageID     string
	name        string
	payload     []byte
	caseCount   int
}

func prepareExecution(ctx context.Context, pool *pgxpool.Pool, request *judgev1.RunRequest, mode string) (executionInput, error) {
	if request == nil || !validProblemID(request.GetProblemId()) || !problemVersionPattern.MatchString(request.GetProblemVersion()) {
		return executionInput{}, status.Error(codes.InvalidArgument, "Provide a valid problem ID and version.")
	}
	if !utf8.ValidString(request.Code) || len(request.Code) > 51200 || len(utf16.Encode([]rune(request.Code))) > 32768 {
		return executionInput{}, status.Error(codes.InvalidArgument, "Keep code under 32,768 characters and 50 KiB.")
	}
	if mode != "example" && mode != "submit" {
		return executionInput{}, status.Error(codes.InvalidArgument, "Invalid run mode.")
	}

	var version string
	var rawSpec []byte
	var specVersion *string
	err := pool.QueryRow(ctx, `SELECT p.current_version, s.content, s.spec_version
		FROM cp_problems p
		LEFT JOIN cp_grading_specs s ON s.exercise_id = p.id AND s.problem_version = p.current_version
		WHERE p.id = $1 AND p.active`, request.ProblemId).Scan(&version, &rawSpec, &specVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return executionInput{}, status.Error(codes.NotFound, "Problem not found.")
	}
	if err != nil {
		if ctx.Err() != nil {
			return executionInput{}, status.FromContextError(ctx.Err()).Err()
		}
		return executionInput{}, status.Error(codes.Unavailable, "The problem catalog is temporarily unavailable.")
	}
	if version != request.ProblemVersion {
		return executionInput{}, status.Error(codes.FailedPrecondition, "This problem changed. Refresh before submitting.")
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
			return executionInput{}, status.FromContextError(ctx.Err()).Err()
		}
		return executionInput{}, status.Error(codes.Unavailable, "The problem catalog is temporarily unavailable.")
	}
	input, err := makeExecutionInput(problemID, version, specVersion, code, "submit", rawSpec)
	if err == nil && input.runtime != runtime {
		return executionInput{}, invalidGradingSpec()
	}
	return input, err
}

func invalidGradingSpec() error {
	return status.Error(codes.FailedPrecondition, "The grading specification is unavailable or invalid. Nothing was marked solved.")
}

func makeExecutionInput(problemID, version, specVersion, code, mode string, rawSpec []byte) (executionInput, error) {
	unavailable := invalidGradingSpec()
	var spec map[string]any
	if len(rawSpec) > maxRunnerPayload || json.Unmarshal(rawSpec, &spec) != nil || !safeObject(spec) {
		return executionInput{}, unavailable
	}
	digest := sha256.Sum256(stableJSON(spec))
	if hex.EncodeToString(digest[:]) != specVersion {
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

// Match the existing Node stableJson digest, including UTF-16 key ordering and
// JSON.stringify's literal Unicode characters rather than HTML-safe escaping.
func stableJSON(value any) []byte {
	switch value := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(value))
		for key := range value {
			keys = append(keys, key)
		}
		slices.SortFunc(keys, func(a, b string) int {
			return slices.Compare(utf16.Encode([]rune(a)), utf16.Encode([]rune(b)))
		})
		parts := make([][]byte, 0, len(keys))
		for _, key := range keys {
			parts = append(parts, append(append(stableJSON(key), ':'), stableJSON(value[key])...))
		}
		return append(append([]byte{'{'}, bytes.Join(parts, []byte{','})...), '}')
	case []any:
		parts := make([][]byte, len(value))
		for i, item := range value {
			parts[i] = stableJSON(item)
		}
		return append(append([]byte{'['}, bytes.Join(parts, []byte{','})...), ']')
	case string:
		var result bytes.Buffer
		result.WriteByte('"')
		for _, character := range value {
			if character == '"' || character == '\\' || character < 32 {
				encoded, _ := json.Marshal(string(character))
				result.Write(encoded[1 : len(encoded)-1])
			} else {
				result.WriteRune(character)
			}
		}
		result.WriteByte('"')
		return result.Bytes()
	case float64:
		if value == 0 { // JavaScript serializes negative zero as zero.
			return []byte{'0'}
		}
	}
	encoded, _ := json.Marshal(value)
	return encoded
}

func parseExecutionResult(data []byte, expectedCases int) (*judgev1.RunResult, error) {
	invalid := status.Error(codes.FailedPrecondition, "The runner returned an invalid result. Nothing was marked solved.")
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
