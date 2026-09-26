package main

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
)

// docKind describes one of the three document types stored in `documents`.
type docKind struct {
	Type      string // quote | challan | credit_note (database value)
	Path      string // quotes | challans | credit-notes (URL)
	Label     string
	PrefixCol string
	NextCol   string
	Issued    string              // status meaning "issued to the customer": sent (quotes) or open
	Moves     map[string][]string // allowed status changes, from -> to
}

var (
	quoteKind = docKind{Type: "quote", Path: "quotes", Label: "Quote", PrefixCol: "quote_prefix", NextCol: "next_quote_number",
		Issued: "sent", Moves: map[string][]string{
			"draft": {"sent", "accepted", "declined"}, "sent": {"accepted", "declined"},
			"accepted": {"sent", "declined"}, "declined": {"sent", "accepted"}}}
	challanKind = docKind{Type: "challan", Path: "challans", Label: "Delivery challan", PrefixCol: "challan_prefix",
		NextCol: "next_challan_number", Issued: "open", Moves: map[string][]string{
			"draft": {"open"}, "open": {"cancelled"}, "cancelled": {"open"}}}
	creditKind = docKind{Type: "credit_note", Path: "credit-notes", Label: "Credit note", PrefixCol: "credit_prefix",
		NextCol: "next_credit_number", Issued: "open", Moves: map[string][]string{
			"draft": {"open"}, "open": {"void"}}}
	docKinds = []docKind{quoteKind, challanKind, creditKind}
)

func kindByType(t string) docKind {
	for _, k := range docKinds {
		if k.Type == t {
			return k
		}
	}
	return quoteKind
}

// GST law (Rule 55) lists why goods may move on a delivery challan.
var challanTypes = []map[string]string{
	{"value": "supply_on_approval", "label": "Supply on approval"},
	{"value": "job_work", "label": "Job work"},
	{"value": "supply_of_liquid_gas", "label": "Supply of liquid gas"},
	{"value": "others", "label": "Others"},
}

var creditReasons = []map[string]string{
	{"value": "sales_return", "label": "Sales return"},
	{"value": "post_sale_discount", "label": "Post-sale discount"},
	{"value": "deficiency_in_services", "label": "Deficiency in services"},
	{"value": "correction_in_invoice", "label": "Correction in invoice"},
	{"value": "change_in_pos", "label": "Change in place of supply"},
	{"value": "others", "label": "Others"},
}

func inOptions(v string, opts []map[string]string) bool {
	for _, o := range opts {
		if o["value"] == v {
			return true
		}
	}
	return false
}

type CreditAllocation struct {
	ID            int64  `json:"id"`
	InvoiceID     int64  `json:"invoiceId"`
	InvoiceNumber string `json:"invoiceNumber"`
	AppliedOn     string `json:"appliedOn"`
	Amount        Dec2   `json:"amount"`
}

type CreditRefund struct {
	ID         int64  `json:"id"`
	RefundDate string `json:"refundDate"`
	Amount     Dec2   `json:"amount"`
	Mode       string `json:"mode"`
	Reference  string `json:"reference"`
}

