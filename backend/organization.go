package main

import (
	"context"
	"net/http"
	"net/mail"
	"strings"
)

type Organization struct {
	Name              string `json:"name"`
	GSTRegistered     bool   `json:"gstRegistered"`
	GSTIN             string `json:"gstin"`
	StateCode         string `json:"stateCode"`
	Address           string `json:"address"`
	City              string `json:"city"`
	Pincode           string `json:"pincode"`
	Email             string `json:"email"`
	Phone             string `json:"phone"`
	BankName          string `json:"bankName"`
	BankAccountNumber string `json:"bankAccountNumber"`
	BankIFSC          string `json:"bankIfsc"`
	UPIID             string `json:"upiId"`
	InvoicePrefix     string `json:"invoicePrefix"`
	NextInvoiceNumber int    `json:"nextInvoiceNumber"`
	PaymentPrefix     string `json:"paymentPrefix"`
	NextPaymentNumber int    `json:"nextPaymentNumber"`
	QuotePrefix       string `json:"quotePrefix"`
	NextQuoteNumber   int    `json:"nextQuoteNumber"`
	ChallanPrefix     string `json:"challanPrefix"`
	NextChallanNumber int    `json:"nextChallanNumber"`
	CreditPrefix      string `json:"creditPrefix"`
	NextCreditNumber  int    `json:"nextCreditNumber"`
	PaymentTermsDays  int    `json:"paymentTermsDays"`
	QuoteValidityDays int    `json:"quoteValidityDays"`
	InvoiceNotes      string `json:"invoiceNotes"`
	InvoiceTerms      string `json:"invoiceTerms"`
	QuoteNotes        string `json:"quoteNotes"`
	QuoteTerms        string `json:"quoteTerms"`
	// Email sending (SMTP). The password is write-only: it's never sent back
	// to the browser, and leaving it blank when saving keeps the stored one.
	SMTPHost        string `json:"smtpHost"`
	SMTPPort        int    `json:"smtpPort"`
	SMTPUsername    string `json:"smtpUsername"`
	SMTPPassword    string `json:"smtpPassword"`
	SMTPPasswordSet bool   `json:"smtpPasswordSet"`
	SMTPFromEmail   string `json:"smtpFromEmail"`
	SMTPFromName    string `json:"smtpFromName"`
	GSTFilingFrequency string `json:"gstFilingFrequency"` // monthly | quarterly
}

const orgColumns = `name, gst_registered, gstin, state_code, address, city, pincode, email, phone,
	bank_name, bank_account_number, bank_ifsc, upi_id, invoice_prefix, next_invoice_number,
	payment_prefix, next_payment_number, quote_prefix, next_quote_number, challan_prefix, next_challan_number,
	credit_prefix, next_credit_number, payment_terms_days, quote_validity_days, invoice_notes, invoice_terms,
	quote_notes, quote_terms, smtp_host, smtp_port, smtp_username, smtp_password, smtp_from_email, smtp_from_name, gst_filing_frequency`

func (o *Organization) fields() []any {
	return []any{&o.Name, &o.GSTRegistered, &o.GSTIN, &o.StateCode, &o.Address, &o.City, &o.Pincode, &o.Email, &o.Phone,
		&o.BankName, &o.BankAccountNumber, &o.BankIFSC, &o.UPIID, &o.InvoicePrefix, &o.NextInvoiceNumber,
		&o.PaymentPrefix, &o.NextPaymentNumber, &o.QuotePrefix, &o.NextQuoteNumber, &o.ChallanPrefix, &o.NextChallanNumber,
		&o.CreditPrefix, &o.NextCreditNumber, &o.PaymentTermsDays, &o.QuoteValidityDays, &o.InvoiceNotes, &o.InvoiceTerms,
		&o.QuoteNotes, &o.QuoteTerms, &o.SMTPHost, &o.SMTPPort, &o.SMTPUsername, &o.SMTPPassword, &o.SMTPFromEmail, &o.SMTPFromName, &o.GSTFilingFrequency}
}

// loadOrganization includes the SMTP password; only use it inside the server.
func (s *server) loadOrganization(ctx context.Context) (Organization, error) {
	var o Organization
	err := s.db.QueryRowContext(ctx, `SELECT `+orgColumns+` FROM organization WHERE id = 1`).Scan(o.fields()...)
	o.SMTPPasswordSet = o.SMTPPassword != ""
	return o, err
}

func (o Organization) public() Organization {
	o.SMTPPassword = ""
	return o
}

func (o Organization) emailReady() bool {
	return o.SMTPHost != "" && o.SMTPFromEmail != ""
}

func (s *server) getOrganization(w http.ResponseWriter, r *http.Request) {
	o, err := s.loadOrganization(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, o.public())
}

