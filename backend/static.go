package main

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

// staticDir finds the built website: STATIC_DIR, ./public (Docker), or the
// Angular build output next to the backend. Empty means development mode,
// where `npm start` serves the website instead.
func staticDir() string {
	candidates := []string{os.Getenv("STATIC_DIR"), "public", filepath.Join("..", "frontend", "dist", "frontend", "browser")}
	for _, d := range candidates {
		if d == "" {
			continue
		}
		if _, err := os.Stat(filepath.Join(d, "index.html")); err == nil {
			abs, _ := filepath.Abs(d)
			return abs
		}
	}
	return ""
}

// Built files have a content hash in their name, so they can be cached forever.
var hashedFile = regexp.MustCompile(`-[A-Z0-9]{8}\.(js|css)$`)

// spaHandler serves the website's files, and index.html for app routes such
// as /invoices/12, so reloading any page works.
func spaHandler(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		p := path.Clean("/" + r.URL.Path)
		if p != "/" && !strings.HasSuffix(p, "/index.html") {
			if info, err := os.Stat(filepath.Join(dir, filepath.FromSlash(p))); err == nil && !info.IsDir() {
				if hashedFile.MatchString(p) {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				} else {
					w.Header().Set("Cache-Control", "public, max-age=3600")
				}
				files.ServeHTTP(w, r)
				return
			}
		}
		f, err := os.Open(filepath.Join(dir, "index.html"))
		if err != nil {
			http.Error(w, "Website not built", http.StatusNotFound)
			return
		}
		defer f.Close()
		info, _ := f.Stat()
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeContent(w, r, "index.html", info.ModTime(), f)
	})
}

// securityHeaders adds the browser protections a public website should have.
func securityHeaders(next http.Handler) http.Handler {
	const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
		"font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; " +
		"frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		h.Set("Content-Security-Policy", csp)
		if secureCookies(r) {
			h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}