type Document struct {
	ID             int64              `json:"id"`
	Type           string             `json:"type"`
	Number         string             `json:"number"`
	CustomerID     int64              `json:"customerId"`
	CustomerName   string             `json:"customerName"`
	CustomerEmail  string             `json:"customerEmail"`
	CustomerGSTIN  string             `json:"customerGstin"`
	BillingAddress string             `json:"billingAddress"`
	PlaceOfSupply  string             `json:"placeOfSupply"`
	IssueDate      string             `json:"issueDate"`
	ExpiryDate     *string            `json:"expiryDate"`
	Status         string             `json:"status"`
	ChallanType    string             `json:"challanType"`
	Reason         string             `json:"reason"`
	InvoiceID      *int64             `json:"invoiceId"`
	InvoiceNumber  *string            `json:"invoiceNumber"`
	InvoiceDate    *string            `json:"invoiceDate"`
	Reference      string             `json:"reference"`
	Subtotal       Dec2               `json:"subtotal"`
	DiscountTotal  Dec2               `json:"discountTotal"`
	CGSTTotal      Dec2               `json:"cgstTotal"`
	SGSTTotal      Dec2               `json:"sgstTotal"`
	IGSTTotal      Dec2               `json:"igstTotal"`
	Total          Dec2               `json:"total"`
	Applied        Dec2               `json:"applied"`  // credit notes: used against invoices
	Refunded       Dec2               `json:"refunded"` // credit notes: paid back
	Balance        Dec2               `json:"balance"`  // credit notes: still available
	Notes          string             `json:"notes"`
	Terms          string             `json:"terms"`
	CreatedAt      string             `json:"createdAt"`
	Lines          []InvoiceLine      `json:"lines,omitempty"`
	Allocations    []CreditAllocation `json:"allocations,omitempty"`
	Refunds        []CreditRefund     `json:"refunds,omitempty"`
	Activity       []ActivityEntry    `json:"activity,omitempty"`
}

const docAppliedSQL = `COALESCE((SELECT SUM(ca.amount) FROM credit_allocations ca WHERE ca.credit_note_id = d.id), 0)`
const docRefundedSQL = `COALESCE((SELECT SUM(cr.amount) FROM credit_refunds cr WHERE cr.credit_note_id = d.id), 0)`

const docSelect = `SELECT d.id, d.doc_type, d.doc_number, d.customer_id, d.customer_name, d.customer_email, d.customer_gstin,
	d.billing_address, d.place_of_supply, d.issue_date, d.expiry_date, d.status, d.challan_type, d.reason,
	d.invoice_id, inv.invoice_number, inv.issue_date, d.reference, d.subtotal, d.discount_total, d.cgst_total,
	d.sgst_total, d.igst_total, d.total, ` + docAppliedSQL + `, ` + docRefundedSQL + `, d.notes, d.terms, d.created_at
	FROM documents d LEFT JOIN invoices inv ON inv.id = d.invoice_id`

func scanDocument(row interface{ Scan(...any) error }) (Document, error) {
	var d Document
	err := row.Scan(&d.ID, &d.Type, &d.Number, &d.CustomerID, &d.CustomerName, &d.CustomerEmail, &d.CustomerGSTIN,
		&d.BillingAddress, &d.PlaceOfSupply, &d.IssueDate, &d.ExpiryDate, &d.Status, &d.ChallanType, &d.Reason,
		&d.InvoiceID, &d.InvoiceNumber, &d.InvoiceDate, &d.Reference, &d.Subtotal, &d.DiscountTotal, &d.CGSTTotal,
		&d.SGSTTotal, &d.IGSTTotal, &d.Total, &d.Applied, &d.Refunded, &d.Notes, &d.Terms, &d.CreatedAt)
	if d.Type == "credit_note" && d.Status == "open" {
		d.Balance = d.Total - d.Applied - d.Refunded
	}
	return d, err
}

func (s *server) loadDocument(ctx context.Context, k docKind, id int64) (Document, error) {
	d, err := scanDocument(s.db.QueryRowContext(ctx, docSelect+` WHERE d.id = ? AND d.doc_type = ?`, id, k.Type))
	if err != nil {
		return d, err
	}
	if d.Lines, err = loadLines(ctx, s.db, "document_items", "document_id", id); err != nil {
		return d, err
	}
	if k.Type == "credit_note" {
		rows, err := s.db.QueryContext(ctx, `SELECT ca.id, ca.invoice_id, i.invoice_number, ca.applied_on, ca.amount
			FROM credit_allocations ca JOIN invoices i ON i.id = ca.invoice_id WHERE ca.credit_note_id = ? ORDER BY ca.id`, id)
		if err != nil {
			return d, err
		}
		d.Allocations = []CreditAllocation{}
		for rows.Next() {
			var a CreditAllocation
			if err := rows.Scan(&a.ID, &a.InvoiceID, &a.InvoiceNumber, &a.AppliedOn, &a.Amount); err != nil {
				rows.Close()
				return d, err
			}
			d.Allocations = append(d.Allocations, a)
		}
		rows.Close()
		rrows, err := s.db.QueryContext(ctx, `SELECT id, refund_date, amount, mode, reference FROM credit_refunds
			WHERE credit_note_id = ? ORDER BY refund_date, id`, id)
		if err != nil {
			return d, err
		}
		d.Refunds = []CreditRefund{}
		for rrows.Next() {
			var r CreditRefund
			if err := rrows.Scan(&r.ID, &r.RefundDate, &r.Amount, &r.Mode, &r.Reference); err != nil {
				rrows.Close()
				return d, err
			}
			d.Refunds = append(d.Refunds, r)
		}
		rrows.Close()
	}
	d.Activity, err = loadActivity(ctx, s.db, k.Type, id)
	return d, err
}

