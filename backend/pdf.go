package main

import (
	"bytes"
	_ "embed"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/go-pdf/fpdf"
	"rsc.io/qr"
)

// DejaVu Sans has the ₹ sign and is free to redistribute (see fonts/LICENSE-DejaVu.txt).
//
//go:embed fonts/DejaVuSans.ttf
var fontRegular []byte

//go:embed fonts/DejaVuSans-Bold.ttf
var fontBold []byte

// printable is everything a PDF needs, whatever the document type.
type printable struct {
	Title, Number, FileName                                    string
	Meta                                                       [][2]string
	PartyLabel                                                 string
	CustomerName, BillingAddress, CustomerGSTIN, CustomerEmail string
	Lines                                                      []InvoiceLine
	Subtotal, Discount, CGST, SGST, IGST, Total                Dec2
	After                                                      [][2]string // rows after the total, e.g. Paid, Balance due
	Notes, Terms                                               string
	ShowPayment                                                bool // print bank and UPI details
	UPIAmount                                                  Dec2 // > 0 adds a "scan to pay" QR code
	UPINote                                                    string
	Watermark                                                  string
}

func placeOfSupplyText(code string) string {
	if n := stateName(code); n != "" {
		return fmt.Sprintf("%s (%s)", n, code)
	}
	return ""
}

func dateText(iso string) string {
	if len(iso) < 10 {
		return iso
	}
	months := []string{"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"}
	var y, m, d int
	fmt.Sscanf(iso[:10], "%d-%d-%d", &y, &m, &d)
	if m < 1 || m > 12 {
		return iso
	}
	return fmt.Sprintf("%d %s %d", d, months[m-1], y)
}

func optionLabel(v string, opts []map[string]string) string {
	for _, o := range opts {
		if o["value"] == v {
			return o["label"]
		}
	}
	return v
}

func invoicePrintable(inv Invoice, org Organization) printable {
	p := printable{Title: "INVOICE", Number: inv.InvoiceNumber, FileName: inv.InvoiceNumber + ".pdf", PartyLabel: "Bill to",
		CustomerName: inv.CustomerName, BillingAddress: inv.BillingAddress, CustomerGSTIN: inv.CustomerGSTIN,
		CustomerEmail: inv.CustomerEmail, Lines: inv.Lines, Subtotal: inv.Subtotal, Discount: inv.DiscountTotal,
		CGST: inv.CGSTTotal, SGST: inv.SGSTTotal, IGST: inv.IGSTTotal, Total: inv.Total, Notes: inv.Notes, Terms: inv.Terms,
		ShowPayment: true}
	if org.GSTRegistered {
		p.Title = "TAX INVOICE"
	}
	p.Meta = [][2]string{{"Invoice no.", inv.InvoiceNumber}, {"Date", dateText(inv.IssueDate)}, {"Due date", dateText(inv.DueDate)}}
	if inv.Reference != "" {
		p.Meta = append(p.Meta, [2]string{"Reference", inv.Reference})
	}
	if pos := placeOfSupplyText(inv.PlaceOfSupply); pos != "" {
		p.Meta = append(p.Meta, [2]string{"Place of supply", pos})
	}
	if inv.Paid > 0 {
		p.After = append(p.After, [2]string{"Paid", "−" + inv.Paid.Rupees()})
	}
	if inv.Credited > 0 {
		p.After = append(p.After, [2]string{"Credits applied", "−" + inv.Credited.Rupees()})
	}
	if inv.Paid+inv.Credited > 0 {
		p.After = append(p.After, [2]string{"Balance due", inv.Balance.Rupees()})
	}
	if inv.Lifecycle == "void" {
		p.Watermark = "VOID"
	} else if inv.Balance > 0 {
		p.UPIAmount = inv.Balance
		p.UPINote = "Invoice " + inv.InvoiceNumber
	}
	return p
}

