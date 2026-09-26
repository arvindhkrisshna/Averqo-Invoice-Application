package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// userError is a problem with the request that the user can fix.
// Handlers return it and respond with its message and status code.
type userError struct {
	status int
	msg    string
}

func (e *userError) Error() string { return e.msg }

func badRequest(msg string) error { return &userError{http.StatusBadRequest, msg} }
func notFound(msg string) error   { return &userError{http.StatusNotFound, msg} }
func conflict(msg string) error   { return &userError{http.StatusConflict, msg} }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("encode response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// fail sends a user-facing error as-is, "not found" for missing rows, and a
// generic 500 (with the details in the server log) for everything else.
func fail(w http.ResponseWriter, err error) {
	var ue *userError
	switch {
	case errors.As(err, &ue):
		writeError(w, ue.status, ue.msg)
	case errors.Is(err, sql.ErrNoRows):
		writeError(w, http.StatusNotFound, "That record doesn't exist. It may have been deleted.")
	default:
		log.Printf("internal error: %v", err)
		writeError(w, http.StatusInternalServerError, "Something went wrong on the server. Check the backend terminal for details.")
	}
}

func decodeJSON(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		return badRequest("The request body isn't valid JSON: " + err.Error())
	}
	return nil
}

func pathID(r *http.Request) (int64, error) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		return 0, badRequest("The id in the URL must be a positive number.")
	}
	return id, nil
}

// today returns ?today=YYYY-MM-DD from the browser (so "overdue" follows the
// user's own calendar day), falling back to the server's date.
func today(r *http.Request) string {
	if t := r.URL.Query().Get("today"); t != "" {
		if _, err := time.Parse(dateLayout, t); err == nil {
			return t
		}
	}
	return todayIST()
}

// Averqo is built for India, so the server's own "today" uses IST (UTC+5:30).
var istZone = time.FixedZone("IST", 5*3600+1800)

func todayIST() string { return time.Now().In(istZone).Format(dateLayout) }

const dateLayout = "2006-01-02"

func validDate(s string) bool {
	_, err := time.Parse(dateLayout, s)
	return err == nil
}

// likePattern escapes % and _ so user text is matched literally in LIKE.
func likePattern(q string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + r.Replace(q) + "%"
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		log.Printf("%s %s -> %d (%s)", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
	})
}
