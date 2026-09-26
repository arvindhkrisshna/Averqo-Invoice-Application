package main

import (
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

func TestPBKDF2MatchesReference(t *testing.T) {
	// Expected values come from Python's hashlib.pbkdf2_hmac.
	cases := []struct {
		pw, salt string
		rounds, n int
		want      string
	}{
		{"passwd", "salt", 1, 64, "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783"},
		{"correct horse", "averqo-salt", 1000, 32, "449cfc093ef5e3ea8791b774f14987e1e88d1c375b62c31cdadd7ec73cb9dda6"},
	}
	for _, c := range cases {
		if got := hex.EncodeToString(pbkdf2SHA256([]byte(c.pw), []byte(c.salt), c.rounds, c.n)); got != c.want {
			t.Errorf("pbkdf2(%q) = %s, want %s", c.pw, got, c.want)
		}
	}
}

func TestPasswordHashRoundTrip(t *testing.T) {
	h, err := hashPassword("s3cret-pass")
	if err != nil {
		t.Fatal(err)
	}
	if !checkPassword(h, "s3cret-pass") || checkPassword(h, "s3cret-pasS") || checkPassword("garbage", "x") {
		t.Fatal("password check is wrong")
	}
}

func TestSetoffOrder(t *testing.T) {
	// IGST credit pays IGST first, then covers the CGST gap; CGST credit never pays SGST.
	s := computeSetoff(heads{1000_00, 500_00, 500_00}, heads{1300_00, 100_00, 600_00})
	if s.FromIGST.IGST != 1000_00 || s.FromIGST.CGST != 300_00 || s.FromIGST.SGST != 0 {
		t.Fatalf("IGST credit use wrong: %+v", s.FromIGST)
	}
	if s.FromCGST.CGST != 100_00 || s.FromSGST.SGST != 500_00 {
		t.Fatalf("CGST/SGST credit use wrong: %+v %+v", s.FromCGST, s.FromSGST)
	}
	if s.Cash != (heads{0, 100_00, 0}) || s.CreditLeft != (heads{0, 0, 100_00}) {
		t.Fatalf("cash %+v, left %+v", s.Cash, s.CreditLeft)
	}
	// CGST credit can pay IGST once CGST is covered.
	s = computeSetoff(heads{500_00, 100_00, 100_00}, heads{0, 400_00, 0})
	if s.FromCGST.IGST != 300_00 || s.Cash != (heads{200_00, 0, 100_00}) {
		t.Fatalf("cross use wrong: %+v cash %+v", s.FromCGST, s.Cash)
	}
}

func TestExpenseTaxIncludesGST(t *testing.T) {
	// ₹1,180 including 18% GST in the same state: ₹1,000 + ₹90 + ₹90.
	sub, a := expenseTax(1180_00, 1800, true, false)
	if sub != 1000_00 || a.CGST != 90_00 || a.SGST != 90_00 || a.IGST != 0 {
		t.Fatalf("got %v %+v", sub, a)
	}
	// Awkward amounts still add up to the bill exactly.
	for _, amt := range []Dec2{99_99, 1_01, 12345_67, 7} {
		sub, a := expenseTax(amt, 1800, true, true)
		if sub+a.IGST != amt {
			t.Fatalf("%v: %v + %v != bill", amt, sub, a.IGST)
		}
	}
	sub, a = expenseTax(500_00, 500, false, true)
	if sub != 500_00 || a.IGST != 25_00 {
		t.Fatalf("exclusive: %v %+v", sub, a)
	}
}

func TestGSTR1Classification(t *testing.T) {
	big := Dec2(150000_00)
	gst := "29AAACI1234K1ZY"
	lines := []saleLine{
		{DocID: 1, Number: "INV-1", GSTIN: gst, POS: "29", DocTotal: 1180_00, HSN: "998314", Unit: "hrs", Qty: 1000, Rate: 1800, Amt: taxAmt{1000_00, 180_00, 0, 0}},
		{DocID: 2, Number: "INV-2", POS: "29", DocTotal: big, HSN: "8471", Unit: "nos", Qty: 100, Rate: 1800, Amt: taxAmt{127118_64, 22881_36, 0, 0}},
		{DocID: 3, Number: "INV-3", POS: "33", DocTotal: 1050_00, HSN: "8471", Unit: "nos", Qty: 200, Rate: 500, Amt: taxAmt{1000_00, 0, 25_00, 25_00}},
		{DocID: 3, Number: "INV-3", POS: "33", DocTotal: 1050_00, HSN: "0401", Unit: "ltr", Qty: 500, Rate: 0, Amt: taxAmt{200_00, 0, 0, 0}},
		{DocID: 4, Number: "INV-4", POS: "96", Treatment: "overseas", DocTotal: 5000_00, HSN: "998314", Rate: 0, Amt: taxAmt{5000_00, 0, 0, 0}},
		{DocID: 5, Credit: true, Number: "CN-1", POS: "33", DocTotal: 105_00, HSN: "8471", Unit: "nos", Qty: 20, Rate: 500, Amt: taxAmt{100_00, 0, 2_50, 2_50}},
		{DocID: 6, Credit: true, Number: "CN-2", GSTIN: gst, POS: "29", DocTotal: 118_00, HSN: "998314", Rate: 1800, Amt: taxAmt{100_00, 18_00, 0, 0}},
	}
	g := buildGSTR1("33", lines)
	if len(g.B2B) != 1 || len(g.B2CL) != 1 || len(g.EXP) != 1 || len(g.CDNR) != 1 || len(g.CDNUR) != 0 {
		t.Fatalf("sections: b2b %d b2cl %d exp %d cdnr %d cdnur %d", len(g.B2B), len(g.B2CL), len(g.EXP), len(g.CDNR), len(g.CDNUR))
	}
	if g.EXP[0].Type != "WOPAY" {
		t.Fatalf("export type %s", g.EXP[0].Type)
	}
	if len(g.B2CS) != 1 || g.B2CS[0].Taxable != 900_00 || g.B2CS[0].CGST != 22_50 || g.B2CS[0].SupplyType != "INTRA" {
		t.Fatalf("b2cs net of credit note: %+v", g.B2CS)
	}
	if len(g.Nil) != 1 || g.Nil[0].SupplyType != "INTRAB2C" || g.Nil[0].Amount != 200_00 {
		t.Fatalf("nil: %+v", g.Nil)
	}
	for _, h := range g.HSNB2B {
		if h.HSN == "998314" && (h.UQC != "NA" || h.Taxable != 900_00 || h.Qty != 0) {
			t.Fatalf("hsn b2b service: %+v", h)
		}
	}
	if g.Invoices != 4 {
		t.Fatalf("invoices %d", g.Invoices)
	}
}

func TestEmptyGSTR1HasNoNulls(t *testing.T) {
	b, _ := json.Marshal(buildGSTR1("33", nil))
	if strings.Contains(string(b), "null") {
		t.Fatalf("empty GSTR-1 has nulls: %s", b)
	}
}
