package main

import (
	"context"
	"net/http"
	"strings"
	"time"
)

// Open (sent, not fully paid) invoices with their remaining balance.
const openInvoices = `(SELECT i.id, i.invoice_number, i.customer_id, i.customer_name, i.due_date, i.total,
	` + invoiceBalanceSQL + ` AS balance FROM invoices i WHERE i.lifecycle = 'sent') AS b`

type invoiceBrief struct {
	ID            int64  `json:"id"`
	InvoiceNumber string `json:"invoiceNumber"`
	CustomerName  string `json:"customerName"`
	DueDate       string `json:"dueDate"`
	Amount        Dec2   `json:"amount"` // balance, or total for drafts
}

type monthTotals struct {
	Month    string `json:"month"` // YYYY-MM
	Invoiced Dec2   `json:"invoiced"`
	Received Dec2   `json:"received"`
}

type agingBucket struct {
	Label  string `json:"label"`
	Amount Dec2   `json:"amount"`
}

type Dashboard struct {
	Receivables       Dec2           `json:"receivables"`
	Overdue           Dec2           `json:"overdue"`
	DueThisWeek       Dec2           `json:"dueThisWeek"`
	InvoicedThisMonth Dec2           `json:"invoicedThisMonth"`
	ReceivedThisMonth Dec2           `json:"receivedThisMonth"`
	OverdueInvoices   []invoiceBrief `json:"overdueInvoices"`
	DueSoonInvoices   []invoiceBrief `json:"dueSoonInvoices"`
	DraftInvoices     []invoiceBrief `json:"draftInvoices"`
	DraftCount        int            `json:"draftCount"`
	Months            []monthTotals  `json:"months"`
	Aging             []agingBucket  `json:"aging"`
	RecentPayments    []Payment      `json:"recentPayments"`
	Setup             map[string]any `json:"setup"`
}

