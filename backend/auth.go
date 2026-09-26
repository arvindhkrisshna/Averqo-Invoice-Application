package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"net/mail"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------- Passwords ----------
// PBKDF2-HMAC-SHA256 (RFC 8018) with a random salt, 600,000 rounds as
// OWASP recommends. Stored as pbkdf2-sha256$<rounds>$<salt>$<hash>.

const passwordRounds = 600_000

func pbkdf2SHA256(password, salt []byte, rounds, keyLen int) []byte {
	prf := hmac.New(sha256.New, password)
	hLen := prf.Size()
	blocks := (keyLen + hLen - 1) / hLen
	out := make([]byte, 0, blocks*hLen)
	u := make([]byte, hLen)
	for block := 1; block <= blocks; block++ {
		prf.Reset()
		prf.Write(salt)
		prf.Write([]byte{byte(block >> 24), byte(block >> 16), byte(block >> 8), byte(block)})
		out = prf.Sum(out)
		t := out[len(out)-hLen:]
		copy(u, t)
		for n := 2; n <= rounds; n++ {
			prf.Reset()
			prf.Write(u)
			u = prf.Sum(u[:0])
			for i := range u {
				t[i] ^= u[i]
			}
		}
	}
	return out[:keyLen]
}

func hashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := pbkdf2SHA256([]byte(password), salt, passwordRounds, 32)
	enc := base64.RawStdEncoding
	return fmt.Sprintf("pbkdf2-sha256$%d$%s$%s", passwordRounds, enc.EncodeToString(salt), enc.EncodeToString(key)), nil
}

func checkPassword(stored, password string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" {
		return false
	}
	rounds, err := strconv.Atoi(parts[1])
	if err != nil || rounds < 1 {
		return false
	}
	enc := base64.RawStdEncoding
	salt, err1 := enc.DecodeString(parts[2])
	want, err2 := enc.DecodeString(parts[3])
	if err1 != nil || err2 != nil {
		return false
	}
	got := pbkdf2SHA256([]byte(password), salt, rounds, len(want))
	return subtle.ConstantTimeCompare(got, want) == 1
}

func validatePassword(p string) error {
	switch {
	case len(p) < 8:
		return badRequest("Use a password of at least 8 characters.")
	case len(p) > 200:
		return badRequest("That password is too long.")
	}
	return nil
}

// ---------- Users ----------

type User struct {
	ID          int64   `json:"id"`
	Name        string  `json:"name"`
	Email       string  `json:"email"`
	Role        string  `json:"role"` // owner | staff
	Active      bool    `json:"active"`
	LastLoginAt *string `json:"lastLoginAt"`
	CreatedAt   string  `json:"createdAt"`
}

const userColumns = `id, name, email, role, active, last_login_at, created_at`

func scanUser(row interface{ Scan(...any) error }) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Name, &u.Email, &u.Role, &u.Active, &u.LastLoginAt, &u.CreatedAt)
	return u, err
}

type ctxKey int

const userKey ctxKey = 1

func currentUser(r *http.Request) *User {
	u, _ := r.Context().Value(userKey).(*User)
	return u
}

func currentUserID(r *http.Request) any {
	if u := currentUser(r); u != nil {
		return u.ID
	}
	return nil
}

// requireOwner stops staff from changing business settings and the team.
func requireOwner(w http.ResponseWriter, r *http.Request) bool {
	if u := currentUser(r); u == nil || u.Role != "owner" {
		fail(w, &userError{http.StatusForbidden, "Only the account owner can do this."})
		return false
	}
	return true
}

// ---------- Sessions ----------

const sessionCookie = "averqo_session"
const sessionDays = 30

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func secureCookies(r *http.Request) bool {
	if v := os.Getenv("COOKIE_SECURE"); v != "" {
		return v == "true" || v == "1"
	}
	return r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
}

func (s *server) startSession(w http.ResponseWriter, r *http.Request, userID int64) error {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return err
	}
	token := base64.RawURLEncoding.EncodeToString(b)
	ua := r.UserAgent()
	if len(ua) > 255 {
		ua = ua[:255]
	}
	if _, err := s.db.ExecContext(r.Context(), `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent)
		VALUES (?, ?, UTC_TIMESTAMP() + INTERVAL ? DAY, ?)`, tokenHash(token), userID, sessionDays, ua); err != nil {
		return err
	}
	_, _ = s.db.ExecContext(r.Context(), `UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?`, userID)
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: token, Path: "/", MaxAge: sessionDays * 86400,
		HttpOnly: true, Secure: secureCookies(r), SameSite: http.SameSiteLaxMode})
	return nil
}

func clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: secureCookies(r), SameSite: http.SameSiteLaxMode})
}