func documentPrintable(d Document, org Organization) printable {
	p := printable{Number: d.Number, FileName: d.Number + ".pdf", PartyLabel: "Bill to", CustomerName: d.CustomerName,
		BillingAddress: d.BillingAddress, CustomerGSTIN: d.CustomerGSTIN, CustomerEmail: d.CustomerEmail, Lines: d.Lines,
		Subtotal: d.Subtotal, Discount: d.DiscountTotal, CGST: d.CGSTTotal, SGST: d.SGSTTotal, IGST: d.IGSTTotal,
		Total: d.Total, Notes: d.Notes, Terms: d.Terms}
	switch d.Type {
	case "quote":
		p.Title = "QUOTATION"
		p.Meta = [][2]string{{"Quote no.", d.Number}, {"Date", dateText(d.IssueDate)}}
		if d.ExpiryDate != nil {
			p.Meta = append(p.Meta, [2]string{"Valid until", dateText(*d.ExpiryDate)})
		}
		if d.Status == "declined" {
			p.Watermark = "DECLINED"
		}
	case "challan":
		p.Title = "DELIVERY CHALLAN"
		p.PartyLabel = "Deliver to"
		p.Meta = [][2]string{{"Challan no.", d.Number}, {"Date", dateText(d.IssueDate)}, {"Challan type", optionLabel(d.ChallanType, challanTypes)}}
		if d.Status == "cancelled" {
			p.Watermark = "CANCELLED"
		}
	case "credit_note":
		p.Title = "CREDIT NOTE"
		p.Meta = [][2]string{{"Credit note no.", d.Number}, {"Date", dateText(d.IssueDate)}}
		if d.InvoiceNumber != nil {
			against := *d.InvoiceNumber
			if d.InvoiceDate != nil {
				against += " (" + dateText(*d.InvoiceDate) + ")"
			}
			p.Meta = append(p.Meta, [2]string{"Against invoice", against})
		}
		p.Meta = append(p.Meta, [2]string{"Reason", optionLabel(d.Reason, creditReasons)})
		if d.Status == "void" {
			p.Watermark = "VOID"
		}
	}
	if d.Reference != "" {
		p.Meta = append(p.Meta, [2]string{"Reference", d.Reference})
	}
	if pos := placeOfSupplyText(d.PlaceOfSupply); pos != "" {
		p.Meta = append(p.Meta, [2]string{"Place of supply", pos})
	}
	return p
}

// upiLink builds a UPI payment link (NPCI format) that any UPI app can open.
func upiLink(vpa, payee string, amount Dec2, note string) string {
	esc := func(s string) string {
		return strings.ReplaceAll(strings.ReplaceAll(url.QueryEscape(s), "%40", "@"), "+", "%20")
	}
	return fmt.Sprintf("upi://pay?pa=%s&pn=%s&am=%s&cu=INR&tn=%s", esc(vpa), esc(payee), amount.String(), esc(note))
}

func upiQRPNG(vpa, payee string, amount Dec2, note string) ([]byte, error) {
	code, err := qr.Encode(upiLink(vpa, payee, amount, note), qr.M)
	if err != nil {
		return nil, err
	}
	return code.PNG(), nil
}

