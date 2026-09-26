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

type InvoiceLine struct {
	ID            int64  `json:"id"`
	ItemID        *int64 `json:"itemId"`
	Description   string `json:"description"`
	HSNSAC        string `json:"hsnSac"`
	Unit          string `json:"unit"`
	Quantity      Dec2   `json:"quantity"`
	Rate          Dec2   `json:"rate"`
	DiscountPct   Dec2   `json:"discountPct"`
	TaxRate       Dec2   `json:"taxRate"`
	TaxableAmount Dec2   `json:"taxableAmount"`
	CGST          Dec2   `json:"cgst"`
	SGST          Dec2   `json:"sgst"`
	IGST          Dec2   `json:"igst"`
	TimeEntryIDs  []int64 `json:"timeEntryIds,omitempty"`
	ExpenseID     *int64  `json:"expenseId,omitempty"`
}

type InvoicePayment struct {
	PaymentID     int64  `json:"paymentId"`
	PaymentNumber string `json:"paymentNumber"`
	PaymentDate   string `json:"paymentDate"`
	Mode          string `json:"mode"`
	Amount        Dec2   `json:"amount"`
}

type InvoiceCredit struct {
	AllocationID int64  `json:"allocationId"`
	CreditNoteID int64  `json:"creditNoteId"`
	Number       string `json:"number"`
	AppliedOn    string `json:"appliedOn"`
	Amount       Dec2   `json:"amount"`
}

type Invoice struct {
	ID             int64            `json:"id"`
	InvoiceNumber  string           `json:"invoiceNumber"`
	CustomerID     int64            `json:"customerId"`
	CustomerName   string           `json:"customerName"`
	CustomerEmail  string           `json:"customerEmail"`
	CustomerGSTIN  string           `json:"customerGstin"`
	BillingAddress string           `json:"billingAddress"`
	PlaceOfSupply  string           `json:"placeOfSupply"`
	IssueDate      string           `json:"issueDate"`
	DueDate        string           `json:"dueDate"`
	Lifecycle      string           `json:"lifecycle"` // draft | sent | void
	Reference      string           `json:"reference"`
	Subtotal       Dec2             `json:"subtotal"` // taxable value after discounts
	DiscountTotal  Dec2             `json:"discountTotal"`
	CGSTTotal      Dec2             `json:"cgstTotal"`
	SGSTTotal      Dec2             `json:"sgstTotal"`
	IGSTTotal      Dec2             `json:"igstTotal"`
	Total          Dec2             `json:"total"`
	Paid           Dec2             `json:"paid"`     // payments received
	Credited       Dec2             `json:"credited"` // credit notes applied
	Balance        Dec2             `json:"balance"`
	Notes          string           `json:"notes"`
	Terms          string           `json:"terms"`
	RecurringID    *int64           `json:"recurringId"`
	CreatedAt      string           `json:"createdAt"`
	Lines          []InvoiceLine    `json:"lines,omitempty"`
	Payments       []InvoicePayment `json:"payments,omitempty"`
	Credits        []InvoiceCredit  `json:"credits,omitempty"`
	Related        []DocRef         `json:"related,omitempty"` // quotes/challans it came from, credit notes against it
	Activity       []ActivityEntry  `json:"activity,omitempty"`
}

const invoicePaidSQL = `COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id = i.id), 0)`
const invoiceCreditedSQL = `COALESCE((SELECT SUM(ca.amount) FROM credit_allocations ca WHERE ca.invoice_id = i.id), 0)`

// What's still owed on invoice i: total minus payments and credits.
const invoiceBalanceSQL = `(i.total - ` + invoicePaidSQL + ` - ` + invoiceCreditedSQL + `)`

const invoiceSelect = `SELECT i.id, i.invoice_number, i.customer_id, i.customer_name, i.customer_email,
	i.customer_gstin, i.billing_address, i.place_of_supply, i.issue_date, i.due_date, i.lifecycle, i.reference,
	i.subtotal, i.discount_total, i.cgst_total, i.sgst_total, i.igst_total, i.total, ` + invoicePaidSQL + `,
	` + invoiceCreditedSQL + `, i.notes, i.terms, i.recurring_id, i.created_at FROM invoices i`