// registerDocumentRoutes adds the same set of endpoints for each document type.
func (s *server) registerDocumentRoutes(mux *http.ServeMux) {
	for _, k := range docKinds {
		k := k
		base := "/api/" + k.Path
		mux.HandleFunc("GET "+base, func(w http.ResponseWriter, r *http.Request) { s.listDocuments(w, r, k) })
		mux.HandleFunc("POST "+base, func(w http.ResponseWriter, r *http.Request) { s.saveDocument(w, r, k, false) })
		mux.HandleFunc("GET "+base+"/{id}", func(w http.ResponseWriter, r *http.Request) { s.getDocument(w, r, k) })
		mux.HandleFunc("PUT "+base+"/{id}", func(w http.ResponseWriter, r *http.Request) { s.saveDocument(w, r, k, true) })
		mux.HandleFunc("POST "+base+"/{id}/status", func(w http.ResponseWriter, r *http.Request) { s.setDocumentStatus(w, r, k) })
		mux.HandleFunc("DELETE "+base+"/{id}", func(w http.ResponseWriter, r *http.Request) { s.deleteDocument(w, r, k) })
		mux.HandleFunc("GET "+base+"/{id}/pdf", func(w http.ResponseWriter, r *http.Request) { s.documentPDF(w, r, k) })
		mux.HandleFunc("POST "+base+"/{id}/email", func(w http.ResponseWriter, r *http.Request) { s.emailDocument(w, r, k) })
		mux.HandleFunc("POST "+base+"/{id}/shared", func(w http.ResponseWriter, r *http.Request) { s.sharedDocument(w, r, k) })
	}
	mux.HandleFunc("POST /api/quotes/{id}/convert", s.convertQuote)
	mux.HandleFunc("POST /api/challans/convert", s.convertChallans)
	mux.HandleFunc("POST /api/credit-notes/{id}/apply", s.applyCreditNote)
	mux.HandleFunc("DELETE /api/credit-notes/{id}/allocations/{allocId}", s.removeCreditAllocation)
	mux.HandleFunc("POST /api/credit-notes/{id}/refunds", s.addRefund)
	mux.HandleFunc("DELETE /api/credit-notes/{id}/refunds/{refundId}", s.removeRefund)
}

// GET /api/{quotes|challans|credit-notes}[?customerId=]
func (s *server) listDocuments(w http.ResponseWriter, r *http.Request, k docKind) {
	q := docSelect + ` WHERE d.doc_type = ?`
	args := []any{k.Type}
	if cid, err := strconv.ParseInt(r.URL.Query().Get("customerId"), 10, 64); err == nil {
		q += ` AND d.customer_id = ?`
		args = append(args, cid)
	}
	rows, err := s.db.QueryContext(r.Context(), q+` ORDER BY d.issue_date DESC, d.id DESC`, args...)
	if err != nil {
		fail(w, err)
		return
	}
	defer rows.Close()
	list := []Document{}
	for rows.Next() {
		d, err := scanDocument(rows)
		if err != nil {
			fail(w, err)
			return
		}
		list = append(list, d)
	}
	if err := rows.Err(); err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *server) getDocument(w http.ResponseWriter, r *http.Request, k docKind) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	d, err := s.loadDocument(r.Context(), k, id)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