// renderPDF lays out an A4 PDF that matches the on-screen document.
func renderPDF(org Organization, p printable) ([]byte, error) {
	const (
		left, right, width = 15.0, 195.0, 180.0
		font               = "dv"
	)
	pdf := fpdf.New("P", "mm", "A4", "")
	pdf.AddUTF8FontFromBytes(font, "", fontRegular)
	pdf.AddUTF8FontFromBytes(font, "B", fontBold)
	pdf.SetMargins(left, 15, 15)
	pdf.SetAutoPageBreak(true, 18)
	pdf.AliasNbPages("{nb}")
	pdf.SetTitle(p.Title+" "+p.Number, true)
	pdf.SetCreator("Averqo", true)

	ink := func() { pdf.SetTextColor(17, 26, 46) }
	grey := func() { pdf.SetTextColor(110, 120, 145) }
	pdf.SetFooterFunc(func() {
		pdf.SetY(-12)
		pdf.SetFont(font, "", 7.5)
		grey()
		pdf.CellFormat(width/2, 5, p.Title+" "+p.Number, "", 0, "L", false, 0, "")
		pdf.CellFormat(width/2, 5, fmt.Sprintf("Page %d of {nb}", pdf.PageNo()), "", 0, "R", false, 0, "")
	})
	pdf.AddPage()

	if p.Watermark != "" {
		pdf.SetFont(font, "B", 60)
		pdf.SetTextColor(240, 190, 192)
		pdf.TransformBegin()
		pdf.TransformRotate(30, 105, 150)
		pdf.Text(55, 160, p.Watermark)
		pdf.TransformEnd()
	}

	// Header: business on the left, document title and details on the right.
	top := pdf.GetY()
	pdf.SetFont(font, "B", 15)
	ink()
	pdf.CellFormat(100, 7, orDefault(org.Name, "Your business"), "", 1, "L", false, 0, "")
	pdf.SetFont(font, "", 9)
	var fromLines []string
	if org.Address != "" {
		fromLines = append(fromLines, strings.Split(org.Address, "\n")...)
	}
	place := strings.TrimSpace(strings.Join(nonEmpty(strings.TrimSpace(org.City+" "+org.Pincode), stateName(org.StateCode)), ", "))
	if place != "" {
		fromLines = append(fromLines, place)
	}
	if org.GSTIN != "" {
		fromLines = append(fromLines, "GSTIN "+org.GSTIN)
	}
	if contact := strings.Join(nonEmpty(org.Email, org.Phone), " · "); contact != "" {
		fromLines = append(fromLines, contact)
	}
	for _, l := range fromLines {
		pdf.CellFormat(100, 4.6, l, "", 1, "L", false, 0, "")
	}
	leftBottom := pdf.GetY()

	pdf.SetXY(110, top)
	pdf.SetFont(font, "B", 15)
	pdf.SetTextColor(15, 30, 61)
	pdf.CellFormat(85, 7, p.Title, "", 1, "R", false, 0, "")
	pdf.SetFont(font, "", 9)
	for _, m := range p.Meta {
		pdf.SetX(110)
		grey()
		pdf.CellFormat(35, 5, m[0], "", 0, "L", false, 0, "")
		ink()
		pdf.SetFont(font, "B", 9)
		pdf.CellFormat(50, 5, m[1], "", 1, "R", false, 0, "")
		pdf.SetFont(font, "", 9)
	}
	y := max(leftBottom, pdf.GetY()) + 3
	pdf.SetDrawColor(15, 30, 61)
	pdf.SetLineWidth(0.6)
	pdf.Line(left, y, right, y)
	pdf.SetLineWidth(0.2)

	// Customer.
	pdf.SetXY(left, y+4)
	pdf.SetFont(font, "B", 7.5)
	grey()
	pdf.CellFormat(width, 4, strings.ToUpper(p.PartyLabel), "", 1, "L", false, 0, "")
	pdf.SetFont(font, "B", 10)
	ink()
	pdf.CellFormat(width, 5.5, p.CustomerName, "", 1, "L", false, 0, "")
	pdf.SetFont(font, "", 9)
	for _, l := range strings.Split(p.BillingAddress, "\n") {
		if strings.TrimSpace(l) != "" {
			pdf.CellFormat(width, 4.6, l, "", 1, "L", false, 0, "")
		}
	}
	if p.CustomerGSTIN != "" {
		pdf.CellFormat(width, 4.6, "GSTIN "+p.CustomerGSTIN, "", 1, "L", false, 0, "")
	}
	pdf.Ln(4)

	// Lines table. Columns that would be empty for every line are dropped.
	hasDisc := p.Discount > 0
	hasTax := p.CGST+p.SGST+p.IGST > 0
	type col struct {
		title string
		w     float64
		align string
	}
	cols := []col{{"#", 8, "L"}, {"Item", 0, "L"}, {"HSN/SAC", 20, "L"}, {"Qty", 20, "R"}, {"Rate", 26, "R"}}
	if hasDisc {
		cols = append(cols, col{"Disc", 13, "R"})
	}
	if hasTax {
		cols = append(cols, col{"GST", 13, "R"})
	}
	cols = append(cols, col{"Taxable value", 28, "R"})
	used := 0.0
	for _, c := range cols {
		used += c.w
	}
	cols[1].w = width - used

	header := func() {
		pdf.SetFillColor(15, 30, 61)
		pdf.SetTextColor(255, 255, 255)
		pdf.SetFont(font, "B", 8)
		for _, c := range cols {
			pdf.CellFormat(c.w, 7, " "+c.title+" ", "", 0, c.align, true, 0, "")
		}
		pdf.Ln(-1)
		ink()
		pdf.SetFont(font, "", 8.5)
	}
	header()
	pdf.SetDrawColor(227, 232, 242)
	for i, l := range p.Lines {
		desc := pdf.SplitText(l.Description, cols[1].w-2)
		h := float64(max(1, len(desc)))*4.3 + 2.6
		if pdf.GetY()+h > 297-22 {
			pdf.AddPage()
			header()
		}
		x, rowY := pdf.GetX(), pdf.GetY()
		cells := []string{fmt.Sprint(i + 1), "", orDefault(l.HSNSAC, "—"), strings.TrimSpace(trimZeros(l.Quantity) + " " + l.Unit), l.Rate.Rupees()}
		if hasDisc {
			cells = append(cells, pctText(l.DiscountPct))
		}
		if hasTax {
			cells = append(cells, trimZeros(l.TaxRate)+"%")
		}
		cells = append(cells, l.TaxableAmount.Rupees())
		cx := x
		for ci, c := range cols {
			pdf.SetXY(cx, rowY+1.3)
			if ci == 1 {
				for li, dl := range desc {
					pdf.SetXY(cx+1, rowY+1.3+float64(li)*4.3)
					pdf.CellFormat(c.w-2, 4.3, dl, "", 0, "L", false, 0, "")
				}
			} else {
				pdf.CellFormat(c.w, 4.3, " "+cells[ci]+" ", "", 0, c.align, false, 0, "")
			}
			cx += c.w
		}
		pdf.Line(left, rowY+h, right, rowY+h)
		pdf.SetXY(left, rowY+h)
	}
	pdf.Ln(4)

	// Totals on the right, amount in words on the left.
	type row struct {
		label, value string
		bold         bool
	}
	rows := []row{{"Taxable value", p.Subtotal.Rupees(), false}}
	for _, g := range taxGroups(p.Lines) {
		if g.igst > 0 {
			rows = append(rows, row{"IGST " + trimZeros(g.rate) + "%", g.igst.Rupees(), false})
		} else {
			half := trimZeros(g.rate / 2)
			rows = append(rows, row{"CGST " + half + "%", g.cgst.Rupees(), false}, row{"SGST " + half + "%", g.sgst.Rupees(), false})
		}
	}
	rows = append(rows, row{"Total", p.Total.Rupees(), true})
	for i, a := range p.After {
		rows = append(rows, row{a[0], a[1], i == len(p.After)-1})
	}
	need := float64(len(rows))*6 + 8
	if pdf.GetY()+need > 297-22 {
		pdf.AddPage()
	}
	startY := pdf.GetY()
	pdf.SetXY(left, startY)
	pdf.SetFont(font, "B", 7.5)
	grey()
	pdf.CellFormat(95, 4, "AMOUNT IN WORDS", "", 1, "L", false, 0, "")
	pdf.SetFont(font, "", 9)
	ink()
	pdf.MultiCell(95, 4.6, amountInWords(p.Total), "", "L", false)
	wordsBottom := pdf.GetY()

	pdf.SetY(startY)
	for _, r := range rows {
		pdf.SetX(125)
		if r.bold {
			pdf.Line(125, pdf.GetY()+0.5, right, pdf.GetY()+0.5)
			pdf.SetFont(font, "B", 10.5)
			ink()
			pdf.CellFormat(35, 7.5, r.label, "", 0, "L", false, 0, "")
			pdf.CellFormat(35, 7.5, r.value, "", 1, "R", false, 0, "")
		} else {
			pdf.SetFont(font, "", 9)
			grey()
			pdf.CellFormat(35, 5.6, r.label, "", 0, "L", false, 0, "")
			ink()
			pdf.CellFormat(35, 5.6, r.value, "", 1, "R", false, 0, "")
		}
	}
	y = max(wordsBottom, pdf.GetY()) + 5

	// How to pay (invoices), notes, terms, signature.
	var qrPNG []byte
	if p.ShowPayment && org.UPIID != "" && p.UPIAmount > 0 {
		qrPNG, _ = upiQRPNG(org.UPIID, org.Name, p.UPIAmount, p.UPINote)
	}
	if pdf.GetY()+50 > 297-22 {
		pdf.AddPage()
		y = pdf.GetY()
	}
	pdf.SetDrawColor(227, 232, 242)
	pdf.Line(left, y, right, y)
	pdf.SetXY(left, y+4)
	textW := width
	if qrPNG != nil {
		textW = width - 36
		pdf.RegisterImageOptionsReader("upi", fpdf.ImageOptions{ImageType: "PNG"}, bytes.NewReader(qrPNG))
		pdf.ImageOptions("upi", right-30, y+4, 30, 30, false, fpdf.ImageOptions{ImageType: "PNG"}, 0, "")
		pdf.SetXY(right-34, y+34.5)
		pdf.SetFont(font, "", 7)
		grey()
		pdf.CellFormat(38, 3.5, "Scan to pay with any UPI app", "", 0, "C", false, 0, "")
		pdf.SetXY(left, y+4)
	}
	section := func(title, body string) {
		if strings.TrimSpace(body) == "" {
			return
		}
		pdf.SetX(left)
		pdf.SetFont(font, "B", 7.5)
		grey()
		pdf.CellFormat(textW, 4, strings.ToUpper(title), "", 1, "L", false, 0, "")
		pdf.SetFont(font, "", 8.5)
		ink()
		pdf.MultiCell(textW, 4.3, body, "", "L", false)
		pdf.Ln(2)
	}
	if p.ShowPayment {
		var pay []string
		if org.BankAccountNumber != "" {
			pay = append(pay, strings.Join(nonEmpty(org.BankName, "A/c "+org.BankAccountNumber, prefixIf("IFSC ", org.BankIFSC)), " · "))
		}
		if org.UPIID != "" {
			pay = append(pay, "UPI: "+org.UPIID)
		}
		section("How to pay", strings.Join(pay, "\n"))
	}
	section("Notes", p.Notes)
	section("Terms and conditions", p.Terms)
	if qrPNG != nil && pdf.GetY() < y+40 {
		pdf.SetY(y + 40)
	}
	if pdf.GetY()+22 > 297-22 {
		pdf.AddPage()
	}
	pdf.Ln(4)
	pdf.SetFont(font, "", 9)
	ink()
	pdf.SetX(125)
	pdf.CellFormat(70, 5, "For "+orDefault(org.Name, "your business"), "", 1, "R", false, 0, "")
	pdf.Ln(12)
	pdf.SetDrawColor(123, 134, 160)
	pdf.Line(140, pdf.GetY(), right, pdf.GetY())
	pdf.SetX(140)
	grey()
	pdf.CellFormat(55, 5, "Authorised signatory", "", 1, "C", false, 0, "")

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

type taxGroup struct {
	rate             Dec2
	cgst, sgst, igst Dec2
}

func taxGroups(lines []InvoiceLine) []taxGroup {
	m := map[Dec2]*taxGroup{}
	for _, l := range lines {
		if l.CGST+l.SGST+l.IGST == 0 {
			continue
		}
		g, ok := m[l.TaxRate]
		if !ok {
			g = &taxGroup{rate: l.TaxRate}
			m[l.TaxRate] = g
		}
		g.cgst += l.CGST
		g.sgst += l.SGST
		g.igst += l.IGST
	}
	out := make([]taxGroup, 0, len(m))
	for _, g := range m {
		out = append(out, *g)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].rate < out[j].rate })
	return out
}