func scanInvoice(row interface{ Scan(...any) error }) (Invoice, error) {
	var inv Invoice
	err := row.Scan(&inv.ID, &inv.InvoiceNumber, &inv.CustomerID, &inv.CustomerName, &inv.CustomerEmail,
		&inv.CustomerGSTIN, &inv.BillingAddress, &inv.PlaceOfSupply, &inv.IssueDate, &inv.DueDate, &inv.Lifecycle,
		&inv.Reference, &inv.Subtotal, &inv.DiscountTotal, &inv.CGSTTotal, &inv.SGSTTotal, &inv.IGSTTotal,
		&inv.Total, &inv.Paid, &inv.Credited, &inv.Notes, &inv.Terms, &inv.RecurringID, &inv.CreatedAt)
	inv.Balance = inv.Total - inv.Paid - inv.Credited
	return inv, err
}

// GET /api/invoices[?customerId=1][&open=1][&recurringId=2]  open = sent with a balance due
func (s *server) listInvoices(w http.ResponseWriter, r *http.Request) {
	q := invoiceSelect + ` WHERE 1 = 1`
	var args []any
	if cid, err := strconv.ParseInt(r.URL.Query().Get("customerId"), 10, 64); err == nil {
		q += ` AND i.customer_id = ?`
		args = append(args, cid)
	}
	if rid, err := strconv.ParseInt(r.URL.Query().Get("recurringId"), 10, 64); err == nil {
		q += ` AND i.recurring_id = ?`
		args = append(args, rid)
	}
	order := ` ORDER BY i.issue_date DESC, i.id DESC`
	if r.URL.Query().Get("open") == "1" {
		q += ` AND i.lifecycle = 'sent' AND ` + invoiceBalanceSQL + ` > 0`
		order = ` ORDER BY i.due_date, i.id`
	}
	rows, err := s.db.QueryContext(r.Context(), q+order, args...)
	if err != nil {
		fail(w, err)
		return
	}
	defer rows.Close()
	list := []Invoice{}
	for rows.Next() {
		inv, err := scanInvoice(rows)
		if err != nil {
			fail(w, err)
			return
		}
		list = append(list, inv)
	}
	if err := rows.Err(); err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// loadInvoice returns one invoice with its lines, payments, credits, related documents, and history.
func (s *server) loadInvoice(ctx context.Context, id int64) (Invoice, error) {
	inv, err := scanInvoice(s.db.QueryRowContext(ctx, invoiceSelect+` WHERE i.id = ?`, id))
	if err != nil {
		return inv, err
	}
	if inv.Lines, err = loadLines(ctx, s.db, "invoice_items", "invoice_id", id); err != nil {
		return inv, err
	}

	prows, err := s.db.QueryContext(ctx, `SELECT p.id, p.payment_number, p.payment_date, p.mode, pa.amount
		FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
		WHERE pa.invoice_id = ? ORDER BY p.payment_date, p.id`, id)
	if err != nil {
		return inv, err
	}
	inv.Payments = []InvoicePayment{}
	for prows.Next() {
		var p InvoicePayment
		if err := prows.Scan(&p.PaymentID, &p.PaymentNumber, &p.PaymentDate, &p.Mode, &p.Amount); err != nil {
			prows.Close()
			return inv, err
		}
		inv.Payments = append(inv.Payments, p)
	}
	prows.Close()

	crows, err := s.db.QueryContext(ctx, `SELECT ca.id, d.id, d.doc_number, ca.applied_on, ca.amount
		FROM credit_allocations ca JOIN documents d ON d.id = ca.credit_note_id
		WHERE ca.invoice_id = ? ORDER BY ca.applied_on, ca.id`, id)
	if err != nil {
		return inv, err
	}
	inv.Credits = []InvoiceCredit{}
	for crows.Next() {
		var c InvoiceCredit
		if err := crows.Scan(&c.AllocationID, &c.CreditNoteID, &c.Number, &c.AppliedOn, &c.Amount); err != nil {
			crows.Close()
			return inv, err
		}
		inv.Credits = append(inv.Credits, c)
	}
	crows.Close()

	rrows, err := s.db.QueryContext(ctx, `SELECT d.id, d.doc_type, d.doc_number,
		IF(d.doc_type = 'credit_note' AND d.status = 'open' AND d.total - `+docAppliedSQL+` - `+docRefundedSQL+` <= 0, 'closed', d.status),
		d.total FROM documents d WHERE d.invoice_id = ? ORDER BY d.issue_date, d.id`, id)
	if err != nil {
		return inv, err
	}
	inv.Related = []DocRef{}
	for rrows.Next() {
		var d DocRef
		if err := rrows.Scan(&d.ID, &d.Type, &d.Number, &d.Status, &d.Total); err != nil {
			rrows.Close()
			return inv, err
		}
		inv.Related = append(inv.Related, d)
	}
	rrows.Close()

	inv.Activity, err = loadActivity(ctx, s.db, "invoice", id)
	return inv, err
}

func (s *server) getInvoice(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	inv, err := s.loadInvoice(r.Context(), id)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, inv)
}

