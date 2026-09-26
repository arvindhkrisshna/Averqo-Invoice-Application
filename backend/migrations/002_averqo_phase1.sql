-- Averqo phase 1: business profile, customers, items, GST-aware invoices,
-- and payments. Existing invoices are kept: their customers become customer
-- records, and invoices that were marked paid get a matching payment.

-- ---------- Business profile (always exactly one row) ----------
CREATE TABLE organization (
  id                   TINYINT UNSIGNED NOT NULL DEFAULT 1,
  name                 VARCHAR(255)  NOT NULL DEFAULT '',
  gst_registered       BOOLEAN       NOT NULL DEFAULT TRUE,
  gstin                VARCHAR(15)   NOT NULL DEFAULT '',
  state_code           CHAR(2)       NOT NULL DEFAULT '',
  address              VARCHAR(500)  NOT NULL DEFAULT '',
  city                 VARCHAR(100)  NOT NULL DEFAULT '',
  pincode              VARCHAR(10)   NOT NULL DEFAULT '',
  email                VARCHAR(255)  NOT NULL DEFAULT '',
  phone                VARCHAR(30)   NOT NULL DEFAULT '',
  bank_name            VARCHAR(100)  NOT NULL DEFAULT '',
  bank_account_number  VARCHAR(40)   NOT NULL DEFAULT '',
  bank_ifsc            VARCHAR(11)   NOT NULL DEFAULT '',
  upi_id               VARCHAR(100)  NOT NULL DEFAULT '',
  invoice_prefix       VARCHAR(10)   NOT NULL DEFAULT 'INV-',
  next_invoice_number  INT UNSIGNED  NOT NULL DEFAULT 1,
  payment_prefix       VARCHAR(10)   NOT NULL DEFAULT 'PAY-',
  next_payment_number  INT UNSIGNED  NOT NULL DEFAULT 1,
  payment_terms_days   SMALLINT UNSIGNED NOT NULL DEFAULT 15,
  invoice_notes        VARCHAR(1000) NOT NULL DEFAULT 'Thank you for your business.',
  invoice_terms        VARCHAR(2000) NOT NULL DEFAULT '',
  updated_at           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

INSERT INTO organization (id) VALUES (1);

-- ---------- Customers ----------
CREATE TABLE customers (
  id                  INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  display_name        VARCHAR(255)  NOT NULL,
  contact_person      VARCHAR(255)  NOT NULL DEFAULT '',
  email               VARCHAR(255)  NOT NULL DEFAULT '',
  phone               VARCHAR(30)   NOT NULL DEFAULT '',
  gst_treatment       ENUM('registered','unregistered','consumer','overseas') NOT NULL DEFAULT 'unregistered',
  gstin               VARCHAR(15)   NOT NULL DEFAULT '',
  state_code          CHAR(2)       NOT NULL DEFAULT '',   -- place of supply
  address             VARCHAR(500)  NOT NULL DEFAULT '',
  city                VARCHAR(100)  NOT NULL DEFAULT '',
  pincode             VARCHAR(10)   NOT NULL DEFAULT '',
  payment_terms_days  SMALLINT UNSIGNED NULL,              -- NULL = business default
  notes               VARCHAR(1000) NOT NULL DEFAULT '',
  archived            BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_customers_name (display_name)
) ENGINE=InnoDB;

-- ---------- Items (products and services) ----------
CREATE TABLE items (
  id           INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  name         VARCHAR(255)  NOT NULL,
  kind         ENUM('goods','service') NOT NULL DEFAULT 'service',
  hsn_sac      VARCHAR(8)    NOT NULL DEFAULT '',
  unit         VARCHAR(10)   NOT NULL DEFAULT 'nos',
  rate         DECIMAL(12,2) NOT NULL DEFAULT 0,
  tax_rate     DECIMAL(5,2)  NOT NULL DEFAULT 18,
  description  VARCHAR(500)  NOT NULL DEFAULT '',
  archived     BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_items_name (name)
) ENGINE=InnoDB;

-- Turn the customer names on existing invoices into customer records.
INSERT INTO customers (display_name, email)
SELECT customer_name, MAX(customer_email) FROM invoices
GROUP BY customer_name ORDER BY MIN(id);

-- ---------- Invoices: customer link, lifecycle, GST totals ----------
ALTER TABLE invoices
  ADD COLUMN customer_id      INT UNSIGNED NULL AFTER invoice_number,
  ADD COLUMN lifecycle        ENUM('draft','sent','void') NOT NULL DEFAULT 'sent' AFTER due_date,
  ADD COLUMN reference        VARCHAR(100)  NOT NULL DEFAULT '',
  ADD COLUMN customer_gstin   VARCHAR(15)   NOT NULL DEFAULT '',
  ADD COLUMN billing_address  VARCHAR(700)  NOT NULL DEFAULT '',
  ADD COLUMN place_of_supply  CHAR(2)       NOT NULL DEFAULT '',
  ADD COLUMN subtotal         DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN discount_total   DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN cgst_total       DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN sgst_total       DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN igst_total       DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN total            DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN notes            VARCHAR(1000) NOT NULL DEFAULT '',
  ADD COLUMN terms            VARCHAR(2000) NOT NULL DEFAULT '',
  ADD COLUMN updated_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

UPDATE invoices i JOIN customers c ON c.display_name = i.customer_name
SET i.customer_id = c.id;

-- ---------- Invoice lines: item link, HSN/SAC, discount, per-line GST ----------
ALTER TABLE invoice_items
  ADD COLUMN item_id         INT UNSIGNED  NULL AFTER invoice_id,
  ADD COLUMN hsn_sac         VARCHAR(8)    NOT NULL DEFAULT '',
  ADD COLUMN unit            VARCHAR(10)   NOT NULL DEFAULT '',
  ADD COLUMN discount_pct    DECIMAL(5,2)  NOT NULL DEFAULT 0,
  ADD COLUMN tax_rate        DECIMAL(5,2)  NOT NULL DEFAULT 0,
  ADD COLUMN taxable_amount  DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN cgst            DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN sgst            DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN igst            DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN sort_order      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  CHANGE COLUMN unit_price rate DECIMAL(12,2) NOT NULL;

-- Old invoices had one tax rate for the whole invoice: copy it to each line.
UPDATE invoice_items it JOIN invoices i ON i.id = it.invoice_id
SET it.tax_rate = i.tax_rate,
    it.taxable_amount = ROUND(it.quantity * it.rate, 2),
    it.sort_order = it.id;

-- Old invoices didn't record the place of supply; treat them as same-state (CGST + SGST).
UPDATE invoice_items
SET cgst = ROUND(taxable_amount * tax_rate / 200, 2),
    sgst = ROUND(taxable_amount * tax_rate / 200, 2);

UPDATE invoices i JOIN (
  SELECT invoice_id, SUM(taxable_amount) AS sub, SUM(cgst) AS c, SUM(sgst) AS s, SUM(igst) AS g
  FROM invoice_items GROUP BY invoice_id
) t ON t.invoice_id = i.id
SET i.subtotal = t.sub, i.cgst_total = t.c, i.sgst_total = t.s, i.igst_total = t.g,
    i.total = t.sub + t.c + t.s + t.g;

-- ---------- Payments received ----------
CREATE TABLE payments (
  id                 INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  payment_number     VARCHAR(20)   NULL,
  customer_id        INT UNSIGNED  NOT NULL,
  payment_date       DATE          NOT NULL,
  amount             DECIMAL(14,2) NOT NULL,
  mode               ENUM('cash','upi','bank_transfer','cheque','card','other') NOT NULL DEFAULT 'bank_transfer',
  reference          VARCHAR(100)  NOT NULL DEFAULT '',
  notes              VARCHAR(500)  NOT NULL DEFAULT '',
  created_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  legacy_invoice_id  INT UNSIGNED  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_number (payment_number),
  KEY idx_payments_customer (customer_id),
  CONSTRAINT fk_payments_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
) ENGINE=InnoDB;

-- One payment can be split across several invoices.
CREATE TABLE payment_allocations (
  id          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  payment_id  INT UNSIGNED  NOT NULL,
  invoice_id  INT UNSIGNED  NOT NULL,
  amount      DECIMAL(14,2) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_alloc (payment_id, invoice_id),
  KEY idx_alloc_invoice (invoice_id),
  CONSTRAINT fk_alloc_payment FOREIGN KEY (payment_id) REFERENCES payments (id) ON DELETE CASCADE,
  CONSTRAINT fk_alloc_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id)
) ENGINE=InnoDB;

