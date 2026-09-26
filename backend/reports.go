package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"time"
)

// Every report comes back in one shape, so one screen can show (and export) any of them.
type reportCol struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Type  string `json:"type"` // text | money | number | hours | date | link
}

type Report struct {
	Key      string           `json:"key"`
	Title    string           `json:"title"`
	From     string           `json:"from"`
	To       string           `json:"to"`
	AsOf     bool             `json:"asOf"` // a snapshot for today; the date range doesn't apply
	Columns  []reportCol      `json:"columns"`
	Rows     []map[string]any `json:"rows"`
	Totals   map[string]any   `json:"totals"`
	Note     string           `json:"note"`
}

type row = map[string]any

func col(key, label, typ string) reportCol { return reportCol{key, label, typ} }

// fyStart is 1 April of the financial year that contains date.
func fyStart(date string) string {
	t, _ := time.Parse(dateLayout, date)
	y := t.Year()
	if t.Month() < time.April {
		y--
	}
	return fmt.Sprintf("%d-04-01", y)
}

func sumCols(rows []map[string]any, keys ...string) map[string]any {
	totals := map[string]any{}
	for _, k := range keys {
		var s Dec2
		var n int
		isInt := false
		for _, r := range rows {
			switch v := r[k].(type) {
			case Dec2:
				s += v
			case int:
				n += v
				isInt = true
			}
		}
		if isInt {
			totals[k] = n
		} else {
			totals[k] = s
		}
	}
	return totals
}

// GET /api/reports/{key}?from=&to=
func (s *server) getReport(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	to := r.URL.Query().Get("to")
	if !validDate(to) {
		to = todayIST()
	}
	from := r.URL.Query().Get("from")
	if !validDate(from) {
		from = fyStart(to)
	}
	if from > to {
		fail(w, badRequest("The start date must be before the end date."))
		return
	}
	build, ok := reports[key]
	if !ok {
		fail(w, notFound("That report doesn't exist."))
		return
	}
	rep, err := build(s, r.Context(), from, to)
	if err != nil {
		fail(w, err)
		return
	}
	rep.Key, rep.From, rep.To = key, from, to
	if rep.Rows == nil {
		rep.Rows = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, rep)
}

type reportFunc func(s *server, ctx context.Context, from, to string) (Report, error)

var reports = map[string]reportFunc{
	"sales-by-customer":    salesByCustomer,
	"sales-by-item":        salesByItem,
	"sales-by-month":       salesByMonth,
	"receivables-aging":    receivablesAging,
	"invoice-details":      invoiceDetails,
	"payments-received":    paymentsReceived,
	"customer-balances":    customerBalances,
	"expenses-by-category": expensesByCategory,
	"expense-details":      expenseDetails,
	"profit-and-loss":      profitAndLoss,
	"tax-summary":          taxSummary,
	"time-by-project":      timeByProject,
}

func salesByCustomer(s *server, ctx context.Context, from, to string) (Report, error) {
	rep := Report{Title: "Sales by customer", Columns: []reportCol{col("customer", "Customer", "text"),
		col("invoices", "Invoices", "number"), col("taxable", "Taxable value", "money"), col("gst", "GST", "money"),
		col("total", "Invoiced", "money"), col("credits", "Credit notes", "money"), col("net", "Net sales", "money")},
		Note: "Sent invoices and issued credit notes dated in the period."}
	rows, err := s.db.QueryContext(ctx, `SELECT c.id, c.display_name, COUNT(i.id), SUM(i.subtotal),
		SUM(i.cgst_total + i.sgst_total + i.igst_total), SUM(i.total),
		COALESCE((SELECT SUM(d.total) FROM documents d WHERE d.customer_id = c.id AND d.doc_type = 'credit_note'
			AND d.status = 'open' AND d.issue_date BETWEEN ? AND ?), 0)
		FROM invoices i JOIN customers c ON c.id = i.customer_id
		WHERE i.lifecycle = 'sent' AND i.issue_date BETWEEN ? AND ? GROUP BY c.id, c.display_name ORDER BY SUM(i.total) DESC`,
		from, to, from, to)
	if err != nil {
		return rep, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var name string
		var n int
		var taxable, gst, total, credits Dec2
		if err := rows.Scan(&id, &name, &n, &taxable, &gst, &total, &credits); err != nil {
			return rep, err
		}
		rep.Rows = append(rep.Rows, row{"customer": name, "_link": fmt.Sprintf("/customers/%d", id), "invoices": n,
			"taxable": taxable, "gst": gst, "total": total, "credits": credits, "net": total - credits})
	}
	rep.Totals = sumCols(rep.Rows, "invoices", "taxable", "gst", "total", "credits", "net")
	return rep, rows.Err()
}

