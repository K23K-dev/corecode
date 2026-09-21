package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"os"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

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

// TLS terminates at the hosting proxy; every native RPC still authenticates
// here, including streaming and health methods. The browser never gets this token.
func authentication(token string) []grpc.ServerOption {
	expected := sha256.Sum256([]byte("Bearer " + token))
	check := func(ctx context.Context) error {
		values := metadata.ValueFromIncomingContext(ctx, "authorization")
		if len(values) == 1 {
			actual := sha256.Sum256([]byte(values[0]))
			if subtle.ConstantTimeCompare(actual[:], expected[:]) == 1 {
				return nil
			}
		}
		return status.Error(codes.Unauthenticated, "Judge authentication is required.")
	}
	return []grpc.ServerOption{
		grpc.UnaryInterceptor(func(ctx context.Context, request any, _ *grpc.UnaryServerInfo, next grpc.UnaryHandler) (any, error) {
			if err := check(ctx); err != nil {
				return nil, err
			}
			return next(ctx, request)
		}),
		grpc.StreamInterceptor(func(service any, stream grpc.ServerStream, _ *grpc.StreamServerInfo, next grpc.StreamHandler) error {
			if err := check(stream.Context()); err != nil {
				return err
			}
			return next(service, stream)
		}),
	}
}
