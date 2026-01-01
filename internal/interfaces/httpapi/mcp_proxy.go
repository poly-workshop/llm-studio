package httpapi

import (
	"net/http"
	"net/http/httputil"
	"net/url"
)

type mcpProxyHandler struct {
	target *url.URL
	proxy  *httputil.ReverseProxy
}

func newMCPProxyHandler() *mcpProxyHandler {
	// McD MCP server (Streamable HTTP)
	target := mustParseURL("https://mcp.mcd.cn")

	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(r *http.Request) {
		originalDirector(r)
		// Force the upstream path for this MCP server.
		r.URL.Path = "/mcp-servers/mcd-mcp"
		r.Host = target.Host
	}

	return &mcpProxyHandler{target: target, proxy: proxy}
}

func (h *mcpProxyHandler) mcd(w http.ResponseWriter, r *http.Request) {
	// Same-origin endpoint, so no browser CORS preflight needed.
	// Proxy supports streaming responses.
	h.proxy.ServeHTTP(w, r)
}

func mustParseURL(raw string) *url.URL {
	u, err := url.Parse(raw)
	if err != nil {
		panic(err)
	}
	return u
}
