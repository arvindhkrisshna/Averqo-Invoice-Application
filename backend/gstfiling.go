package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Invoices to unregistered buyers in another state go into B2C (large) when
// their value is more than ₹1,00,000 (the limit since 1 August 2024).
const b2clLimit Dec2 = 10_000_000

type taxAmt struct {
	Taxable Dec2 `json:"taxable"`
	IGST    Dec2 `json:"igst"`
	CGST    Dec2 `json:"cgst"`
	SGST    Dec2 `json:"sgst"`
}

func (t *taxAmt) add(o taxAmt, negative bool) {
	if negative {
		o = taxAmt{-o.Taxable, -o.IGST, -o.CGST, -o.SGST}
	}
	t.Taxable += o.Taxable
	t.IGST += o.IGST
	t.CGST += o.CGST
	t.SGST += o.SGST
}

// saleLine is one line of a sent invoice or an issued credit note.
type saleLine struct {
	DocID                          int64
	Credit                         bool
	Number, Date, Customer, GSTIN  string
	POS, Treatment                 string
	DocTotal                       Dec2
	HSN, Unit, Desc                string
	Qty, Rate                      Dec2
	Amt                            taxAmt
	LinkedNumber                   string // credit notes: the invoice being corrected
	LinkedTotal                    *Dec2
	LinkedPOS, LinkedGSTIN         *string
}

func (l saleLine) export() bool { return l.POS == overseasState || l.Treatment == "overseas" }

func periodFromQuery(r *http.Request) (string, string, error) {
	from, to := r.URL.Query().Get("from"), r.URL.Query().Get("to")
	if !validDate(from) || !validDate(to) || from > to {
		return "", "", badRequest("Choose a valid return period.")
	}
	f, _ := time.Parse(dateLayout, from)
	t, _ := time.Parse(dateLayout, to)
	if t.Sub(f) > 93*24*time.Hour {
		return "", "", badRequest("A return period can be at most one quarter.")
	}
	return from, to, nil
}

