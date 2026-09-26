package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
)

type Expense struct {
	ID                int64   `json:"id"`
	Date              string  `json:"date"`
	CategoryID        int64   `json:"categoryId"`
	CategoryName      string  `json:"categoryName"`
	VendorName        string  `json:"vendorName"`
	VendorGSTIN       string  `json:"vendorGstin"`
	VendorState       string  `json:"vendorState"`
	BillNumber        string  `json:"billNumber"`
	HSNSAC            string  `json:"hsnSac"`
	Description       string  `json:"description"`
	AmountIncludesTax bool    `json:"amountIncludesTax"`
	GSTRate           Dec2    `json:"gstRate"`
	Subtotal          Dec2    `json:"subtotal"`
	CGST              Dec2    `json:"cgst"`
	SGST              Dec2    `json:"sgst"`
	IGST              Dec2    `json:"igst"`
	Total             Dec2    `json:"total"`
	ITCEligible       bool    `json:"itcEligible"`
	ReverseCharge     bool    `json:"reverseCharge"`
	PaidThrough       string  `json:"paidThrough"`
	Reference         string  `json:"reference"`
	CustomerID        *int64  `json:"customerId"`
	CustomerName      *string `json:"customerName"`
	Billable          bool    `json:"billable"`
	MarkupPct         Dec2    `json:"markupPct"`
	InvoiceID         *int64  `json:"invoiceId"`
	InvoiceNumber     *string `json:"invoiceNumber"`
	ReceiptName       *string `json:"receiptName"`
	CreatedAt         string  `json:"createdAt"`
}

const expenseSelect = `SELECT e.id, e.expense_date, e.category_id, ec.name, e.vendor_name, e.vendor_gstin, e.vendor_state,
	e.bill_number, e.hsn_sac, e.description, e.amount_includes_tax, e.gst_rate, e.subtotal, e.cgst, e.sgst, e.igst, e.total,
	e.itc_eligible, e.reverse_charge, e.paid_through, e.reference, e.customer_id, c.display_name, e.billable, e.markup_pct,
	e.invoice_id, i.invoice_number, r.file_name, e.created_at
	FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
	LEFT JOIN customers c ON c.id = e.customer_id LEFT JOIN invoices i ON i.id = e.invoice_id
	LEFT JOIN expense_receipts r ON r.expense_id = e.id`

func scanExpense(row interface{ Scan(...any) error }) (Expense, error) {
	var e Expense
	err := row.Scan(&e.ID, &e.Date, &e.CategoryID, &e.CategoryName, &e.VendorName, &e.VendorGSTIN, &e.VendorState,
		&e.BillNumber, &e.HSNSAC, &e.Description, &e.AmountIncludesTax, &e.GSTRate, &e.Subtotal, &e.CGST, &e.SGST, &e.IGST,
		&e.Total, &e.ITCEligible, &e.ReverseCharge, &e.PaidThrough, &e.Reference, &e.CustomerID, &e.CustomerName, &e.Billable,
		&e.MarkupPct, &e.InvoiceID, &e.InvoiceNumber, &e.ReceiptName, &e.CreatedAt)
	return e, err
}

// rebillAmount is what a billable expense is charged at: its value before GST plus the markup.
func (e Expense) rebillAmount() Dec2 {
	return e.Subtotal + Dec2(roundDiv(int64(e.Subtotal)*int64(e.MarkupPct), 10000))
}

// GET /api/expenses[?from=&to=&categoryId=&customerId=&status=billable|unbilled|billed]
func (s *server) listExpenses(w http.ResponseWriter, r *http.Request) {
	q := expenseSelect + ` WHERE 1 = 1`
	var args []any
	qs := r.URL.Query()
	if from := qs.Get("from"); validDate(from) {
		q += ` AND e.expense_date >= ?`
		args = append(args, from)
	}
	if to := qs.Get("to"); validDate(to) {
		q += ` AND e.expense_date <= ?`
		args = append(args, to)
	}
	if id, err := strconv.ParseInt(qs.Get("categoryId"), 10, 64); err == nil {
		q += ` AND e.category_id = ?`
		args = append(args, id)
	}
	if id, err := strconv.ParseInt(qs.Get("customerId"), 10, 64); err == nil {
		q += ` AND e.customer_id = ?`
		args = append(args, id)
	}
	switch qs.Get("status") {
	case "billable":
		q += ` AND e.billable = TRUE`
	case "unbilled":
		q += ` AND e.billable = TRUE AND e.invoice_id IS NULL`
	case "billed":
		q += ` AND e.invoice_id IS NOT NULL`
	}
	rows, err := s.db.QueryContext(r.Context(), q+` ORDER BY e.expense_date DESC, e.id DESC LIMIT 5000`, args...)
	if err != nil {
		fail(w, err)
		return
	}
	defer rows.Close()
	list := []Expense{}
	for rows.Next() {
		e, err := scanExpense(rows)
		if err != nil {
			fail(w, err)
			return
		}
		list = append(list, e)
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *server) getExpense(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	e, err := scanExpense(s.db.QueryRowContext(r.Context(), expenseSelect+` WHERE e.id = ?`, id))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, e)
}