// GET /api/dashboard?today=YYYY-MM-DD
func (s *server) dashboard(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	t := today(r)
	d := Dashboard{}
	q := s.db.QueryRowContext

	scalars := []struct {
		dest *Dec2
		sql  string
		args []any
	}{
		{&d.Receivables, `SELECT COALESCE(SUM(balance), 0) FROM ` + openInvoices + ` WHERE balance > 0`, nil},
		{&d.Overdue, `SELECT COALESCE(SUM(balance), 0) FROM ` + openInvoices + ` WHERE balance > 0 AND due_date < ?`, []any{t}},
		{&d.DueThisWeek, `SELECT COALESCE(SUM(balance), 0) FROM ` + openInvoices +
			` WHERE balance > 0 AND due_date BETWEEN ? AND DATE_ADD(?, INTERVAL 7 DAY)`, []any{t, t}},
		{&d.InvoicedThisMonth, `SELECT COALESCE(SUM(total), 0) FROM invoices WHERE lifecycle = 'sent'
			AND DATE_FORMAT(issue_date, '%Y-%m') = DATE_FORMAT(?, '%Y-%m')`, []any{t}},
		{&d.ReceivedThisMonth, `SELECT COALESCE(SUM(amount), 0) FROM payments
			WHERE DATE_FORMAT(payment_date, '%Y-%m') = DATE_FORMAT(?, '%Y-%m')`, []any{t}},
	}
	for _, sc := range scalars {
		if err := q(ctx, sc.sql, sc.args...).Scan(sc.dest); err != nil {
			fail(w, err)
			return
		}
	}

	var err error
	if d.OverdueInvoices, err = s.briefs(ctx, `SELECT id, invoice_number, customer_name, due_date, balance FROM `+
		openInvoices+` WHERE balance > 0 AND due_date < ? ORDER BY due_date LIMIT 5`, t); err != nil {
		fail(w, err)
		return
	}
	if d.DueSoonInvoices, err = s.briefs(ctx, `SELECT id, invoice_number, customer_name, due_date, balance FROM `+
		openInvoices+` WHERE balance > 0 AND due_date BETWEEN ? AND DATE_ADD(?, INTERVAL 7 DAY) ORDER BY due_date LIMIT 5`, t, t); err != nil {
		fail(w, err)
		return
	}
	if d.DraftInvoices, err = s.briefs(ctx, `SELECT id, invoice_number, customer_name, due_date, total FROM invoices
		WHERE lifecycle = 'draft' ORDER BY created_at DESC LIMIT 3`); err != nil {
		fail(w, err)
		return
	}
	if err := q(ctx, `SELECT COUNT(*) FROM invoices WHERE lifecycle = 'draft'`).Scan(&d.DraftCount); err != nil {
		fail(w, err)
		return
	}

	// Last six months of invoicing and payments, oldest first.
	start, _ := time.Parse(dateLayout, t)
	start = time.Date(start.Year(), start.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, -5, 0)
	for i := 0; i < 6; i++ {
		m := start.AddDate(0, i, 0).Format("2006-01")
		mt := monthTotals{Month: m}
		if err := q(ctx, `SELECT COALESCE(SUM(total), 0) FROM invoices WHERE lifecycle = 'sent'
			AND DATE_FORMAT(issue_date, '%Y-%m') = ?`, m).Scan(&mt.Invoiced); err != nil {
			fail(w, err)
			return
		}
		if err := q(ctx, `SELECT COALESCE(SUM(amount), 0) FROM payments WHERE DATE_FORMAT(payment_date, '%Y-%m') = ?`, m).
			Scan(&mt.Received); err != nil {
			fail(w, err)
			return
		}
		d.Months = append(d.Months, mt)
	}

	// How long unpaid money has been waiting past its due date.
	var b0, b1, b2, b3, b4 Dec2
	if err := q(ctx, `SELECT
		COALESCE(SUM(CASE WHEN DATEDIFF(?, due_date) <= 0 THEN balance END), 0),
		COALESCE(SUM(CASE WHEN DATEDIFF(?, due_date) BETWEEN 1 AND 15 THEN balance END), 0),
		COALESCE(SUM(CASE WHEN DATEDIFF(?, due_date) BETWEEN 16 AND 30 THEN balance END), 0),
		COALESCE(SUM(CASE WHEN DATEDIFF(?, due_date) BETWEEN 31 AND 60 THEN balance END), 0),
		COALESCE(SUM(CASE WHEN DATEDIFF(?, due_date) > 60 THEN balance END), 0)
		FROM `+openInvoices+` WHERE balance > 0`, t, t, t, t, t).Scan(&b0, &b1, &b2, &b3, &b4); err != nil {
		fail(w, err)
		return
	}
	d.Aging = []agingBucket{{"Not due yet", b0}, {"1–15 days", b1}, {"16–30 days", b2}, {"31–60 days", b3}, {"Over 60 days", b4}}

	rows, err := s.db.QueryContext(ctx, paymentSelect+` ORDER BY p.payment_date DESC, p.id DESC LIMIT 5`)
	if err != nil {
		fail(w, err)
		return
	}
	d.RecentPayments = []Payment{}
	for rows.Next() {
		p, err := scanPayment(rows)
		if err != nil {
			rows.Close()
			fail(w, err)
			return
		}
		d.RecentPayments = append(d.RecentPayments, p)
	}
	rows.Close()

	// Getting-started checklist.
	var orgName, orgState string
	var customers, items, invoices, sent, payments int
	if err := q(ctx, `SELECT name, state_code,
		(SELECT COUNT(*) FROM customers), (SELECT COUNT(*) FROM items), (SELECT COUNT(*) FROM invoices),
		(SELECT COUNT(*) FROM invoices WHERE lifecycle = 'sent'), (SELECT COUNT(*) FROM payments)
		FROM organization WHERE id = 1`).Scan(&orgName, &orgState, &customers, &items, &invoices, &sent, &payments); err != nil {
		fail(w, err)
		return
	}
	d.Setup = map[string]any{
		"profile":   orgName != "" && orgState != "",
		"customer":  customers > 0,
		"item":      items > 0,
		"invoice":   invoices > 0,
		"sent":      sent > 0,
		"payment":   payments > 0,
		"orgName":   orgName,
		"customers": customers,
		"invoices":  invoices,
	}
	writeJSON(w, http.StatusOK, d)
}

