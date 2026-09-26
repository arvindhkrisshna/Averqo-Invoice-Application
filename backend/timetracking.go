package main

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

type Project struct {
	ID              int64  `json:"id"`
	Name            string `json:"name"`
	CustomerID      int64  `json:"customerId"`
	CustomerName    string `json:"customerName"`
	HourlyRate      Dec2   `json:"hourlyRate"`
	SAC             string `json:"sac"`
	TaxRate         Dec2   `json:"taxRate"`
	BudgetHours     *Dec2  `json:"budgetHours"`
	Status          string `json:"status"` // active | completed
	Description     string `json:"description"`
	LoggedMinutes   int    `json:"loggedMinutes"`
	BillableMinutes int    `json:"billableMinutes"`
	UnbilledMinutes int    `json:"unbilledMinutes"`
	UnbilledAmount  Dec2   `json:"unbilledAmount"`
	CreatedAt       string `json:"createdAt"`
}

// Timer entries that are still running are left out of every total.
const projectSelect = `SELECT p.id, p.project_name, p.customer_id, c.display_name, p.hourly_rate, p.sac, p.tax_rate,
	p.budget_hours, p.status, p.description,
	COALESCE((SELECT SUM(minutes) FROM time_entries t WHERE t.project_id = p.id AND t.timer_started_at IS NULL), 0),
	COALESCE((SELECT SUM(minutes) FROM time_entries t WHERE t.project_id = p.id AND t.timer_started_at IS NULL AND t.billable), 0),
	COALESCE((SELECT SUM(minutes) FROM time_entries t WHERE t.project_id = p.id AND t.timer_started_at IS NULL AND t.billable
		AND t.invoice_id IS NULL), 0),
	p.created_at
	FROM projects p JOIN customers c ON c.id = p.customer_id`

// minutesToHours rounds minutes to hours with 2 decimals, as they appear on an invoice line.
func minutesToHours(m int) Dec2 { return Dec2(roundDiv(int64(m)*100, 60)) }

func scanProject(row interface{ Scan(...any) error }) (Project, error) {
	var p Project
	err := row.Scan(&p.ID, &p.Name, &p.CustomerID, &p.CustomerName, &p.HourlyRate, &p.SAC, &p.TaxRate, &p.BudgetHours,
		&p.Status, &p.Description, &p.LoggedMinutes, &p.BillableMinutes, &p.UnbilledMinutes, &p.CreatedAt)
	p.UnbilledAmount = calcLine(minutesToHours(p.UnbilledMinutes), p.HourlyRate, 0, 0, false).Taxable
	return p, err
}