type ExpenseInput struct {
	Date              string `json:"date"`
	CategoryID        int64  `json:"categoryId"`
	VendorName        string `json:"vendorName"`
	VendorGSTIN       string `json:"vendorGstin"`
	VendorState       string `json:"vendorState"`
	BillNumber        string `json:"billNumber"`
	HSNSAC            string `json:"hsnSac"`
	Description       string `json:"description"`
	Amount            Dec2   `json:"amount"`
	AmountIncludesTax bool   `json:"amountIncludesTax"`
	GSTRate           Dec2   `json:"gstRate"`
	ITCEligible       bool   `json:"itcEligible"`
	ReverseCharge     bool   `json:"reverseCharge"`
	PaidThrough       string `json:"paidThrough"`
	Reference         string `json:"reference"`
	CustomerID        *int64 `json:"customerId"`
	Billable          bool   `json:"billable"`
	MarkupPct         Dec2   `json:"markupPct"`
}

func (in *ExpenseInput) validate() error {
	in.VendorName = strings.TrimSpace(in.VendorName)
	in.VendorGSTIN = strings.ToUpper(strings.TrimSpace(in.VendorGSTIN))
	in.BillNumber = strings.TrimSpace(in.BillNumber)
	in.HSNSAC = strings.TrimSpace(in.HSNSAC)
	in.Reference = strings.TrimSpace(in.Reference)
	switch {
	case !validDate(in.Date):
		return badRequest("Enter the expense date.")
	case in.CategoryID <= 0:
		return badRequest("Choose a category.")
	case in.Amount <= 0 || in.Amount > 100_000_000_000:
		return badRequest("Enter the amount you paid.")
	case in.GSTRate < 0 || in.GSTRate > 10000:
		return badRequest("GST rate must be between 0 and 100%.")
	case in.VendorGSTIN != "" && !validGSTIN(in.VendorGSTIN):
		return badRequest("The vendor's GSTIN isn't valid. It should be 15 characters, like 33ABCDE1234F1Z5.")
	case in.VendorState != "" && !validState(in.VendorState):
		return badRequest("Choose the vendor's state.")
	case in.HSNSAC != "" && !hsnPattern.MatchString(in.HSNSAC):
		return badRequest("HSN/SAC must be 4, 6, or 8 digits.")
	case !validPaymentMode(in.PaidThrough):
		return badRequest("Choose how you paid.")
	case len(in.VendorName) > 255 || len(in.BillNumber) > 50 || len(in.Description) > 500 || len(in.Reference) > 100:
		return badRequest("Vendor, bill number, description, or reference is too long.")
	case in.Billable && in.CustomerID == nil:
		return badRequest("Choose the customer to bill this expense to.")
	case in.MarkupPct < 0 || in.MarkupPct > 100000:
		return badRequest("Markup must be between 0 and 1000%.")
	}
	if in.VendorGSTIN != "" && in.VendorState == "" {
		in.VendorState = in.VendorGSTIN[:2]
	}
	if in.ReverseCharge {
		in.AmountIncludesTax = false // under reverse charge the vendor's bill has no GST on it
	}
	if !in.Billable {
		in.MarkupPct = 0
	}
	return nil
}

// expenseTax splits the amount into value and GST. When the amount includes
// GST, the value is worked back so value + GST always equals the bill.
func expenseTax(amount, rate Dec2, includesTax, interState bool) (subtotal Dec2, a lineAmounts) {
	subtotal = amount
	if includesTax && rate > 0 {
		subtotal = Dec2(roundDiv(int64(amount)*10000, 10000+int64(rate)))
	}
	a = calcLine(100, subtotal, 0, rate, interState)
	if includesTax && rate > 0 {
		if diff := amount - (subtotal + a.CGST + a.SGST + a.IGST); diff != 0 {
			subtotal += diff
		}
	}
	return subtotal, a
}