// InvoiceInput is the body of POST and PUT /api/invoices.
type InvoiceInput struct {
	CustomerID int64       `json:"customerId"`
	IssueDate  string      `json:"issueDate"`
	DueDate    string      `json:"dueDate"`
	Reference  string      `json:"reference"`
	Notes      string      `json:"notes"`
	Terms      string      `json:"terms"`
	Status     string      `json:"status"` // "draft" or "sent"
	Lines      []LineInput `json:"lines"`
}

func (in *InvoiceInput) validate() error {
	in.Reference = strings.TrimSpace(in.Reference)
	switch {
	case in.CustomerID <= 0:
		return badRequest("Choose a customer.")
	case !validDate(in.IssueDate):
		return badRequest("Enter a valid invoice date.")
	case !validDate(in.DueDate):
		return badRequest("Enter a valid due date.")
	case in.DueDate < in.IssueDate:
		return badRequest("The due date can't be before the invoice date.")
	case len(in.Reference) > 100 || len(in.Notes) > 1000 || len(in.Terms) > 2000:
		return badRequest("Reference, notes, or terms are too long.")
	case in.Status != "draft" && in.Status != "sent":
		return badRequest(`Status must be "draft" or "sent".`)
	}
	return validateLines(in.Lines)
}

type customerSnapshot struct {
	name, email, gstin, state, address string
	archived                           bool
}

func loadCustomerSnapshot(ctx context.Context, tx *sql.Tx, id int64) (customerSnapshot, error) {
	var c customerSnapshot
	var addr, city, pin string
	err := tx.QueryRowContext(ctx, `SELECT display_name, email, gstin, state_code, address, city, pincode, archived
		FROM customers WHERE id = ?`, id).Scan(&c.name, &c.email, &c.gstin, &c.state, &addr, &city, &pin, &c.archived)
	if errors.Is(err, sql.ErrNoRows) {
		return c, badRequest("That customer doesn't exist. Choose another one.")
	}
	if err != nil {
		return c, err
	}
	if c.state == "" {
		return c, badRequest(`Add a state for "` + c.name + `" first (open the customer and edit it). It's the place of supply for GST.`)
	}
	parts := []string{}
	for _, p := range []string{strings.TrimSpace(addr), strings.TrimSpace(strings.Trim(city+" "+pin, " ")), stateName(c.state)} {
		if p != "" {
			parts = append(parts, p)
		}
	}
	c.address = strings.Join(parts, "\n")
	return c, nil
}

func stateName(code string) string {
	for _, st := range states {
		if st.Code == code {
			return st.Name
		}
	}
	return ""
}

