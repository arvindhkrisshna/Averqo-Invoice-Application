package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

type PaymentAllocation struct {
	InvoiceID     int64  `json:"invoiceId"`
	InvoiceNumber string `json:"invoiceNumber"`
	Amount        Dec2   `json:"amount"`
}

type Payment struct {
	ID            int64               `json:"id"`
	PaymentNumber string              `json:"paymentNumber"`
	CustomerID    int64               `json:"customerId"`
	CustomerName  string              `json:"customerName"`
	PaymentDate   string              `json:"paymentDate"`
	Amount        Dec2                `json:"amount"`
	Mode          string              `json:"mode"`
	Reference     string              `json:"reference"`
	Notes         string              `json:"notes"`
	CreatedAt     string              `json:"createdAt"`
	InvoiceNums   string              `json:"invoiceNumbers"` // comma-separated, for lists
	Allocations   []PaymentAllocation `json:"allocations,omitempty"`
}

const paymentSelect = `SELECT p.id, p.payment_number, p.customer_id, c.display_name, p.payment_date, p.amount,
	p.mode, p.reference, p.notes, p.created_at,
	COALESCE((SELECT GROUP_CONCAT(i.invoice_number ORDER BY i.invoice_number SEPARATOR ', ')
	          FROM payment_allocations pa JOIN invoices i ON i.id = pa.invoice_id WHERE pa.payment_id = p.id), '')
	FROM payments p JOIN customers c ON c.id = p.customer_id`

func scanPayment(row interface{ Scan(...any) error }) (Payment, error) {
	var p Payment
	err := row.Scan(&p.ID, &p.PaymentNumber, &p.CustomerID, &p.CustomerName, &p.PaymentDate, &p.Amount,
		&p.Mode, &p.Reference, &p.Notes, &p.CreatedAt, &p.InvoiceNums)
	return p, err
}