type DocumentInput struct {
	CustomerID     int64       `json:"customerId"`
	IssueDate      string      `json:"issueDate"`
	ExpiryDate     string      `json:"expiryDate"` // quotes only
	Reference      string      `json:"reference"`
	Notes          string      `json:"notes"`
	Terms          string      `json:"terms"`
	Status         string      `json:"status"` // "draft", or the issued status (sent/open)
	ChallanType    string      `json:"challanType"`
	Reason         string      `json:"reason"`
	InvoiceID      *int64      `json:"invoiceId"`      // credit notes: the invoice being corrected
	ApplyToInvoice bool        `json:"applyToInvoice"` // credit notes: use the credit on that invoice now
	Lines          []LineInput `json:"lines"`
}

func (in *DocumentInput) validate(k docKind) error {
	in.Reference = strings.TrimSpace(in.Reference)
	switch {
	case in.CustomerID <= 0:
		return badRequest("Choose a customer.")
	case !validDate(in.IssueDate):
		return badRequest("Enter a valid date.")
	case len(in.Reference) > 100 || len(in.Notes) > 1000 || len(in.Terms) > 2000:
		return badRequest("Reference, notes, or terms are too long.")
	case in.Status != "draft" && in.Status != k.Issued:
		return badRequest(fmt.Sprintf(`Status must be "draft" or "%s".`, k.Issued))
	}
	switch k.Type {
	case "quote":
		if in.ExpiryDate != "" && (!validDate(in.ExpiryDate) || in.ExpiryDate < in.IssueDate) {
			return badRequest("The valid-until date must be on or after the quote date.")
		}
	case "challan":
		if !inOptions(in.ChallanType, challanTypes) {
			return badRequest("Choose the challan type.")
		}
	case "credit_note":
		if !inOptions(in.Reason, creditReasons) {
			return badRequest("Choose the reason for this credit note.")
		}
	}
	return validateLines(in.Lines)
}

