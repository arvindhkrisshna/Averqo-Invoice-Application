-- Averqo phase 2: quotes, delivery challans, credit notes, recurring
-- invoices, sending by email or WhatsApp, and an activity history.

-- ---------- Numbering, defaults, and email (SMTP) settings ----------
ALTER TABLE organization
  ADD COLUMN quote_prefix         VARCHAR(10)   NOT NULL DEFAULT 'QT-',
  ADD COLUMN next_quote_number    INT UNSIGNED  NOT NULL DEFAULT 1,
  ADD COLUMN challan_prefix       VARCHAR(10)   NOT NULL DEFAULT 'DC-',
  ADD COLUMN next_challan_number  INT UNSIGNED  NOT NULL DEFAULT 1,
  ADD COLUMN credit_prefix        VARCHAR(10)   NOT NULL DEFAULT 'CN-',
  ADD COLUMN next_credit_number   INT UNSIGNED  NOT NULL DEFAULT 1,
  ADD COLUMN quote_validity_days  SMALLINT UNSIGNED NOT NULL DEFAULT 15,
  ADD COLUMN quote_notes          VARCHAR(1000) NOT NULL DEFAULT 'We look forward to working with you.',
  ADD COLUMN quote_terms          VARCHAR(2000) NOT NULL DEFAULT '',
  ADD COLUMN smtp_host            VARCHAR(255)  NOT NULL DEFAULT '',
  ADD COLUMN smtp_port            SMALLINT UNSIGNED NOT NULL DEFAULT 587,
  ADD COLUMN smtp_username        VARCHAR(255)  NOT NULL DEFAULT '',
  ADD COLUMN smtp_password        VARCHAR(255)  NOT NULL DEFAULT '',
  ADD COLUMN smtp_from_email      VARCHAR(255)  NOT NULL DEFAULT '',
  ADD COLUMN smtp_from_name       VARCHAR(255)  NOT NULL DEFAULT '';

-- ---------- Quotes, delivery challans, and credit notes ----------
-- One table for all three, because they share customers, lines, and GST.
CREATE TABLE documents (
  id               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  doc_type         ENUM('quote','challan','credit_note') NOT NULL,
  doc_number       VARCHAR(20)   NOT NULL,
  customer_id      INT UNSIGNED  NOT NULL,
  customer_name    VARCHAR(255)  NOT NULL,
  customer_email   VARCHAR(255)  NOT NULL DEFAULT '',
  customer_gstin   VARCHAR(15)   NOT NULL DEFAULT '',
  billing_address  VARCHAR(700)  NOT NULL DEFAULT '',
  place_of_supply  CHAR(2)       NOT NULL DEFAULT '',
  issue_date       DATE          NOT NULL,
  expiry_date      DATE          NULL,                 -- quotes: valid until
  status           VARCHAR(20)   NOT NULL DEFAULT 'draft',
  challan_type     VARCHAR(30)   NOT NULL DEFAULT '',  -- challans only
  reason           VARCHAR(30)   NOT NULL DEFAULT '',  -- credit notes only
  invoice_id       INT UNSIGNED  NULL,                 -- quote/challan: invoice made from it; credit note: invoice it corrects
  reference        VARCHAR(100)  NOT NULL DEFAULT '',
  subtotal         DECIMAL(14,2) NOT NULL DEFAULT 0,
  discount_total   DECIMAL(14,2) NOT NULL DEFAULT 0,
  cgst_total       DECIMAL(14,2) NOT NULL DEFAULT 0,
  sgst_total       DECIMAL(14,2) NOT NULL DEFAULT 0,
  igst_total       DECIMAL(14,2) NOT NULL DEFAULT 0,
  total            DECIMAL(14,2) NOT NULL DEFAULT 0,
  notes            VARCHAR(1000) NOT NULL DEFAULT '',
  terms            VARCHAR(2000) NOT NULL DEFAULT '',
  created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_doc_number (doc_type, doc_number),
  KEY idx_docs_customer (customer_id),
  KEY idx_docs_type_date (doc_type, issue_date),
  CONSTRAINT fk_docs_customer FOREIGN KEY (customer_id) REFERENCES customers (id),
  CONSTRAINT fk_docs_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE document_items (
  id              INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  document_id     INT UNSIGNED  NOT NULL,
  item_id         INT UNSIGNED  NULL,
  description     VARCHAR(255)  NOT NULL,
  hsn_sac         VARCHAR(8)    NOT NULL DEFAULT '',
  unit            VARCHAR(10)   NOT NULL DEFAULT '',
  quantity        DECIMAL(10,2) NOT NULL,
  rate            DECIMAL(12,2) NOT NULL,
  discount_pct    DECIMAL(5,2)  NOT NULL DEFAULT 0,
  tax_rate        DECIMAL(5,2)  NOT NULL DEFAULT 0,
  taxable_amount  DECIMAL(14,2) NOT NULL DEFAULT 0,
  cgst            DECIMAL(14,2) NOT NULL DEFAULT 0,
  sgst            DECIMAL(14,2) NOT NULL DEFAULT 0,
  igst            DECIMAL(14,2) NOT NULL DEFAULT 0,
  sort_order      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_doc_items_doc (document_id),
  CONSTRAINT fk_doc_items_doc FOREIGN KEY (document_id) REFERENCES documents (id) ON DELETE CASCADE,
  CONSTRAINT fk_doc_items_item FOREIGN KEY (item_id) REFERENCES items (id)
) ENGINE=InnoDB;

-- Credit note amounts used to reduce what's owed on invoices.
CREATE TABLE credit_allocations (
  id              INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  credit_note_id  INT UNSIGNED  NOT NULL,
  invoice_id      INT UNSIGNED  NOT NULL,
  amount          DECIMAL(14,2) NOT NULL,
  applied_on      DATE          NOT NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_credit_alloc_invoice (invoice_id),
  KEY idx_credit_alloc_note (credit_note_id),
  CONSTRAINT fk_credit_alloc_note FOREIGN KEY (credit_note_id) REFERENCES documents (id),
  CONSTRAINT fk_credit_alloc_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id)
) ENGINE=InnoDB;

