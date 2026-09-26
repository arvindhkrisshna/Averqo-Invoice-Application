package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

type RecurringLine struct {
	ID          int64  `json:"id"`
	ItemID      *int64 `json:"itemId"`
	Description string `json:"description"`
	HSNSAC      string `json:"hsnSac"`
	Unit        string `json:"unit"`
	Quantity    Dec2   `json:"quantity"`
	Rate        Dec2   `json:"rate"`
	DiscountPct Dec2   `json:"discountPct"`
	TaxRate     Dec2   `json:"taxRate"`
}

type RecurringProfile struct {
	ID               int64           `json:"id"`
	ProfileName      string          `json:"profileName"`
	CustomerID       int64           `json:"customerId"`
	CustomerName     string          `json:"customerName"`
	Frequency        string          `json:"frequency"`
	StartDate        string          `json:"startDate"`
	EndDate          *string         `json:"endDate"`
	NextRunDate      *string         `json:"nextRunDate"`
	Occurrences      int             `json:"occurrences"`
	Status           string          `json:"status"` // active | paused | ended
	CreateAs         string          `json:"createAs"`
	PaymentTermsDays int             `json:"paymentTermsDays"`
	Reference        string          `json:"reference"`
	Notes            string          `json:"notes"`
	Terms            string          `json:"terms"`
	LastError        string          `json:"lastError"`
	Subtotal         Dec2            `json:"subtotal"` // before GST
	InvoiceCount     int             `json:"invoiceCount"`
	CreatedAt        string          `json:"createdAt"`
	Lines            []RecurringLine `json:"lines,omitempty"`
	Activity         []ActivityEntry `json:"activity,omitempty"`
}

var frequencyMonths = map[string]int{"monthly": 1, "quarterly": 3, "half_yearly": 6, "yearly": 12}

// addMonthsClamped moves a date by whole months, keeping it inside the
// target month: 31 Jan + 1 month is 28 (or 29) Feb, not 3 March.
func addMonthsClamped(t time.Time, months int) time.Time {
	m := int(t.Month()) - 1 + months
	y := t.Year() + m/12
	m = m % 12
	first := time.Date(y, time.Month(m+1), 1, 0, 0, 0, 0, time.UTC)
	last := first.AddDate(0, 1, -1).Day()
	return time.Date(y, time.Month(m+1), min(t.Day(), last), 0, 0, 0, 0, time.UTC)
}

// occurrenceDate is the date of the n-th invoice (n = 0 is the start date).
// Every date is worked out from the start date so month-ends don't drift.
func occurrenceDate(start time.Time, frequency string, n int) time.Time {
	if frequency == "weekly" {
		return start.AddDate(0, 0, 7*n)
	}
	return addMonthsClamped(start, frequencyMonths[frequency]*n)
}

const recurringSelect = `SELECT r.id, r.profile_name, r.customer_id, c.display_name, r.frequency, r.start_date, r.end_date,
	r.next_run_date, r.occurrences, r.status, r.create_as, r.payment_terms_days, r.reference, r.notes, r.terms, r.last_error,
	(SELECT COUNT(*) FROM invoices i WHERE i.recurring_id = r.id), r.created_at
	FROM recurring_profiles r JOIN customers c ON c.id = r.customer_id`

func (s *server) scanRecurring(ctx context.Context, row interface{ Scan(...any) error }, withDetails bool) (RecurringProfile, error) {
	var p RecurringProfile
	if err := row.Scan(&p.ID, &p.ProfileName, &p.CustomerID, &p.CustomerName, &p.Frequency, &p.StartDate, &p.EndDate,
		&p.NextRunDate, &p.Occurrences, &p.Status, &p.CreateAs, &p.PaymentTermsDays, &p.Reference, &p.Notes, &p.Terms,
		&p.LastError, &p.InvoiceCount, &p.CreatedAt); err != nil {
		return p, err
	}
	return p, nil
}

