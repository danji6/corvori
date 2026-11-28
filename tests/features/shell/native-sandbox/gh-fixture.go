// This test launcher routes the installed CLI to a loopback HTTP fixture.
package main

import (
	"fmt"
	"os"
	"os/exec"
)

func main() {
	proxy, err := os.ReadFile("fixture-proxy")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	cmd := exec.Command(".\\fixture-gh.exe", os.Args[1:]...)
	cmd.Env = append(os.Environ(), "GH_HOST=github.localhost", "HTTP_PROXY="+string(proxy))
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
