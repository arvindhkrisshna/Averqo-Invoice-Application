// Averqo API server. In production it also serves the built website, so the
// whole app runs as one program on one port.
package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-sql-driver/mysql"
)

type server struct {
	db *sql.DB
}

func main() {
	db, err := openDB()
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer db.Close()

	if err := runMigrations(db); err != nil {
		log.Fatalf("migrations: %v", err)
	}

	s := &server{db: db}
	mux := http.NewServeMux()
	s.routes(mux)

	if dir := staticDir(); dir != "" {
		log.Printf("serving the website from %s", dir)
		mux.Handle("/", spaHandler(dir))
	}

	// Creates recurring invoices when due, and clears expired sign-ins.
	s.startScheduler()
	go s.cleanSessions()

	addr := ":" + env("PORT", "8080")
	srv := &http.Server{
		Addr:              addr,
		Handler:           logRequests(securityHeaders(s.withAuth(mux))),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      120 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		log.Printf("Averqo is listening on http://localhost%s", addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server: %v", err)
		}
	}()
	<-ctx.Done()
	log.Printf("shutting down…")
	shutdown, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdown) // lets requests in progress finish
}

func (s *server) routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/health", s.health)
	mux.HandleFunc("GET /api/auth/status", s.authStatus)
	mux.HandleFunc("POST /api/auth/setup", s.authSetup)
	mux.HandleFunc("POST /api/auth/login", s.authLogin)
	mux.HandleFunc("POST /api/auth/logout", s.authLogout)
	mux.HandleFunc("POST /api/auth/password", s.authChangePassword)
	mux.HandleFunc("GET /api/users", s.listUsers)
	mux.HandleFunc("POST /api/users", s.createUser)
	mux.HandleFunc("PUT /api/users/{id}", s.updateUser)
	mux.HandleFunc("POST /api/users/{id}/password", s.resetUserPassword)
	mux.HandleFunc("DELETE /api/users/{id}", s.deleteUser)

	mux.HandleFunc("GET /api/meta", s.meta)
	mux.HandleFunc("GET /api/dashboard", s.dashboard)
	mux.HandleFunc("GET /api/search", s.search)

	mux.HandleFunc("GET /api/organization", s.getOrganization)
	mux.HandleFunc("PUT /api/organization", s.updateOrganization)

	mux.HandleFunc("GET /api/customers", s.listCustomers)
	mux.HandleFunc("POST /api/customers", s.createCustomer)
	mux.HandleFunc("GET /api/customers/{id}", s.getCustomer)
	mux.HandleFunc("PUT /api/customers/{id}", s.updateCustomer)
	mux.HandleFunc("PATCH /api/customers/{id}/archive", s.archiveCustomer)
	mux.HandleFunc("DELETE /api/customers/{id}", s.deleteCustomer)
	mux.HandleFunc("GET /api/customers/{id}/unbilled", s.customerUnbilled)
	mux.HandleFunc("GET /api/customers/{id}/statement", s.customerStatement)

	mux.HandleFunc("GET /api/items", s.listItems)
	mux.HandleFunc("POST /api/items", s.createItem)
	mux.HandleFunc("GET /api/items/{id}", s.getItem)
	mux.HandleFunc("PUT /api/items/{id}", s.updateItem)
	mux.HandleFunc("PATCH /api/items/{id}/archive", s.archiveItem)
	mux.HandleFunc("DELETE /api/items/{id}", s.deleteItem)

	mux.HandleFunc("GET /api/invoices", s.listInvoices)
	mux.HandleFunc("POST /api/invoices", s.createInvoice)
	mux.HandleFunc("GET /api/invoices/{id}", s.getInvoice)
	mux.HandleFunc("PUT /api/invoices/{id}", s.updateInvoice)
	mux.HandleFunc("POST /api/invoices/{id}/send", s.sendInvoice)
	mux.HandleFunc("POST /api/invoices/{id}/void", s.voidInvoice)
	mux.HandleFunc("DELETE /api/invoices/{id}", s.deleteInvoice)
	mux.HandleFunc("GET /api/invoices/{id}/pdf", s.invoicePDF)
	mux.HandleFunc("GET /api/invoices/{id}/upi-qr.png", s.invoiceUPIQR)
	mux.HandleFunc("POST /api/invoices/{id}/email", s.emailInvoice)
	mux.HandleFunc("POST /api/invoices/{id}/shared", s.sharedInvoice)

	// Quotes, delivery challans, credit notes (same endpoints for each).
	s.registerDocumentRoutes(mux)

	mux.HandleFunc("GET /api/recurring", s.listRecurring)
	mux.HandleFunc("POST /api/recurring", s.saveRecurring)
	mux.HandleFunc("GET /api/recurring/{id}", s.getRecurring)
	mux.HandleFunc("PUT /api/recurring/{id}", s.saveRecurring)
	mux.HandleFunc("POST /api/recurring/{id}/status", s.setRecurringStatus)
	mux.HandleFunc("POST /api/recurring/{id}/run", s.runRecurringNow)
	mux.HandleFunc("DELETE /api/recurring/{id}", s.deleteRecurring)

	mux.HandleFunc("GET /api/email/status", s.emailStatus)
	mux.HandleFunc("POST /api/email/test", s.emailTest)

	mux.HandleFunc("GET /api/payments", s.listPayments)
	mux.HandleFunc("POST /api/payments", s.createPayment)
	mux.HandleFunc("GET /api/payments/{id}", s.getPayment)
	mux.HandleFunc("DELETE /api/payments/{id}", s.deletePayment)

	mux.HandleFunc("GET /api/expenses", s.listExpenses)
	mux.HandleFunc("POST /api/expenses", s.saveExpense)
	mux.HandleFunc("GET /api/expenses/{id}", s.getExpense)
	mux.HandleFunc("PUT /api/expenses/{id}", s.saveExpense)
	mux.HandleFunc("DELETE /api/expenses/{id}", s.deleteExpense)
	mux.HandleFunc("POST /api/expenses/{id}/receipt", s.uploadReceipt)
	mux.HandleFunc("GET /api/expenses/{id}/receipt", s.getReceipt)
	mux.HandleFunc("DELETE /api/expenses/{id}/receipt", s.deleteReceipt)
	mux.HandleFunc("GET /api/expense-categories", s.listExpenseCategories)
	mux.HandleFunc("POST /api/expense-categories", s.saveExpenseCategory)
	mux.HandleFunc("PUT /api/expense-categories/{id}", s.saveExpenseCategory)
	mux.HandleFunc("DELETE /api/expense-categories/{id}", s.deleteExpenseCategory)
	mux.HandleFunc("GET /api/vendors", s.listVendors)

	mux.HandleFunc("GET /api/projects", s.listProjects)
	mux.HandleFunc("POST /api/projects", s.saveProject)
	mux.HandleFunc("GET /api/projects/{id}", s.getProject)
	mux.HandleFunc("PUT /api/projects/{id}", s.saveProject)
	mux.HandleFunc("DELETE /api/projects/{id}", s.deleteProject)
	mux.HandleFunc("GET /api/time-entries", s.listTimeEntries)
	mux.HandleFunc("POST /api/time-entries", s.saveTimeEntry)
	mux.HandleFunc("PUT /api/time-entries/{id}", s.saveTimeEntry)
	mux.HandleFunc("DELETE /api/time-entries/{id}", s.deleteTimeEntry)
	mux.HandleFunc("GET /api/timer", s.getTimer)
	mux.HandleFunc("POST /api/timer/start", s.startTimer)
	mux.HandleFunc("POST /api/timer/stop", s.stopTimer)

	mux.HandleFunc("GET /api/gst/gstr1", s.getGSTR1)
	mux.HandleFunc("GET /api/gst/gstr1.json", s.downloadGSTR1JSON)
	mux.HandleFunc("GET /api/gst/gstr3b", s.getGSTR3B)
	mux.HandleFunc("GET /api/gst/returns", s.listGSTReturns)
	mux.HandleFunc("POST /api/gst/returns", s.markGSTReturnFiled)
	mux.HandleFunc("DELETE /api/gst/returns/{id}", s.unmarkGSTReturn)

	mux.HandleFunc("GET /api/reports/{key}", s.getReport)

	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		fail(w, notFound("That API route doesn't exist."))
	})
}