func (o *Organization) validate() error {
	o.Name = strings.TrimSpace(o.Name)
	o.GSTIN = strings.ToUpper(strings.TrimSpace(o.GSTIN))
	o.Email = strings.TrimSpace(o.Email)
	o.BankIFSC = strings.ToUpper(strings.TrimSpace(o.BankIFSC))
	o.Pincode = strings.TrimSpace(o.Pincode)
	o.UPIID = strings.TrimSpace(o.UPIID)
	o.SMTPHost = strings.TrimSpace(o.SMTPHost)
	o.SMTPUsername = strings.TrimSpace(o.SMTPUsername)
	o.SMTPFromEmail = strings.TrimSpace(o.SMTPFromEmail)
	for _, p := range []*string{&o.InvoicePrefix, &o.PaymentPrefix, &o.QuotePrefix, &o.ChallanPrefix, &o.CreditPrefix} {
		*p = strings.TrimSpace(*p)
		if *p == "" || len(*p) > 10 {
			return badRequest("Number prefixes must be 1 to 10 characters, like INV-.")
		}
	}

	switch {
	case o.Name == "":
		return badRequest("Enter your business name.")
	case len(o.Name) > 255:
		return badRequest("Business name must be 255 characters or fewer.")
	case !validState(o.StateCode) || o.StateCode == overseasState:
		return badRequest("Choose the state your business is registered in. It decides whether CGST + SGST or IGST applies.")
	}
	if o.GSTRegistered {
		if !validGSTIN(o.GSTIN) {
			return badRequest("That GSTIN isn't valid. It should be 15 characters, like 33ABCDE1234F1Z5.")
		}
		if o.GSTIN[:2] != o.StateCode {
			return badRequest("Your GSTIN starts with state code " + o.GSTIN[:2] + ", which doesn't match the state you chose.")
		}
	} else {
		o.GSTIN = ""
	}
	if o.Email != "" {
		if _, err := mail.ParseAddress(o.Email); err != nil {
			return badRequest("Business email isn't a valid email address.")
		}
	}
	if o.Pincode != "" && !pincodePattern.MatchString(o.Pincode) {
		return badRequest("PIN code must be 6 digits.")
	}
	if o.BankIFSC != "" && !ifscPattern.MatchString(o.BankIFSC) {
		return badRequest("IFSC must be 11 characters, like HDFC0001234.")
	}
	if o.UPIID != "" && !strings.Contains(o.UPIID, "@") {
		return badRequest("A UPI ID looks like yourname@okhdfcbank.")
	}
	if o.NextInvoiceNumber < 1 || o.NextPaymentNumber < 1 || o.NextQuoteNumber < 1 || o.NextChallanNumber < 1 || o.NextCreditNumber < 1 {
		return badRequest("Next numbers must be 1 or more.")
	}
	if o.PaymentTermsDays < 0 || o.PaymentTermsDays > 365 || o.QuoteValidityDays < 0 || o.QuoteValidityDays > 365 {
		return badRequest("Payment terms and quote validity must be between 0 and 365 days.")
	}
	if len(o.Address) > 500 || len(o.InvoiceNotes) > 1000 || len(o.InvoiceTerms) > 2000 || len(o.QuoteNotes) > 1000 || len(o.QuoteTerms) > 2000 {
		return badRequest("Address, notes, or terms are too long.")
	}
	if o.GSTFilingFrequency != "monthly" && o.GSTFilingFrequency != "quarterly" {
		return badRequest("Choose whether you file GST returns monthly or quarterly.")
	}
	if o.SMTPHost != "" {
		if o.SMTPPort < 1 || o.SMTPPort > 65535 {
			return badRequest("Email server port must be a number like 587 or 465.")
		}
		if _, err := mail.ParseAddress(o.SMTPFromEmail); err != nil {
			return badRequest("Enter the email address your emails are sent from.")
		}
	}
	return nil
}

func (s *server) updateOrganization(w http.ResponseWriter, r *http.Request) {
	if !requireOwner(w, r) {
		return
	}
	var o Organization
	if err := decodeJSON(w, r, &o); err != nil {
		fail(w, err)
		return
	}
	if err := o.validate(); err != nil {
		fail(w, err)
		return
	}
	ctx := r.Context()
	if o.SMTPPassword == "" { // blank means "keep the saved password"
		current, err := s.loadOrganization(ctx)
		if err != nil {
			fail(w, err)
			return
		}
		o.SMTPPassword = current.SMTPPassword
	}
	if o.SMTPHost == "" {
		o.SMTPPassword = "" // email turned off: forget the password
	}
	sets := strings.Split(strings.Join(strings.Fields(orgColumns), " "), ",")
	for i := range sets {
		sets[i] = strings.TrimSpace(sets[i]) + " = ?"
	}
	args := []any{}
	for _, f := range o.fields() {
		switch v := f.(type) {
		case *string:
			args = append(args, *v)
		case *int:
			args = append(args, *v)
		case *bool:
			args = append(args, *v)
		}
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE organization SET `+strings.Join(sets, ", ")+` WHERE id = 1`, args...); err != nil {
		fail(w, err)
		return
	}
	s.getOrganization(w, r)
}