-- Invoices marked "paid" in the old app get a payment for their full total.
INSERT INTO payments (customer_id, payment_date, amount, mode, notes, legacy_invoice_id)
SELECT customer_id, issue_date, total, 'other', 'Recorded automatically when upgrading to Averqo.', id
FROM invoices WHERE status = 'paid' AND total > 0 ORDER BY id;

INSERT INTO payment_allocations (payment_id, invoice_id, amount)
SELECT id, legacy_invoice_id, amount FROM payments WHERE legacy_invoice_id IS NOT NULL;

UPDATE payments SET payment_number = CONCAT('PAY-', LPAD(id, 4, '0'));

ALTER TABLE payments DROP COLUMN legacy_invoice_id;

-- Continue numbering after the existing records.
UPDATE organization SET
  next_invoice_number = (SELECT COALESCE(MAX(id), 0) + 1 FROM invoices),
  next_payment_number = (SELECT COALESCE(MAX(id), 0) + 1 FROM payments);

-- ---------- Tidy up: old columns go, links become required ----------
ALTER TABLE invoices
  DROP COLUMN status,
  DROP COLUMN tax_rate,
  MODIFY invoice_number VARCHAR(20) NOT NULL,
  MODIFY customer_id INT UNSIGNED NOT NULL,
  ADD KEY idx_invoices_customer (customer_id),
  ADD KEY idx_invoices_issue (issue_date),
  ADD CONSTRAINT fk_invoices_customer FOREIGN KEY (customer_id) REFERENCES customers (id);

ALTER TABLE invoice_items
  ADD CONSTRAINT fk_lines_item FOREIGN KEY (item_id) REFERENCES items (id);