func (s *server) loadSaleLines(ctx context.Context, from, to string) ([]saleLine, error) {
	var out []saleLine
	rows, err := s.db.QueryContext(ctx, `SELECT i.id, i.invoice_number, i.issue_date, i.customer_name, i.customer_gstin,
		i.place_of_supply, COALESCE(c.gst_treatment, ''), i.total, l.hsn_sac, l.unit, l.description, l.quantity, l.tax_rate,
		l.taxable_amount, l.igst, l.cgst, l.sgst
		FROM invoices i JOIN invoice_items l ON l.invoice_id = i.id LEFT JOIN customers c ON c.id = i.customer_id
		WHERE i.lifecycle = 'sent' AND i.issue_date BETWEEN ? AND ? ORDER BY i.issue_date, i.invoice_number, l.sort_order, l.id`, from, to)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var l saleLine
		if err := rows.Scan(&l.DocID, &l.Number, &l.Date, &l.Customer, &l.GSTIN, &l.POS, &l.Treatment, &l.DocTotal, &l.HSN,
			&l.Unit, &l.Desc, &l.Qty, &l.Rate, &l.Amt.Taxable, &l.Amt.IGST, &l.Amt.CGST, &l.Amt.SGST); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, l)
	}
	rows.Close()
	rows, err = s.db.QueryContext(ctx, `SELECT d.id, d.doc_number, d.issue_date, d.customer_name, d.customer_gstin,
		d.place_of_supply, COALESCE(c.gst_treatment, ''), d.total, l.hsn_sac, l.unit, l.description, l.quantity, l.tax_rate,
		l.taxable_amount, l.igst, l.cgst, l.sgst, COALESCE(i.invoice_number, ''), i.total, i.place_of_supply, i.customer_gstin
		FROM documents d JOIN document_items l ON l.document_id = d.id LEFT JOIN customers c ON c.id = d.customer_id
		LEFT JOIN invoices i ON i.id = d.invoice_id
		WHERE d.doc_type = 'credit_note' AND d.status = 'open' AND d.issue_date BETWEEN ? AND ?
		ORDER BY d.issue_date, d.doc_number, l.sort_order, l.id`, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		l := saleLine{Credit: true}
		if err := rows.Scan(&l.DocID, &l.Number, &l.Date, &l.Customer, &l.GSTIN, &l.POS, &l.Treatment, &l.DocTotal, &l.HSN,
			&l.Unit, &l.Desc, &l.Qty, &l.Rate, &l.Amt.Taxable, &l.Amt.IGST, &l.Amt.CGST, &l.Amt.SGST, &l.LinkedNumber,
			&l.LinkedTotal, &l.LinkedPOS, &l.LinkedGSTIN); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// ---------- GSTR-1 ----------

type g1Item struct {
	Rate Dec2 `json:"rate"`
	taxAmt
}

type g1Doc struct {
	ID       int64    `json:"id"`
	Number   string   `json:"number"`
	Date     string   `json:"date"`
	Customer string   `json:"customer"`
	GSTIN    string   `json:"gstin"`
	POS      string   `json:"pos"`
	Value    Dec2     `json:"value"`
	Type     string   `json:"type"` // B2CL / EXPWP / EXPWOP (credit notes to unregistered), WPAY / WOPAY (exports)
	Against  string   `json:"against"`
	Items    []g1Item `json:"items"`
	Total    taxAmt   `json:"total"`
}

type g1B2CS struct {
	SupplyType string `json:"supplyType"` // INTRA / INTER
	POS        string `json:"pos"`
	Rate       Dec2   `json:"rate"`
	taxAmt
}

type g1HSN struct {
	HSN  string `json:"hsn"`
	Desc string `json:"desc"`
	UQC  string `json:"uqc"`
	Qty  Dec2   `json:"qty"`
	Rate Dec2   `json:"rate"`
	taxAmt
}

type g1Nil struct {
	SupplyType string `json:"supplyType"` // INTRB2B, INTRAB2B, INTRB2C, INTRAB2C
	Label      string `json:"label"`
	Amount     Dec2   `json:"amount"`
}

type g1Series struct {
	Nature    string `json:"nature"`
	DocNum    int    `json:"docNum"`
	From      string `json:"from"`
	To        string `json:"to"`
	Total     int    `json:"total"`
	Cancelled int    `json:"cancelled"`
}

type GSTR1 struct {
	From     string     `json:"from"`
	To       string     `json:"to"`
	GSTIN    string     `json:"gstin"`
	B2B      []g1Doc    `json:"b2b"`
	B2CL     []g1Doc    `json:"b2cl"`
	B2CS     []g1B2CS   `json:"b2cs"`
	EXP      []g1Doc    `json:"exp"`
	CDNR     []g1Doc    `json:"cdnr"`
	CDNUR    []g1Doc    `json:"cdnur"`
	HSNB2B   []g1HSN    `json:"hsnB2b"`
	HSNB2C   []g1HSN    `json:"hsnB2c"`
	Nil      []g1Nil    `json:"nil"`
	Docs     []g1Series `json:"docs"`
	Totals   taxAmt     `json:"totals"` // net of credit notes, all sections
	Invoices int        `json:"invoices"`
	Checks   []gstCheck `json:"checks"`
}

// uqc maps an Averqo unit to the GST portal's unit codes. Services use NA.
func uqc(unit, hsn string) string {
	if strings.HasPrefix(hsn, "99") {
		return "NA"
	}
	switch strings.ToLower(unit) {
	case "nos":
		return "NOS"
	case "pcs":
		return "PCS"
	case "kg":
		return "KGS"
	case "g":
		return "GMS"
	case "ltr":
		return "LTR"
	case "m":
		return "MTR"
	case "sqft":
		return "SQF"
	case "box":
		return "BOX"
	case "set":
		return "SET"
	case "pack":
		return "PAC"
	}
	return "OTH"
}

// docBuilder groups lines into documents with rate-wise items, keeping order.
type docBuilder struct {
	order []int64
	docs  map[int64]*g1Doc
}

func newDocBuilder() *docBuilder { return &docBuilder{docs: map[int64]*g1Doc{}} }

func (b *docBuilder) add(l saleLine, typ string) {
	d, ok := b.docs[l.DocID]
	if !ok {
		d = &g1Doc{ID: l.DocID, Number: l.Number, Date: l.Date, Customer: l.Customer, GSTIN: l.GSTIN, POS: l.POS,
			Value: l.DocTotal, Type: typ, Against: l.LinkedNumber}
		b.docs[l.DocID] = d
		b.order = append(b.order, l.DocID)
	}
	for i := range d.Items {
		if d.Items[i].Rate == l.Rate {
			d.Items[i].add(l.Amt, false)
			d.Total.add(l.Amt, false)
			return
		}
	}
	d.Items = append(d.Items, g1Item{Rate: l.Rate, taxAmt: l.Amt})
	d.Total.add(l.Amt, false)
}

func (b *docBuilder) list() []g1Doc {
	out := make([]g1Doc, 0, len(b.order))
	for _, id := range b.order {
		out = append(out, *b.docs[id])
	}
	return out
}

func buildGSTR1(orgState string, lines []saleLine) GSTR1 {
	// Empty sections are sent as [] (never null) so the page can always list them.
	g := GSTR1{B2CS: []g1B2CS{}, HSNB2B: []g1HSN{}, HSNB2C: []g1HSN{}, Nil: []g1Nil{}, Docs: []g1Series{}, Checks: []gstCheck{}}
	b2b, b2cl, exp, cdnr, cdnur := newDocBuilder(), newDocBuilder(), newDocBuilder(), newDocBuilder(), newDocBuilder()
	b2cs := map[string]*g1B2CS{}
	var b2csOrder []string
	hsn := map[string]*g1HSN{}
	var hsnOrder []string
	nilAmt := map[string]Dec2{}
	invoices := map[int64]bool{}

	for _, l := range lines {
		if !l.Credit {
			invoices[l.DocID] = true
		}
		registered := l.GSTIN != ""
		inter := l.POS != orgState
		g.Totals.add(l.Amt, l.Credit)

		// HSN summary (net of credit notes), split by registered and unregistered buyers.
		code := uqc(l.Unit, l.HSN)
		key := fmt.Sprintf("%t|%s|%s|%s", registered, l.HSN, l.Rate, code)
		h, ok := hsn[key]
		if !ok {
			h = &g1HSN{HSN: l.HSN, Desc: truncate(l.Desc, 30), UQC: code, Rate: l.Rate}
			hsn[key] = h
			hsnOrder = append(hsnOrder, key)
		}
		h.add(l.Amt, l.Credit)
		if code != "NA" {
			if l.Credit {
				h.Qty -= l.Qty
			} else {
				h.Qty += l.Qty
			}
		}

		// Nil-rated lines (0% GST, not exports) go in Table 8 only.
		if l.Rate == 0 && !l.export() {
			st := map[bool]string{true: "INTR", false: "INTRA"}[inter] + map[bool]string{true: "B2B", false: "B2C"}[registered]
			if l.Credit {
				nilAmt[st] -= l.Amt.Taxable
			} else {
				nilAmt[st] += l.Amt.Taxable
			}
			continue
		}

		switch {
		case !l.Credit && l.export():
			exp.add(l, "")
		case !l.Credit && registered:
			b2b.add(l, "R")
		case !l.Credit && inter && l.DocTotal > b2clLimit:
			b2cl.add(l, "")
		case l.Credit && registered:
			cdnr.add(l, "")
		case l.Credit && l.export():
			cdnur.add(l, "EXPWP")
		case l.Credit && l.LinkedTotal != nil && l.LinkedGSTIN != nil && *l.LinkedGSTIN == "" && l.LinkedPOS != nil &&
			*l.LinkedPOS != orgState && *l.LinkedPOS != overseasState && *l.LinkedTotal > b2clLimit:
			cdnur.add(l, "B2CL")
		default: // B2C (small), aggregated by place of supply and rate; credit notes reduce it
			typ := map[bool]string{true: "INTER", false: "INTRA"}[inter]
			k := typ + "|" + l.POS + "|" + l.Rate.String()
			row, ok := b2cs[k]
			if !ok {
				row = &g1B2CS{SupplyType: typ, POS: l.POS, Rate: l.Rate}
				b2cs[k] = row
				b2csOrder = append(b2csOrder, k)
			}
			row.add(l.Amt, l.Credit)
		}
	}
	g.B2B, g.B2CL, g.EXP, g.CDNR, g.CDNUR = b2b.list(), b2cl.list(), exp.list(), cdnr.list(), cdnur.list()
	for i := range g.EXP {
		g.EXP[i].Type = "WOPAY"
		if g.EXP[i].Total.IGST > 0 {
			g.EXP[i].Type = "WPAY"
		}
	}
	for i := range g.CDNUR {
		if g.CDNUR[i].Type == "EXPWP" && g.CDNUR[i].Total.IGST == 0 {
			g.CDNUR[i].Type = "EXPWOP"
		}
	}
	sort.Strings(b2csOrder)
	for _, k := range b2csOrder {
		g.B2CS = append(g.B2CS, *b2cs[k])
	}
	for _, k := range hsnOrder {
		if strings.HasPrefix(k, "true|") {
			g.HSNB2B = append(g.HSNB2B, *hsn[k])
		} else {
			g.HSNB2C = append(g.HSNB2C, *hsn[k])
		}
	}
	labels := map[string]string{"INTRB2B": "Inter-state, to registered buyers", "INTRAB2B": "Intra-state, to registered buyers",
		"INTRB2C": "Inter-state, to unregistered buyers", "INTRAB2C": "Intra-state, to unregistered buyers"}
	for _, st := range []string{"INTRB2B", "INTRAB2B", "INTRB2C", "INTRAB2C"} {
		if nilAmt[st] != 0 {
			g.Nil = append(g.Nil, g1Nil{st, labels[st], nilAmt[st]})
		}
	}
	g.Invoices = len(invoices)
	return g
}

// documentSeries builds Table 13 (documents issued), one row per number series.
func (s *server) documentSeries(ctx context.Context, from, to string) ([]g1Series, error) {
	type doc struct {
		number, kind string
		cancelled  bool
	}
	var docs []doc
	rows, err := s.db.QueryContext(ctx, `SELECT invoice_number, 'invoice', lifecycle = 'void' FROM invoices
		WHERE lifecycle <> 'draft' AND issue_date BETWEEN ? AND ?
		UNION ALL SELECT doc_number, 'credit_note', status = 'void' FROM documents
		WHERE doc_type = 'credit_note' AND status <> 'draft' AND issue_date BETWEEN ? AND ?
		UNION ALL SELECT doc_number, CONCAT('challan_', challan_type), status = 'cancelled' FROM documents
		WHERE doc_type = 'challan' AND status <> 'draft' AND issue_date BETWEEN ? AND ?`, from, to, from, to, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var d doc
		if err := rows.Scan(&d.number, &d.kind, &d.cancelled); err != nil {
			return nil, err
		}
		docs = append(docs, d)
	}
	natures := map[string]struct {
		name string
		num  int
	}{
		"invoice": {"Invoices for outward supply", 1}, "credit_note": {"Credit notes", 5},
		"challan_job_work": {"Delivery challans for job work", 9}, "challan_supply_on_approval": {"Delivery challans for supply on approval", 10},
		"challan_supply_of_liquid_gas": {"Delivery challans for liquid gas", 11}, "challan_others": {"Delivery challans for other than supply", 12},
	}
	type series struct {
		kind, prefix     string
		nums             []string
		total, cancelled int
	}
	groups := map[string]*series{}
	var keys []string
	for _, d := range docs {
		prefix := strings.TrimRight(d.number, "0123456789")
		k := d.kind + "|" + prefix
		g, ok := groups[k]
		if !ok {
			g = &series{kind: d.kind, prefix: prefix}
			groups[k] = g
			keys = append(keys, k)
		}
		g.nums = append(g.nums, d.number)
		g.total++
		if d.cancelled {
			g.cancelled++
		}
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := groups[keys[i]], groups[keys[j]]
		if natures[a.kind].num != natures[b.kind].num {
			return natures[a.kind].num < natures[b.kind].num
		}
		return a.prefix < b.prefix
	})
	numPart := func(n, prefix string) int { v, _ := strconv.Atoi(strings.TrimPrefix(n, prefix)); return v }
	out := []g1Series{}
	for _, k := range keys {
		g := groups[k]
		sort.Slice(g.nums, func(i, j int) bool { return numPart(g.nums[i], g.prefix) < numPart(g.nums[j], g.prefix) })
		n := natures[g.kind]
		out = append(out, g1Series{n.name, n.num, g.nums[0], g.nums[len(g.nums)-1], g.total, g.cancelled})
	}
	return out, nil
}

