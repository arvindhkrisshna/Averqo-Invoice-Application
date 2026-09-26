package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// LineInput is one line as sent by the browser. Totals are never trusted
// from the browser; priceLines works them out.
type LineInput struct {
	ItemID      *int64 `json:"itemId"`
	Description string `json:"description"`
	HSNSAC      string `json:"hsnSac"`
	Unit        string `json:"unit"`
	Quantity    Dec2   `json:"quantity"`
	Rate        Dec2   `json:"rate"`
	DiscountPct Dec2   `json:"discountPct"`
	TaxRate     Dec2   `json:"taxRate"`
	// Invoices only: the timesheet entries or expense this line bills.
	TimeEntryIDs []int64 `json:"timeEntryIds,omitempty"`
	ExpenseID    *int64  `json:"expenseId,omitempty"`
}

func validateLines(lines []LineInput) error {
	switch {
	case len(lines) == 0:
		return badRequest("Add at least one line item.")
	case len(lines) > 200:
		return badRequest("A document can have at most 200 lines.")
	}
	for i := range lines {
		l := &lines[i]
		n := i + 1
		l.Description = strings.TrimSpace(l.Description)
		l.HSNSAC = strings.TrimSpace(l.HSNSAC)
		l.Unit = strings.TrimSpace(l.Unit)
		switch {
		case l.Description == "":
			return badRequest(fmt.Sprintf("Line %d needs a description.", n))
		case len(l.Description) > 255 || len(l.Unit) > 10:
			return badRequest(fmt.Sprintf("Line %d description or unit is too long.", n))
		case l.HSNSAC != "" && !hsnPattern.MatchString(l.HSNSAC):
			return badRequest(fmt.Sprintf("Line %d HSN/SAC code must be 4, 6, or 8 digits.", n))
		case l.Quantity <= 0 || l.Quantity > 10_000_000:
			return badRequest(fmt.Sprintf("Line %d quantity must be more than 0 and at most 1,00,000.", n))
		case l.Rate < 0 || l.Rate > 1_000_000_000:
			return badRequest(fmt.Sprintf("Line %d rate must be between 0 and 1,00,00,000.", n))
		case l.DiscountPct < 0 || l.DiscountPct > 10000:
			return badRequest(fmt.Sprintf("Line %d discount must be between 0 and 100%%.", n))
		case l.TaxRate < 0 || l.TaxRate > 10000:
			return badRequest(fmt.Sprintf("Line %d GST rate must be between 0 and 100%%.", n))
		case len(l.TimeEntryIDs) > 200:
			return badRequest(fmt.Sprintf("Line %d bills too many timesheet entries; split it into smaller lines.", n))
		}
	}
	return nil
}

type pricedLine struct {
	LineInput
	amounts lineAmounts
}

type priced struct {
	Lines                                []pricedLine
	Subtotal, Discount, CGST, SGST, IGST Dec2
	Total                                Dec2
}

// saleContext is what decides the GST on a sale: whether the business is
// GST-registered, and whether the customer is in another state.
type saleContext struct {
	gstRegistered bool
	interState    bool
	customer      customerSnapshot
}

// loadSaleContext locks the business profile row (so numbering is safe) and
// loads the customer's details as they are right now.
func loadSaleContext(ctx context.Context, tx *sql.Tx, customerID int64) (saleContext, error) {
	var sc saleContext
	var orgState string
	if err := tx.QueryRowContext(ctx, `SELECT gst_registered, state_code FROM organization WHERE id = 1 FOR UPDATE`).
		Scan(&sc.gstRegistered, &orgState); err != nil {
		return sc, err
	}
	if orgState == "" {
		return sc, badRequest("Add your business details in Settings first. Your state decides whether CGST + SGST or IGST applies.")
	}
	cust, err := loadCustomerSnapshot(ctx, tx, customerID)
	if err != nil {
		return sc, err
	}
	sc.customer = cust
	sc.interState = cust.state != orgState
	return sc, nil
}