// POST (create) and PUT (update) for quotes, challans, and credit notes.
func (s *server) saveDocument(w http.ResponseWriter, r *http.Request, k docKind, editing bool) {
	var id int64
	var err error
	if editing {
		if id, err = pathID(r); err != nil {
			fail(w, err)
			return
		}
	}
	var in DocumentInput
	if err := decodeJSON(w, r, &in); err != nil {
		fail(w, err)
		return
	}
	if err := in.validate(k); err != nil {
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

	status := in.Status
	var used Dec2 // credit already applied or refunded
	if editing {
		var current, oldDate string
		var customerID int64
		err := tx.QueryRowContext(ctx, `SELECT status, issue_date, customer_id, `+docAppliedSQL+` + `+docRefundedSQL+`
			FROM documents d WHERE id = ? AND doc_type = ? FOR UPDATE`, id, k.Type).Scan(&current, &oldDate, &customerID, &used)
		if err != nil {
			fail(w, err)
			return
		}
		if k.Type == "credit_note" && current != "draft" {
			if err := s.periodOpen(ctx, "credit note", oldDate); err != nil {
				fail(w, err)
				return
			}
		}
		switch current {
		case "invoiced":
			fail(w, conflict("This has already been turned into an invoice. Edit the invoice instead."))
			return
		case "void", "cancelled":
			fail(w, conflict(fmt.Sprintf("A %s %s can't be edited.", current, strings.ToLower(k.Label))))
			return
		}
		if used > 0 && in.CustomerID != customerID {
			fail(w, badRequest("This credit note has been used, so the customer can't be changed."))
			return
		}
		if current != "draft" { // saving never moves an issued document back to draft
			status = current
		}
	}

	if k.Type == "credit_note" && status != "draft" {
		if err := s.periodOpen(ctx, "credit note", in.IssueDate); err != nil {
			fail(w, err)
			return
		}
	}
	for i := range in.Lines { // only invoice lines can bill hours or expenses
		in.Lines[i].TimeEntryIDs, in.Lines[i].ExpenseID = nil, nil
	}
	sc, err := loadSaleContext(ctx, tx, in.CustomerID)
	if err != nil {
		fail(w, err)
		return
	}
	p, err := priceLines(ctx, tx, in.Lines, sc)
	if err != nil {
		fail(w, err)
		return
	}
	if p.Total < used {
		fail(w, badRequest(fmt.Sprintf("%s of this credit note is already used, so its total can't go below that.", used.Rupees())))
		return
	}
	var expiry any
	if k.Type == "quote" && in.ExpiryDate != "" {
		expiry = in.ExpiryDate
	}
	var invoiceID any
	if k.Type == "credit_note" && in.InvoiceID != nil {
		var custID int64
		var lifecycle string
		err := tx.QueryRowContext(ctx, `SELECT customer_id, lifecycle FROM invoices WHERE id = ?`, *in.InvoiceID).Scan(&custID, &lifecycle)
		if err != nil || custID != in.CustomerID || lifecycle != "sent" {
			fail(w, badRequest("A credit note can only correct a sent invoice for the same customer."))
			return
		}
		invoiceID = *in.InvoiceID
	}
	c := sc.customer
	if !editing {
		number, err := takeNumber(ctx, tx, k.PrefixCol, k.NextCol,
			`SELECT COUNT(*) FROM documents WHERE doc_number = ? AND doc_type = ?`, k.Type)
		if err != nil {
			fail(w, err)
			return
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO documents (doc_type, doc_number, customer_id, customer_name, customer_email,
			customer_gstin, billing_address, place_of_supply, issue_date, expiry_date, status, challan_type, reason, invoice_id,
			reference, subtotal, discount_total, cgst_total, sgst_total, igst_total, total, notes, terms)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			k.Type, number, in.CustomerID, c.name, c.email, c.gstin, c.address, c.state, in.IssueDate, expiry, status,
			in.ChallanType, in.Reason, invoiceID, in.Reference, p.Subtotal, p.Discount, p.CGST, p.SGST, p.IGST, p.Total,
			in.Notes, in.Terms)
		if err != nil {
			fail(w, err)
			return
		}
		id, _ = res.LastInsertId()
		logActivity(ctx, tx, k.Type, id, "created", map[bool]string{true: "Created as a draft", false: "Created"}[status == "draft"])
	} else {
		if _, err := tx.ExecContext(ctx, `UPDATE documents SET customer_id=?, customer_name=?, customer_email=?, customer_gstin=?,
			billing_address=?, place_of_supply=?, issue_date=?, expiry_date=?, status=?, challan_type=?, reason=?, invoice_id=?,
			reference=?, subtotal=?, discount_total=?, cgst_total=?, sgst_total=?, igst_total=?, total=?, notes=?, terms=?
			WHERE id = ?`,
			in.CustomerID, c.name, c.email, c.gstin, c.address, c.state, in.IssueDate, expiry, status, in.ChallanType, in.Reason,
			invoiceID, in.Reference, p.Subtotal, p.Discount, p.CGST, p.SGST, p.IGST, p.Total, in.Notes, in.Terms, id); err != nil {
			fail(w, err)
			return
		}
		logActivity(ctx, tx, k.Type, id, "edited", "Edited")
	}
	if err := insertLines(ctx, tx, "document_items", "document_id", id, p); err != nil {
		fail(w, err)
		return
	}
	// A new credit note can be used on the invoice it corrects straight away.
	if !editing && k.Type == "credit_note" && status == "open" && in.ApplyToInvoice && in.InvoiceID != nil {
		var balance Dec2
		if err := tx.QueryRowContext(ctx, `SELECT `+invoiceBalanceSQL+` FROM invoices i WHERE id = ?`, *in.InvoiceID).Scan(&balance); err != nil {
			fail(w, err)
			return
		}
		if amount := min(balance, p.Total); amount > 0 {
			if err := s.applyCredit(ctx, tx, id, []allocationInput{{*in.InvoiceID, amount}}, in.IssueDate); err != nil {
				fail(w, err)
				return
			}
		}
	}
	if err := tx.Commit(); err != nil {
		fail(w, err)
		return
	}
	d, err := s.loadDocument(ctx, k, id)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, map[bool]int{true: http.StatusOK, false: http.StatusCreated}[editing], d)
}

