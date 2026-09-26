package main

import (
	"context"
	"net/http"
	"strings"
)

type Item struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Kind        string `json:"kind"` // goods | service
	HSNSAC      string `json:"hsnSac"`
	Unit        string `json:"unit"`
	Rate        Dec2   `json:"rate"`
	TaxRate     Dec2   `json:"taxRate"`
	Description string `json:"description"`
	Archived    bool   `json:"archived"`
	CreatedAt   string `json:"createdAt"`
	TimesUsed   int    `json:"timesUsed"` // invoice lines that use this item (read-only)
}

const itemSelect = `SELECT it.id, it.name, it.kind, it.hsn_sac, it.unit, it.rate, it.tax_rate, it.description,
	it.archived, it.created_at, (SELECT COUNT(*) FROM invoice_items l WHERE l.item_id = it.id)
	+ (SELECT COUNT(*) FROM document_items l WHERE l.item_id = it.id)
	+ (SELECT COUNT(*) FROM recurring_items l WHERE l.item_id = it.id) FROM items it`

func scanItem(row interface{ Scan(...any) error }) (Item, error) {
	var it Item
	err := row.Scan(&it.ID, &it.Name, &it.Kind, &it.HSNSAC, &it.Unit, &it.Rate, &it.TaxRate, &it.Description,
		&it.Archived, &it.CreatedAt, &it.TimesUsed)
	return it, err
}

func (s *server) loadItem(ctx context.Context, id int64) (Item, error) {
	return scanItem(s.db.QueryRowContext(ctx, itemSelect+` WHERE it.id = ?`, id))
}

func (s *server) listItems(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.QueryContext(r.Context(), itemSelect+` ORDER BY it.archived, it.name`)
	if err != nil {
		fail(w, err)
		return
	}
	defer rows.Close()
	list := []Item{}
	for rows.Next() {
		it, err := scanItem(rows)
		if err != nil {
			fail(w, err)
			return
		}
		list = append(list, it)
	}
	if err := rows.Err(); err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *server) getItem(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	it, err := s.loadItem(r.Context(), id)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, it)
}

func (it *Item) validate() error {
	it.Name = strings.TrimSpace(it.Name)
	it.HSNSAC = strings.TrimSpace(it.HSNSAC)
	it.Unit = strings.TrimSpace(it.Unit)
	switch {
	case it.Name == "":
		return badRequest("Enter the item name.")
	case len(it.Name) > 255 || len(it.Description) > 500:
		return badRequest("Item name or description is too long.")
	case it.Kind != "goods" && it.Kind != "service":
		return badRequest("Choose whether this is goods or a service.")
	case it.HSNSAC != "" && !hsnPattern.MatchString(it.HSNSAC):
		return badRequest("HSN/SAC code must be 4, 6, or 8 digits.")
	case it.Unit == "" || len(it.Unit) > 10:
		return badRequest("Choose a unit, like nos or hrs.")
	case it.Rate < 0 || it.Rate > 1_000_000_000:
		return badRequest("Rate must be between 0 and 1,00,00,000.")
	case it.TaxRate < 0 || it.TaxRate > 10000:
		return badRequest("GST rate must be between 0 and 100%.")
	}
	return nil
}

func (s *server) createItem(w http.ResponseWriter, r *http.Request) {
	var it Item
	if err := decodeJSON(w, r, &it); err != nil {
		fail(w, err)
		return
	}
	if err := it.validate(); err != nil {
		fail(w, err)
		return
	}
	res, err := s.db.ExecContext(r.Context(),
		`INSERT INTO items (name, kind, hsn_sac, unit, rate, tax_rate, description) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		it.Name, it.Kind, it.HSNSAC, it.Unit, it.Rate, it.TaxRate, it.Description)
	if err != nil {
		fail(w, err)
		return
	}
	id, _ := res.LastInsertId()
	saved, err := s.loadItem(r.Context(), id)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, saved)
}

// PUT /api/items/{id}. Invoices keep the prices they were created with, so
// changing an item never alters existing invoices.
func (s *server) updateItem(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	var it Item
	if err := decodeJSON(w, r, &it); err != nil {
		fail(w, err)
		return
	}
	if err := it.validate(); err != nil {
		fail(w, err)
		return
	}
	res, err := s.db.ExecContext(r.Context(),
		`UPDATE items SET name=?, kind=?, hsn_sac=?, unit=?, rate=?, tax_rate=?, description=? WHERE id = ?`,
		it.Name, it.Kind, it.HSNSAC, it.Unit, it.Rate, it.TaxRate, it.Description, id)
	if err != nil {
		fail(w, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, notFound("Item not found."))
		return
	}
	saved, err := s.loadItem(r.Context(), id)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, saved)
}

func (s *server) archiveItem(w http.ResponseWriter, r *http.Request) {
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
	res, err := s.db.ExecContext(r.Context(), `UPDATE items SET archived = ? WHERE id = ?`, body.Archived, id)
	if err != nil {
		fail(w, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, notFound("Item not found."))
		return
	}
	saved, err := s.loadItem(r.Context(), id)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, saved)
}

// DELETE /api/items/{id}: unused items are deleted; used ones must be archived.
func (s *server) deleteItem(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	it, err := s.loadItem(r.Context(), id)
	if err != nil {
		fail(w, err)
		return
	}
	if it.TimesUsed > 0 {
		fail(w, conflict("This item is on existing invoices, quotes, or challans, so it can't be deleted. Archive it instead to hide it from new invoices."))
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `DELETE FROM items WHERE id = ?`, id); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