// sessionUser returns the signed-in user for this request, or nil.
func (s *server) sessionUser(r *http.Request) *User {
	c, err := r.Cookie(sessionCookie)
	if err != nil || c.Value == "" || len(c.Value) > 100 {
		return nil
	}
	h := tokenHash(c.Value)
	var sessionID int64
	var stale bool
	u, err := scanUserWith(s.db.QueryRowContext(r.Context(), `SELECT s.id, s.last_seen_at < UTC_TIMESTAMP() - INTERVAL 10 MINUTE,
		u.id, u.name, u.email, u.role, u.active, u.last_login_at, u.created_at
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP() AND u.active = TRUE`, h), &sessionID, &stale)
	if err != nil {
		return nil
	}
	if stale { // sliding expiry, written at most every 10 minutes
		_, _ = s.db.ExecContext(r.Context(), `UPDATE sessions SET last_seen_at = UTC_TIMESTAMP(),
			expires_at = UTC_TIMESTAMP() + INTERVAL ? DAY WHERE id = ?`, sessionDays, sessionID)
	}
	return &u
}

func scanUserWith(row interface{ Scan(...any) error }, sessionID *int64, stale *bool) (User, error) {
	var u User
	err := row.Scan(sessionID, stale, &u.ID, &u.Name, &u.Email, &u.Role, &u.Active, &u.LastLoginAt, &u.CreatedAt)
	return u, err
}

// ---------- Guarding the API ----------

var publicAPI = map[string]bool{
	"/api/health": true, "/api/auth/status": true, "/api/auth/login": true, "/api/auth/setup": true,
}

// withAuth protects every /api route except sign-in. State-changing
// requests must also carry the X-Requested-With header, which browsers
// never add to cross-site form posts (CSRF protection).
func (s *server) withAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("X-Requested-With") == "" {
			fail(w, &userError{http.StatusForbidden, "This request was blocked for security. Reload the page and try again."})
			return
		}
		if publicAPI[r.URL.Path] {
			next.ServeHTTP(w, r)
			return
		}
		u := s.sessionUser(r)
		if u == nil {
			fail(w, &userError{http.StatusUnauthorized, "Please sign in."})
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey, u)))
	})
}

// ---------- Too many wrong passwords ----------

type attempt struct {
	count int
	first time.Time
}

type limiter struct {
	mu   sync.Mutex
	seen map[string]*attempt
}

var loginLimiter = &limiter{seen: map[string]*attempt{}}

const maxFailures = 10      // per email, from one address
const maxFailuresPerIP = 50 // from one address (an office may share one)
const failureWindow = 15 * time.Minute

func (l *limiter) blocked(key string, limit int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	a, ok := l.seen[key]
	if !ok {
		return false
	}
	if time.Since(a.first) > failureWindow {
		delete(l.seen, key)
		return false
	}
	return a.count >= limit
}

func (l *limiter) fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.seen) > 10000 { // forget old entries so memory stays small
		for k, a := range l.seen {
			if time.Since(a.first) > failureWindow {
				delete(l.seen, k)
			}
		}
	}
	a, ok := l.seen[key]
	if !ok || time.Since(a.first) > failureWindow {
		l.seen[key] = &attempt{1, time.Now()}
		return
	}
	a.count++
}

func (l *limiter) reset(key string) {
	l.mu.Lock()
	delete(l.seen, key)
	l.mu.Unlock()
}