// POST /api/{kind}/{id}/status  {"status": "accepted"}
func (s *server) setDocumentStatus(w http.ResponseWriter, r *http.Request, k docKind) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	var body struct {
		Status string `json:"status"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		fail(w, err)
		return
	}
	ctx := r.Context()
	d, err := s.loadDocument(ctx, k, id)
	if err != nil {
		fail(w, err)
		return
	}
	if d.Status == "invoiced" {
		fail(w, conflict("This has already been turned into an invoice, so its status can't change."))
		return
	}
	if !slices.Contains(k.Moves[d.Status], body.Status) {
		fail(w, conflict(fmt.Sprintf("A %s %s can't be marked as %s.", d.Status, strings.ToLower(k.Label), body.Status)))
		return
	}
	if k.Type == "credit_note" {
		if err := s.periodOpen(ctx, "credit note", d.IssueDate); err != nil {
			fail(w, err)
			return
		}
	}
	if k.Type == "credit_note" && body.Status == "void" && d.Applied+d.Refunded > 0 {
		fail(w, conflict("This credit note has been used or refunded. Remove those first, then void it."))
		return
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE documents SET status = ? WHERE id = ?`, body.Status, id); err != nil {
		fail(w, err)
		return
	}
	logActivity(ctx, s.db, k.Type, id, body.Status, "Marked as "+body.Status)
	d, err = s.loadDocument(ctx, k, id)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

// markDocumentIssued moves a draft to its issued status after it's emailed or shared.
func (s *server) markDocumentIssued(ctx context.Context, k docKind, id int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE documents SET status = ? WHERE id = ? AND status = 'draft'`, k.Issued, id)
	return err
}

func (s *server) deleteDocument(w http.ResponseWriter, r *http.Request, k docKind) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	ctx := r.Context()
	d, err := s.loadDocument(ctx, k, id)
	if err != nil {
		fail(w, err)
		return
	}
	if d.Applied+d.Refunded > 0 {
		fail(w, conflict("This credit note has been used or refunded. Remove those first, then delete it."))
		return
	}
	if k.Type == "credit_note" && d.Status != "draft" {
		if err := s.periodOpen(ctx, "credit note", d.IssueDate); err != nil {
			fail(w, err)
			return
		}
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM documents WHERE id = ?`, id); err != nil {
		fail(w, err)
		return
	}
	_, _ = s.db.ExecContext(ctx, `DELETE FROM activity WHERE subject_type = ? AND subject_id = ?`, k.Type, id)
	w.WriteHeader(http.StatusNoContent)
}

func linesAsInput(lines []InvoiceLine) []LineInput {
	out := make([]LineInput, len(lines))
	for i, l := range lines {
		out[i] = LineInput{ItemID: l.ItemID, Description: l.Description, HSNSAC: l.HSNSAC, Unit: l.Unit, Quantity: l.Quantity,
			Rate: l.Rate, DiscountPct: l.DiscountPct, TaxRate: l.TaxRate}
	}
	return out
}

// newDraftFrom builds a draft invoice for a customer, dated today, with the
// usual payment terms and the business's default notes.
func (s *server) newDraftFrom(ctx context.Context, tx *sql.Tx, customerID int64, reference string, lines []LineInput) (int64, error) {
	var terms int
	var notes, termsText string
	err := tx.QueryRowContext(ctx, `SELECT COALESCE(c.payment_terms_days, o.payment_terms_days), o.invoice_notes, o.invoice_terms
		FROM customers c JOIN organization o ON o.id = 1 WHERE c.id = ?`, customerID).Scan(&terms, &notes, &termsText)
	if err != nil {
		return 0, err
	}
	today := todayIST()
	t, _ := time.Parse(dateLayout, today)
	if len(reference) > 100 {
		reference = reference[:97] + "..."
	}
	in := InvoiceInput{CustomerID: customerID, IssueDate: today, DueDate: t.AddDate(0, 0, terms).Format(dateLayout),
		Reference: reference, Notes: notes, Terms: termsText, Status: "draft", Lines: lines}
	if err := in.validate(); err != nil {
		return 0, err
	}
	return s.saveInvoice(ctx, tx, 0, in, "draft", 0)
}

