package main

import (
	"net/http"
	"regexp"
	"strings"
)

type state struct {
	Code string `json:"code"`
	Name string `json:"name"`
}

// GST state codes (the first two digits of a GSTIN). 96 is used as the
// place of supply for customers outside India.
var states = []state{
	{"35", "Andaman and Nicobar Islands"}, {"37", "Andhra Pradesh"}, {"12", "Arunachal Pradesh"},
	{"18", "Assam"}, {"10", "Bihar"}, {"04", "Chandigarh"}, {"22", "Chhattisgarh"},
	{"26", "Dadra and Nagar Haveli and Daman and Diu"}, {"07", "Delhi"}, {"30", "Goa"},
	{"24", "Gujarat"}, {"06", "Haryana"}, {"02", "Himachal Pradesh"}, {"01", "Jammu and Kashmir"},
	{"20", "Jharkhand"}, {"29", "Karnataka"}, {"32", "Kerala"}, {"38", "Ladakh"},
	{"31", "Lakshadweep"}, {"23", "Madhya Pradesh"}, {"27", "Maharashtra"}, {"14", "Manipur"},
	{"17", "Meghalaya"}, {"15", "Mizoram"}, {"13", "Nagaland"}, {"21", "Odisha"},
	{"34", "Puducherry"}, {"03", "Punjab"}, {"08", "Rajasthan"}, {"11", "Sikkim"},
	{"33", "Tamil Nadu"}, {"36", "Telangana"}, {"16", "Tripura"}, {"09", "Uttar Pradesh"},
	{"05", "Uttarakhand"}, {"19", "West Bengal"}, {"97", "Other Territory"},
	{"96", "Outside India"},
}

const overseasState = "96"

func validState(code string) bool {
	for _, s := range states {
		if s.Code == code {
			return true
		}
	}
	return false
}

// GST rates offered in the app. The main slabs since 22 September 2025 are
// 0, 5, 18 and 40%; 0.25% and 3% cover precious stones and metals, and 28%
// remains for a few residual goods. Any rate from 0 to 100 is still accepted.
var gstRates = []float64{0, 0.25, 3, 5, 18, 28, 40}

var units = []string{"nos", "pcs", "hrs", "days", "months", "kg", "g", "ltr", "m", "sqft", "box", "set", "pack"}

var paymentModes = []map[string]string{
	{"value": "bank_transfer", "label": "Bank transfer"},
	{"value": "upi", "label": "UPI"},
	{"value": "cash", "label": "Cash"},
	{"value": "cheque", "label": "Cheque"},
	{"value": "card", "label": "Card"},
	{"value": "other", "label": "Other"},
}

func validPaymentMode(m string) bool {
	for _, pm := range paymentModes {
		if pm["value"] == m {
			return true
		}
	}
	return false
}

// GET /api/meta: reference lists the frontend uses for dropdowns.
func (s *server) meta(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"states":        states,
		"gstRates":      gstRates,
		"units":         units,
		"paymentModes":  paymentModes,
		"challanTypes":  challanTypes,
		"creditReasons": creditReasons,
	})
}

var gstinPattern = regexp.MustCompile(`^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$`)

// validGSTIN checks the format and the check digit (the 15th character).
func validGSTIN(g string) bool {
	if !gstinPattern.MatchString(g) || !validState(g[:2]) {
		return false
	}
	const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	sum := 0
	for i := 0; i < 14; i++ {
		v := strings.IndexByte(chars, g[i])
		factor := 1
		if i%2 == 1 {
			factor = 2
		}
		p := v * factor
		sum += p/36 + p%36
	}
	check := chars[(36-sum%36)%36]
	return g[14] == check
}

var (
	pincodePattern = regexp.MustCompile(`^[1-9][0-9]{5}$`)
	ifscPattern    = regexp.MustCompile(`^[A-Z]{4}0[A-Z0-9]{6}$`)
	hsnPattern     = regexp.MustCompile(`^([0-9]{4}|[0-9]{6}|[0-9]{8})$`)
)