func salesByItem(s *server, ctx context.Context, from, to string) (Report, error) {
	rep := Report{Title: "Sales by item", Columns: []reportCol{col("item", "Item", "text"), col("hsn", "HSN/SAC", "text"),
		col("qty", "Quantity", "number"), col("unit", "Unit", "text"), col("invoices", "Invoices", "number"),
		col("avgRate", "Average rate", "money"), col("taxable", "Taxable value", "money")},
		Note: "Lines on sent invoices dated in the period. Lines without a saved item are grouped by description."}
	rows, err := s.db.QueryContext(ctx, `SELECT COALESCE(it.name, l.description), MAX(l.hsn_sac), SUM(l.quantity), MAX(l.unit),
		COUNT(DISTINCT i.id), SUM(l.taxable_amount)
		FROM invoice_items l JOIN invoices i ON i.id = l.invoice_id LEFT JOIN items it ON it.id = l.item_id
		WHERE i.lifecycle = 'sent' AND i.issue_date BETWEEN ? AND ?
		GROUP BY COALESCE(it.name, l.description) ORDER BY SUM(l.taxable_amount) DESC LIMIT 1000`, from, to)
	if err != nil {
		return rep, err
	}
	defer rows.Close()
	for rows.Next() {
		var name, hsn, unit string
		var qty, taxable Dec2
		var n int
		if err := rows.Scan(&name, &hsn, &qty, &unit, &n, &taxable); err != nil {
			return rep, err
		}
		avg := Dec2(0)
		if qty > 0 {
			avg = Dec2(roundDiv(int64(taxable)*100, int64(qty)))
		}
		rep.Rows = append(rep.Rows, row{"item": name, "hsn": hsn, "qty": qty, "unit": unit, "invoices": n, "avgRate": avg, "taxable": taxable})
	}
	rep.Totals = sumCols(rep.Rows, "taxable")
	return rep, rows.Err()
}

func salesByMonth(s *server, ctx context.Context, from, to string) (Report, error) {
	rep := Report{Title: "Sales by month", Columns: []reportCol{col("month", "Month", "text"), col("invoices", "Invoices", "number"),
		col("taxable", "Taxable value", "money"), col("gst", "GST", "money"), col("total", "Invoiced", "money"),
		col("received", "Payments received", "money")}}
	type m struct {
		n                              int
		taxable, gst, total, received Dec2
	}
	months := map[string]*m{}
	get := func(k string) *m {
		if months[k] == nil {
			months[k] = &m{}
		}
		return months[k]
	}
	rows, err := s.db.QueryContext(ctx, `SELECT DATE_FORMAT(issue_date, '%Y-%m'), COUNT(*), SUM(subtotal),
		SUM(cgst_total + sgst_total + igst_total), SUM(total) FROM invoices WHERE lifecycle = 'sent' AND issue_date BETWEEN ? AND ?
		GROUP BY 1`, from, to)
	if err != nil {
		return rep, err
	}
	for rows.Next() {
		var k string
		var x m
		if err := rows.Scan(&k, &x.n, &x.taxable, &x.gst, &x.total); err != nil {
			rows.Close()
			return rep, err
		}
		v := get(k)
		v.n, v.taxable, v.gst, v.total = x.n, x.taxable, x.gst, x.total
	}
	rows.Close()
	rows, err = s.db.QueryContext(ctx, `SELECT DATE_FORMAT(payment_date, '%Y-%m'), SUM(amount) FROM payments
		WHERE payment_date BETWEEN ? AND ? GROUP BY 1`, from, to)
	if err != nil {
		return rep, err
	}
	for rows.Next() {
		var k string
		var amt Dec2
		if err := rows.Scan(&k, &amt); err != nil {
			rows.Close()
			return rep, err
		}
		get(k).received = amt
	}
	rows.Close()
	start, _ := time.Parse(dateLayout, from[:8]+"01")
	end, _ := time.Parse(dateLayout, to)
	for t := start; !t.After(end); t = t.AddDate(0, 1, 0) {
		v := get(t.Format("2006-01"))
		rep.Rows = append(rep.Rows, row{"month": t.Format("Jan 2006"), "invoices": v.n, "taxable": v.taxable, "gst": v.gst,
			"total": v.total, "received": v.received})
	}
	rep.Totals = sumCols(rep.Rows, "invoices", "taxable", "gst", "total", "received")
	return rep, nil
}

