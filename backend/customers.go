package main

import (
	"context"
	"net/http"
	"net/mail"
	"strings"
)

type Customer struct {
	ID               int64  `json:"id"`
	DisplayName      string `json:"displayName"`
	ContactPerson    string `json:"contactPerson"`
	Email            string `json:"email"`
	Phone            string `json:"phone"`
	GSTTreatment     string `json:"gstTreatment"` // registered | unregistered | consumer | overseas
	GSTIN            string `json:"gstin"`
	StateCode        string `json:"stateCode"`
	Address          string `json:"address"`
	City             string `json:"city"`
	Pincode          string `json:"pincode"`
	PaymentTermsDays *int   `json:"paymentTermsDays"` // nil = use the business default
	Notes            string `json:"notes"`
	Archived         bool   `json:"archived"`
	CreatedAt        string `json:"createdAt"`
	// Totals (read-only)
	Invoiced    Dec2 `json:"invoiced"`
	Received    Dec2 `json:"received"`
	Outstanding Dec2 `json:"outstanding"`
	Credits     Dec2 `json:"credits"` // unused credit note balances
}

// Money owed by each customer: sent invoices minus what's been allocated to them.
const customerSelect = `
SELECT c.id, c.display_name, c.contact_person, c.email, c.phone, c.gst_treatment, c.gstin,
       c.state_code, c.address, c.city, c.pincode, c.payment_terms_days, c.notes, c.archived, c.created_at,
       COALESCE((SELECT SUM(i.total) FROM invoices i WHERE i.customer_id = c.id AND i.lifecycle = 'sent'), 0),
       COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.customer_id = c.id), 0),
       COALESCE((SELECT SUM(i.total) FROM invoices i WHERE i.customer_id = c.id AND i.lifecycle = 'sent'), 0)
       - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa JOIN invoices i ON i.id = pa.invoice_id
                   WHERE i.customer_id = c.id AND i.lifecycle = 'sent'), 0)
       - COALESCE((SELECT SUM(ca.amount) FROM credit_allocations ca JOIN invoices i ON i.id = ca.invoice_id
                   WHERE i.customer_id = c.id AND i.lifecycle = 'sent'), 0),
       COALESCE((SELECT SUM(d.total) FROM documents d WHERE d.customer_id = c.id AND d.doc_type = 'credit_note' AND d.status = 'open'), 0)
       - COALESCE((SELECT SUM(ca.amount) FROM credit_allocations ca JOIN documents d ON d.id = ca.credit_note_id
                   WHERE d.customer_id = c.id AND d.status = 'open'), 0)
       - COALESCE((SELECT SUM(cr.amount) FROM credit_refunds cr JOIN documents d ON d.id = cr.credit_note_id
                   WHERE d.customer_id = c.id AND d.status = 'open'), 0)
FROM customers c`

func scanCustomer(row interface{ Scan(...any) error }) (Customer, error) {
	var c Customer
	err := row.Scan(&c.ID, &c.DisplayName, &c.ContactPerson, &c.Email, &c.Phone, &c.GSTTreatment, &c.GSTIN,
		&c.StateCode, &c.Address, &c.City, &c.Pincode, &c.PaymentTermsDays, &c.Notes, &c.Archived, &c.CreatedAt,
		&c.Invoiced, &c.Received, &c.Outstanding, &c.Credits)
	return c, err
}

func (s *server) loadCustomer(ctx context.Context, id int64) (Customer, error) {
	return scanCustomer(s.db.QueryRowContext(ctx, customerSelect+` WHERE c.id = ?`, id))
}