-- Credit note amounts paid back to the customer.
CREATE TABLE credit_refunds (
  id              INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  credit_note_id  INT UNSIGNED  NOT NULL,
  refund_date     DATE          NOT NULL,
  amount          DECIMAL(14,2) NOT NULL,
  mode            ENUM('cash','upi','bank_transfer','cheque','card','other') NOT NULL DEFAULT 'bank_transfer',
  reference       VARCHAR(100)  NOT NULL DEFAULT '',
  notes           VARCHAR(500)  NOT NULL DEFAULT '',
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_refunds_note (credit_note_id),
  CONSTRAINT fk_refunds_note FOREIGN KEY (credit_note_id) REFERENCES documents (id)
) ENGINE=InnoDB;

-- ---------- Recurring invoices ----------
CREATE TABLE recurring_profiles (
  id                  INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  profile_name        VARCHAR(100)  NOT NULL,
  customer_id         INT UNSIGNED  NOT NULL,
  frequency           ENUM('weekly','monthly','quarterly','half_yearly','yearly') NOT NULL DEFAULT 'monthly',
  start_date          DATE          NOT NULL,
  end_date            DATE          NULL,
  next_run_date       DATE          NULL,
  occurrences         INT UNSIGNED  NOT NULL DEFAULT 0,
  status              ENUM('active','paused','ended') NOT NULL DEFAULT 'active',
  create_as           ENUM('draft','sent') NOT NULL DEFAULT 'draft',
  payment_terms_days  SMALLINT UNSIGNED NOT NULL DEFAULT 15,
  reference           VARCHAR(100)  NOT NULL DEFAULT '',
  notes               VARCHAR(1000) NOT NULL DEFAULT '',
  terms               VARCHAR(2000) NOT NULL DEFAULT '',
  last_error          VARCHAR(500)  NOT NULL DEFAULT '',
  created_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_recurring_next (status, next_run_date),
  CONSTRAINT fk_recurring_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
) ENGINE=InnoDB;

CREATE TABLE recurring_items (
  id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  profile_id    INT UNSIGNED  NOT NULL,
  item_id       INT UNSIGNED  NULL,
  description   VARCHAR(255)  NOT NULL,
  hsn_sac       VARCHAR(8)    NOT NULL DEFAULT '',
  unit          VARCHAR(10)   NOT NULL DEFAULT '',
  quantity      DECIMAL(10,2) NOT NULL,
  rate          DECIMAL(12,2) NOT NULL,
  discount_pct  DECIMAL(5,2)  NOT NULL DEFAULT 0,
  tax_rate      DECIMAL(5,2)  NOT NULL DEFAULT 0,
  sort_order    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_recurring_items_profile (profile_id),
  CONSTRAINT fk_recurring_items_profile FOREIGN KEY (profile_id) REFERENCES recurring_profiles (id) ON DELETE CASCADE,
  CONSTRAINT fk_recurring_items_item FOREIGN KEY (item_id) REFERENCES items (id)
) ENGINE=InnoDB;

ALTER TABLE invoices
  ADD COLUMN recurring_id INT UNSIGNED NULL,
  ADD KEY idx_invoices_recurring (recurring_id),
  ADD CONSTRAINT fk_invoices_recurring FOREIGN KEY (recurring_id) REFERENCES recurring_profiles (id) ON DELETE SET NULL;

-- ---------- Activity history (sent by email, shared on WhatsApp, converted...) ----------
CREATE TABLE activity (
  id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  subject_type  VARCHAR(20)   NOT NULL,   -- invoice | quote | challan | credit_note | recurring
  subject_id    INT UNSIGNED  NOT NULL,
  action        VARCHAR(30)   NOT NULL,
  detail        VARCHAR(500)  NOT NULL DEFAULT '',
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_activity_subject (subject_type, subject_id)
) ENGINE=InnoDB;