// trimZeros shows 18.00 as "18", 2.50 as "2.5".
func trimZeros(d Dec2) string {
	s := d.String()
	s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	return s
}

func pctText(d Dec2) string {
	if d == 0 {
		return "—"
	}
	return trimZeros(d) + "%"
}

func orDefault(s, fallback string) string {
	if strings.TrimSpace(s) == "" {
		return fallback
	}
	return s
}

func nonEmpty(parts ...string) []string {
	var out []string
	for _, p := range parts {
		if strings.TrimSpace(p) != "" && strings.TrimSpace(p) != "A/c" {
			out = append(out, p)
		}
	}
	return out
}

func prefixIf(prefix, s string) string {
	if s == "" {
		return ""
	}
	return prefix + s
}

func writePDF(w http.ResponseWriter, r *http.Request, name string, data []byte) {
	disposition := "inline"
	if r.URL.Query().Get("download") == "1" {
		disposition = "attachment"
	}
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`%s; filename="%s"`, disposition, name))
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(data)
}

// GET /api/invoices/{id}/pdf[?download=1]
func (s *server) invoicePDF(w http.ResponseWriter, r *http.Request) {
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
	org, err := s.loadOrganization(ctx)
	if err != nil {
		fail(w, err)
		return
	}
	p := invoicePrintable(inv, org)
	data, err := renderPDF(org, p)
	if err != nil {
		fail(w, err)
		return
	}
	writePDF(w, r, p.FileName, data)
}

