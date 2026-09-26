-- Averqo database.
-- This only creates the empty database. The Go backend creates and upgrades
-- all tables itself when it starts (see backend/migrations/), so you never
-- need to reset MySQL when Averqo gets new features.
CREATE DATABASE IF NOT EXISTS invoicedb
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