func clientIP(r *http.Request) string {
	if os.Getenv("TRUST_PROXY") == "1" {
		if f := r.Header.Get("X-Forwarded-For"); f != "" {
			return strings.TrimSpace(strings.Split(f, ",")[0])
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// ---------- Handlers ----------

func (s *server) userCount(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

// GET /api/auth/status
func (s *server) authStatus(w http.ResponseWriter, r *http.Request) {
	n, err := s.userCount(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"setupNeeded": n == 0, "setupCodeRequired": n == 0 && os.Getenv("SETUP_CODE") != "", "user": s.sessionUser(r)})
}

type credentials struct {
	Name      string `json:"name"`
	Email     string `json:"email"`
	Password  string `json:"password"`
	SetupCode string `json:"setupCode"`
}

func cleanEmail(e string) (string, error) {
	e = strings.ToLower(strings.TrimSpace(e))
	if a, err := mail.ParseAddress(e); err != nil || a.Address != e || len(e) > 255 {
		return "", badRequest("Enter a valid email address.")
	}
	return e, nil
}

// POST /api/auth/setup: creates the owner account. Only works while there are no users.
func (s *server) authSetup(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if err := decodeJSON(w, r, &c); err != nil {
		fail(w, err)
		return
	}
	if code := os.Getenv("SETUP_CODE"); code != "" && subtle.ConstantTimeCompare([]byte(code), []byte(c.SetupCode)) != 1 {
		fail(w, &userError{http.StatusForbidden, "That setup code isn't right. It's the SETUP_CODE set on the server."})
		return
	}
	c.Name = strings.TrimSpace(c.Name)
	email, err := cleanEmail(c.Email)
	if err != nil {
		fail(w, err)
		return
	}
	if c.Name == "" || len(c.Name) > 100 {
		fail(w, badRequest("Enter your name."))
		return
	}
	if err := validatePassword(c.Password); err != nil {
		fail(w, err)
		return
	}
	hash, err := hashPassword(c.Password)
	if err != nil {
		fail(w, err)
		return
	}
	ctx := r.Context()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		fail(w, err)
		return
	}
	defer tx.Rollback()
	var n int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM users FOR UPDATE`).Scan(&n); err != nil {
		fail(w, err)
		return
	}
	if n > 0 {
		fail(w, conflict("This Averqo account is already set up. Sign in instead."))
		return
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'owner')`, c.Name, email, hash)
	if err != nil {
		fail(w, err)
		return
	}
	id, _ := res.LastInsertId()
	if err := tx.Commit(); err != nil {
		fail(w, err)
		return
	}
	if err := s.startSession(w, r, id); err != nil {
		fail(w, err)
		return
	}
	s.writeUser(w, r, id, http.StatusCreated)
}

func (s *server) writeUser(w http.ResponseWriter, r *http.Request, id int64, status int) {
	u, err := scanUser(s.db.QueryRowContext(r.Context(), `SELECT `+userColumns+` FROM users WHERE id = ?`, id))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, status, u)
}

// POST /api/auth/login
func (s *server) authLogin(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if err := decodeJSON(w, r, &c); err != nil {
		fail(w, err)
		return
	}
	email := strings.ToLower(strings.TrimSpace(c.Email))
	key := clientIP(r) + "|" + email
	if loginLimiter.blocked(key, maxFailures) || loginLimiter.blocked(clientIP(r), maxFailuresPerIP) {
		fail(w, &userError{http.StatusTooManyRequests, "Too many wrong attempts. Wait 15 minutes, then try again."})
		return
	}
	var id int64
	var hash string
	var active bool
	err := s.db.QueryRowContext(r.Context(), `SELECT id, password_hash, active FROM users WHERE email = ?`, email).Scan(&id, &hash, &active)
	if err != nil || !checkPassword(hash, c.Password) {
		if err != nil {
			checkPassword("pbkdf2-sha256$600000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", c.Password) // same timing either way
		}
		loginLimiter.fail(key)
		loginLimiter.fail(clientIP(r))
		fail(w, &userError{http.StatusUnauthorized, "That email and password don't match."})
		return
	}
	if !active {
		fail(w, &userError{http.StatusForbidden, "This account has been turned off. Ask the owner to turn it back on."})
		return
	}
	loginLimiter.reset(key)
	if err := s.startSession(w, r, id); err != nil {
		fail(w, err)
		return
	}
	s.writeUser(w, r, id, http.StatusOK)
}

// POST /api/auth/logout
func (s *server) authLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		_, _ = s.db.ExecContext(r.Context(), `DELETE FROM sessions WHERE token_hash = ?`, tokenHash(c.Value))
	}
	clearSessionCookie(w, r)
	w.WriteHeader(http.StatusNoContent)
}

// POST /api/auth/password {"currentPassword", "newPassword"}: also signs out other devices.
func (s *server) authChangePassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		fail(w, err)
		return
	}
	u := currentUser(r)
	var hash string
	if err := s.db.QueryRowContext(r.Context(), `SELECT password_hash FROM users WHERE id = ?`, u.ID).Scan(&hash); err != nil {
		fail(w, err)
		return
	}
	if !checkPassword(hash, body.CurrentPassword) {
		fail(w, badRequest("Your current password isn't right."))
		return
	}
	if err := validatePassword(body.NewPassword); err != nil {
		fail(w, err)
		return
	}
	newHash, err := hashPassword(body.NewPassword)
	if err != nil {
		fail(w, err)
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `UPDATE users SET password_hash = ? WHERE id = ?`, newHash, u.ID); err != nil {
		fail(w, err)
		return
	}
	c, _ := r.Cookie(sessionCookie)
	_, _ = s.db.ExecContext(r.Context(), `DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?`, u.ID, tokenHash(c.Value))
	writeJSON(w, http.StatusOK, map[string]string{"status": "changed"})
}

// ---------- Team (owner only) ----------