// GET /api/customers
func (s *server) listCustomers(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.QueryContext(r.Context(), customerSelect+` ORDER BY c.archived, c.display_name`)
	if err != nil {
		fail(w, err)
		return
	}
	defer rows.Close()
	list := []Customer{}
	for rows.Next() {
		c, err := scanCustomer(rows)
		if err != nil {
			fail(w, err)
			return
		}
		list = append(list, c)
	}
	if err := rows.Err(); err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// GET /api/customers/{id}  (invoices and payments are fetched with ?customerId=)
func (s *server) getCustomer(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	c, err := s.loadCustomer(r.Context(), id)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (c *Customer) validate() error {
	c.DisplayName = strings.TrimSpace(c.DisplayName)
	c.Email = strings.TrimSpace(c.Email)
	c.GSTIN = strings.ToUpper(strings.TrimSpace(c.GSTIN))
	c.Pincode = strings.TrimSpace(c.Pincode)

	if c.DisplayName == "" {
		return badRequest("Enter the customer's name.")
	}
	if len(c.DisplayName) > 255 || len(c.ContactPerson) > 255 || len(c.Phone) > 30 || len(c.Address) > 500 || len(c.Notes) > 1000 {
		return badRequest("One of the customer fields is too long.")
	}
	if c.Email != "" {
		if _, err := mail.ParseAddress(c.Email); err != nil || len(c.Email) > 255 {
			return badRequest("Customer email isn't a valid email address.")
		}
	}
	if c.Pincode != "" && !pincodePattern.MatchString(c.Pincode) {
		return badRequest("PIN code must be 6 digits.")
	}
	switch c.GSTTreatment {
	case "registered":
		if !validGSTIN(c.GSTIN) {
			return badRequest("That GSTIN isn't valid. It should be 15 characters, like 33ABCDE1234F1Z5.")
		}
		if c.StateCode == "" {
			c.StateCode = c.GSTIN[:2]
		}
		if c.StateCode != c.GSTIN[:2] {
			return badRequest("The GSTIN starts with state code " + c.GSTIN[:2] + ", which doesn't match the state you chose.")
		}
	case "unregistered", "consumer":
		c.GSTIN = ""
		if !validState(c.StateCode) || c.StateCode == overseasState {
			return badRequest("Choose the customer's state. It's the place of supply for GST.")
		}
	case "overseas":
		c.GSTIN = ""
		c.StateCode = overseasState
	default:
		return badRequest("Choose a GST treatment for this customer.")
	}
	if c.PaymentTermsDays != nil && (*c.PaymentTermsDays < 0 || *c.PaymentTermsDays > 365) {
		return badRequest("Payment terms must be between 0 and 365 days.")
	}
	return nil
}

// POST /api/customers
func (s *server) createCustomer(w http.ResponseWriter, r *http.Request) {
	var c Customer
	if err := decodeJSON(w, r, &c); err != nil {
		fail(w, err)
		return
	}
	if err := c.validate(); err != nil {
		fail(w, err)
		return
	}
	res, err := s.db.ExecContext(r.Context(), `INSERT INTO customers
		(display_name, contact_person, email, phone, gst_treatment, gstin, state_code, address, city, pincode, payment_terms_days, notes)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		c.DisplayName, c.ContactPerson, c.Email, c.Phone, c.GSTTreatment, c.GSTIN, c.StateCode,
		c.Address, c.City, c.Pincode, c.PaymentTermsDays, c.Notes)
	if err != nil {
		fail(w, err)
		return
	}
	id, _ := res.LastInsertId()
	saved, err := s.loadCustomer(r.Context(), id)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, saved)
}

// PUT /api/customers/{id}
func (s *server) updateCustomer(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	var c Customer
	if err := decodeJSON(w, r, &c); err != nil {
		fail(w, err)
		return
	}
	if err := c.validate(); err != nil {
		fail(w, err)
		return
	}
	res, err := s.db.ExecContext(r.Context(), `UPDATE customers SET
		display_name=?, contact_person=?, email=?, phone=?, gst_treatment=?, gstin=?, state_code=?,
		address=?, city=?, pincode=?, payment_terms_days=?, notes=? WHERE id = ?`,
		c.DisplayName, c.ContactPerson, c.Email, c.Phone, c.GSTTreatment, c.GSTIN, c.StateCode,
		c.Address, c.City, c.Pincode, c.PaymentTermsDays, c.Notes, id)
	if err != nil {
		fail(w, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, notFound("Customer not found."))
		return
	}
	saved, err := s.loadCustomer(r.Context(), id)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, saved)
}

// PATCH /api/customers/{id}/archive   body: {"archived": true|false}
func (s *server) archiveCustomer(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	var body struct {
		Archived bool `json:"archived"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		fail(w, err)
		return
	}
	res, err := s.db.ExecContext(r.Context(), `UPDATE customers SET archived = ? WHERE id = ?`, body.Archived, id)
	if err != nil {
		fail(w, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, notFound("Customer not found."))
		return
	}
	saved, err := s.loadCustomer(r.Context(), id)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, saved)
}

// DELETE /api/customers/{id}  (only customers with no invoices or payments)
func (s *server) deleteCustomer(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	var used int
	if err := s.db.QueryRowContext(r.Context(),
		`SELECT (SELECT COUNT(*) FROM invoices WHERE customer_id = ?) + (SELECT COUNT(*) FROM payments WHERE customer_id = ?)
		 + (SELECT COUNT(*) FROM documents WHERE customer_id = ?) + (SELECT COUNT(*) FROM recurring_profiles WHERE customer_id = ?)`,
		id, id, id, id).Scan(&used); err != nil {
		fail(w, err)
		return
	}
	if used > 0 {
		fail(w, conflict("This customer has invoices, quotes, or payments, so it can't be deleted. Archive it instead to hide it from lists."))
		return
	}
	res, err := s.db.ExecContext(r.Context(), `DELETE FROM customers WHERE id = ?`, id)
	if err != nil {
		fail(w, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, notFound("Customer not found."))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