// saveInvoice creates (id == 0) or replaces an invoice inside tx and returns its id.
// minTotal is what's already been paid or credited; the new total can't go below it.
func (s *server) saveInvoice(ctx context.Context, tx *sql.Tx, id int64, in InvoiceInput, lifecycle string, minTotal Dec2) (int64, error) {
	if lifecycle != "draft" {
		if err := s.periodOpen(ctx, "invoice", in.IssueDate); err != nil {
			return 0, err
		}
	}
	sc, err := loadSaleContext(ctx, tx, in.CustomerID)
	if err != nil {
		return 0, err
	}
	p, err := priceLines(ctx, tx, in.Lines, sc)
	if err != nil {
		return 0, err
	}
	if p.Total < minTotal {
		return 0, badRequest(fmt.Sprintf("This invoice already has %s in payments or credits, so its total can't go below that.", minTotal.Rupees()))
	}
	c := sc.customer
	if id == 0 {
		number, err := takeNumber(ctx, tx, "invoice_prefix", "next_invoice_number",
			`SELECT COUNT(*) FROM invoices WHERE invoice_number = ?`)
		if err != nil {
			return 0, err
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO invoices (invoice_number, customer_id, customer_name, customer_email,
			customer_gstin, billing_address, place_of_supply, issue_date, due_date, lifecycle, reference,
			subtotal, discount_total, cgst_total, sgst_total, igst_total, total, notes, terms)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			number, in.CustomerID, c.name, c.email, c.gstin, c.address, c.state, in.IssueDate, in.DueDate,
			lifecycle, in.Reference, p.Subtotal, p.Discount, p.CGST, p.SGST, p.IGST, p.Total, in.Notes, in.Terms)
		if err != nil {
			return 0, err
		}
		if id, err = res.LastInsertId(); err != nil {
			return 0, err
		}
	} else if _, err := tx.ExecContext(ctx, `UPDATE invoices SET customer_id=?, customer_name=?, customer_email=?,
		customer_gstin=?, billing_address=?, place_of_supply=?, issue_date=?, due_date=?, lifecycle=?, reference=?,
		subtotal=?, discount_total=?, cgst_total=?, sgst_total=?, igst_total=?, total=?, notes=?, terms=?
		WHERE id = ?`,
		in.CustomerID, c.name, c.email, c.gstin, c.address, c.state, in.IssueDate, in.DueDate,
		lifecycle, in.Reference, p.Subtotal, p.Discount, p.CGST, p.SGST, p.IGST, p.Total, in.Notes, in.Terms, id); err != nil {
		return 0, err
	}
	if err := insertLines(ctx, tx, "invoice_items", "invoice_id", id, p); err != nil {
		return 0, err
	}
	return id, linkSources(ctx, tx, id, in.CustomerID, p.Lines)
}

// POST /api/invoices
func (s *server) createInvoice(w http.ResponseWriter, r *http.Request) {
	var in InvoiceInput
	if err := decodeJSON(w, r, &in); err != nil {
		fail(w, err)
		return
	}
	if err := in.validate(); err != nil {
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

	id, err := s.saveInvoice(ctx, tx, 0, in, in.Status, 0)
	if err == nil {
		logActivity(ctx, tx, "invoice", id, "created", map[bool]string{true: "Created as a draft", false: "Created and marked as sent"}[in.Status == "draft"])
		err = tx.Commit()
	}
	if err != nil {
		fail(w, err)
		return
	}
	inv, err := s.loadInvoice(ctx, id)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, inv)
}