func receivablesAging(s *server, ctx context.Context, from, to string) (Report, error) {
	rep := Report{Title: "Receivables aging", AsOf: true, Columns: []reportCol{col("customer", "Customer", "text"),
		col("current", "Not yet due", "money"), col("d15", "1–15 days", "money"), col("d30", "16–30 days", "money"),
		col("d45", "31–45 days", "money"), col("over45", "Over 45 days", "money"), col("total", "Total due", "money")},
		Note: "What each customer owes today, by how many days it is overdue."}
	rows, err := s.db.QueryContext(ctx, `SELECT c.id, c.display_name, i.due_date, `+invoiceBalanceSQL+`
		FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.lifecycle = 'sent' AND `+invoiceBalanceSQL+` > 0
		ORDER BY c.display_name`)
	if err != nil {
		return rep, err
	}
	defer rows.Close()
	today, _ := time.Parse(dateLayout, todayIST())
	byCustomer := map[int64]row{}
	var order []int64
	for rows.Next() {
		var id int64
		var name, due string
		var bal Dec2
		if err := rows.Scan(&id, &name, &due, &bal); err != nil {
			return rep, err
		}
		rw, ok := byCustomer[id]
		if !ok {
			rw = row{"customer": name, "_link": fmt.Sprintf("/customers/%d", id), "current": Dec2(0), "d15": Dec2(0),
				"d30": Dec2(0), "d45": Dec2(0), "over45": Dec2(0), "total": Dec2(0)}
			byCustomer[id] = rw
			order = append(order, id)
		}
		d, _ := time.Parse(dateLayout, due)
		days := int(today.Sub(d).Hours() / 24)
		bucket := "over45"
		switch {
		case days <= 0:
			bucket = "current"
		case days <= 15:
			bucket = "d15"
		case days <= 30:
			bucket = "d30"
		case days <= 45:
			bucket = "d45"
		}
		rw[bucket] = rw[bucket].(Dec2) + bal
		rw["total"] = rw["total"].(Dec2) + bal
	}
	for _, id := range order {
		rep.Rows = append(rep.Rows, byCustomer[id])
	}
	rep.Totals = sumCols(rep.Rows, "current", "d15", "d30", "d45", "over45", "total")
	return rep, rows.Err()
}

func invoiceDetails(s *server, ctx context.Context, from, to string) (Report, error) {
	rep := Report{Title: "Invoice details", Columns: []reportCol{col("number", "Invoice", "text"), col("date", "Date", "date"),
		col("customer", "Customer", "text"), col("due", "Due date", "date"), col("status", "Status", "text"),
		col("total", "Total", "money"), col("balance", "Balance due", "money")}}
	rows, err := s.db.QueryContext(ctx, invoiceSelect+` WHERE i.issue_date BETWEEN ? AND ? ORDER BY i.issue_date, i.id`, from, to)
	if err != nil {
		return rep, err
	}
	defer rows.Close()
	today := todayIST()
	for rows.Next() {
		inv, err := scanInvoice(rows)
		if err != nil {
			return rep, err
		}
		status := map[string]string{"draft": "Draft", "void": "Void"}[inv.Lifecycle]
		bal := inv.Balance
		if status == "" {
			switch {
			case inv.Balance <= 0:
				status = "Paid"
			case inv.DueDate < today:
				status = "Overdue"
			case inv.Paid+inv.Credited > 0:
				status = "Partially paid"
			default:
				status = "Sent"
			}
		} else {
			bal = 0
		}
		rep.Rows = append(rep.Rows, row{"number": inv.InvoiceNumber, "_link": fmt.Sprintf("/invoices/%d", inv.ID), "date": inv.IssueDate,
			"customer": inv.CustomerName, "due": inv.DueDate, "status": status, "total": inv.Total, "balance": bal})
	}
	rep.Totals = sumCols(rep.Rows, "total", "balance")
	return rep, rows.Err()
}

