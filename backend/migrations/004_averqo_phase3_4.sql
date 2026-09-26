-- Averqo phases 3 and 4: sign-in, expenses, time tracking, GST filing.

-- ---------- People who can sign in ----------
CREATE TABLE users (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name           VARCHAR(100) NOT NULL,
  email          VARCHAR(255) NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,
  role           ENUM('owner','staff') NOT NULL DEFAULT 'staff',
  active         BOOLEAN      NOT NULL DEFAULT TRUE,
  last_login_at  DATETIME     NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB;

CREATE TABLE sessions (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  token_hash    CHAR(64)     NOT NULL,       -- SHA-256 of the cookie value; the value itself is never stored
  user_id       INT UNSIGNED NOT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at    DATETIME     NOT NULL,
  user_agent    VARCHAR(255) NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_token (token_hash),
  KEY idx_sessions_user (user_id),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------- Expenses ----------
CREATE TABLE expense_categories (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(60)  NOT NULL,
  archived    BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_expense_category_name (name)
) ENGINE=InnoDB;

INSERT INTO expense_categories (name) VALUES
  ('Advertising and marketing'), ('Bank charges'), ('Fuel and travel'), ('Internet and phone'),
  ('Meals and entertainment'), ('Office supplies'), ('Professional fees'), ('Purchases and raw materials'),
  ('Rent'), ('Repairs and maintenance'), ('Salaries and wages'), ('Software and subscriptions'),
  ('Utilities'), ('Other expenses');

CREATE TABLE expenses (
  id                   INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  expense_date         DATE          NOT NULL,
  category_id          INT UNSIGNED  NOT NULL,
  vendor_name          VARCHAR(255)  NOT NULL DEFAULT '',
  vendor_gstin         VARCHAR(15)   NOT NULL DEFAULT '',
  vendor_state         CHAR(2)       NOT NULL DEFAULT '',
  bill_number          VARCHAR(50)   NOT NULL DEFAULT '',
  hsn_sac              VARCHAR(8)    NOT NULL DEFAULT '',
  description          VARCHAR(500)  NOT NULL DEFAULT '',
  amount_includes_tax  BOOLEAN       NOT NULL DEFAULT TRUE,
  gst_rate             DECIMAL(5,2)  NOT NULL DEFAULT 0,
  subtotal             DECIMAL(14,2) NOT NULL DEFAULT 0,  -- value before GST
  cgst                 DECIMAL(14,2) NOT NULL DEFAULT 0,
  sgst                 DECIMAL(14,2) NOT NULL DEFAULT 0,
  igst                 DECIMAL(14,2) NOT NULL DEFAULT 0,
  total                DECIMAL(14,2) NOT NULL DEFAULT 0,  -- what the bill says
  itc_eligible         BOOLEAN       NOT NULL DEFAULT TRUE,   -- claim this GST back (input tax credit)
  reverse_charge       BOOLEAN       NOT NULL DEFAULT FALSE,  -- you pay the GST instead of the vendor
  paid_through         ENUM('cash','upi','bank_transfer','cheque','card','other') NOT NULL DEFAULT 'bank_transfer',
  reference            VARCHAR(100)  NOT NULL DEFAULT '',
  customer_id          INT UNSIGNED  NULL,
  billable             BOOLEAN       NOT NULL DEFAULT FALSE,
  markup_pct           DECIMAL(6,2)  NOT NULL DEFAULT 0,
  invoice_id           INT UNSIGNED  NULL,
  created_by           INT UNSIGNED  NULL,
  created_at           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_expenses_date (expense_date),
  KEY idx_expenses_customer (customer_id, invoice_id),
  CONSTRAINT fk_expenses_category FOREIGN KEY (category_id) REFERENCES expense_categories (id),
  CONSTRAINT fk_expenses_customer FOREIGN KEY (customer_id) REFERENCES customers (id),
  CONSTRAINT fk_expenses_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE SET NULL,
  CONSTRAINT fk_expenses_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Receipts live in the database so a normal database backup includes them.
CREATE TABLE expense_receipts (
  expense_id    INT UNSIGNED NOT NULL,
  file_name     VARCHAR(255) NOT NULL,
  content_type  VARCHAR(100) NOT NULL,
  size_bytes    INT UNSIGNED NOT NULL,
  data          MEDIUMBLOB   NOT NULL,
  uploaded_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (expense_id),
  CONSTRAINT fk_receipts_expense FOREIGN KEY (expense_id) REFERENCES expenses (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------- Time tracking ----------
CREATE TABLE projects (
  id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  project_name  VARCHAR(120)  NOT NULL,
  customer_id   INT UNSIGNED  NOT NULL,
  hourly_rate   DECIMAL(12,2) NOT NULL DEFAULT 0,
  sac           VARCHAR(8)    NOT NULL DEFAULT '',
  tax_rate      DECIMAL(5,2)  NOT NULL DEFAULT 18,
  budget_hours  DECIMAL(10,2) NULL,
  status        ENUM('active','completed') NOT NULL DEFAULT 'active',
  description   VARCHAR(1000) NOT NULL DEFAULT '',
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_projects_customer (customer_id),
  CONSTRAINT fk_projects_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
) ENGINE=InnoDB;

CREATE TABLE time_entries (
  id                INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  project_id        INT UNSIGNED  NOT NULL,
  user_id           INT UNSIGNED  NULL,
  entry_date        DATE          NOT NULL,
  task              VARCHAR(255)  NOT NULL DEFAULT '',
  minutes           INT UNSIGNED  NOT NULL DEFAULT 0,
  notes             VARCHAR(1000) NOT NULL DEFAULT '',
  billable          BOOLEAN       NOT NULL DEFAULT TRUE,
  invoice_id        INT UNSIGNED  NULL,
  timer_started_at  DATETIME      NULL,     -- set while a timer is running (UTC)
  created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_time_project_date (project_id, entry_date),
  KEY idx_time_user_timer (user_id, timer_started_at),
  KEY idx_time_invoice (invoice_id),
  CONSTRAINT fk_time_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
  CONSTRAINT fk_time_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_time_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Invoice lines remember the timesheet entries or expense they bill.
ALTER TABLE invoice_items
  ADD COLUMN expense_id      INT UNSIGNED  NULL,
  ADD COLUMN time_entry_ids  VARCHAR(2000) NOT NULL DEFAULT '';

-- ---------- GST filing ----------
ALTER TABLE organization
  ADD COLUMN gst_filing_frequency ENUM('monthly','quarterly') NOT NULL DEFAULT 'monthly';

CREATE TABLE gst_returns (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  return_type   ENUM('GSTR1','GSTR3B') NOT NULL,
  period_start  DATE         NOT NULL,
  period_end    DATE         NOT NULL,
  filed_on      DATE         NOT NULL,
  arn           VARCHAR(30)  NOT NULL DEFAULT '',
  filed_by      INT UNSIGNED NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gst_return_period (return_type, period_start, period_end),
  CONSTRAINT fk_gst_returns_user FOREIGN KEY (filed_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;