func (s *server) gstr1(ctx context.Context, from, to string) (GSTR1, Organization, error) {
	org, err := s.loadOrganization(ctx)
	if err != nil {
		return GSTR1{}, org, err
	}
	lines, err := s.loadSaleLines(ctx, from, to)
	if err != nil {
		return GSTR1{}, org, err
	}
	g := buildGSTR1(org.StateCode, lines)
	g.From, g.To, g.GSTIN = from, to, org.GSTIN
	if g.Docs, err = s.documentSeries(ctx, from, to); err != nil {
		return g, org, err
	}
	g.Checks, err = s.gstChecks(ctx, org, from, to, lines)
	return g, org, err
}

// GET /api/gst/gstr1?from=&to=
func (s *server) getGSTR1(w http.ResponseWriter, r *http.Request) {
	from, to, err := periodFromQuery(r)
	if err != nil {
		fail(w, err)
		return
	}
	g, _, err := s.gstr1(r.Context(), from, to)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, g)
}

func portalDate(iso string) string { return iso[8:10] + "-" + iso[5:7] + "-" + iso[0:4] }

type jsonItem struct {
	Num    int            `json:"num"`
	ItmDet map[string]any `json:"itm_det"`
}

func portalItems(items []g1Item, withNum bool) any {
	var out []any
	for i, it := range items {
		det := map[string]any{"txval": it.Taxable, "rt": it.Rate, "csamt": Dec2(0)}
		if it.IGST != 0 {
			det["iamt"] = it.IGST
		} else if it.CGST != 0 || it.SGST != 0 {
			det["camt"], det["samt"] = it.CGST, it.SGST
		} else {
			det["iamt"] = Dec2(0)
		}
		if withNum {
			out = append(out, jsonItem{i + 1, det})
		} else {
			out = append(out, det)
		}
	}
	return out
}