// openDB connects to MySQL using DB_* environment variables and waits for
// the database to become ready (MySQL can take ~30s on first start).
func openDB() (*sql.DB, error) {
	cfg := mysql.NewConfig()
	cfg.User = env("DB_USER", "invoice")
	cfg.Passwd = env("DB_PASSWORD", "invoicepass")
	cfg.Net = "tcp"
	cfg.Addr = env("DB_HOST", "db") + ":" + env("DB_PORT", "3306")
	cfg.DBName = env("DB_NAME", "invoicedb")
	cfg.ClientFoundRows = true // UPDATE reports matched rows, even if unchanged

	db, err := sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(20)
	db.SetMaxIdleConns(10)
	db.SetConnMaxLifetime(5 * time.Minute)

	for attempt := 1; attempt <= 30; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		err = db.PingContext(ctx)
		cancel()
		if err == nil {
			log.Printf("connected to MySQL at %s", cfg.Addr)
			return db, nil
		}
		log.Printf("waiting for MySQL (attempt %d/30): %v", attempt, err)
		time.Sleep(2 * time.Second)
	}
	db.Close()
	return nil, err
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func (s *server) health(w http.ResponseWriter, r *http.Request) {
	if err := s.db.PingContext(r.Context()); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "error", "database": "unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "database": "connected"})
}

func (s *server) cleanSessions() {
	for {
		_, _ = s.db.Exec(`DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP()`)
		time.Sleep(time.Hour)
	}
}