func paymentsReceived(s *server, ctx context.Context, from, to string) (Report, error) {
	rep := Report{Title: "Payments received", Columns: []reportCol{col("number", "Payment", "text"), col("date", "Date", "date"),
		col("customer", "Customer", "text"), col("mode", "Mode", "text"), col("reference", "Reference", "text"),
		col("amount", "Amount", "money")}}
	rows, err := s.db.QueryContext(ctx, `SELECT p.id, p.payment_number, p.payment_date, c.display_name, p.mode, p.reference, p.amount
		FROM payments p JOIN customers c ON c.id = p.customer_id WHERE p.payment_date BETWEEN ? AND ?
		ORDER BY p.payment_date, p.id`, from, to)
	if err != nil {
		return rep, err
	}
	defer rows.Close()
	modes := map[string]string{}
	for _, m := range paymentModes {
		modes[m["value"]] = m["label"]
	}
	for rows.Next() {
		var id int64
		var number, date, customer, mode, ref string
		var amt Dec2
		if err := rows.Scan(&id, &number, &date, &customer, &mode, &ref, &amt); err != nil {
			return rep, err
		}
		rep.Rows = append(rep.Rows, row{"number": number, "_link": fmt.Sprintf("/payments/%d", id), "date": date,
			"customer": customer, "mode": modes[mode], "reference": ref, "amount": amt})
	}
	rep.Totals = sumCols(rep.Rows, "amount")
	return rep, rows.Err()
}

func customerBalances(s *server, ctx context.Context, from, to string) (Report, error) {
	rep := Report{Title: "Customer balances", AsOf: true, Columns: []reportCol{col("customer", "Customer", "text"),
		col("invoiced", "Invoiced", "money"), col("received", "Received", "money"), col("balance", "Balance due", "money"),
		col("credits", "Unused credit", "money")}, Note: "All-time totals for every customer, as of today."}
	rows, err := s.db.QueryContext(ctx, customerSelect+` ORDER BY c.display_name`)
	if err != nil {
		return rep, err
	}
	defer rows.Close()
	for rows.Next() {
		c, err := scanCustomer(rows)
		if err != nil {
			return rep, err
		}
		if c.Invoiced == 0 && c.Credits == 0 {
			continue
		}
		rep.Rows = append(rep.Rows, row{"customer": c.DisplayName, "_link": fmt.Sprintf("/customers/%d", c.ID),
			"invoiced": c.Invoiced, "received": c.Received, "balance": c.Outstanding, "credits": c.Credits})
	}
	rep.Totals = sumCols(rep.Rows, "invoiced", "received", "balance", "credits")
	return rep, rows.Err()
}

// A bill's GST is a cost unless it can be claimed back as input tax credit.
const expenseCostSQL = `(e.subtotal + CASE WHEN e.itc_eligible AND (e.reverse_charge OR e.vendor_gstin <> '')
	THEN 0 ELSE e.igst + e.cgst + e.sgst END)`
const expenseClaimSQL = `(CASE WHEN e.itc_eligible AND (e.reverse_charge OR e.vendor_gstin <> '') THEN e.igst + e.cgst + e.sgst ELSE 0 END)`

func expensesByCategory(s *server, ctx context.Context, from, to string) (Report, error) {
	rep := Report{Title: "Expenses by category", Columns: []reportCol{col("category", "Category", "text"),
		col("count", "Expenses", "number"), col("subtotal", "Before GST", "money"), col("gst", "GST", "money"),
		col("claim", "GST you can claim", "money"), col("cost", "Cost to you", "money")},
		Note: "Cost to you is the amount before GST, plus any GST you can't claim back."}
	rows, err := s.db.QueryContext(ctx, `SELECT ec.name, COUNT(*), SUM(e.subtotal), SUM(e.igst + e.cgst + e.sgst),
		SUM(`+expenseClaimSQL+`), SUM(`+expenseCostSQL+`)
		FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id WHERE e.expense_date BETWEEN ? AND ?
		GROUP BY ec.name ORDER BY SUM(`+expenseCostSQL+`) DESC`, from, to)
	if err != nil {
		return rep, err
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		var n int
		var sub, gst, claim, cost Dec2
		if err := rows.Scan(&name, &n, &sub, &gst, &claim, &cost); err != nil {
			return rep, err
		}
		rep.Rows = append(rep.Rows, row{"category": name, "count": n, "subtotal": sub, "gst": gst, "claim": claim, "cost": cost})
	}
	rep.Totals = sumCols(rep.Rows, "count", "subtotal", "gst", "claim", "cost")
	return rep, rows.Err()
}