func (s *server) documentPDF(w http.ResponseWriter, r *http.Request, k docKind) {
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
	org, err := s.loadOrganization(ctx)
	if err != nil {
		fail(w, err)
		return
	}
	p := documentPrintable(d, org)
	data, err := renderPDF(org, p)
	if err != nil {
		fail(w, err)
		return
	}
	writePDF(w, r, p.FileName, data)
}

// GET /api/invoices/{id}/upi-qr.png: a QR code for the balance due.
func (s *server) invoiceUPIQR(w http.ResponseWriter, r *http.Request) {
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
	org, err := s.loadOrganization(ctx)
	if err != nil {
		fail(w, err)
		return
	}
	if org.UPIID == "" || inv.Balance <= 0 || inv.Lifecycle == "void" {
		fail(w, notFound("No UPI QR code: add a UPI ID in Settings, and the invoice must have a balance due."))
		return
	}
	png, err := upiQRPNG(org.UPIID, org.Name, inv.Balance, "Invoice "+inv.InvoiceNumber)
	if err != nil {
		fail(w, err)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(png)
}

// amountInWords: 47790.50 -> "Rupees Forty-Seven Thousand Seven Hundred Ninety and Fifty Paise Only".
func amountInWords(d Dec2) string {
	ones := []string{"", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven",
		"Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"}
	tens := []string{"", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"}
	below100 := func(n int64) string {
		if n < 20 {
			return ones[n]
		}
		if n%10 == 0 {
			return tens[n/10]
		}
		return tens[n/10] + "-" + ones[n%10]
	}
	below1000 := func(n int64) string {
		parts := []string{}
		if n >= 100 {
			parts = append(parts, ones[n/100]+" Hundred")
		}
		if n%100 != 0 {
			parts = append(parts, below100(n%100))
		}
		return strings.Join(parts, " ")
	}
	if d < 0 {
		d = -d
	}
	rupees, paise := int64(d)/100, int64(d)%100
	var parts []string
	crore := rupees / 10_000_000
	rupees %= 10_000_000
	lakh := rupees / 100_000
	rupees %= 100_000
	thousand := rupees / 1000
	rupees %= 1000
	if crore > 0 {
		parts = append(parts, below1000(crore)+" Crore")
	}
	if lakh > 0 {
		parts = append(parts, below100(lakh)+" Lakh")
	}
	if thousand > 0 {
		parts = append(parts, below100(thousand)+" Thousand")
	}
	if rupees > 0 {
		parts = append(parts, below1000(rupees))
	}
	words := "Rupees Zero"
	if len(parts) > 0 {
		words = "Rupees " + strings.Join(parts, " ")
	}
	if paise > 0 {
		words += " and " + below100(paise) + " Paise"
	}
	return words + " Only"
}
