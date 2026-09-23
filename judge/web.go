package main

import (
	"context"
	"io"
	"net/http"
	"time"

	"connectrpc.com/connect"
	judgev1 "github.com/K23K-dev/corecode/judge/gen"
	"google.golang.org/grpc"
	healthv1 "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// The Sandbox HTTPS proxy speaks HTTP/1.1 to the VM. Connect translates
// gRPC-Web into calls to the same authenticated native gRPC service.
func newWebServer(address string, connection *grpc.ClientConn) *http.Server {
	judge := judgev1.NewJudgeServiceClient(connection)
	health := healthv1.NewHealthClient(connection)
	mux := http.NewServeMux()
	registerUnary(mux, judgev1.JudgeService_Run_FullMethodName, judge.Run)
	registerUnary(mux, judgev1.JudgeService_Submit_FullMethodName, judge.Submit)
	registerUnary(mux, judgev1.JudgeService_GetJob_FullMethodName, judge.GetJob)
	registerUnary(mux, judgev1.JudgeService_ListJobs_FullMethodName, judge.ListJobs)
	registerUnary(mux, judgev1.JudgeService_CancelJob_FullMethodName, judge.CancelJob)
	registerUnary(mux, healthv1.Health_Check_FullMethodName, health.Check)
	registerUnary(mux, healthv1.Health_List_FullMethodName, health.List)
	registerStream(mux, judgev1.JudgeService_WatchJob_FullMethodName, judge.WatchJob)
	registerStream(mux, healthv1.Health_Watch_FullMethodName, health.Watch)
	return &http.Server{
		Addr:              address,
		Handler:           http.MaxBytesHandler(mux, (1<<20)+1024),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       75 * time.Second,
	}
}

func forwardedContext(ctx context.Context, header http.Header) context.Context {
	// Preserve every supplied value so native authentication rejects duplicates.
	return metadata.NewOutgoingContext(ctx, metadata.MD{"authorization": header.Values("Authorization")})
}

func webError(err error) error {
	if err == nil {
		return nil
	}
	return connect.NewError(connect.Code(status.Code(err)), err)
}

func registerUnary[Request, Response any](mux *http.ServeMux, path string, call func(context.Context, *Request, ...grpc.CallOption) (*Response, error)) {
	mux.Handle(path, connect.NewUnaryHandler(path, func(ctx context.Context, request *connect.Request[Request]) (*connect.Response[Response], error) {
		response, err := call(forwardedContext(ctx, request.Header()), request.Msg)
		if err != nil {
			return nil, webError(err)
		}
		return connect.NewResponse(response), nil
	}, connect.WithReadMaxBytes(1<<20), connect.WithSendMaxBytes(1<<20)))
}

func registerStream[Request, Response any](mux *http.ServeMux, path string, call func(context.Context, *Request, ...grpc.CallOption) (grpc.ServerStreamingClient[Response], error)) {
	mux.Handle(path, connect.NewServerStreamHandler(path, func(ctx context.Context, request *connect.Request[Request], output *connect.ServerStream[Response]) error {
		stream, err := call(forwardedContext(ctx, request.Header()), request.Msg)
		if err != nil {
			return webError(err)
		}
		for {
			message, err := stream.Recv()
			if err == io.EOF {
				return nil
			}
			if err != nil {
				return webError(err)
			}
			if err := output.Send(message); err != nil {
				return err
			}
		}
	}, connect.WithReadMaxBytes(1<<20), connect.WithSendMaxBytes(1<<20)))
}