// priceLines applies discounts and GST to every line and totals them up.
func priceLines(ctx context.Context, tx *sql.Tx, lines []LineInput, sc saleContext) (priced, error) {
	var p priced
	for i, l := range lines {
		if !sc.gstRegistered {
			l.TaxRate = 0 // businesses without GST registration can't charge GST
		}
		if l.ItemID != nil {
			var exists int
			if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM items WHERE id = ?`, *l.ItemID).Scan(&exists); err != nil {
				return p, err
			}
			if exists == 0 {
				return p, badRequest(fmt.Sprintf("Line %d uses an item that no longer exists.", i+1))
			}
		}
		a := calcLine(l.Quantity, l.Rate, l.DiscountPct, l.TaxRate, sc.interState)
		p.Lines = append(p.Lines, pricedLine{l, a})
		p.Subtotal += a.Taxable
		p.Discount += a.Discount
		p.CGST += a.CGST
		p.SGST += a.SGST
		p.IGST += a.IGST
	}
	p.Total = p.Subtotal + p.CGST + p.SGST + p.IGST
	return p, nil
}

// insertLines replaces the lines of an invoice (invoice_items) or a quote,
// challan, or credit note (document_items).
func insertLines(ctx context.Context, tx *sql.Tx, table, parentCol string, parentID int64, p priced) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM `+table+` WHERE `+parentCol+` = ?`, parentID); err != nil {
		return err
	}
	withSources := table == "invoice_items"
	cols, marks := "", ""
	if withSources {
		cols, marks = ", expense_id, time_entry_ids", ", ?, ?"
	}
	stmt, err := tx.PrepareContext(ctx, `INSERT INTO `+table+` (`+parentCol+`, item_id, description, hsn_sac, unit,
		quantity, rate, discount_pct, tax_rate, taxable_amount, cgst, sgst, igst, sort_order`+cols+`)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?`+marks+`)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for i, l := range p.Lines {
		args := []any{parentID, l.ItemID, l.Description, l.HSNSAC, l.Unit, l.Quantity, l.Rate,
			l.DiscountPct, l.TaxRate, l.amounts.Taxable, l.amounts.CGST, l.amounts.SGST, l.amounts.IGST, i + 1}
		if withSources {
			args = append(args, l.ExpenseID, joinIDs(l.TimeEntryIDs))
		}
		if _, err := stmt.ExecContext(ctx, args...); err != nil {
			return err
		}
	}
	return nil
}

type queryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func loadLines(ctx context.Context, q queryer, table, parentCol string, id int64) ([]InvoiceLine, error) {
	sources := `NULL, ''`
	if table == "invoice_items" {
		sources = `expense_id, time_entry_ids`
	}
	rows, err := q.QueryContext(ctx, `SELECT id, item_id, description, hsn_sac, unit, quantity, rate,
		discount_pct, tax_rate, taxable_amount, cgst, sgst, igst, `+sources+`
		FROM `+table+` WHERE `+parentCol+` = ? ORDER BY sort_order, id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	lines := []InvoiceLine{}
	for rows.Next() {
		var l InvoiceLine
		var timeIDs string
		if err := rows.Scan(&l.ID, &l.ItemID, &l.Description, &l.HSNSAC, &l.Unit, &l.Quantity, &l.Rate,
			&l.DiscountPct, &l.TaxRate, &l.TaxableAmount, &l.CGST, &l.SGST, &l.IGST, &l.ExpenseID, &timeIDs); err != nil {
			return nil, err
		}
		l.TimeEntryIDs = splitIDs(timeIDs)
		lines = append(lines, l)
	}
	return lines, rows.Err()
}

// takeNumber hands out the next document number (e.g. QT-0007) and moves the
// counter on, skipping any number already used. Column names are constants.
func takeNumber(ctx context.Context, tx *sql.Tx, prefixCol, nextCol, existsSQL string, existsArgs ...any) (string, error) {
	var prefix string
	var next int
	if err := tx.QueryRowContext(ctx, `SELECT `+prefixCol+`, `+nextCol+` FROM organization WHERE id = 1 FOR UPDATE`).
		Scan(&prefix, &next); err != nil {
		return "", err
	}
	for {
		number := fmt.Sprintf("%s%04d", prefix, next)
		var taken int
		if err := tx.QueryRowContext(ctx, existsSQL, append([]any{number}, existsArgs...)...).Scan(&taken); err != nil {
			return "", err
		}
		if taken == 0 {
			_, err := tx.ExecContext(ctx, `UPDATE organization SET `+nextCol+` = ? WHERE id = 1`, next+1)
			return number, err
		}
		next++
	}
}

// ---------- Activity history ----------

type ActivityEntry struct {
	Action    string `json:"action"`
	Detail    string `json:"detail"`
	CreatedAt string `json:"createdAt"`
}

func logActivity(ctx context.Context, q queryer, subjectType string, id int64, action, detail string) {
	if len(detail) > 500 {
		detail = detail[:500]
	}
	// History is helpful but never worth failing the real action over.
	_, _ = q.ExecContext(ctx, `INSERT INTO activity (subject_type, subject_id, action, detail) VALUES (?, ?, ?, ?)`,
		subjectType, id, action, detail)
}

func loadActivity(ctx context.Context, q queryer, subjectType string, id int64) ([]ActivityEntry, error) {
	rows, err := q.QueryContext(ctx, `SELECT action, detail, created_at FROM activity
		WHERE subject_type = ? AND subject_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`, subjectType, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ActivityEntry{}
	for rows.Next() {
		var a ActivityEntry
		if err := rows.Scan(&a.Action, &a.Detail, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// DocRef is a short link to a related document (e.g. the quote an invoice came from).
type DocRef struct {
	ID     int64  `json:"id"`
	Type   string `json:"type"`
	Number string `json:"number"`
	Status string `json:"status"`
	Total  Dec2   `json:"total"`
}

func isNotFound(err error) bool { return errors.Is(err, sql.ErrNoRows) }

func joinIDs(ids []int64) string {
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = strconv.FormatInt(id, 10)
	}
	return strings.Join(parts, ",")
}

func splitIDs(s string) []int64 {
	var out []int64
	for _, p := range strings.Split(s, ",") {
		if id, err := strconv.ParseInt(strings.TrimSpace(p), 10, 64); err == nil && id > 0 {
			out = append(out, id)
		}
	}
	return out
}

// linkSources marks the timesheet entries and expenses on an invoice's lines
// as billed by it. Whatever the invoice billed before is released first, so
// removing a line makes its hours or expense unbilled again.
func linkSources(ctx context.Context, tx *sql.Tx, invoiceID, customerID int64, lines []pricedLine) error {
	if err := releaseSources(ctx, tx, invoiceID); err != nil {
		return err
	}
	for i, l := range lines {
		if len(l.TimeEntryIDs) > 0 {
			marks := strings.TrimSuffix(strings.Repeat("?,", len(l.TimeEntryIDs)), ",")
			args := []any{invoiceID}
			for _, id := range l.TimeEntryIDs {
				args = append(args, id)
			}
			args = append(args, customerID)
			res, err := tx.ExecContext(ctx, `UPDATE time_entries te JOIN projects p ON p.id = te.project_id
				SET te.invoice_id = ? WHERE te.id IN (`+marks+`) AND p.customer_id = ? AND te.billable = TRUE
				AND te.timer_started_at IS NULL AND te.invoice_id IS NULL`, args...)
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); int(n) != len(l.TimeEntryIDs) {
				return badRequest(fmt.Sprintf("Line %d includes hours that are already billed or belong to another customer. Remove the line and add the unbilled time again.", i+1))
			}
		}
		if l.ExpenseID != nil {
			res, err := tx.ExecContext(ctx, `UPDATE expenses SET invoice_id = ? WHERE id = ? AND customer_id = ?
				AND billable = TRUE AND invoice_id IS NULL`, invoiceID, *l.ExpenseID, customerID)
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n != 1 {
				return badRequest(fmt.Sprintf("Line %d is an expense that's already billed or belongs to another customer. Remove the line and add it again.", i+1))
			}
		}
	}
	return nil
}

func releaseSources(ctx context.Context, q queryer, invoiceID int64) error {
	if _, err := q.ExecContext(ctx, `UPDATE time_entries SET invoice_id = NULL WHERE invoice_id = ?`, invoiceID); err != nil {
		return err
	}
	_, err := q.ExecContext(ctx, `UPDATE expenses SET invoice_id = NULL WHERE invoice_id = ?`, invoiceID)
	return err
}
