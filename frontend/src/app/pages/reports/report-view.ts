import { CurrencyPipe, DatePipe, DecimalPipe } from '@angular/common';
import { Component, OnInit, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, errorMessage } from '../../core/api';
import { downloadCsv } from '../../core/format';
import { Report, ReportColumn, ReportRow } from '../../core/models';
import { RANGE_PRESETS, presetRange } from '../../core/periods';

/** Shows any report: the server sends its columns, rows, and totals. */
@Component({
  selector: 'app-report-view',
  imports: [FormsModule, RouterLink, DatePipe],
  template: `
    <section class="page page-wide report-page">
      <div class="page-head">
        <div>
          <a class="back no-print" routerLink="/reports"><i class="ti ti-arrow-left" aria-hidden="true"></i>Reports</a>
          <h1>{{ report()?.title ?? 'Report' }}</h1>
          @if (report(); as r) {
            <p class="muted">{{ org()?.name }} · @if (r.asOf) { As of {{ today | date: 'd MMM y' }} } @else { {{ r.from | date: 'd MMM y' }} to {{ r.to | date: 'd MMM y' }} }</p>
          }
        </div>
        <div class="head-actions no-print">
          <button type="button" class="btn" (click)="print()" [disabled]="!report()"><i class="ti ti-printer" aria-hidden="true"></i>Print</button>
          <button type="button" class="btn" (click)="exportCsv()" [disabled]="!report()?.rows?.length"><i class="ti ti-download" aria-hidden="true"></i>Export CSV</button>
        </div>
      </div>

      @if (!report()?.asOf) {
        <div class="toolbar no-print">
          <select [ngModel]="preset()" (ngModelChange)="setPreset($event)" aria-label="Period">
            @for (p of presets; track p.key) { <option [value]="p.key">{{ p.label }}</option> }
          </select>
          @if (preset() === 'custom') {
            <label class="inline-field">From <input type="date" [(ngModel)]="from" /></label>
            <label class="inline-field">To <input type="date" [(ngModel)]="to" /></label>
            <button type="button" class="btn" (click)="load()">Show</button>
          }
        </div>
      }

      @if (error()) {
        <div class="alert" role="alert"><span>{{ error() }}</span><button type="button" class="btn" (click)="load()">Try again</button></div>
      } @else if (loading()) {
        <p class="muted">Preparing the report…</p>
      } @else if (report(); as r) {
        <div class="table-card">
          <table class="table report-table">
            <thead><tr>@for (c of r.columns; track c.key) { <th [class.num]="isNum(c)">{{ c.label }}</th> }</tr></thead>
            <tbody>
              @for (row of r.rows; track $index) {
                <tr [attr.data-kind]="row['_kind'] ?? null" [class.clickable]="!!row['_link']" (click)="open(row)">
                  @for (c of r.columns; track c.key; let first = $first) {
                    <td [class.num]="isNum(c)">
                      @if (first && row['_link']) { <a [routerLink]="$any(row['_link'])" class="strong-link" (click)="$event.stopPropagation()">{{ row[c.key] }}</a> }
                      @else { {{ cell(row, c) }} }
                    </td>
                  }
                </tr>
              } @empty {
                <tr><td [attr.colspan]="r.columns.length" class="empty-row">Nothing to show for this period.</td></tr>
              }
            </tbody>
            @if (r.totals && r.rows.length) {
              <tfoot><tr>@for (c of r.columns; track c.key; let first = $first) {
                <td [class.num]="isNum(c)">{{ first ? 'Total' : (r.totals[c.key] !== undefined ? cell(r.totals, c) : '') }}</td>
              }</tr></tfoot>
            }
          </table>
        </div>
        @if (r.note) { <p class="sub">{{ r.note }}</p> }
      }
    </section>
  `,
})
export class ReportView implements OnInit {
  private api = inject(Api);
  private router = inject(Router);
  private currency = new CurrencyPipe('en-IN', 'INR');
  private number = new DecimalPipe('en-IN');
  private date = new DatePipe('en-IN');
  readonly key = input.required<string>();
  protected org = this.api.org;
  protected readonly presets = RANGE_PRESETS;
  protected readonly today = new Date().toISOString().slice(0, 10);
  protected report = signal<Report | null>(null);
  protected loading = signal(true);
  protected error = signal('');
  protected preset = signal('this-fy');
  protected from = presetRange('this-fy').from;
  protected to = presetRange('this-fy').to;

  ngOnInit() {
    this.load();
  }

  protected setPreset(key: string) {
    this.preset.set(key);
    if (key === 'custom') return;
    const r = presetRange(key);
    this.from = r.from;
    this.to = r.to;
    this.load();
  }

  protected load() {
    this.loading.set(true);
    this.error.set('');
    this.api.report(this.key(), this.from, this.to).subscribe({
      next: (r) => {
        this.report.set(r);
        this.loading.set(false);
        document.title = `${r.title} · Averqo`;
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.loading.set(false);
      },
    });
  }

  protected isNum(c: ReportColumn) {
    return c.type === 'money' || c.type === 'number' || c.type === 'hours';
  }

  protected cell(row: ReportRow, c: ReportColumn): string {
    const v = row[c.key];
    if (v === null || v === undefined || v === '') return '';
    switch (c.type) {
      case 'money': return this.currency.transform(Number(v)) ?? '';
      case 'number': return this.number.transform(Number(v), '1.0-2') ?? '';
      case 'hours': return `${this.number.transform(Number(v), '1.2-2')} h`;
      case 'date': return this.date.transform(String(v), 'd MMM y') ?? '';
      default: return String(v);
    }
  }

  protected open(row: ReportRow) {
    if (row['_link']) this.router.navigateByUrl(String(row['_link']));
  }

  protected print() {
    window.print();
  }

  protected exportCsv() {
    const r = this.report();
    if (!r) return;
    const raw = (row: ReportRow, c: ReportColumn) => {
      const v = row[c.key];
      if (v === null || v === undefined) return '';
      return c.type === 'money' ? Number(v).toFixed(2) : v;
    };
    const rows = r.rows.map((row) => r.columns.map((c) => raw(row, c)));
    if (r.totals) rows.push(r.columns.map((c, i) => (i === 0 ? 'Total' : r.totals![c.key] !== undefined ? raw(r.totals!, c) : '')));
    downloadCsv(`averqo-${r.key}-${r.asOf ? this.today : r.from + '-to-' + r.to}.csv`, r.columns.map((c) => c.label || 'Account'), rows as (string | number)[][]);
  }
}