func (s *server) saveExpense(w http.ResponseWriter, r *http.Request) {
	editing := r.Method == http.MethodPut
	var id int64
	var err error
	if editing {
		if id, err = pathID(r); err != nil {
			fail(w, err)
			return
		}
	}
	var in ExpenseInput
	if err := decodeJSON(w, r, &in); err != nil {
		fail(w, err)
		return
	}
	if err := in.validate(); err != nil {
		fail(w, err)
		return
	}
	ctx := r.Context()
	var orgState string
	var registered bool
	if err := s.db.QueryRowContext(ctx, `SELECT state_code, gst_registered FROM organization WHERE id = 1`).Scan(&orgState, &registered); err != nil {
		fail(w, err)
		return
	}
	if !registered {
		in.ITCEligible = false // only GST-registered businesses can claim input tax
	}
	var exists int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM expense_categories WHERE id = ?`, in.CategoryID).Scan(&exists); err != nil || exists == 0 {
		fail(w, badRequest("That category no longer exists."))
		return
	}
	if in.CustomerID != nil {
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM customers WHERE id = ?`, *in.CustomerID).Scan(&exists); err != nil || exists == 0 {
			fail(w, badRequest("That customer no longer exists."))
			return
		}
	}
	if editing {
		var invoiceID, customerID *int64
		if err := s.db.QueryRowContext(ctx, `SELECT invoice_id, customer_id FROM expenses WHERE id = ?`, id).Scan(&invoiceID, &customerID); err != nil {
			fail(w, err)
			return
		}
		if invoiceID != nil && (!in.Billable || in.CustomerID == nil || customerID == nil || *in.CustomerID != *customerID) {
			fail(w, conflict("This expense is already on an invoice, so its customer can't change. Remove it from the invoice first."))
			return
		}
	}
	vendorState := in.VendorState
	if vendorState == "" {
		vendorState = orgState
	}
	subtotal, a := expenseTax(in.Amount, in.GSTRate, in.AmountIncludesTax, vendorState != orgState)
	total := subtotal + a.CGST + a.SGST + a.IGST
	args := []any{in.Date, in.CategoryID, in.VendorName, in.VendorGSTIN, in.VendorState, in.BillNumber, in.HSNSAC, in.Description,
		in.AmountIncludesTax, in.GSTRate, subtotal, a.CGST, a.SGST, a.IGST, total, in.ITCEligible, in.ReverseCharge,
		in.PaidThrough, in.Reference, in.CustomerID, in.Billable, in.MarkupPct}
	if editing {
		_, err = s.db.ExecContext(ctx, `UPDATE expenses SET expense_date=?, category_id=?, vendor_name=?, vendor_gstin=?,
			vendor_state=?, bill_number=?, hsn_sac=?, description=?, amount_includes_tax=?, gst_rate=?, subtotal=?, cgst=?, sgst=?,
			igst=?, total=?, itc_eligible=?, reverse_charge=?, paid_through=?, reference=?, customer_id=?, billable=?, markup_pct=?
			WHERE id = ?`, append(args, id)...)
	} else {
		var res interface{ LastInsertId() (int64, error) }
		res, err = s.db.ExecContext(ctx, `INSERT INTO expenses (expense_date, category_id, vendor_name, vendor_gstin, vendor_state,
			bill_number, hsn_sac, description, amount_includes_tax, gst_rate, subtotal, cgst, sgst, igst, total, itc_eligible,
			reverse_charge, paid_through, reference, customer_id, billable, markup_pct, created_by)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, append(args, currentUserID(r))...)
		if err == nil {
			id, _ = res.LastInsertId()
		}
	}
	if err != nil {
		fail(w, err)
		return
	}
	e, err := scanExpense(s.db.QueryRowContext(ctx, expenseSelect+` WHERE e.id = ?`, id))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, map[bool]int{true: http.StatusOK, false: http.StatusCreated}[editing], e)
}

func (s *server) deleteExpense(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	var invoiceID *int64
	if err := s.db.QueryRowContext(r.Context(), `SELECT invoice_id FROM expenses WHERE id = ?`, id).Scan(&invoiceID); err != nil {
		fail(w, err)
		return
	}
	if invoiceID != nil {
		fail(w, conflict("This expense is on an invoice. Remove it from the invoice first."))
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `DELETE FROM expenses WHERE id = ?`, id); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------- Receipts ----------

var receiptTypes = map[string]bool{"image/jpeg": true, "image/png": true, "image/webp": true, "application/pdf": true}

const maxReceipt = 5 << 20

// POST /api/expenses/{id}/receipt (multipart form, field "file")
func (s *server) uploadReceipt(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxReceipt+(64<<10))
	file, header, err := r.FormFile("file")
	if err != nil {
		fail(w, badRequest("Choose a receipt file of up to 5 MB (JPG, PNG, WebP, or PDF)."))
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxReceipt+1))
	if err != nil || len(data) == 0 || len(data) > maxReceipt {
		fail(w, badRequest("Receipts can be up to 5 MB."))
		return
	}
	ctype := http.DetectContentType(data)
	if strings.HasPrefix(ctype, "application/pdf") || bytes.HasPrefix(data, []byte("%PDF")) {
		ctype = "application/pdf"
	}
	if !receiptTypes[ctype] {
		fail(w, badRequest("Receipts must be JPG, PNG, WebP, or PDF files."))
		return
	}
	name := filepath.Base(header.Filename)
	if len(name) > 200 {
		name = name[len(name)-200:]
	}
	var exists int
	if err := s.db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM expenses WHERE id = ?`, id).Scan(&exists); err != nil || exists == 0 {
		fail(w, notFound("Expense not found."))
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `REPLACE INTO expense_receipts (expense_id, file_name, content_type, size_bytes, data)
		VALUES (?, ?, ?, ?, ?)`, id, name, ctype, len(data), data); err != nil {
		fail(w, err)
		return
	}
	s.getExpense(w, r)
}

