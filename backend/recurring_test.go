package main

import (
	"testing"
	"time"
)

func TestOccurrenceDates(t *testing.T) {
	d := func(s string) time.Time { t, _ := time.Parse(dateLayout, s); return t }
	cases := []struct {
		start, freq string
		n           int
		want        string
	}{
		{"2026-01-31", "monthly", 1, "2026-02-28"}, // short month: last day, not 3 March
		{"2026-01-31", "monthly", 2, "2026-03-31"}, // back to the 31st afterwards
		{"2028-01-31", "monthly", 1, "2028-02-29"}, // leap year
		{"2026-11-15", "quarterly", 1, "2027-02-15"},
		{"2026-08-31", "half_yearly", 1, "2027-02-28"},
		{"2026-09-25", "weekly", 3, "2026-10-16"},
		{"2026-09-25", "yearly", 2, "2028-09-25"},
	}
	for _, c := range cases {
		if got := occurrenceDate(d(c.start), c.freq, c.n).Format(dateLayout); got != c.want {
			t.Errorf("%s %s #%d: got %s, want %s", c.start, c.freq, c.n, got, c.want)
		}
	}
}

func TestAmountInWords(t *testing.T) {
	cases := map[Dec2]string{
		4779000:    "Rupees Forty-Seven Thousand Seven Hundred Ninety Only",
		10777500:   "Rupees One Lakh Seven Thousand Seven Hundred Seventy-Five Only",
		1250000050: "Rupees One Crore Twenty-Five Lakh and Fifty Paise Only",
		0:          "Rupees Zero Only",
	}
	for in, want := range cases {
		if got := amountInWords(in); got != want {
			t.Errorf("%d: got %q, want %q", in, got, want)
		}
	}
}

func TestUPILink(t *testing.T) {
	got := upiLink("nila@okhdfcbank", "Nila Studio", 4779000, "Invoice INV-0008")
	want := "upi://pay?pa=nila@okhdfcbank&pn=Nila%20Studio&am=47790.00&cu=INR&tn=Invoice%20INV-0008"
	if got != want {
		t.Errorf("got %s", got)
	}
}