func expenseDetails(s *server, ctx context.Context, from, to string) (Report, error) {
	rep := Report{Title: "Expense details", Columns: []reportCol{col("date", "Date", "date"), col("category", "Category", "text"),
		col("vendor", "Vendor", "text"), col("bill", "Bill no.", "text"), col("subtotal", "Before GST", "money"),
		col("gst", "GST", "money"), col("total", "Total", "money"), col("billing", "Billing", "text")}}
	rows, err := s.db.QueryContext(ctx, expenseSelect+` WHERE e.expense_date BETWEEN ? AND ? ORDER BY e.expense_date, e.id`, from, to)
	if err != nil {
		return rep, err
	}
	defer rows.Close()
	for rows.Next() {
		e, err := scanExpense(rows)
		if err != nil {
			return rep, err
		}
		billing := ""
		switch {
		case e.InvoiceNumber != nil:
			billing = "Billed on " + *e.InvoiceNumber
		case e.Billable && e.CustomerName != nil:
			billing = "To bill: " + *e.CustomerName
		}
		rep.Rows = append(rep.Rows, row{"date": e.Date, "_link": fmt.Sprintf("/expenses/%d", e.ID), "category": e.CategoryName,
			"vendor": e.VendorName, "bill": e.BillNumber, "subtotal": e.Subtotal, "gst": e.CGST + e.SGST + e.IGST,
			"total": e.Total, "billing": billing})
	}
	rep.Totals = sumCols(rep.Rows, "subtotal", "gst", "total")
	return rep, rows.Err()
}

func profitAndLoss(s *server, ctx context.Context, from, to string) (Report, error) {
	rep := Report{Title: "Profit and loss", Columns: []reportCol{col("account", "", "text"), col("amount", "Amount", "money")},
		Note: "Accrual basis, before GST: sales count when invoiced, expenses when incurred. GST you can claim back isn't a cost."}
	var sales, credits Dec2
	if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(subtotal), 0) FROM invoices WHERE lifecycle = 'sent'
		AND issue_date BETWEEN ? AND ?`, from, to).Scan(&sales); err != nil {
		return rep, err
	}
	if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(subtotal), 0) FROM documents WHERE doc_type = 'credit_note'
		AND status = 'open' AND issue_date BETWEEN ? AND ?`, from, to).Scan(&credits); err != nil {
		return rep, err
	}
	income := sales - credits
	rep.Rows = append(rep.Rows, row{"account": "Income", "_kind": "heading"}, row{"account": "Sales", "amount": sales},
		row{"account": "Less: credit notes", "amount": -credits}, row{"account": "Total income", "amount": income, "_kind": "total"},
		row{"account": "Expenses", "_kind": "heading"})
	rows, err := s.db.QueryContext(ctx, `SELECT ec.name, SUM(`+expenseCostSQL+`) FROM expenses e
		JOIN expense_categories ec ON ec.id = e.category_id WHERE e.expense_date BETWEEN ? AND ? GROUP BY ec.name ORDER BY ec.name`, from, to)
	if err != nil {
		return rep, err
	}
	var totalExp Dec2
	for rows.Next() {
		var name string
		var amt Dec2
		if err := rows.Scan(&name, &amt); err != nil {
			rows.Close()
			return rep, err
		}
		totalExp += amt
		rep.Rows = append(rep.Rows, row{"account": name, "amount": amt})
	}
	rows.Close()
	label := "Net profit"
	if income-totalExp < 0 {
		label = "Net loss"
	}
	rep.Rows = append(rep.Rows, row{"account": "Total expenses", "amount": totalExp, "_kind": "total"},
		row{"account": label, "amount": income - totalExp, "_kind": "grand"})
	return rep, nil
}