func (s *server) loadRecurringLines(ctx context.Context, q queryer, id int64) ([]RecurringLine, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, item_id, description, hsn_sac, unit, quantity, rate, discount_pct, tax_rate
		FROM recurring_items WHERE profile_id = ? ORDER BY sort_order, id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RecurringLine{}
	for rows.Next() {
		var l RecurringLine
		if err := rows.Scan(&l.ID, &l.ItemID, &l.Description, &l.HSNSAC, &l.Unit, &l.Quantity, &l.Rate, &l.DiscountPct, &l.TaxRate); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func subtotalOf(lines []RecurringLine) Dec2 {
	var sum Dec2
	for _, l := range lines {
		sum += calcLine(l.Quantity, l.Rate, l.DiscountPct, 0, false).Taxable
	}
	return sum
}

func (s *server) loadRecurring(ctx context.Context, id int64) (RecurringProfile, error) {
	p, err := s.scanRecurring(ctx, s.db.QueryRowContext(ctx, recurringSelect+` WHERE r.id = ?`, id), true)
	if err != nil {
		return p, err
	}
	if p.Lines, err = s.loadRecurringLines(ctx, s.db, id); err != nil {
		return p, err
	}
	p.Subtotal = subtotalOf(p.Lines)
	p.Activity, err = loadActivity(ctx, s.db, "recurring", id)
	return p, err
}

func (s *server) listRecurring(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rows, err := s.db.QueryContext(ctx, recurringSelect+` ORDER BY FIELD(r.status, 'active', 'paused', 'ended'), r.next_run_date, r.id`)
	if err != nil {
		fail(w, err)
		return
	}
	list := []RecurringProfile{}
	for rows.Next() {
		p, err := s.scanRecurring(ctx, rows, false)
		if err != nil {
			rows.Close()
			fail(w, err)
			return
		}
		list = append(list, p)
	}
	rows.Close()
	for i := range list {
		lines, err := s.loadRecurringLines(ctx, s.db, list[i].ID)
		if err != nil {
			fail(w, err)
			return
		}
		list[i].Subtotal = subtotalOf(lines)
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *server) getRecurring(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	p, err := s.loadRecurring(r.Context(), id)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

type RecurringInput struct {
	ProfileName      string      `json:"profileName"`
	CustomerID       int64       `json:"customerId"`
	Frequency        string      `json:"frequency"`
	StartDate        string      `json:"startDate"`
	EndDate          string      `json:"endDate"`
	CreateAs         string      `json:"createAs"`
	PaymentTermsDays int         `json:"paymentTermsDays"`
	Reference        string      `json:"reference"`
	Notes            string      `json:"notes"`
	Terms            string      `json:"terms"`
	Lines            []LineInput `json:"lines"`
}

func (in *RecurringInput) validate() error {
	in.ProfileName = strings.TrimSpace(in.ProfileName)
	switch {
	case in.ProfileName == "" || len(in.ProfileName) > 100:
		return badRequest("Give this schedule a short name, like \"Monthly retainer\".")
	case in.CustomerID <= 0:
		return badRequest("Choose a customer.")
	case in.Frequency != "weekly" && frequencyMonths[in.Frequency] == 0:
		return badRequest("Choose how often to invoice.")
	case !validDate(in.StartDate):
		return badRequest("Enter the date of the first invoice.")
	case in.EndDate != "" && (!validDate(in.EndDate) || in.EndDate < in.StartDate):
		return badRequest("The end date must be after the start date.")
	case in.CreateAs != "draft" && in.CreateAs != "sent":
		return badRequest("Choose whether invoices are created as drafts or ready to send.")
	case in.PaymentTermsDays < 0 || in.PaymentTermsDays > 365:
		return badRequest("Payment terms must be between 0 and 365 days.")
	case len(in.Reference) > 100 || len(in.Notes) > 1000 || len(in.Terms) > 2000:
		return badRequest("Reference, notes, or terms are too long.")
	}
	return validateLines(in.Lines)
}

// schedule works out next_run_date and status from the start date and how many invoices exist.
func schedule(in RecurringInput, occurrences int, status string) (next any, newStatus string) {
	start, _ := time.Parse(dateLayout, in.StartDate)
	n := occurrenceDate(start, in.Frequency, occurrences)
	if in.EndDate != "" && n.Format(dateLayout) > in.EndDate {
		return nil, "ended"
	}
	if status == "ended" {
		status = "active" // the end date was moved later
	}
	return n.Format(dateLayout), status
}

func (s *server) saveRecurring(w http.ResponseWriter, r *http.Request) {
	editing := r.Method == http.MethodPut
	var id int64
	var err error
	if editing {
		if id, err = pathID(r); err != nil {
			fail(w, err)
			return
		}
	}
	var in RecurringInput
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
	var endDate any
	if in.EndDate != "" {
		endDate = in.EndDate
	}
	if !editing {
		if in.StartDate < todayIST() {
			fail(w, badRequest("The first invoice date can't be in the past."))
			return
		}
		next, status := schedule(in, 0, "active")
		res, err := tx.ExecContext(ctx, `INSERT INTO recurring_profiles (profile_name, customer_id, frequency, start_date, end_date,
			next_run_date, status, create_as, payment_terms_days, reference, notes, terms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			in.ProfileName, in.CustomerID, in.Frequency, in.StartDate, endDate, next, status, in.CreateAs, in.PaymentTermsDays,
			in.Reference, in.Notes, in.Terms)
		if err != nil {
			fail(w, err)
			return
		}
		id, _ = res.LastInsertId()
		logActivity(ctx, tx, "recurring", id, "created", "Schedule created")
	} else {
		var occurrences int
		var status string
		if err := tx.QueryRowContext(ctx, `SELECT occurrences, status FROM recurring_profiles WHERE id = ? FOR UPDATE`, id).
			Scan(&occurrences, &status); err != nil {
			fail(w, err)
			return
		}
		next, newStatus := schedule(in, occurrences, status)
		if _, err := tx.ExecContext(ctx, `UPDATE recurring_profiles SET profile_name=?, customer_id=?, frequency=?, start_date=?,
			end_date=?, next_run_date=?, status=?, create_as=?, payment_terms_days=?, reference=?, notes=?, terms=?, last_error=''
			WHERE id = ?`, in.ProfileName, in.CustomerID, in.Frequency, in.StartDate, endDate, next, newStatus, in.CreateAs,
			in.PaymentTermsDays, in.Reference, in.Notes, in.Terms, id); err != nil {
			fail(w, err)
			return
		}
		logActivity(ctx, tx, "recurring", id, "edited", "Schedule edited")
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM recurring_items WHERE profile_id = ?`, id); err != nil {
		fail(w, err)
		return
	}
	for i, l := range in.Lines {
		if _, err := tx.ExecContext(ctx, `INSERT INTO recurring_items (profile_id, item_id, description, hsn_sac, unit, quantity,
			rate, discount_pct, tax_rate, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, l.ItemID, l.Description, l.HSNSAC, l.Unit, l.Quantity, l.Rate, l.DiscountPct, l.TaxRate, i+1); err != nil {
			fail(w, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		fail(w, err)
		return
	}
	s.runDueProfiles(ctx) // a schedule starting today creates its first invoice now
	p, err := s.loadRecurring(ctx, id)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, map[bool]int{true: http.StatusOK, false: http.StatusCreated}[editing], p)
}

// POST /api/recurring/{id}/status {"status": "paused" | "active"}
func (s *server) setRecurringStatus(w http.ResponseWriter, r *http.Request) {
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
	p, err := s.loadRecurring(ctx, id)
	if err != nil {
		fail(w, err)
		return
	}
	switch {
	case body.Status != "active" && body.Status != "paused":
		fail(w, badRequest(`Status must be "active" or "paused".`))
		return
	case p.Status == "ended":
		fail(w, conflict("This schedule has ended. Edit it and move the end date later to restart it."))
		return
	}
	// Resuming skips the dates missed while paused instead of back-filling them.
	occ := p.Occurrences
	next := p.NextRunDate
	if body.Status == "active" && p.Status == "paused" {
		start, _ := time.Parse(dateLayout, p.StartDate)
		today := todayIST()
		for occurrenceDate(start, p.Frequency, occ).Format(dateLayout) < today {
			occ++
		}
		n := occurrenceDate(start, p.Frequency, occ).Format(dateLayout)
		next = &n
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE recurring_profiles SET status = ?, occurrences = ?, next_run_date = ? WHERE id = ?`,
		body.Status, occ, next, id); err != nil {
		fail(w, err)
		return
	}
	logActivity(ctx, s.db, "recurring", id, body.Status, map[string]string{"active": "Resumed", "paused": "Paused"}[body.Status])
	s.runDueProfiles(ctx)
	s.getRecurring(w, r)
}

// POST /api/recurring/{id}/run: create the next invoice now, dated today.
func (s *server) runRecurringNow(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	ctx := r.Context()
	created, err := s.runProfile(ctx, id, true)
	if err != nil {
		fail(w, err)
		return
	}
	if len(created) == 0 {
		fail(w, conflict("This schedule isn't active, so no invoice was created."))
		return
	}
	inv, err := s.loadInvoice(ctx, created[0])
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, inv)
}

func (s *server) deleteRecurring(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	// Invoices already created are kept; they just lose the link.
	res, err := s.db.ExecContext(r.Context(), `DELETE FROM recurring_profiles WHERE id = ?`, id)
	if err != nil {
		fail(w, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, notFound("Schedule not found."))
		return
	}
	_, _ = s.db.ExecContext(r.Context(), `DELETE FROM activity WHERE subject_type = 'recurring' AND subject_id = ?`, id)
	w.WriteHeader(http.StatusNoContent)
}

// runProfile creates the invoices that are due for one schedule (at most 12
// at a time, if the backend was stopped for a while). With now=true it
// creates the next invoice immediately, dated today.
func (s *server) runProfile(ctx context.Context, id int64, now bool) ([]int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var p RecurringProfile
	err = tx.QueryRowContext(ctx, `SELECT profile_name, customer_id, frequency, start_date, end_date, next_run_date, occurrences,
		status, create_as, payment_terms_days, reference, notes, terms FROM recurring_profiles WHERE id = ? FOR UPDATE`, id).
		Scan(&p.ProfileName, &p.CustomerID, &p.Frequency, &p.StartDate, &p.EndDate, &p.NextRunDate, &p.Occurrences,
			&p.Status, &p.CreateAs, &p.PaymentTermsDays, &p.Reference, &p.Notes, &p.Terms)
	if err != nil {
		return nil, err
	}
	if p.Status != "active" || p.NextRunDate == nil {
		return nil, nil
	}
	lines, err := s.loadRecurringLines(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	start, _ := time.Parse(dateLayout, p.StartDate)
	today := todayIST()
	var created []int64
	for len(created) < 12 {
		next := occurrenceDate(start, p.Frequency, p.Occurrences).Format(dateLayout)
		if p.EndDate != nil && next > *p.EndDate {
			p.Status = "ended"
			break
		}
		if !now && next > today {
			break
		}
		date := next
		if now {
			date = today
		}
		d, _ := time.Parse(dateLayout, date)
		in := InvoiceInput{CustomerID: p.CustomerID, IssueDate: date, DueDate: d.AddDate(0, 0, p.PaymentTermsDays).Format(dateLayout),
			Reference: p.Reference, Notes: p.Notes, Terms: p.Terms, Status: p.CreateAs}
		for _, l := range lines {
			in.Lines = append(in.Lines, LineInput{ItemID: l.ItemID, Description: l.Description, HSNSAC: l.HSNSAC, Unit: l.Unit,
				Quantity: l.Quantity, Rate: l.Rate, DiscountPct: l.DiscountPct, TaxRate: l.TaxRate})
		}
		invID, err := s.createRecurringInvoice(ctx, tx, in, id, p.ProfileName)
		if err != nil {
			tx.Rollback()
			msg := err.Error()
			if _, ok := err.(*userError); !ok {
				msg = "Couldn't create the invoice. Check the backend terminal for details."
				log.Printf("recurring %d: %v", id, err)
			}
			_, _ = s.db.ExecContext(ctx, `UPDATE recurring_profiles SET last_error = ? WHERE id = ?`, msg, id)
			return nil, err
		}
		created = append(created, invID)
		p.Occurrences++
		if now {
			break
		}
	}
	var next any
	if p.Status != "ended" {
		n := occurrenceDate(start, p.Frequency, p.Occurrences).Format(dateLayout)
		if p.EndDate != nil && n > *p.EndDate {
			p.Status = "ended"
		} else {
			next = n
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE recurring_profiles SET occurrences = ?, next_run_date = ?, status = ?, last_error = ''
		WHERE id = ?`, p.Occurrences, next, p.Status, id); err != nil {
		return nil, err
	}
	if p.Status == "ended" {
		logActivity(ctx, tx, "recurring", id, "ended", "Schedule ended")
	}
	return created, tx.Commit()
}

func (s *server) createRecurringInvoice(ctx context.Context, tx *sql.Tx, in InvoiceInput, profileID int64, name string) (int64, error) {
	if err := in.validate(); err != nil {
		return 0, err
	}
	invID, err := s.saveInvoice(ctx, tx, 0, in, in.Status, 0)
	if err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE invoices SET recurring_id = ? WHERE id = ?`, profileID, invID); err != nil {
		return 0, err
	}
	logActivity(ctx, tx, "invoice", invID, "created", fmt.Sprintf("Created by the recurring schedule \"%s\"", name))
	logActivity(ctx, tx, "recurring", profileID, "invoice_created", fmt.Sprintf("Invoice dated %s created", dateText(in.IssueDate)))
	return invID, nil
}

// runDueProfiles creates every invoice that is due today or was missed.
func (s *server) runDueProfiles(ctx context.Context) {
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM recurring_profiles WHERE status = 'active' AND next_run_date <= ?`, todayIST())
	if err != nil {
		log.Printf("recurring: %v", err)
		return
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		created, err := s.runProfile(ctx, id, false)
		if err != nil {
			log.Printf("recurring schedule %d: %v", id, err)
		} else if len(created) > 0 {
			log.Printf("recurring schedule %d: created %d invoice(s)", id, len(created))
		}
	}
}

// startScheduler checks for due recurring invoices when the server starts
// and every 15 minutes while it runs.
func (s *server) startScheduler() {
	go func() {
		for {
			s.runDueProfiles(context.Background())
			time.Sleep(15 * time.Minute)
		}
	}()
}
