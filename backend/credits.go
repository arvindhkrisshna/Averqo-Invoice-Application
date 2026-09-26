package main

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

type allocationInput struct {
	InvoiceID int64 `json:"invoiceId"`
	Amount    Dec2  `json:"amount"`
}

// applyCredit uses part of an open credit note to reduce what's owed on
// invoices of the same customer.
func (s *server) applyCredit(ctx context.Context, tx *sql.Tx, noteID int64, allocs []allocationInput, date string) error {
	var number, status string
	var customerID int64
	var total, used Dec2
	err := tx.QueryRowContext(ctx, `SELECT doc_number, status, customer_id, total, `+docAppliedSQL+` + `+docRefundedSQL+`
		FROM documents d WHERE id = ? AND doc_type = 'credit_note' FOR UPDATE`, noteID).Scan(&number, &status, &customerID, &total, &used)
	if err != nil {
		return err
	}
	if status != "open" {
		return conflict("Only open credit notes can be used. Issue this one first.")
	}
	var sum Dec2
	for _, a := range allocs {
		if a.Amount < 0 {
			return badRequest("Amounts can't be negative.")
		}
		sum += a.Amount
	}
	if sum <= 0 {
		return badRequest("Enter how much of the credit to use on each invoice.")
	}
	if sum > total-used {
		return badRequest(fmt.Sprintf("%s only has %s of credit left.", number, (total - used).Rupees()))
	}
	for _, a := range allocs {
		if a.Amount == 0 {
			continue
		}
		var invNumber, lifecycle string
		var invCustomer int64
		var balance Dec2
		err := tx.QueryRowContext(ctx, `SELECT invoice_number, lifecycle, customer_id, `+invoiceBalanceSQL+`
			FROM invoices i WHERE id = ? FOR UPDATE`, a.InvoiceID).Scan(&invNumber, &lifecycle, &invCustomer, &balance)
		if isNotFound(err) {
			return badRequest("One of the invoices no longer exists. Reload the page and try again.")
		} else if err != nil {
			return err
		}
		switch {
		case invCustomer != customerID:
			return badRequest(invNumber + " belongs to a different customer.")
		case lifecycle != "sent":
			return badRequest(invNumber + " isn't a sent invoice, so credit can't be used on it.")
		case a.Amount > balance:
			return badRequest(fmt.Sprintf("%s only has %s left to pay.", invNumber, balance.Rupees()))
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO credit_allocations (credit_note_id, invoice_id, amount, applied_on)
			VALUES (?, ?, ?, ?)`, noteID, a.InvoiceID, a.Amount, date); err != nil {
			return err
		}
		logActivity(ctx, tx, "invoice", a.InvoiceID, "credited", fmt.Sprintf("%s of credit note %s used", a.Amount.Rupees(), number))
		logActivity(ctx, tx, "credit_note", noteID, "applied", fmt.Sprintf("%s used on %s", a.Amount.Rupees(), invNumber))
	}
	return nil
}

// POST /api/credit-notes/{id}/apply  {"date": "2026-09-25", "allocations": [{"invoiceId": 7, "amount": 500}]}
func (s *server) applyCreditNote(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	var body struct {
		Date        string            `json:"date"`
		Allocations []allocationInput `json:"allocations"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		fail(w, err)
		return
	}
	if body.Date == "" {
		body.Date = todayIST()
	}
	if !validDate(body.Date) {
		fail(w, badRequest("Enter a valid date."))
		return
	}
	ctx := r.Context()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		fail(w, err)
		return
	}
	defer tx.Rollback()
	if err := s.applyCredit(ctx, tx, id, body.Allocations, body.Date); err != nil {
		fail(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		fail(w, err)
		return
	}
	s.getDocument(w, r, creditKind)
}

// DELETE /api/credit-notes/{id}/allocations/{allocId}: stop using the credit on that invoice.
func (s *server) removeCreditAllocation(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	allocID, _ := strconv.ParseInt(r.PathValue("allocId"), 10, 64)
	ctx := r.Context()
	var invoiceID int64
	var amount Dec2
	if err := s.db.QueryRowContext(ctx, `SELECT invoice_id, amount FROM credit_allocations WHERE id = ? AND credit_note_id = ?`,
		allocID, id).Scan(&invoiceID, &amount); err != nil {
		fail(w, err)
		return
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM credit_allocations WHERE id = ?`, allocID); err != nil {
		fail(w, err)
		return
	}
	logActivity(ctx, s.db, "credit_note", id, "unapplied", amount.Rupees()+" removed from an invoice")
	logActivity(ctx, s.db, "invoice", invoiceID, "uncredited", amount.Rupees()+" of credit removed")
	s.getDocument(w, r, creditKind)
}

// POST /api/credit-notes/{id}/refunds: record money paid back to the customer.
func (s *server) addRefund(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	var body struct {
		RefundDate string `json:"refundDate"`
		Amount     Dec2   `json:"amount"`
		Mode       string `json:"mode"`
		Reference  string `json:"reference"`
		Notes      string `json:"notes"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		fail(w, err)
		return
	}
	body.Reference = strings.TrimSpace(body.Reference)
	switch {
	case !validDate(body.RefundDate):
		fail(w, badRequest("Enter the refund date."))
		return
	case body.Amount <= 0:
		fail(w, badRequest("Enter the amount refunded."))
		return
	case !validPaymentMode(body.Mode):
		fail(w, badRequest("Choose how you refunded the money."))
		return
	case len(body.Reference) > 100 || len(body.Notes) > 500:
		fail(w, badRequest("Reference or notes are too long."))
		return
	}
	ctx := r.Context()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		fail(w, err)
		return
	}
	defer tx.Rollback()
	var status, number string
	var total, used Dec2
	if err := tx.QueryRowContext(ctx, `SELECT status, doc_number, total, `+docAppliedSQL+` + `+docRefundedSQL+`
		FROM documents d WHERE id = ? AND doc_type = 'credit_note' FOR UPDATE`, id).Scan(&status, &number, &total, &used); err != nil {
		fail(w, err)
		return
	}
	if status != "open" {
		fail(w, conflict("Only open credit notes can be refunded."))
		return
	}
	if body.Amount > total-used {
		fail(w, badRequest(fmt.Sprintf("%s only has %s of credit left.", number, (total-used).Rupees())))
		return
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO credit_refunds (credit_note_id, refund_date, amount, mode, reference, notes)
		VALUES (?, ?, ?, ?, ?, ?)`, id, body.RefundDate, body.Amount, body.Mode, body.Reference, body.Notes); err != nil {
		fail(w, err)
		return
	}
	logActivity(ctx, tx, "credit_note", id, "refunded", body.Amount.Rupees()+" refunded")
	if err := tx.Commit(); err != nil {
		fail(w, err)
		return
	}
	s.getDocument(w, r, creditKind)
}

func (s *server) removeRefund(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	refundID, _ := strconv.ParseInt(r.PathValue("refundId"), 10, 64)
	res, err := s.db.ExecContext(r.Context(), `DELETE FROM credit_refunds WHERE id = ? AND credit_note_id = ?`, refundID, id)
	if err != nil {
		fail(w, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, notFound("Refund not found."))
		return
	}
	logActivity(r.Context(), s.db, "credit_note", id, "refund_removed", "A refund was removed")
	s.getDocument(w, r, creditKind)
}