func taxSummary(s *server, ctx context.Context, from, to string) (Report, error) {
	rep := Report{Title: "Tax summary", Columns: []reportCol{col("month", "Month", "text"), col("output", "GST on sales", "money"),
		col("rcm", "Reverse charge GST", "money"), col("input", "GST you can claim", "money"), col("net", "Net GST", "money")},
		Note: "GST on sales is net of credit notes. Net GST = GST on sales + reverse charge − claimable GST; a negative figure is credit carried forward. Use GST filing for return figures."}
	type m struct{ out, rcm, in Dec2 }
	months := map[string]*m{}
	get := func(k string) *m {
		if months[k] == nil {
			months[k] = &m{}
		}
		return months[k]
	}
	queries := []struct {
		sql   string
		apply func(v *m, amt Dec2)
	}{
		{`SELECT DATE_FORMAT(issue_date, '%Y-%m'), SUM(cgst_total + sgst_total + igst_total) FROM invoices
			WHERE lifecycle = 'sent' AND issue_date BETWEEN ? AND ? GROUP BY 1`, func(v *m, a Dec2) { v.out += a }},
		{`SELECT DATE_FORMAT(issue_date, '%Y-%m'), SUM(cgst_total + sgst_total + igst_total) FROM documents
			WHERE doc_type = 'credit_note' AND status = 'open' AND issue_date BETWEEN ? AND ? GROUP BY 1`, func(v *m, a Dec2) { v.out -= a }},
		{`SELECT DATE_FORMAT(e.expense_date, '%Y-%m'), SUM(e.igst + e.cgst + e.sgst) FROM expenses e
			WHERE e.reverse_charge AND e.expense_date BETWEEN ? AND ? GROUP BY 1`, func(v *m, a Dec2) { v.rcm += a }},
		{`SELECT DATE_FORMAT(e.expense_date, '%Y-%m'), SUM(` + expenseClaimSQL + `) FROM expenses e
			WHERE e.expense_date BETWEEN ? AND ? GROUP BY 1`, func(v *m, a Dec2) { v.in += a }},
	}
	for _, q := range queries {
		rows, err := s.db.QueryContext(ctx, q.sql, from, to)
		if err != nil {
			return rep, err
		}
		for rows.Next() {
			var k string
			var amt Dec2
			if err := rows.Scan(&k, &amt); err != nil {
				rows.Close()
				return rep, err
			}
			q.apply(get(k), amt)
		}
		rows.Close()
	}
	start, _ := time.Parse(dateLayout, from[:8]+"01")
	end, _ := time.Parse(dateLayout, to)
	for t := start; !t.After(end); t = t.AddDate(0, 1, 0) {
		v := get(t.Format("2006-01"))
		rep.Rows = append(rep.Rows, row{"month": t.Format("Jan 2006"), "output": v.out, "rcm": v.rcm, "input": v.in, "net": v.out + v.rcm - v.in})
	}
	rep.Totals = sumCols(rep.Rows, "output", "rcm", "input", "net")
	return rep, nil
}

func timeByProject(s *server, ctx context.Context, from, to string) (Report, error) {
	rep := Report{Title: "Time by project", Columns: []reportCol{col("project", "Project", "text"), col("customer", "Customer", "text"),
		col("hours", "Hours logged", "hours"), col("billable", "Billable", "hours"), col("billed", "Billed", "hours"),
		col("unbilled", "Not yet billed", "hours"), col("unbilledAmount", "Unbilled value", "money")},
		Note: "Timesheet entries dated in the period. Running timers aren't counted."}
	rows, err := s.db.QueryContext(ctx, `SELECT p.id, p.project_name, c.display_name, p.hourly_rate, SUM(t.minutes),
		SUM(IF(t.billable, t.minutes, 0)), SUM(IF(t.invoice_id IS NOT NULL, t.minutes, 0)),
		SUM(IF(t.billable AND t.invoice_id IS NULL, t.minutes, 0))
		FROM time_entries t JOIN projects p ON p.id = t.project_id JOIN customers c ON c.id = p.customer_id
		WHERE t.timer_started_at IS NULL AND t.entry_date BETWEEN ? AND ? GROUP BY p.id, p.project_name, c.display_name, p.hourly_rate
		ORDER BY SUM(t.minutes) DESC`, from, to)
	if err != nil {
		return rep, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var name, customer string
		var rate Dec2
		var all, billable, billed, unbilled int
		if err := rows.Scan(&id, &name, &customer, &rate, &all, &billable, &billed, &unbilled); err != nil {
			return rep, err
		}
		uh := minutesToHours(unbilled)
		rep.Rows = append(rep.Rows, row{"project": name, "_link": fmt.Sprintf("/time-tracking/projects/%d", id), "customer": customer,
			"hours": minutesToHours(all), "billable": minutesToHours(billable), "billed": minutesToHours(billed), "unbilled": uh,
			"unbilledAmount": calcLine(uh, rate, 0, 0, false).Taxable})
	}
	rep.Totals = sumCols(rep.Rows, "hours", "billable", "billed", "unbilled", "unbilledAmount")
	return rep, rows.Err()
}