// POST /api/quotes/{id}/convert: makes a draft invoice from the quote.
func (s *server) convertQuote(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	ctx := r.Context()
	q, err := s.loadDocument(ctx, quoteKind, id)
	if err != nil {
		fail(w, err)
		return
	}
	switch q.Status {
	case "invoiced":
		fail(w, conflict("This quote has already been turned into an invoice."))
		return
	case "declined":
		fail(w, conflict("This quote was declined. Mark it as accepted first."))
		return
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		fail(w, err)
		return
	}
	defer tx.Rollback()
	ref := q.Reference
	if ref == "" {
		ref = "Quote " + q.Number
	}
	invID, err := s.newDraftFrom(ctx, tx, q.CustomerID, ref, linesAsInput(q.Lines))
	if err == nil {
		_, err = tx.ExecContext(ctx, `UPDATE documents SET status = 'invoiced', invoice_id = ? WHERE id = ?`, invID, id)
	}
	if err == nil {
		logActivity(ctx, tx, "quote", id, "invoiced", "Turned into an invoice")
		logActivity(ctx, tx, "invoice", invID, "created", "Created from quote "+q.Number)
		err = tx.Commit()
	}
	if err != nil {
		fail(w, err)
		return
	}
	inv, err := s.loadInvoice(ctx, invID)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, inv)
}

// POST /api/challans/convert {"ids": [1, 2]}: one draft invoice from open challans of one customer.
func (s *server) convertChallans(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDs []int64 `json:"ids"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		fail(w, err)
		return
	}
	if len(body.IDs) == 0 || len(body.IDs) > 50 {
		fail(w, badRequest("Choose between 1 and 50 challans to invoice."))
		return
	}
	ctx := r.Context()
	var lines []LineInput
	var numbers []string
	var customerID int64
	for _, id := range body.IDs {
		c, err := s.loadDocument(ctx, challanKind, id)
		if isNotFound(err) {
			fail(w, badRequest("One of those challans no longer exists."))
			return
		} else if err != nil {
			fail(w, err)
			return
		}
		if c.Status != "open" {
			fail(w, conflict(c.Number+" is "+c.Status+". Only open challans can be invoiced."))
			return
		}
		if customerID != 0 && c.CustomerID != customerID {
			fail(w, badRequest("All the challans on one invoice must be for the same customer."))
			return
		}
		customerID = c.CustomerID
		lines = append(lines, linesAsInput(c.Lines)...)
		numbers = append(numbers, c.Number)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		fail(w, err)
		return
	}
	defer tx.Rollback()
	label := "Challan "
	if len(numbers) > 1 {
		label = "Challans "
	}
	invID, err := s.newDraftFrom(ctx, tx, customerID, label+strings.Join(numbers, ", "), lines)
	for i, id := range body.IDs {
		if err != nil {
			break
		}
		_, err = tx.ExecContext(ctx, `UPDATE documents SET status = 'invoiced', invoice_id = ? WHERE id = ? AND status = 'open'`, invID, id)
		logActivity(ctx, tx, "challan", id, "invoiced", "Added to an invoice")
		_ = i
	}
	if err == nil {
		logActivity(ctx, tx, "invoice", invID, "created", "Created from "+strings.ToLower(label)+strings.Join(numbers, ", "))
		err = tx.Commit()
	}
	if err != nil {
		fail(w, err)
		return
	}
	inv, err := s.loadInvoice(ctx, invID)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, inv)
}
