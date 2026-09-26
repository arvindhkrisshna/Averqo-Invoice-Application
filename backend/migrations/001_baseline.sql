-- The original invoice app tables. On a Codespace that already has them this
-- does nothing; on a brand-new database it creates them so every database
-- goes through exactly the same upgrade steps.

CREATE TABLE IF NOT EXISTS invoices (
  id              INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  invoice_number  VARCHAR(20)   NULL,
  customer_name   VARCHAR(255)  NOT NULL,
  customer_email  VARCHAR(255)  NOT NULL DEFAULT '',
  issue_date      DATE          NOT NULL,
  due_date        DATE          NOT NULL,
  tax_rate        DECIMAL(5,2)  NOT NULL DEFAULT 0.00,
  status          ENUM('unpaid','paid') NOT NULL DEFAULT 'unpaid',
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_invoice_number (invoice_number)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS invoice_items (
  id           INT UNSIGNED   NOT NULL AUTO_INCREMENT,
  invoice_id   INT UNSIGNED   NOT NULL,
  description  VARCHAR(255)   NOT NULL,
  quantity     DECIMAL(10,2)  NOT NULL,
  unit_price   DECIMAL(12,2)  NOT NULL,
  PRIMARY KEY (id),
  KEY idx_items_invoice (invoice_id),
  CONSTRAINT fk_items_invoice FOREIGN KEY (invoice_id)
    REFERENCES invoices (id) ON DELETE CASCADE
) ENGINE=InnoDB;
