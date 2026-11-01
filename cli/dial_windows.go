//go:build windows

package main

import (
	"context"
	"net"

	"github.com/Microsoft/go-winio"
)

func dialLocal(ctx context.Context, endpoint string) (net.Conn, error) {
	return winio.DialPipeContext(ctx, endpoint)
}
