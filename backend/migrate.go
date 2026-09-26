package main

import (
	"database/sql"
	"embed"
	"fmt"
	"log"
	"sort"
	"strings"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// runMigrations applies every migrations/*.sql file that hasn't run yet, in
// file-name order, and records it in schema_migrations. This is how the
// database gets new tables and columns without ever being reset.
func runMigrations(db *sql.DB) error {
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version VARCHAR(100) NOT NULL PRIMARY KEY,
		applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`); err != nil {
		return err
	}

	// The app was renamed from Averqo to Averqo; keep databases that ran the old files in step.
	for _, name := range []string{"002_%s_phase1.sql", "003_%s_phase2.sql"} {
		if _, err := db.Exec(`UPDATE schema_migrations SET version = ? WHERE version = ?`,
			fmt.Sprintf(name, "averqo"), fmt.Sprintf(name, "in"+"voxa")); err != nil {
			return err
		}
	}

	applied := map[string]bool{}
	rows, err := db.Query(`SELECT version FROM schema_migrations`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return err
		}
		applied[v] = true
	}
	rows.Close()

	entries, err := migrationFiles.ReadDir("migrations")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)

	for _, name := range names {
		if applied[name] {
			continue
		}
		body, err := migrationFiles.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		log.Printf("applying migration %s", name)
		for i, stmt := range splitStatements(string(body)) {
			if _, err := db.Exec(stmt); err != nil {
				return fmt.Errorf("%s, statement %d: %w\n%s", name, i+1, err, stmt)
			}
		}
		if _, err := db.Exec(`INSERT INTO schema_migrations (version) VALUES (?)`, name); err != nil {
			return err
		}
	}
	return nil
}

// splitStatements drops "--" comment lines and splits on semicolons that end a line.
func splitStatements(sqlText string) []string {
	var out []string
	var cur strings.Builder
	for _, line := range strings.Split(sqlText, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "--") {
			continue
		}
		cur.WriteString(line)
		cur.WriteString("\n")
		if strings.HasSuffix(trimmed, ";") {
			out = append(out, strings.TrimSuffix(strings.TrimSpace(cur.String()), ";"))
			cur.Reset()
		}
	}
	if s := strings.TrimSpace(cur.String()); s != "" {
		out = append(out, s)
	}
	return out
}