// PUT /api/invoices/{id}. Drafts can be sent by saving with status "sent".
func (s *server) updateInvoice(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	var in InvoiceInput
	if err := decodeJSON(w, r, &in); err != nil {
		fail(w, err)
		return
	}
	if err := in.validate(); err != nil {
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

	var lifecycle, oldDate string
	var customerID int64
	var paid, credited Dec2
	err = tx.QueryRowContext(ctx, `SELECT lifecycle, issue_date, customer_id, `+invoicePaidSQL+`, `+invoiceCreditedSQL+`
		FROM invoices i WHERE id = ? FOR UPDATE`, id).Scan(&lifecycle, &oldDate, &customerID, &paid, &credited)
	if err != nil {
		fail(w, err)
		return
	}
	if lifecycle != "draft" {
		if err := s.periodOpen(ctx, "invoice", oldDate); err != nil {
			fail(w, err)
			return
		}
	}
	if lifecycle == "void" {
		fail(w, conflict("Void invoices can't be edited. Duplicate it to make a new one."))
		return
	}
	if paid+credited > 0 && in.CustomerID != customerID {
		fail(w, badRequest("This invoice has payments or credits from its current customer, so the customer can't be changed."))
		return
	}
	if lifecycle == "draft" && in.Status == "sent" {
		lifecycle = "sent"
	}
	if _, err = s.saveInvoice(ctx, tx, id, in, lifecycle, paid+credited); err == nil {
		logActivity(ctx, tx, "invoice", id, "edited", "Invoice edited")
		err = tx.Commit()
	}
	if err != nil {
		fail(w, err)
		return
	}
	inv, err := s.loadInvoice(ctx, id)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, inv)
}

// POST /api/invoices/{id}/send: a draft becomes a sent invoice (money is now owed).
func (s *server) sendInvoice(w http.ResponseWriter, r *http.Request) {
	s.changeLifecycle(w, r, "sent")
}

// POST /api/invoices/{id}/void: cancels an invoice but keeps it for your records.
func (s *server) voidInvoice(w http.ResponseWriter, r *http.Request) {
	s.changeLifecycle(w, r, "void")
}

func (s *server) changeLifecycle(w http.ResponseWriter, r *http.Request, to string) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	ctx := r.Context()
	inv, err := s.loadInvoice(ctx, id)
	if err != nil {
		fail(w, err)
		return
	}
	switch {
	case to == "sent" && inv.Lifecycle != "draft":
		fail(w, conflict("Only draft invoices can be marked as sent."))
		return
	case to == "void" && inv.Lifecycle == "void":
		fail(w, conflict("This invoice is already void."))
		return
	case to == "void" && inv.Paid+inv.Credited > 0:
		fail(w, conflict("This invoice has payments or credits. Remove those first, then void it."))
		return
	}
	if err := s.periodOpen(ctx, "invoice", inv.IssueDate); err != nil {
		fail(w, err)
		return
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE invoices SET lifecycle = ? WHERE id = ?`, to, id); err != nil {
		fail(w, err)
		return
	}
	if to == "void" { // its hours and expenses can be billed again
		if err := releaseSources(ctx, s.db, id); err != nil {
			fail(w, err)
			return
		}
	}
	logActivity(ctx, s.db, "invoice", id, to, map[string]string{"sent": "Marked as sent", "void": "Voided"}[to])
	inv, err = s.loadInvoice(ctx, id)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, inv)
}

// markInvoiceSent moves a draft to sent after it's emailed or shared.
func (s *server) markInvoiceSent(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE invoices SET lifecycle = 'sent' WHERE id = ? AND lifecycle = 'draft'`, id)
	return err
}

// DELETE /api/invoices/{id}: only invoices without payments or credits.
func (s *server) deleteInvoice(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	ctx := r.Context()
	inv, err := s.loadInvoice(ctx, id)
	if err != nil {
		fail(w, err)
		return
	}
	if inv.Paid+inv.Credited > 0 {
		fail(w, conflict("This invoice has payments or credits, so it can't be deleted. Remove those first, or keep it for your records."))
		return
	}
	if inv.Lifecycle != "draft" {
		if err := s.periodOpen(ctx, "invoice", inv.IssueDate); err != nil {
			fail(w, err)
			return
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		fail(w, err)
		return
	}
	defer tx.Rollback()
	// Quotes and challans that were turned into this invoice become convertible again.
	if _, err := tx.ExecContext(ctx, `UPDATE documents SET status = IF(doc_type = 'quote', 'accepted', 'open'), invoice_id = NULL
		WHERE invoice_id = ? AND doc_type IN ('quote', 'challan') AND status = 'invoiced'`, id); err != nil {
		fail(w, err)
		return
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM activity WHERE subject_type = 'invoice' AND subject_id = ?`, id); err != nil {
		fail(w, err)
		return
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM invoices WHERE id = ?`, id); err != nil {
		fail(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