// GET /api/payments[?customerId=1]
func (s *server) listPayments(w http.ResponseWriter, r *http.Request) {
	q := paymentSelect
	var args []any
	if cid, err := strconv.ParseInt(r.URL.Query().Get("customerId"), 10, 64); err == nil {
		q += ` WHERE p.customer_id = ?`
		args = append(args, cid)
	}
	rows, err := s.db.QueryContext(r.Context(), q+` ORDER BY p.payment_date DESC, p.id DESC`, args...)
	if err != nil {
		fail(w, err)
		return
	}
	defer rows.Close()
	list := []Payment{}
	for rows.Next() {
		p, err := scanPayment(rows)
		if err != nil {
			fail(w, err)
			return
		}
		list = append(list, p)
	}
	if err := rows.Err(); err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *server) loadPayment(ctx context.Context, id int64) (Payment, error) {
	p, err := scanPayment(s.db.QueryRowContext(ctx, paymentSelect+` WHERE p.id = ?`, id))
	if err != nil {
		return p, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT pa.invoice_id, i.invoice_number, pa.amount
		FROM payment_allocations pa JOIN invoices i ON i.id = pa.invoice_id
		WHERE pa.payment_id = ? ORDER BY i.due_date, i.id`, id)
	if err != nil {
		return p, err
	}
	defer rows.Close()
	p.Allocations = []PaymentAllocation{}
	for rows.Next() {
		var a PaymentAllocation
		if err := rows.Scan(&a.InvoiceID, &a.InvoiceNumber, &a.Amount); err != nil {
			return p, err
		}
		p.Allocations = append(p.Allocations, a)
	}
	return p, rows.Err()
}

func (s *server) getPayment(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	p, err := s.loadPayment(r.Context(), id)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

type PaymentInput struct {
	CustomerID  int64  `json:"customerId"`
	PaymentDate string `json:"paymentDate"`
	Amount      Dec2   `json:"amount"`
	Mode        string `json:"mode"`
	Reference   string `json:"reference"`
	Notes       string `json:"notes"`
	Allocations []struct {
		InvoiceID int64 `json:"invoiceId"`
		Amount    Dec2  `json:"amount"`
	} `json:"allocations"`
}

// POST /api/payments
func (s *server) createPayment(w http.ResponseWriter, r *http.Request) {
	var in PaymentInput
	if err := decodeJSON(w, r, &in); err != nil {
		fail(w, err)
		return
	}
	in.Reference = strings.TrimSpace(in.Reference)
	switch {
	case in.CustomerID <= 0:
		fail(w, badRequest("Choose the customer who paid."))
		return
	case !validDate(in.PaymentDate):
		fail(w, badRequest("Enter a valid payment date."))
		return
	case in.Amount <= 0:
		fail(w, badRequest("Enter the amount received."))
		return
	case !validPaymentMode(in.Mode):
		fail(w, badRequest("Choose how you were paid."))
		return
	case len(in.Reference) > 100 || len(in.Notes) > 500:
		fail(w, badRequest("Reference or notes are too long."))
		return
	}

	var allocated Dec2
	seen := map[int64]bool{}
	for _, a := range in.Allocations {
		if a.Amount < 0 {
			fail(w, badRequest("Amounts applied to invoices can't be negative."))
			return
		}
		if seen[a.InvoiceID] {
			fail(w, badRequest("Each invoice can appear only once in a payment."))
			return
		}
		seen[a.InvoiceID] = true
		allocated += a.Amount
	}
	if allocated != in.Amount {
		fail(w, badRequest(fmt.Sprintf("Apply the full %s to invoices. Right now %s is applied.", in.Amount.Rupees(), allocated.Rupees())))
		return
	}

	ctx := r.Context()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		fail(w, err)
		return
	}
	defer tx.Rollback()

	id, err := s.insertPayment(ctx, tx, in)
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		fail(w, err)
		return
	}
	p, err := s.loadPayment(ctx, id)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

func (s *server) insertPayment(ctx context.Context, tx *sql.Tx, in PaymentInput) (int64, error) {
	var exists int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM customers WHERE id = ?`, in.CustomerID).Scan(&exists); err != nil {
		return 0, err
	}
	if exists == 0 {
		return 0, badRequest("That customer doesn't exist.")
	}

	// Lock each invoice and check the amount fits its balance.
	for _, a := range in.Allocations {
		if a.Amount == 0 {
			continue
		}
		var number, lifecycle string
		var customerID int64
		var total, paid Dec2
		err := tx.QueryRowContext(ctx, `SELECT invoice_number, lifecycle, customer_id, total, `+invoicePaidSQL+` + `+invoiceCreditedSQL+`
			FROM invoices i WHERE id = ? FOR UPDATE`, a.InvoiceID).Scan(&number, &lifecycle, &customerID, &total, &paid)
		if errors.Is(err, sql.ErrNoRows) {
			return 0, badRequest("One of the invoices no longer exists. Reload the page and try again.")
		}
		if err != nil {
			return 0, err
		}
		switch {
		case customerID != in.CustomerID:
			return 0, badRequest(number + " belongs to a different customer.")
		case lifecycle != "sent":
			return 0, badRequest(number + " is a " + lifecycle + " invoice. Only sent invoices can receive payments.")
		case a.Amount > total-paid:
			return 0, badRequest(fmt.Sprintf("%s only has %s left to pay.", number, (total - paid).Rupees()))
		}
	}

	var prefix string
	var next int
	if err := tx.QueryRowContext(ctx, `SELECT payment_prefix, next_payment_number FROM organization WHERE id = 1 FOR UPDATE`).
		Scan(&prefix, &next); err != nil {
		return 0, err
	}
	number := ""
	for {
		number = fmt.Sprintf("%s%04d", prefix, next)
		var taken int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM payments WHERE payment_number = ?`, number).Scan(&taken); err != nil {
			return 0, err
		}
		if taken == 0 {
			break
		}
		next++
	}

	res, err := tx.ExecContext(ctx, `INSERT INTO payments (payment_number, customer_id, payment_date, amount, mode, reference, notes)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, number, in.CustomerID, in.PaymentDate, in.Amount, in.Mode, in.Reference, in.Notes)
	if err != nil {
		return 0, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	for _, a := range in.Allocations {
		if a.Amount == 0 {
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES (?, ?, ?)`,
			id, a.InvoiceID, a.Amount); err != nil {
			return 0, err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE organization SET next_payment_number = ? WHERE id = 1`, next+1); err != nil {
		return 0, err
	}
	return id, nil
}

// DELETE /api/payments/{id}: the invoices it paid become unpaid again.
func (s *server) deletePayment(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	res, err := s.db.ExecContext(r.Context(), `DELETE FROM payments WHERE id = ?`, id)
	if err != nil {
		fail(w, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, notFound("Payment not found."))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
