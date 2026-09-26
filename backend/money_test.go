package main

import "testing"

// Run with: cd backend && go test ./...

func TestRupees(t *testing.T) {
	cases := map[Dec2]string{
		0: "₹0.00", 5: "₹0.05", 99999: "₹999.99", 123456: "₹1,234.56", 4779000: "₹47,790.00",
		123456750: "₹12,34,567.50", 1000000000: "₹1,00,00,000.00", -150000: "-₹1,500.00",
	}
	for in, want := range cases {
		if got := in.Rupees(); got != want {
			t.Errorf("%d: got %s, want %s", in, got, want)
		}
	}
}

func TestCalcLine(t *testing.T) {
	// 2.5 × ₹1,333.33 at 18%, same state: ₹3,333.33 taxable, ₹300.00 CGST + ₹300.00 SGST
	a := calcLine(250, 133333, 0, 1800, false)
	if a.Taxable != 333333 || a.CGST != 30000 || a.SGST != 30000 || a.IGST != 0 {
		t.Errorf("same-state: %+v", a)
	}
	// 1 × ₹45,000 with 10% off at 18%, other state: ₹40,500 taxable, ₹7,290 IGST
	b := calcLine(100, 4500000, 1000, 1800, true)
	if b.Taxable != 4050000 || b.Discount != 450000 || b.IGST != 729000 || b.CGST != 0 {
		t.Errorf("inter-state: %+v", b)
	}
}

func TestGSTIN(t *testing.T) {
	cases := map[string]bool{
		"27AAPFU0939F1ZV": true,  // published valid example
		"27AAPFU0939F1ZX": false, // wrong check digit
		"33AAACI1234K1ZY": true,
		"99AAACI1234K1ZY": false, // not a state code
		"short":           false,
	}
	for g, ok := range cases {
		if validGSTIN(g) != ok {
			t.Errorf("%s: expected valid=%v", g, ok)
		}
	}
}

func TestParseDec2(t *testing.T) {
	cases := map[string]Dec2{"12.5": 1250, "0.125": 13, "-3": -300, "1e3": 100000, "7": 700}
	for in, want := range cases {
		if got, err := parseDec2(in); err != nil || got != want {
			t.Errorf("%s: got %d (%v), want %d", in, got, err, want)
		}
	}
}
