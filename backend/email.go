package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"net/textproto"
	"strconv"
	"strings"
	"time"
)

// Emails go out through the SMTP server of your own email account (for
// Gmail: smtp.gmail.com, port 587, and an App Password). Nothing is sent
// through Averqo's own servers; there aren't any.

type attachment struct {
	name string
	data []byte
}

func encodeHeader(s string) string { return mime.QEncoding.Encode("utf-8", s) }

// buildEmail makes a plain-text email with optional PDF attachments.
func buildEmail(from mail.Address, to, cc []*mail.Address, subject, body string, files []attachment) ([]byte, error) {
	var msg bytes.Buffer
	mw := multipart.NewWriter(&msg)
	list := func(as []*mail.Address) string {
		out := make([]string, len(as))
		for i, a := range as {
			out[i] = a.String()
		}
		return strings.Join(out, ", ")
	}
	id := make([]byte, 12)
	_, _ = rand.Read(id)
	domain := "averqo.local"
	if at := strings.LastIndex(from.Address, "@"); at >= 0 {
		domain = from.Address[at+1:]
	}
	var head bytes.Buffer
	fmt.Fprintf(&head, "From: %s\r\n", from.String())
	fmt.Fprintf(&head, "To: %s\r\n", list(to))
	if len(cc) > 0 {
		fmt.Fprintf(&head, "Cc: %s\r\n", list(cc))
	}
	fmt.Fprintf(&head, "Subject: %s\r\n", encodeHeader(subject))
	fmt.Fprintf(&head, "Date: %s\r\n", time.Now().Format(time.RFC1123Z))
	fmt.Fprintf(&head, "Message-ID: <%s@%s>\r\n", hex.EncodeToString(id), domain)
	fmt.Fprintf(&head, "MIME-Version: 1.0\r\n")
	fmt.Fprintf(&head, "Content-Type: multipart/mixed; boundary=%q\r\n\r\n", mw.Boundary())

	tw, err := mw.CreatePart(textproto.MIMEHeader{
		"Content-Type":              {"text/plain; charset=utf-8"},
		"Content-Transfer-Encoding": {"quoted-printable"},
	})
	if err != nil {
		return nil, err
	}
	qp := quotedprintable.NewWriter(tw)
	if _, err := qp.Write([]byte(strings.ReplaceAll(body, "\n", "\r\n"))); err != nil {
		return nil, err
	}
	qp.Close()

	for _, f := range files {
		pw, err := mw.CreatePart(textproto.MIMEHeader{
			"Content-Type":              {mime.FormatMediaType("application/pdf", map[string]string{"name": f.name})},
			"Content-Disposition":       {mime.FormatMediaType("attachment", map[string]string{"filename": f.name})},
			"Content-Transfer-Encoding": {"base64"},
		})
		if err != nil {
			return nil, err
		}
		enc := base64.StdEncoding.EncodeToString(f.data)
		for len(enc) > 76 {
			fmt.Fprintf(pw, "%s\r\n", enc[:76])
			enc = enc[76:]
		}
		fmt.Fprintf(pw, "%s\r\n", enc)
	}
	mw.Close()
	return append(head.Bytes(), msg.Bytes()...), nil
}

func isLocalHost(h string) bool { return h == "localhost" || h == "127.0.0.1" || h == "::1" }