// GET /api/gst/gstr1.json?from=&to=: the GSTR-1 file for the portal's "Prepare offline" upload.
func (s *server) downloadGSTR1JSON(w http.ResponseWriter, r *http.Request) {
	from, to, err := periodFromQuery(r)
	if err != nil {
		fail(w, err)
		return
	}
	g, org, err := s.gstr1(r.Context(), from, to)
	if err != nil {
		fail(w, err)
		return
	}
	if !org.GSTRegistered || org.GSTIN == "" {
		fail(w, badRequest("Add your GSTIN in Settings first."))
		return
	}
	fp := to[5:7] + to[0:4]
	out := map[string]any{"gstin": org.GSTIN, "fp": fp, "version": "GST3.2.1", "hash": "hash"}

	if len(g.B2B) > 0 {
		byCtin := map[string][]any{}
		var ctins []string
		for _, d := range g.B2B {
			if _, ok := byCtin[d.GSTIN]; !ok {
				ctins = append(ctins, d.GSTIN)
			}
			byCtin[d.GSTIN] = append(byCtin[d.GSTIN], map[string]any{"inum": d.Number, "idt": portalDate(d.Date), "val": d.Value,
				"pos": d.POS, "rchrg": "N", "inv_typ": "R", "itms": portalItems(d.Items, true)})
		}
		var b2b []any
		for _, c := range ctins {
			b2b = append(b2b, map[string]any{"ctin": c, "inv": byCtin[c]})
		}
		out["b2b"] = b2b
	}
	if len(g.B2CL) > 0 {
		byPos := map[string][]any{}
		var poss []string
		for _, d := range g.B2CL {
			if _, ok := byPos[d.POS]; !ok {
				poss = append(poss, d.POS)
			}
			byPos[d.POS] = append(byPos[d.POS], map[string]any{"inum": d.Number, "idt": portalDate(d.Date), "val": d.Value,
				"itms": portalItems(d.Items, true)})
		}
		var b2cl []any
		for _, p := range poss {
			b2cl = append(b2cl, map[string]any{"pos": p, "inv": byPos[p]})
		}
		out["b2cl"] = b2cl
	}
	if len(g.B2CS) > 0 {
		var b2cs []any
		for _, row := range g.B2CS {
			m := map[string]any{"sply_ty": row.SupplyType, "pos": row.POS, "typ": "OE", "txval": row.Taxable, "rt": row.Rate, "csamt": Dec2(0)}
			if row.SupplyType == "INTER" {
				m["iamt"] = row.IGST
			} else {
				m["camt"], m["samt"] = row.CGST, row.SGST
			}
			b2cs = append(b2cs, m)
		}
		out["b2cs"] = b2cs
	}
	if len(g.EXP) > 0 {
		byType := map[string][]any{}
		for _, d := range g.EXP {
			byType[d.Type] = append(byType[d.Type], map[string]any{"inum": d.Number, "idt": portalDate(d.Date), "val": d.Value,
				"itms": portalItems(d.Items, false)})
		}
		var exp []any
		for _, t := range []string{"WPAY", "WOPAY"} {
			if len(byType[t]) > 0 {
				exp = append(exp, map[string]any{"exp_typ": t, "inv": byType[t]})
			}
		}
		out["exp"] = exp
	}
	if len(g.CDNR) > 0 {
		byCtin := map[string][]any{}
		var ctins []string
		for _, d := range g.CDNR {
			if _, ok := byCtin[d.GSTIN]; !ok {
				ctins = append(ctins, d.GSTIN)
			}
			byCtin[d.GSTIN] = append(byCtin[d.GSTIN], map[string]any{"ntty": "C", "nt_num": d.Number, "nt_dt": portalDate(d.Date),
				"val": d.Value, "pos": d.POS, "rchrg": "N", "inv_typ": "R", "itms": portalItems(d.Items, true)})
		}
		var cdnr []any
		for _, c := range ctins {
			cdnr = append(cdnr, map[string]any{"ctin": c, "nt": byCtin[c]})
		}
		out["cdnr"] = cdnr
	}
	if len(g.CDNUR) > 0 {
		var cdnur []any
		for _, d := range g.CDNUR {
			m := map[string]any{"typ": d.Type, "ntty": "C", "nt_num": d.Number, "nt_dt": portalDate(d.Date), "val": d.Value,
				"itms": portalItems(d.Items, true)}
			if d.Type == "B2CL" {
				m["pos"] = d.POS
			}
			cdnur = append(cdnur, m)
		}
		out["cdnur"] = cdnur
	}
	hsnRows := func(list []g1HSN) []any {
		var rows []any
		for i, h := range list {
			rows = append(rows, map[string]any{"num": i + 1, "hsn_sc": h.HSN, "desc": h.Desc, "uqc": h.UQC, "qty": h.Qty,
				"rt": h.Rate, "txval": h.Taxable, "iamt": h.IGST, "camt": h.CGST, "samt": h.SGST, "csamt": Dec2(0)})
		}
		return rows
	}
	if len(g.HSNB2B)+len(g.HSNB2C) > 0 {
		hsn := map[string]any{}
		if len(g.HSNB2B) > 0 {
			hsn["hsn_b2b"] = hsnRows(g.HSNB2B)
		}
		if len(g.HSNB2C) > 0 {
			hsn["hsn_b2c"] = hsnRows(g.HSNB2C)
		}
		out["hsn"] = hsn
	}
	if len(g.Nil) > 0 {
		var inv []any
		for _, n := range g.Nil {
			inv = append(inv, map[string]any{"sply_ty": n.SupplyType, "nil_amt": n.Amount, "expt_amt": Dec2(0), "ngsup_amt": Dec2(0)})
		}
		out["nil"] = map[string]any{"inv": inv}
	}
	if len(g.Docs) > 0 {
		byNum := map[int][]any{}
		var nums []int
		for _, d := range g.Docs {
			if _, ok := byNum[d.DocNum]; !ok {
				nums = append(nums, d.DocNum)
			}
			byNum[d.DocNum] = append(byNum[d.DocNum], map[string]any{"num": len(byNum[d.DocNum]) + 1, "from": d.From, "to": d.To,
				"totnum": d.Total, "cancel": d.Cancelled, "net_issue": d.Total - d.Cancelled})
		}
		var det []any
		for _, n := range nums {
			det = append(det, map[string]any{"doc_num": n, "docs": byNum[n]})
		}
		out["doc_issue"] = map[string]any{"doc_det": det}
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="GSTR1_%s_%s.json"`, org.GSTIN, fp))
	writeJSON(w, http.StatusOK, out)
}

// ---------- GSTR-3B ----------

type heads struct {
	IGST Dec2 `json:"igst"`
	CGST Dec2 `json:"cgst"`
	SGST Dec2 `json:"sgst"`
}

// setoff shows how input tax credit pays the tax due, in the order the law
// requires (sections 49 and 49A): IGST credit first (IGST, then CGST and SGST),
// then CGST credit (CGST, then IGST), then SGST credit (SGST, then IGST).
// CGST credit can never pay SGST, or the other way round.
type setoff struct {
	Liability  heads `json:"liability"`
	Credit     heads `json:"credit"`
	FromIGST   heads `json:"fromIgst"` // IGST credit used against each head
	FromCGST   heads `json:"fromCgst"`
	FromSGST   heads `json:"fromSgst"`
	Cash       heads `json:"cash"`       // still to pay in cash
	CreditLeft heads `json:"creditLeft"` // carried forward
}

func computeSetoff(liab, credit heads) setoff {
	pos := func(d Dec2) Dec2 { return max(d, 0) }
	s := setoff{Liability: heads{pos(liab.IGST), pos(liab.CGST), pos(liab.SGST)}, Credit: heads{pos(credit.IGST), pos(credit.CGST), pos(credit.SGST)}}
	remI, remC, remS := s.Liability.IGST, s.Liability.CGST, s.Liability.SGST
	crI, crC, crS := s.Credit.IGST, s.Credit.CGST, s.Credit.SGST
	use := func(cr, rem *Dec2) Dec2 {
		x := min(*cr, *rem)
		*cr -= x
		*rem -= x
		return x
	}
	s.FromIGST.IGST = use(&crI, &remI)
	// Spend the remaining IGST credit where CGST/SGST credit can't cover first, then any leftover.
	gapC, gapS := pos(remC-crC), pos(remS-crS)
	x := min(crI, gapC)
	crI, remC, s.FromIGST.CGST = crI-x, remC-x, x
	y := min(crI, gapS)
	crI, remS, s.FromIGST.SGST = crI-y, remS-y, y
	s.FromIGST.CGST += use(&crI, &remC)
	s.FromIGST.SGST += use(&crI, &remS)
	s.FromCGST.CGST = use(&crC, &remC)
	s.FromCGST.IGST = use(&crC, &remI)
	s.FromSGST.SGST = use(&crS, &remS)
	s.FromSGST.IGST = use(&crS, &remI)
	s.Cash = heads{remI, remC, remS}
	s.CreditLeft = heads{crI, crC, crS}
	return s
}

type posRow struct {
	POS     string `json:"pos"`
	State   string `json:"state"`
	Taxable Dec2   `json:"taxable"`
	IGST    Dec2   `json:"igst"`
}

type GSTR3B struct {
	From               string     `json:"from"`
	To                 string     `json:"to"`
	Outward            taxAmt     `json:"outward"`            // 3.1(a)
	ZeroRated          taxAmt     `json:"zeroRated"`          // 3.1(b)
	NilExempt          taxAmt     `json:"nilExempt"`          // 3.1(c)
	ReverseCharge      taxAmt     `json:"reverseCharge"`      // 3.1(d)
	InterUnregistered  []posRow   `json:"interUnregistered"`  // 3.2
	ITCReverseCharge   taxAmt     `json:"itcReverseCharge"`   // 4(A)(3)
	ITCOther           taxAmt     `json:"itcOther"`           // 4(A)(5)
	ITCNet             taxAmt     `json:"itcNet"`             // 4(C)
	Setoff             setoff     `json:"setoff"`             // 6.1, tax due on outward supplies
	ReverseChargeCash  heads      `json:"reverseChargeCash"`  // reverse-charge tax is always paid in cash
	Checks             []gstCheck `json:"checks"`
}

func (s *server) getGSTR3B(w http.ResponseWriter, r *http.Request) {
	from, to, err := periodFromQuery(r)
	if err != nil {
		fail(w, err)
		return
	}
	ctx := r.Context()
	org, err := s.loadOrganization(ctx)
	if err != nil {
		fail(w, err)
		return
	}
	lines, err := s.loadSaleLines(ctx, from, to)
	if err != nil {
		fail(w, err)
		return
	}
	g := GSTR3B{From: from, To: to, InterUnregistered: []posRow{}}
	byPos := map[string]*posRow{}
	for _, l := range lines {
		switch {
		case l.export():
			g.ZeroRated.add(l.Amt, l.Credit)
		case l.Rate == 0:
			g.NilExempt.add(l.Amt, l.Credit)
		default:
			g.Outward.add(l.Amt, l.Credit)
			if l.GSTIN == "" && l.POS != org.StateCode {
				p, ok := byPos[l.POS]
				if !ok {
					p = &posRow{POS: l.POS, State: stateName(l.POS)}
					byPos[l.POS] = p
				}
				sign := Dec2(1)
				if l.Credit {
					sign = -1
				}
				p.Taxable += sign * l.Amt.Taxable
				p.IGST += sign * l.Amt.IGST
			}
		}
	}
	for _, p := range byPos {
		g.InterUnregistered = append(g.InterUnregistered, *p)
	}
	sort.Slice(g.InterUnregistered, func(i, j int) bool { return g.InterUnregistered[i].POS < g.InterUnregistered[j].POS })

	rows, err := s.db.QueryContext(ctx, `SELECT subtotal, igst, cgst, sgst, reverse_charge, itc_eligible, vendor_gstin <> ''
		FROM expenses WHERE expense_date BETWEEN ? AND ? AND gst_rate > 0`, from, to)
	if err != nil {
		fail(w, err)
		return
	}
	for rows.Next() {
		var a taxAmt
		var rcm, eligible, hasGSTIN bool
		if err := rows.Scan(&a.Taxable, &a.IGST, &a.CGST, &a.SGST, &rcm, &eligible, &hasGSTIN); err != nil {
			rows.Close()
			fail(w, err)
			return
		}
		if rcm {
			g.ReverseCharge.add(a, false)
			if eligible {
				g.ITCReverseCharge.add(taxAmt{0, a.IGST, a.CGST, a.SGST}, false)
			}
		} else if eligible && hasGSTIN {
			g.ITCOther.add(taxAmt{0, a.IGST, a.CGST, a.SGST}, false)
		}
	}
	rows.Close()
	g.ITCNet.add(g.ITCReverseCharge, false)
	g.ITCNet.add(g.ITCOther, false)
	liab := heads{g.Outward.IGST + g.ZeroRated.IGST, g.Outward.CGST, g.Outward.SGST}
	g.Setoff = computeSetoff(liab, heads{g.ITCNet.IGST, g.ITCNet.CGST, g.ITCNet.SGST})
	g.ReverseChargeCash = heads{g.ReverseCharge.IGST, g.ReverseCharge.CGST, g.ReverseCharge.SGST}
	if g.Checks, err = s.gstChecks(ctx, org, from, to, lines); err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, g)
}

// ---------- Checks before filing ----------

type gstCheck struct {
	Level   string `json:"level"` // error | warning | info
	Message string `json:"message"`
	Link    string `json:"link"`
}

func (s *server) gstChecks(ctx context.Context, org Organization, from, to string, lines []saleLine) ([]gstCheck, error) {
	checks := []gstCheck{}
	if !org.GSTRegistered || org.GSTIN == "" {
		checks = append(checks, gstCheck{"error", "Your business isn't set up as GST-registered with a GSTIN, so there's nothing to file. Add your GSTIN in Settings if you're registered.", "/settings"})
	}
	var drafts, badExpenses int
	var badGST Dec2
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM invoices WHERE lifecycle = 'draft' AND issue_date BETWEEN ? AND ?`,
		from, to).Scan(&drafts); err != nil {
		return nil, err
	}
	if drafts > 0 {
		checks = append(checks, gstCheck{"warning", fmt.Sprintf("%d draft invoice(s) are dated in this period and aren't included. Send or delete them before filing.", drafts), "/invoices?status=draft"})
	}
	noHSN := map[string]bool{}
	noPOS := map[string]bool{}
	for _, l := range lines {
		if l.HSN == "" {
			noHSN[l.Number] = true
		}
		if l.POS == "" {
			noPOS[l.Number] = true
		}
	}
	if len(noHSN) > 0 {
		checks = append(checks, gstCheck{"warning", fmt.Sprintf("%d document(s) have lines without an HSN/SAC code: %s. The HSN summary needs a code for every line.", len(noHSN), joinSome(noHSN)), ""})
	}
	if len(noPOS) > 0 {
		checks = append(checks, gstCheck{"error", fmt.Sprintf("%d document(s) have no place of supply: %s.", len(noPOS), joinSome(noPOS)), ""})
	}
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(igst + cgst + sgst), 0) FROM expenses
		WHERE expense_date BETWEEN ? AND ? AND gst_rate > 0 AND itc_eligible AND NOT reverse_charge AND vendor_gstin = ''`,
		from, to).Scan(&badExpenses, &badGST); err != nil {
		return nil, err
	}
	if badExpenses > 0 {
		checks = append(checks, gstCheck{"warning", fmt.Sprintf("%s of GST on %d expense(s) isn't counted as input tax credit because the vendor's GSTIN is missing. Add it to claim the credit.", badGST.Rupees(), badExpenses), "/expenses"})
	}
	var unlinked int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM documents WHERE doc_type = 'credit_note' AND status = 'open'
		AND invoice_id IS NULL AND customer_gstin = '' AND issue_date BETWEEN ? AND ?`, from, to).Scan(&unlinked); err != nil {
		return nil, err
	}
	if unlinked > 0 {
		checks = append(checks, gstCheck{"info", fmt.Sprintf("%d credit note(s) to unregistered customers aren't linked to an invoice, so they reduce B2C (small) sales.", unlinked), "/credit-notes"})
	}
	if len(lines) == 0 && org.GSTRegistered {
		checks = append(checks, gstCheck{"info", "No sent invoices or credit notes in this period. You may need to file a nil return.", ""})
	}
	return checks, nil
}

