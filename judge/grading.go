package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"time"

	judgev1 "github.com/K23K-dev/corecode/judge/gen"
	"google.golang.org/protobuf/encoding/protojson"
)

var errInvalidResult = errors.New("The grader returned an invalid result.")

type execution struct {
	runtime, container string
	payload            []byte
	cases              int
}

// newExecution builds the grader's stdin. A CHECK constraint on grading_specs already guarantees
// each spec has a known runtime and 1–32 cases. Run grades only the first case.
func newExecution(problemID, version, code, mode string, spec []byte) (execution, error) {
	var parsed struct {
		Runtime string            `json:"runtime"`
		Cases   []json.RawMessage `json:"cases"`
	}
	if json.Unmarshal(spec, &parsed) != nil {
		return execution{}, errInvalidSpec
	}
	payload := new(bytes.Buffer)
	encoder := json.NewEncoder(payload)
	encoder.SetEscapeHTML(false)
	err := encoder.Encode(map[string]any{
		"problemId": problemID, "problemVersion": version,
		"spec": json.RawMessage(spec), "code": code, "mode": mode,
	})
	if err != nil {
		return execution{}, errInvalidSpec
	}
	cases := len(parsed.Cases)
	if mode == "example" {
		cases = 1
	}
	return execution{runtime: parsed.Runtime, payload: payload.Bytes(), cases: cases}, nil
}

// grade runs one execution. Code that breaks a limit gets a result saying so, not an error.
func grade(ctx context.Context, executor *executor, input execution) (*judgev1.RunResult, error) {
	started := time.Now()
	output, err := executor.run(ctx, input.runtime, input.container, input.payload)
	var limit limitError
	if errors.As(err, &limit) {
		message := limit.Error()
		return &judgev1.RunResult{Error: &message, DurationMs: float64(time.Since(started).Milliseconds())}, nil
	}
	if err != nil {
		return nil, err
	}
	// The grader prints its result as JSON, with one entry per case unless it reports an error.
	result := &judgev1.RunResult{}
	if (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(output, result) != nil ||
		(result.GetError() == "" && len(result.Cases) != input.cases) {
		return nil, errInvalidResult
	}
	return result, nil
}