// ---------- Customer statement ----------

type statementLine struct {
	Date    string `json:"date"`
	Type    string `json:"type"` // invoice | payment | credit
	Number  string `json:"number"`
	Detail  string `json:"detail"`
	Link    string `json:"link"`
	Debit   Dec2   `json:"debit"`
	Credit  Dec2   `json:"credit"`
	Balance Dec2   `json:"balance"`
}

// GET /api/customers/{id}/statement?from=&to=
func (s *server) customerStatement(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	to := r.URL.Query().Get("to")
	if !validDate(to) {
		to = todayIST()
	}
	from := r.URL.Query().Get("from")
	if !validDate(from) {
		from = fyStart(to)
	}
	ctx := r.Context()
	c, err := scanCustomer(s.db.QueryRowContext(ctx, customerSelect+` WHERE c.id = ?`, id))
	if err != nil {
		fail(w, err)
		return
	}
	// Everything that changes what the customer owes: sent invoices (+), payments and credits used (−).
	const movements = `SELECT i.issue_date, 'invoice', i.invoice_number, CONCAT('Due ', DATE_FORMAT(i.due_date, '%d %b %Y')), i.id, i.total
		FROM invoices i WHERE i.customer_id = ? AND i.lifecycle = 'sent'
		UNION ALL SELECT p.payment_date, 'payment', p.payment_number, p.mode, p.id, -p.amount FROM payments p WHERE p.customer_id = ?
		UNION ALL SELECT ca.applied_on, 'credit', d.doc_number, CONCAT('Used on ', i.invoice_number), d.id, -ca.amount
		FROM credit_allocations ca JOIN documents d ON d.id = ca.credit_note_id JOIN invoices i ON i.id = ca.invoice_id
		WHERE d.customer_id = ?`
	var opening Dec2
	if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(amt), 0) FROM (`+
		`SELECT t.amt FROM (SELECT x.d, x.amt FROM (`+movementsAmt(movements)+`) x) t WHERE t.d < ?) o`, id, id, id, from).Scan(&opening); err != nil {
		fail(w, err)
		return
	}
	rows, err := s.db.QueryContext(ctx, `SELECT * FROM (`+movements+`) m WHERE m.issue_date BETWEEN ? AND ?
		ORDER BY m.issue_date, FIELD(m.invoice, 'invoice', 'credit', 'payment'), m.invoice_number`, id, id, id, from, to)
	if err != nil {
		fail(w, err)
		return
	}
	defer rows.Close()
	modes := map[string]string{}
	for _, m := range paymentModes {
		modes[m["value"]] = m["label"]
	}
	balance := opening
	lines := []statementLine{}
	var debits, credits Dec2
	for rows.Next() {
		var l statementLine
		var docID int64
		var amt Dec2
		if err := rows.Scan(&l.Date, &l.Type, &l.Number, &l.Detail, &docID, &amt); err != nil {
			fail(w, err)
			return
		}
		switch l.Type {
		case "invoice":
			l.Debit, l.Link = amt, fmt.Sprintf("/invoices/%d", docID)
			debits += amt
		case "payment":
			l.Credit, l.Link, l.Detail = -amt, fmt.Sprintf("/payments/%d", docID), "Payment ("+modes[l.Detail]+")"
			credits -= amt
		default:
			l.Credit, l.Link, l.Detail = -amt, fmt.Sprintf("/credit-notes/%d", docID), "Credit note. "+l.Detail
			credits -= amt
		}
		balance += amt
		l.Balance = balance
		lines = append(lines, l)
	}
	sort.SliceStable(lines, func(i, j int) bool { return lines[i].Date < lines[j].Date })
	writeJSON(w, http.StatusOK, map[string]any{"customer": c, "from": from, "to": to, "opening": opening, "lines": lines,
		"debits": debits, "credits": credits, "closing": balance})
}

// movementsAmt keeps just the date and amount columns of the statement movements.
func movementsAmt(movements string) string {
	return `SELECT m.issue_date AS d, m.total AS amt FROM (` + movements + `) m`
}