func joinSome(set map[string]bool) string {
	var list []string
	for k := range set {
		list = append(list, k)
	}
	sort.Strings(list)
	if len(list) > 5 {
		return strings.Join(list[:5], ", ") + fmt.Sprintf(" and %d more", len(list)-5)
	}
	return strings.Join(list, ", ")
}

// ---------- Filed returns ----------

type GSTReturn struct {
	ID          int64   `json:"id"`
	ReturnType  string  `json:"returnType"`
	PeriodStart string  `json:"periodStart"`
	PeriodEnd   string  `json:"periodEnd"`
	FiledOn     string  `json:"filedOn"`
	ARN         string  `json:"arn"`
	FiledBy     *string `json:"filedBy"`
}

func (s *server) listGSTReturns(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.QueryContext(r.Context(), `SELECT g.id, g.return_type, g.period_start, g.period_end, g.filed_on, g.arn, u.name
		FROM gst_returns g LEFT JOIN users u ON u.id = g.filed_by ORDER BY g.period_start DESC, g.return_type`)
	if err != nil {
		fail(w, err)
		return
	}
	defer rows.Close()
	list := []GSTReturn{}
	for rows.Next() {
		var g GSTReturn
		if err := rows.Scan(&g.ID, &g.ReturnType, &g.PeriodStart, &g.PeriodEnd, &g.FiledOn, &g.ARN, &g.FiledBy); err != nil {
			fail(w, err)
			return
		}
		list = append(list, g)
	}
	writeJSON(w, http.StatusOK, list)
}