func (s *server) listProjects(w http.ResponseWriter, r *http.Request) {
	q := projectSelect + ` WHERE 1 = 1`
	var args []any
	if cid, err := strconv.ParseInt(r.URL.Query().Get("customerId"), 10, 64); err == nil {
		q += ` AND p.customer_id = ?`
		args = append(args, cid)
	}
	rows, err := s.db.QueryContext(r.Context(), q+` ORDER BY p.status, p.project_name`, args...)
	if err != nil {
		fail(w, err)
		return
	}
	defer rows.Close()
	list := []Project{}
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			fail(w, err)
			return
		}
		list = append(list, p)
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *server) getProject(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	p, err := scanProject(s.db.QueryRowContext(r.Context(), projectSelect+` WHERE p.id = ?`, id))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

type ProjectInput struct {
	Name        string `json:"name"`
	CustomerID  int64  `json:"customerId"`
	HourlyRate  Dec2   `json:"hourlyRate"`
	SAC         string `json:"sac"`
	TaxRate     Dec2   `json:"taxRate"`
	BudgetHours *Dec2  `json:"budgetHours"`
	Status      string `json:"status"`
	Description string `json:"description"`
}

func (s *server) saveProject(w http.ResponseWriter, r *http.Request) {
	editing := r.Method == http.MethodPut
	var id int64
	var err error
	if editing {
		if id, err = pathID(r); err != nil {
			fail(w, err)
			return
		}
	}
	var in ProjectInput
	if err := decodeJSON(w, r, &in); err != nil {
		fail(w, err)
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	in.SAC = strings.TrimSpace(in.SAC)
	if in.Status == "" {
		in.Status = "active"
	}
	switch {
	case in.Name == "" || len(in.Name) > 120:
		fail(w, badRequest("Give the project a name (up to 120 characters)."))
		return
	case in.CustomerID <= 0:
		fail(w, badRequest("Choose the customer this project is for."))
		return
	case in.HourlyRate < 0 || in.HourlyRate > 100_000_000:
		fail(w, badRequest("Enter an hourly rate of 0 or more."))
		return
	case in.SAC != "" && !hsnPattern.MatchString(in.SAC):
		fail(w, badRequest("SAC must be 4, 6, or 8 digits, like 998314."))
		return
	case in.TaxRate < 0 || in.TaxRate > 10000:
		fail(w, badRequest("GST rate must be between 0 and 100%."))
		return
	case in.BudgetHours != nil && (*in.BudgetHours <= 0 || *in.BudgetHours > 100_000_000):
		fail(w, badRequest("Budget hours must be more than 0, or left empty."))
		return
	case in.Status != "active" && in.Status != "completed":
		fail(w, badRequest("Status must be active or completed."))
		return
	case len(in.Description) > 1000:
		fail(w, badRequest("The description is too long."))
		return
	}
	ctx := r.Context()
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM customers WHERE id = ?`, in.CustomerID).Scan(&n); err != nil || n == 0 {
		fail(w, badRequest("That customer no longer exists."))
		return
	}
	if editing {
		var current int64
		var billed int
		if err := s.db.QueryRowContext(ctx, `SELECT customer_id, (SELECT COUNT(*) FROM time_entries WHERE project_id = p.id
			AND invoice_id IS NOT NULL) FROM projects p WHERE id = ?`, id).Scan(&current, &billed); err != nil {
			fail(w, err)
			return
		}
		if billed > 0 && current != in.CustomerID {
			fail(w, conflict("This project has billed hours, so its customer can't change."))
			return
		}
		_, err = s.db.ExecContext(ctx, `UPDATE projects SET project_name=?, customer_id=?, hourly_rate=?, sac=?, tax_rate=?,
			budget_hours=?, status=?, description=? WHERE id = ?`, in.Name, in.CustomerID, in.HourlyRate, in.SAC, in.TaxRate,
			in.BudgetHours, in.Status, in.Description, id)
	} else {
		var res interface{ LastInsertId() (int64, error) }
		res, err = s.db.ExecContext(ctx, `INSERT INTO projects (project_name, customer_id, hourly_rate, sac, tax_rate, budget_hours,
			status, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, in.Name, in.CustomerID, in.HourlyRate, in.SAC, in.TaxRate,
			in.BudgetHours, in.Status, in.Description)
		if err == nil {
			id, _ = res.LastInsertId()
		}
	}
	if err != nil {
		fail(w, err)
		return
	}
	p, err := scanProject(s.db.QueryRowContext(ctx, projectSelect+` WHERE p.id = ?`, id))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, map[bool]int{true: http.StatusOK, false: http.StatusCreated}[editing], p)
}