func (s *server) briefs(ctx context.Context, query string, args ...any) ([]invoiceBrief, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []invoiceBrief{}
	for rows.Next() {
		var b invoiceBrief
		if err := rows.Scan(&b.ID, &b.InvoiceNumber, &b.CustomerName, &b.DueDate, &b.Amount); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

type searchResult struct {
	Type     string `json:"type"` // customer | invoice | item | payment
	ID       int64  `json:"id"`
	Title    string `json:"title"`
	Subtitle string `json:"subtitle"`
}

// GET /api/search?q=text: up to 5 matches each from customers, invoices, items, and payments.
func (s *server) search(w http.ResponseWriter, r *http.Request) {
	term := strings.TrimSpace(r.URL.Query().Get("q"))
	results := []searchResult{}
	if term == "" {
		writeJSON(w, http.StatusOK, results)
		return
	}
	like := likePattern(term)
	// Each query returns id, title, a text detail, and an amount; the amount is
	// formatted here so it reads the Indian way (₹1,07,775.00).
	queries := []struct {
		kind, sql, joiner string
		args              []any
	}{
		{"customer", `SELECT id, display_name, CONCAT_WS(' · ', NULLIF(email, ''), NULLIF(gstin, '')), NULL
			FROM customers WHERE display_name LIKE ? OR email LIKE ? OR gstin LIKE ? ORDER BY archived, display_name LIMIT 5`,
			"", []any{like, like, like}},
		{"invoice", `SELECT id, invoice_number, customer_name, total
			FROM invoices WHERE invoice_number LIKE ? OR customer_name LIKE ? OR reference LIKE ? ORDER BY issue_date DESC LIMIT 5`,
			" · ", []any{like, like, like}},
		{"item", `SELECT id, name, CONCAT('per ', unit), rate FROM items
			WHERE name LIKE ? OR hsn_sac LIKE ? ORDER BY archived, name LIMIT 5`, "prefix", []any{like, like}},
		{"document", `SELECT id, doc_number, CONCAT(doc_type, '|', customer_name), total FROM documents
			WHERE doc_number LIKE ? OR customer_name LIKE ? OR reference LIKE ? ORDER BY issue_date DESC LIMIT 8`,
			" · ", []any{like, like, like}},
		{"payment", `SELECT p.id, p.payment_number, c.display_name, p.amount
			FROM payments p JOIN customers c ON c.id = p.customer_id
			WHERE p.payment_number LIKE ? OR p.reference LIKE ? OR c.display_name LIKE ? ORDER BY p.payment_date DESC LIMIT 5`,
			" · ", []any{like, like, like}},
	}
	for _, sq := range queries {
		rows, err := s.db.QueryContext(r.Context(), sq.sql, sq.args...)
		if err != nil {
			fail(w, err)
			return
		}
		for rows.Next() {
			res := searchResult{Type: sq.kind}
			var detail string
			var amount *Dec2
			if err := rows.Scan(&res.ID, &res.Title, &detail, &amount); err != nil {
				rows.Close()
				fail(w, err)
				return
			}
			if sq.kind == "document" { // detail is "quote|Customer name"
				res.Type, detail, _ = strings.Cut(detail, "|")
			}
			switch {
			case amount == nil:
				res.Subtitle = detail
			case sq.joiner == "prefix":
				res.Subtitle = amount.Rupees() + " " + detail
			default:
				res.Subtitle = detail + sq.joiner + amount.Rupees()
			}
			results = append(results, res)
		}
		rows.Close()
	}
	writeJSON(w, http.StatusOK, results)
}