// POST /api/gst/returns {"returnType", "periodStart", "periodEnd", "filedOn", "arn"}
func (s *server) markGSTReturnFiled(w http.ResponseWriter, r *http.Request) {
	var g GSTReturn
	if err := decodeJSON(w, r, &g); err != nil {
		fail(w, err)
		return
	}
	g.ARN = strings.ToUpper(strings.TrimSpace(g.ARN))
	switch {
	case g.ReturnType != "GSTR1" && g.ReturnType != "GSTR3B":
		fail(w, badRequest("Choose GSTR-1 or GSTR-3B."))
		return
	case !validDate(g.PeriodStart) || !validDate(g.PeriodEnd) || g.PeriodStart > g.PeriodEnd:
		fail(w, badRequest("Choose a valid period."))
		return
	case !validDate(g.FiledOn):
		fail(w, badRequest("Enter the date you filed."))
		return
	case len(g.ARN) > 30:
		fail(w, badRequest("The ARN is too long."))
		return
	}
	_, err := s.db.ExecContext(r.Context(), `INSERT INTO gst_returns (return_type, period_start, period_end, filed_on, arn, filed_by)
		VALUES (?, ?, ?, ?, ?, ?)`, g.ReturnType, g.PeriodStart, g.PeriodEnd, g.FiledOn, g.ARN, currentUserID(r))
	if isDuplicate(err) {
		fail(w, conflict("This return is already marked as filed."))
		return
	} else if err != nil {
		fail(w, err)
		return
	}
	s.listGSTReturns(w, r)
}

func (s *server) unmarkGSTReturn(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `DELETE FROM gst_returns WHERE id = ?`, id); err != nil {
		fail(w, err)
		return
	}
	s.listGSTReturns(w, r)
}

// periodOpen blocks changes to invoices and credit notes dated in a period
// whose GSTR-1 is marked as filed, so filed figures can't drift.
func (s *server) periodOpen(ctx context.Context, what, date string) error {
	if !validDate(date) {
		return nil
	}
	var start, end string
	err := s.db.QueryRowContext(ctx, `SELECT period_start, period_end FROM gst_returns WHERE return_type = 'GSTR1'
		AND ? BETWEEN period_start AND period_end LIMIT 1`, date).Scan(&start, &end)
	if err != nil {
		return nil // not filed (or can't tell): allow
	}
	return conflict(fmt.Sprintf("GSTR-1 for %s to %s is marked as filed, so this %s can't change. Unmark it on the GST filing page first, or issue a credit note in the current period.",
		dateText(start), dateText(end), what))
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n - len("…")
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return strings.TrimSpace(s[:cut]) + "…"
}
