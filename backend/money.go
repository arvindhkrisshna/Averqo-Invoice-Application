package main

import (
	"database/sql/driver"
	"fmt"
	"strconv"
	"strings"
)

// Dec2 is a number with exactly 2 decimal places, stored as hundredths:
// ₹1,234.50 is Dec2(123450), a quantity of 2.5 is Dec2(250), 18% is Dec2(1800).
// Using whole numbers means money math never has floating-point errors.
// It reads and writes MySQL DECIMAL columns and JSON numbers directly.
type Dec2 int64

func (d Dec2) String() string {
	sign := ""
	n := int64(d)
	if n < 0 {
		sign, n = "-", -n
	}
	return fmt.Sprintf("%s%d.%02d", sign, n/100, n%100)
}

func (d Dec2) MarshalJSON() ([]byte, error) { return []byte(d.String()), nil }

func (d *Dec2) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		*d = 0
		return nil
	}
	v, err := parseDec2(s)
	if err != nil {
		return fmt.Errorf("%q is not a number", s)
	}
	*d = v
	return nil
}

func (d *Dec2) Scan(src any) error {
	switch v := src.(type) {
	case nil:
		*d = 0
	case []byte:
		p, err := parseDec2(string(v))
		*d = p
		return err
	case string:
		p, err := parseDec2(v)
		*d = p
		return err
	case int64:
		*d = Dec2(v * 100)
	case float64:
		p, err := parseDec2(strconv.FormatFloat(v, 'f', -1, 64))
		*d = p
		return err
	default:
		return fmt.Errorf("cannot scan %T into Dec2", src)
	}
	return nil
}

func (d Dec2) Value() (driver.Value, error) { return d.String(), nil }

// parseDec2 parses "1234.5", "-3", "0.125" (rounded half up to 0.13) exactly.
func parseDec2(s string) (Dec2, error) {
	s = strings.TrimSpace(s)
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(strings.TrimPrefix(s, "-"), "+")
	if strings.ContainsAny(s, "eE") { // JSON exponent form, e.g. 1e3
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return 0, err
		}
		s = strconv.FormatFloat(f, 'f', -1, 64)
	}
	whole, frac, _ := strings.Cut(s, ".")
	if whole == "" {
		whole = "0"
	}
	w, err := strconv.ParseInt(whole, 10, 64)
	if err != nil || w > 1e15 {
		return 0, fmt.Errorf("invalid number %q", s)
	}
	for _, c := range frac {
		if c < '0' || c > '9' {
			return 0, fmt.Errorf("invalid number %q", s)
		}
	}
	frac += "000"
	f, _ := strconv.ParseInt(frac[:2], 10, 64)
	n := w*100 + f
	if frac[2] >= '5' {
		n++ // round half up on the third decimal
	}
	if neg {
		n = -n
	}
	return Dec2(n), nil
}

// roundDiv divides non-negative a by b, rounding half up (like MySQL ROUND).
func roundDiv(a, b int64) int64 { return (2*a + b) / (2 * b) }

// lineAmounts is the result of pricing one invoice line.
type lineAmounts struct {
	Gross, Discount, Taxable, CGST, SGST, IGST Dec2
}

// calcLine prices one line: quantity × rate, minus the discount %, then GST.
// Same-state sales split GST into CGST + SGST (half each); other-state sales
// charge IGST. The Angular form uses the identical rules for its preview.
func calcLine(qty, rate, discountPct, taxRate Dec2, interState bool) lineAmounts {
	var a lineAmounts
	a.Gross = Dec2(roundDiv(int64(qty)*int64(rate), 100))
	a.Discount = Dec2(roundDiv(int64(a.Gross)*int64(discountPct), 10000))
	a.Taxable = a.Gross - a.Discount
	if interState {
		a.IGST = Dec2(roundDiv(int64(a.Taxable)*int64(taxRate), 10000))
	} else {
		half := Dec2(roundDiv(int64(a.Taxable)*int64(taxRate), 20000))
		a.CGST, a.SGST = half, half
	}
	return a
}

// Rupees formats an amount the Indian way, e.g. ₹12,34,567.50.
func (d Dec2) Rupees() string {
	s := d.String()
	sign := ""
	if strings.HasPrefix(s, "-") {
		sign, s = "-", s[1:]
	}
	whole, frac, _ := strings.Cut(s, ".")
	if len(whole) > 3 {
		head, tail := whole[:len(whole)-3], whole[len(whole)-3:]
		var groups []string
		for len(head) > 2 {
			groups = append([]string{head[len(head)-2:]}, groups...)
			head = head[:len(head)-2]
		}
		if head != "" {
			groups = append([]string{head}, groups...)
		}
		whole = strings.Join(groups, ",") + "," + tail
	}
	return sign + "₹" + whole + "." + frac
}