func (s *server) deleteProject(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	var billed int
	if err := s.db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM time_entries WHERE project_id = ? AND invoice_id IS NOT NULL`, id).
		Scan(&billed); err != nil {
		fail(w, err)
		return
	}
	if billed > 0 {
		fail(w, conflict("This project has billed hours, so it can't be deleted. Mark it as completed instead."))
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `DELETE FROM projects WHERE id = ?`, id); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------- Timesheet entries ----------

type TimeEntry struct {
	ID             int64   `json:"id"`
	ProjectID      int64   `json:"projectId"`
	ProjectName    string  `json:"projectName"`
	CustomerID     int64   `json:"customerId"`
	CustomerName   string  `json:"customerName"`
	UserID         *int64  `json:"userId"`
	UserName       *string `json:"userName"`
	Date           string  `json:"date"`
	Task           string  `json:"task"`
	Minutes        int     `json:"minutes"`
	Notes          string  `json:"notes"`
	Billable       bool    `json:"billable"`
	InvoiceID      *int64  `json:"invoiceId"`
	InvoiceNumber  *string `json:"invoiceNumber"`
	Running        bool    `json:"running"`
	ElapsedSeconds int64   `json:"elapsedSeconds"`
}

const entrySelect = `SELECT t.id, t.project_id, p.project_name, p.customer_id, c.display_name, t.user_id, u.name, t.entry_date,
	t.task, t.minutes, t.notes, t.billable, t.invoice_id, i.invoice_number, t.timer_started_at IS NOT NULL,
	COALESCE(TIMESTAMPDIFF(SECOND, t.timer_started_at, UTC_TIMESTAMP()), 0)
	FROM time_entries t JOIN projects p ON p.id = t.project_id JOIN customers c ON c.id = p.customer_id
	LEFT JOIN users u ON u.id = t.user_id LEFT JOIN invoices i ON i.id = t.invoice_id`

func scanEntry(row interface{ Scan(...any) error }) (TimeEntry, error) {
	var t TimeEntry
	err := row.Scan(&t.ID, &t.ProjectID, &t.ProjectName, &t.CustomerID, &t.CustomerName, &t.UserID, &t.UserName, &t.Date,
		&t.Task, &t.Minutes, &t.Notes, &t.Billable, &t.InvoiceID, &t.InvoiceNumber, &t.Running, &t.ElapsedSeconds)
	return t, err
}

// GET /api/time-entries[?from=&to=&projectId=&customerId=&unbilled=1]
func (s *server) listTimeEntries(w http.ResponseWriter, r *http.Request) {
	q := entrySelect + ` WHERE 1 = 1`
	var args []any
	qs := r.URL.Query()
	if from := qs.Get("from"); validDate(from) {
		q += ` AND t.entry_date >= ?`
		args = append(args, from)
	}
	if to := qs.Get("to"); validDate(to) {
		q += ` AND t.entry_date <= ?`
		args = append(args, to)
	}
	if id, err := strconv.ParseInt(qs.Get("projectId"), 10, 64); err == nil {
		q += ` AND t.project_id = ?`
		args = append(args, id)
	}
	if id, err := strconv.ParseInt(qs.Get("customerId"), 10, 64); err == nil {
		q += ` AND p.customer_id = ?`
		args = append(args, id)
	}
	if qs.Get("unbilled") == "1" {
		q += ` AND t.billable AND t.invoice_id IS NULL AND t.timer_started_at IS NULL`
	}
	rows, err := s.db.QueryContext(r.Context(), q+` ORDER BY t.entry_date DESC, t.id DESC LIMIT 5000`, args...)
	if err != nil {
		fail(w, err)
		return
	}
	defer rows.Close()
	list := []TimeEntry{}
	for rows.Next() {
		t, err := scanEntry(rows)
		if err != nil {
			fail(w, err)
			return
		}
		list = append(list, t)
	}
	writeJSON(w, http.StatusOK, list)
}

type TimeEntryInput struct {
	ProjectID int64  `json:"projectId"`
	Date      string `json:"date"`
	Task      string `json:"task"`
	Minutes   int    `json:"minutes"`
	Notes     string `json:"notes"`
	Billable  bool   `json:"billable"`
}

func (s *server) checkProjectOpen(r *http.Request, projectID int64) error {
	var status string
	if err := s.db.QueryRowContext(r.Context(), `SELECT status FROM projects WHERE id = ?`, projectID).Scan(&status); err != nil {
		return badRequest("Choose a project.")
	}
	if status != "active" {
		return conflict("That project is completed. Reopen it to log more time.")
	}
	return nil
}

func (s *server) saveTimeEntry(w http.ResponseWriter, r *http.Request) {
	editing := r.Method == http.MethodPut
	var id int64
	var err error
	if editing {
		if id, err = pathID(r); err != nil {
			fail(w, err)
			return
		}
	}
	var in TimeEntryInput
	if err := decodeJSON(w, r, &in); err != nil {
		fail(w, err)
		return
	}
	in.Task = strings.TrimSpace(in.Task)
	switch {
	case !validDate(in.Date):
		fail(w, badRequest("Enter the date you worked."))
		return
	case in.Minutes < 1 || in.Minutes > 24*60:
		fail(w, badRequest("Enter between 1 minute and 24 hours."))
		return
	case len(in.Task) > 255 || len(in.Notes) > 1000:
		fail(w, badRequest("The task or notes are too long."))
		return
	}
	ctx := r.Context()
	if editing {
		var invoiceID *int64
		var running bool
		var projectID int64
		if err := s.db.QueryRowContext(ctx, `SELECT invoice_id, timer_started_at IS NOT NULL, project_id FROM time_entries WHERE id = ?`, id).
			Scan(&invoiceID, &running, &projectID); err != nil {
			fail(w, err)
			return
		}
		if invoiceID != nil {
			fail(w, conflict("This time is already on an invoice. Remove it from the invoice to change it."))
			return
		}
		if running {
			fail(w, conflict("Stop the timer before editing this entry."))
			return
		}
		if projectID != in.ProjectID {
			if err := s.checkProjectOpen(r, in.ProjectID); err != nil {
				fail(w, err)
				return
			}
		}
		_, err = s.db.ExecContext(ctx, `UPDATE time_entries SET project_id=?, entry_date=?, task=?, minutes=?, notes=?, billable=?
			WHERE id = ?`, in.ProjectID, in.Date, in.Task, in.Minutes, in.Notes, in.Billable, id)
	} else {
		if err := s.checkProjectOpen(r, in.ProjectID); err != nil {
			fail(w, err)
			return
		}
		var res interface{ LastInsertId() (int64, error) }
		res, err = s.db.ExecContext(ctx, `INSERT INTO time_entries (project_id, user_id, entry_date, task, minutes, notes, billable)
			VALUES (?, ?, ?, ?, ?, ?, ?)`, in.ProjectID, currentUserID(r), in.Date, in.Task, in.Minutes, in.Notes, in.Billable)
		if err == nil {
			id, _ = res.LastInsertId()
		}
	}
	if err != nil {
		fail(w, err)
		return
	}
	t, err := scanEntry(s.db.QueryRowContext(ctx, entrySelect+` WHERE t.id = ?`, id))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, map[bool]int{true: http.StatusOK, false: http.StatusCreated}[editing], t)
}

func (s *server) deleteTimeEntry(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	var invoiceID *int64
	if err := s.db.QueryRowContext(r.Context(), `SELECT invoice_id FROM time_entries WHERE id = ?`, id).Scan(&invoiceID); err != nil {
		fail(w, err)
		return
	}
	if invoiceID != nil {
		fail(w, conflict("This time is on an invoice. Remove it from the invoice first."))
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `DELETE FROM time_entries WHERE id = ?`, id); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------- Timer (one running timer per person) ----------

func (s *server) runningEntry(r *http.Request) (*TimeEntry, error) {
	t, err := scanEntry(s.db.QueryRowContext(r.Context(), entrySelect+` WHERE t.user_id = ? AND t.timer_started_at IS NOT NULL
		ORDER BY t.id DESC LIMIT 1`, currentUserID(r)))
	if isNotFound(err) {
		return nil, nil
	}
	return &t, err
}

// GET /api/timer: the running timer, or null.
func (s *server) getTimer(w http.ResponseWriter, r *http.Request) {
	t, err := s.runningEntry(r)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *server) stopRunning(r *http.Request) error {
	_, err := s.db.ExecContext(r.Context(), `UPDATE time_entries SET
		minutes = GREATEST(1, ROUND(TIMESTAMPDIFF(SECOND, timer_started_at, UTC_TIMESTAMP()) / 60)), timer_started_at = NULL
		WHERE user_id = ? AND timer_started_at IS NOT NULL`, currentUserID(r))
	return err
}

// POST /api/timer/start {"projectId", "task", "billable"}: stops any running timer first.
func (s *server) startTimer(w http.ResponseWriter, r *http.Request) {
	var in TimeEntryInput
	if err := decodeJSON(w, r, &in); err != nil {
		fail(w, err)
		return
	}
	in.Task = strings.TrimSpace(in.Task)
	if len(in.Task) > 255 {
		fail(w, badRequest("The task is too long."))
		return
	}
	if err := s.checkProjectOpen(r, in.ProjectID); err != nil {
		fail(w, err)
		return
	}
	if err := s.stopRunning(r); err != nil {
		fail(w, err)
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `INSERT INTO time_entries (project_id, user_id, entry_date, task, billable, timer_started_at)
		VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())`, in.ProjectID, currentUserID(r), todayIST(), in.Task, in.Billable); err != nil {
		fail(w, err)
		return
	}
	s.getTimer(w, r)
}

// POST /api/timer/stop: saves the running timer as a timesheet entry.
func (s *server) stopTimer(w http.ResponseWriter, r *http.Request) {
	t, err := s.runningEntry(r)
	if err != nil {
		fail(w, err)
		return
	}
	if t == nil {
		fail(w, conflict("No timer is running."))
		return
	}
	if err := s.stopRunning(r); err != nil {
		fail(w, err)
		return
	}
	stopped, err := scanEntry(s.db.QueryRowContext(r.Context(), entrySelect+` WHERE t.id = ?`, t.ID))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, stopped)
}

// ---------- Unbilled work for a customer (offered on new invoices) ----------

type UnbilledTime struct {
	ProjectID   int64   `json:"projectId"`
	ProjectName string  `json:"projectName"`
	EntryIDs    []int64 `json:"entryIds"`
	Minutes     int     `json:"minutes"`
	Hours       Dec2    `json:"hours"`
	Rate        Dec2    `json:"rate"`
	Amount      Dec2    `json:"amount"`
	SAC         string  `json:"sac"`
	TaxRate     Dec2    `json:"taxRate"`
	From        string  `json:"from"`
	To          string  `json:"to"`
}

type UnbilledExpense struct {
	ID          int64  `json:"id"`
	Date        string `json:"date"`
	Category    string `json:"category"`
	Vendor      string `json:"vendor"`
	Description string `json:"description"`
	Amount      Dec2   `json:"amount"` // value before GST, plus markup
	TaxRate     Dec2   `json:"taxRate"`
	HSNSAC      string `json:"hsnSac"`
}

// GET /api/customers/{id}/unbilled
func (s *server) customerUnbilled(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	ctx := r.Context()
	rows, err := s.db.QueryContext(ctx, `SELECT t.id, t.minutes, t.entry_date, p.id, p.project_name, p.hourly_rate, p.sac, p.tax_rate
		FROM time_entries t JOIN projects p ON p.id = t.project_id
		WHERE p.customer_id = ? AND t.billable AND t.invoice_id IS NULL AND t.timer_started_at IS NULL
		ORDER BY p.project_name, p.id, t.entry_date, t.id`, id)
	if err != nil {
		fail(w, err)
		return
	}
	var times []UnbilledTime
	index := map[int64]int{}
	for rows.Next() {
		var entryID, projectID int64
		var minutes int
		var date, name, sac string
		var rate, tax Dec2
		if err := rows.Scan(&entryID, &minutes, &date, &projectID, &name, &rate, &sac, &tax); err != nil {
			rows.Close()
			fail(w, err)
			return
		}
		i, ok := index[projectID]
		if !ok {
			times = append(times, UnbilledTime{ProjectID: projectID, ProjectName: name, Rate: rate, SAC: sac, TaxRate: tax, From: date})
			i = len(times) - 1
			index[projectID] = i
		}
		t := &times[i]
		t.EntryIDs = append(t.EntryIDs, entryID)
		t.Minutes += minutes
		t.To = date
	}
	rows.Close()
	for i := range times {
		times[i].Hours = minutesToHours(times[i].Minutes)
		times[i].Amount = calcLine(times[i].Hours, times[i].Rate, 0, 0, false).Taxable
	}

	erows, err := s.db.QueryContext(ctx, expenseSelect+` WHERE e.customer_id = ? AND e.billable AND e.invoice_id IS NULL
		ORDER BY e.expense_date, e.id`, id)
	if err != nil {
		fail(w, err)
		return
	}
	expenses := []UnbilledExpense{}
	for erows.Next() {
		e, err := scanExpense(erows)
		if err != nil {
			erows.Close()
			fail(w, err)
			return
		}
		desc := e.CategoryName
		if e.VendorName != "" {
			desc += " (" + e.VendorName + ")"
		}
		if e.Description != "" {
			desc += ": " + e.Description
		}
		expenses = append(expenses, UnbilledExpense{ID: e.ID, Date: e.Date, Category: e.CategoryName, Vendor: e.VendorName,
			Description: truncate(fmt.Sprintf("Expense %s, %s", dateText(e.Date), desc), 255), Amount: e.rebillAmount(),
			TaxRate: e.GSTRate, HSNSAC: e.HSNSAC})
	}
	erows.Close()
	if times == nil {
		times = []UnbilledTime{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"time": times, "expenses": expenses})
}