// smtpSend delivers msg. Port 465 uses TLS from the start; other ports
// upgrade with STARTTLS, which is required unless the server is this machine.
func smtpSend(org Organization, from string, rcpts []string, msg []byte) error {
	addr := net.JoinHostPort(org.SMTPHost, strconv.Itoa(org.SMTPPort))
	dialer := &net.Dialer{Timeout: 15 * time.Second}
	var conn net.Conn
	var err error
	if org.SMTPPort == 465 {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{ServerName: org.SMTPHost})
	} else {
		conn, err = dialer.Dial("tcp", addr)
	}
	if err != nil {
		return friendlySMTPError(org, err)
	}
	_ = conn.SetDeadline(time.Now().Add(60 * time.Second))
	c, err := smtp.NewClient(conn, org.SMTPHost)
	if err != nil {
		conn.Close()
		return friendlySMTPError(org, err)
	}
	defer c.Close()
	if org.SMTPPort != 465 {
		if ok, _ := c.Extension("STARTTLS"); ok {
			if err := c.StartTLS(&tls.Config{ServerName: org.SMTPHost}); err != nil {
				return friendlySMTPError(org, err)
			}
		} else if !isLocalHost(org.SMTPHost) {
			return &userError{http.StatusBadGateway, "That email server doesn't offer a secure connection (STARTTLS), so Averqo won't send your password to it. Try port 465 or 587."}
		}
	}
	if org.SMTPUsername != "" {
		if ok, _ := c.Extension("AUTH"); ok {
			if err := c.Auth(smtp.PlainAuth("", org.SMTPUsername, org.SMTPPassword, org.SMTPHost)); err != nil {
				return friendlySMTPError(org, err)
			}
		}
	}
	if err := c.Mail(from); err != nil {
		return friendlySMTPError(org, err)
	}
	for _, r := range rcpts {
		if err := c.Rcpt(r); err != nil {
			return friendlySMTPError(org, err)
		}
	}
	w, err := c.Data()
	if err != nil {
		return friendlySMTPError(org, err)
	}
	if _, err := w.Write(msg); err != nil {
		return friendlySMTPError(org, err)
	}
	if err := w.Close(); err != nil {
		return friendlySMTPError(org, err)
	}
	return c.Quit()
}

func friendlySMTPError(org Organization, err error) error {
	msg := err.Error()
	var netErr net.Error
	switch {
	case strings.Contains(msg, "535") || strings.Contains(strings.ToLower(msg), "username and password"):
		msg = "The email server rejected the username or password. For Gmail, turn on 2-step verification and use an App Password, not your normal password."
	case errors.As(err, &netErr) && netErr.Timeout(), strings.Contains(msg, "no such host"), strings.Contains(msg, "connection refused"):
		msg = fmt.Sprintf("Couldn't connect to %s on port %d. Check the server name and port in Settings.", org.SMTPHost, org.SMTPPort)
	default:
		msg = "The email server said: " + msg
	}
	return &userError{http.StatusBadGateway, msg}
}

type emailRequest struct {
	To      string `json:"to"`
	Cc      string `json:"cc"`
	Subject string `json:"subject"`
	Message string `json:"message"`
}

func parseRecipients(to, cc string) ([]*mail.Address, []*mail.Address, error) {
	parse := func(s string) ([]*mail.Address, error) {
		s = strings.TrimSpace(strings.ReplaceAll(s, ";", ","))
		if s == "" {
			return nil, nil
		}
		return mail.ParseAddressList(s)
	}
	toList, err := parse(to)
	if err != nil || len(toList) == 0 {
		return nil, nil, badRequest("Enter at least one valid email address to send to.")
	}
	ccList, err := parse(cc)
	if err != nil {
		return nil, nil, badRequest("One of the CC addresses isn't a valid email address.")
	}
	if len(toList)+len(ccList) > 20 {
		return nil, nil, badRequest("Send to at most 20 addresses at a time.")
	}
	return toList, ccList, nil
}

// sendEmail sends one message through the business's SMTP settings.
func (s *server) sendEmail(ctx context.Context, req emailRequest, files []attachment) (Organization, error) {
	org, err := s.loadOrganization(ctx)
	if err != nil {
		return org, err
	}
	if !org.emailReady() {
		return org, badRequest("Set up email sending in Settings first, or use \"Open in my email app\" instead.")
	}
	to, cc, err := parseRecipients(req.To, req.Cc)
	if err != nil {
		return org, err
	}
	req.Subject = strings.TrimSpace(req.Subject)
	if req.Subject == "" || len(req.Subject) > 250 || len(req.Message) > 10000 {
		return org, badRequest("Enter a subject (up to 250 characters) and a message.")
	}
	from := mail.Address{Name: orDefault(org.SMTPFromName, org.Name), Address: org.SMTPFromEmail}
	msg, err := buildEmail(from, to, cc, req.Subject, req.Message, files)
	if err != nil {
		return org, err
	}
	var rcpts []string
	for _, a := range append(to, cc...) {
		rcpts = append(rcpts, a.Address)
	}
	return org, smtpSend(org, org.SMTPFromEmail, rcpts, msg)
}