func (s *server) getReceipt(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	var name, ctype string
	var data []byte
	if err := s.db.QueryRowContext(r.Context(), `SELECT file_name, content_type, data FROM expense_receipts WHERE expense_id = ?`, id).
		Scan(&name, &ctype, &data); err != nil {
		fail(w, err)
		return
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s"`, strings.ReplaceAll(name, `"`, "")))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
	_, _ = w.Write(data)
}

func (s *server) deleteReceipt(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `DELETE FROM expense_receipts WHERE expense_id = ?`, id); err != nil {
		fail(w, err)
		return
	}
	s.getExpense(w, r)
}

// ---------- Categories and vendors ----------

type ExpenseCategory struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Archived bool   `json:"archived"`
	Used     int    `json:"used"`
}

func (s *server) listExpenseCategories(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.QueryContext(r.Context(), `SELECT ec.id, ec.name, ec.archived,
		(SELECT COUNT(*) FROM expenses e WHERE e.category_id = ec.id) FROM expense_categories ec ORDER BY ec.name`)
	if err != nil {
		fail(w, err)
		return
	}
	defer rows.Close()
	list := []ExpenseCategory{}
	for rows.Next() {
		var c ExpenseCategory
		if err := rows.Scan(&c.ID, &c.Name, &c.Archived, &c.Used); err != nil {
			fail(w, err)
			return
		}
		list = append(list, c)
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *server) saveExpenseCategory(w http.ResponseWriter, r *http.Request) {
	var body ExpenseCategory
	if err := decodeJSON(w, r, &body); err != nil {
		fail(w, err)
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || len(body.Name) > 60 {
		fail(w, badRequest("Category names must be 1 to 60 characters."))
		return
	}
	var err error
	if r.Method == http.MethodPut {
		id, perr := pathID(r)
		if perr != nil {
			fail(w, perr)
			return
		}
		_, err = s.db.ExecContext(r.Context(), `UPDATE expense_categories SET name = ?, archived = ? WHERE id = ?`, body.Name, body.Archived, id)
	} else {
		_, err = s.db.ExecContext(r.Context(), `INSERT INTO expense_categories (name) VALUES (?)`, body.Name)
	}
	if isDuplicate(err) {
		fail(w, conflict("There's already a category with that name."))
		return
	} else if err != nil {
		fail(w, err)
		return
	}
	s.listExpenseCategories(w, r)
}

func (s *server) deleteExpenseCategory(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	var used int
	if err := s.db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM expenses WHERE category_id = ?`, id).Scan(&used); err != nil {
		fail(w, err)
		return
	}
	if used > 0 {
		fail(w, conflict("This category has expenses, so it can't be deleted. Archive it instead."))
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `DELETE FROM expense_categories WHERE id = ?`, id); err != nil {
		fail(w, err)
		return
	}
	s.listExpenseCategories(w, r)
}

// GET /api/vendors: vendors from past expenses, for filling in the form.
func (s *server) listVendors(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.QueryContext(r.Context(), `SELECT e.vendor_name, e.vendor_gstin, e.vendor_state FROM expenses e
		WHERE e.vendor_name <> '' AND e.id = (SELECT MAX(e2.id) FROM expenses e2 WHERE e2.vendor_name = e.vendor_name)
		ORDER BY e.vendor_name LIMIT 1000`)
	if err != nil {
		fail(w, err)
		return
	}
	defer rows.Close()
	type vendor struct {
		Name  string `json:"name"`
		GSTIN string `json:"gstin"`
		State string `json:"state"`
	}
	list := []vendor{}
	for rows.Next() {
		var v vendor
		if err := rows.Scan(&v.Name, &v.GSTIN, &v.State); err != nil {
			fail(w, err)
			return
		}
		list = append(list, v)
	}
	writeJSON(w, http.StatusOK, list)
}