func (s *server) listUsers(w http.ResponseWriter, r *http.Request) {
	if !requireOwner(w, r) {
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `SELECT `+userColumns+` FROM users ORDER BY role, name`)
	if err != nil {
		fail(w, err)
		return
	}
	defer rows.Close()
	list := []User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			fail(w, err)
			return
		}
		list = append(list, u)
	}
	writeJSON(w, http.StatusOK, list)
}

type userInput struct {
	Name     string `json:"name"`
	Email    string `json:"email"`
	Role     string `json:"role"`
	Active   *bool  `json:"active"`
	Password string `json:"password"`
}

func (in *userInput) validate(needPassword bool) error {
	in.Name = strings.TrimSpace(in.Name)
	email, err := cleanEmail(in.Email)
	if err != nil {
		return err
	}
	in.Email = email
	switch {
	case in.Name == "" || len(in.Name) > 100:
		return badRequest("Enter their name.")
	case in.Role != "owner" && in.Role != "staff":
		return badRequest("Choose a role.")
	}
	if needPassword {
		return validatePassword(in.Password)
	}
	return nil
}

func isDuplicate(err error) bool { return err != nil && strings.Contains(err.Error(), "Duplicate entry") }

func (s *server) createUser(w http.ResponseWriter, r *http.Request) {
	if !requireOwner(w, r) {
		return
	}
	var in userInput
	if err := decodeJSON(w, r, &in); err != nil {
		fail(w, err)
		return
	}
	if err := in.validate(true); err != nil {
		fail(w, err)
		return
	}
	hash, err := hashPassword(in.Password)
	if err != nil {
		fail(w, err)
		return
	}
	res, err := s.db.ExecContext(r.Context(), `INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)`,
		in.Name, in.Email, hash, in.Role)
	if isDuplicate(err) {
		fail(w, conflict("Someone with that email is already on the team."))
		return
	} else if err != nil {
		fail(w, err)
		return
	}
	id, _ := res.LastInsertId()
	s.writeUser(w, r, id, http.StatusCreated)
}

// otherActiveOwners counts owners other than id, so the last owner can't be removed.
func (s *server) otherActiveOwners(ctx context.Context, id int64) int {
	var n int
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE role = 'owner' AND active = TRUE AND id <> ?`, id).Scan(&n)
	return n
}

func (s *server) updateUser(w http.ResponseWriter, r *http.Request) {
	if !requireOwner(w, r) {
		return
	}
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	var in userInput
	if err := decodeJSON(w, r, &in); err != nil {
		fail(w, err)
		return
	}
	if err := in.validate(false); err != nil {
		fail(w, err)
		return
	}
	active := in.Active == nil || *in.Active
	if (in.Role != "owner" || !active) && s.otherActiveOwners(r.Context(), id) == 0 {
		fail(w, conflict("Averqo needs at least one active owner. Make someone else an owner first."))
		return
	}
	_, err = s.db.ExecContext(r.Context(), `UPDATE users SET name = ?, email = ?, role = ?, active = ? WHERE id = ?`,
		in.Name, in.Email, in.Role, active, id)
	if isDuplicate(err) {
		fail(w, conflict("Someone with that email is already on the team."))
		return
	} else if err != nil {
		fail(w, err)
		return
	}
	if !active {
		_, _ = s.db.ExecContext(r.Context(), `DELETE FROM sessions WHERE user_id = ?`, id)
	}
	s.writeUser(w, r, id, http.StatusOK)
}

// POST /api/users/{id}/password: the owner sets a new password for someone.
func (s *server) resetUserPassword(w http.ResponseWriter, r *http.Request) {
	if !requireOwner(w, r) {
		return
	}
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	var body struct {
		Password string `json:"password"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		fail(w, err)
		return
	}
	if err := validatePassword(body.Password); err != nil {
		fail(w, err)
		return
	}
	hash, err := hashPassword(body.Password)
	if err != nil {
		fail(w, err)
		return
	}
	res, err := s.db.ExecContext(r.Context(), `UPDATE users SET password_hash = ? WHERE id = ?`, hash, id)
	if err != nil {
		fail(w, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, notFound("Team member not found."))
		return
	}
	if id != currentUser(r).ID {
		_, _ = s.db.ExecContext(r.Context(), `DELETE FROM sessions WHERE user_id = ?`, id)
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "changed"})
}

func (s *server) deleteUser(w http.ResponseWriter, r *http.Request) {
	if !requireOwner(w, r) {
		return
	}
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	if id == currentUser(r).ID {
		fail(w, conflict("You can't remove yourself."))
		return
	}
	if s.otherActiveOwners(r.Context(), id) == 0 {
		fail(w, conflict("Averqo needs at least one active owner."))
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `DELETE FROM users WHERE id = ?`, id); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