// GET /api/email/status: whether Averqo can send emails itself.
func (s *server) emailStatus(w http.ResponseWriter, r *http.Request) {
	org, err := s.loadOrganization(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"configured": org.emailReady(), "fromEmail": org.SMTPFromEmail,
		"fromName": orDefault(org.SMTPFromName, org.Name)})
}

// POST /api/email/test {"to": "you@example.com"}
func (s *server) emailTest(w http.ResponseWriter, r *http.Request) {
	if !requireOwner(w, r) {
		return
	}
	var req emailRequest
	if err := decodeJSON(w, r, &req); err != nil {
		fail(w, err)
		return
	}
	req.Subject = "Averqo test email"
	req.Message = "This is a test email from Averqo.\n\nIf you can read this, email sending is set up correctly and invoices will arrive with their PDF attached."
	if _, err := s.sendEmail(r.Context(), req, nil); err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "sent"})
}

// POST /api/invoices/{id}/email
func (s *server) emailInvoice(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	var req emailRequest
	if err := decodeJSON(w, r, &req); err != nil {
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
	if _, err := s.sendEmail(ctx, req, []attachment{{p.FileName, data}}); err != nil {
		fail(w, err)
		return
	}
	logActivity(ctx, s.db, "invoice", id, "emailed", "Emailed to "+req.To)
	if err := s.markInvoiceSent(ctx, id); err != nil {
		fail(w, err)
		return
	}
	s.getInvoice(w, r)
}

func (s *server) emailDocument(w http.ResponseWriter, r *http.Request, k docKind) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	var req emailRequest
	if err := decodeJSON(w, r, &req); err != nil {
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
	if _, err := s.sendEmail(ctx, req, []attachment{{p.FileName, data}}); err != nil {
		fail(w, err)
		return
	}
	logActivity(ctx, s.db, k.Type, id, "emailed", "Emailed to "+req.To)
	if err := s.markDocumentIssued(ctx, k, id); err != nil {
		fail(w, err)
		return
	}
	s.getDocument(w, r, k)
}

type shareRequest struct {
	Channel string `json:"channel"` // whatsapp | email_app
	To      string `json:"to"`
}

func (sr shareRequest) describe() (string, error) {
	to := strings.TrimSpace(sr.To)
	if len(to) > 100 {
		to = to[:100]
	}
	switch sr.Channel {
	case "whatsapp":
		if to == "" {
			return "Shared on WhatsApp", nil
		}
		return "Shared on WhatsApp with " + to, nil
	case "email_app":
		return "Sent from your email app to " + orDefault(to, "the customer"), nil
	}
	return "", badRequest(`Channel must be "whatsapp" or "email_app".`)
}

// POST /api/invoices/{id}/shared: you sent it yourself (WhatsApp or your
// email app), so record that and treat a draft as sent.
func (s *server) sharedInvoice(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	var req shareRequest
	if err := decodeJSON(w, r, &req); err != nil {
		fail(w, err)
		return
	}
	detail, err := req.describe()
	if err != nil {
		fail(w, err)
		return
	}
	ctx := r.Context()
	if _, err := s.loadInvoice(ctx, id); err != nil {
		fail(w, err)
		return
	}
	logActivity(ctx, s.db, "invoice", id, req.Channel, detail)
	if err := s.markInvoiceSent(ctx, id); err != nil {
		fail(w, err)
		return
	}
	s.getInvoice(w, r)
}

func (s *server) sharedDocument(w http.ResponseWriter, r *http.Request, k docKind) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	var req shareRequest
	if err := decodeJSON(w, r, &req); err != nil {
		fail(w, err)
		return
	}
	detail, err := req.describe()
	if err != nil {
		fail(w, err)
		return
	}
	ctx := r.Context()
	if _, err := s.loadDocument(ctx, k, id); err != nil {
		fail(w, err)
		return
	}
	logActivity(ctx, s.db, k.Type, id, req.Channel, detail)
	if err := s.markDocumentIssued(ctx, k, id); err != nil {
		fail(w, err)
		return
	}
	s.getDocument(w, r, k)
}
