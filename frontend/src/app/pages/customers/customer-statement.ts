import { CurrencyPipe, DatePipe } from '@angular/common';
import { Component, OnInit, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, errorMessage } from '../../core/api';
import { downloadCsv } from '../../core/format';
import { Statement } from '../../core/models';
import { RANGE_PRESETS, presetRange } from '../../core/periods';

@Component({
  selector: 'app-customer-statement',
  imports: [FormsModule, RouterLink, CurrencyPipe, DatePipe],
  template: `
    <section class="page page-wide">
      <div class="page-head no-print">
        <div>
          <a class="back" [routerLink]="['/customers', id()]"><i class="ti ti-arrow-left" aria-hidden="true"></i>{{ st()?.customer?.displayName ?? 'Customer' }}</a>
          <h1>Statement</h1>
        </div>
        <div class="head-actions">
          <button type="button" class="btn" (click)="print()" [disabled]="!st()"><i class="ti ti-printer" aria-hidden="true"></i>Print or PDF</button>
          <button type="button" class="btn" (click)="exportCsv()" [disabled]="!st()"><i class="ti ti-download" aria-hidden="true"></i>Export CSV</button>
        </div>
      </div>
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

      @if (error()) {
        <div class="alert" role="alert"><span>{{ error() }}</span></div>
      } @else if (!st()) {
        <p class="muted">Loading…</p>
      } @else {
        @let s = st()!;
        <div class="card statement">
          <div class="statement-head">
            <div>
              <h2>{{ org()?.name }}</h2>
              <p class="sub pre">{{ org()?.address }}@if (org()?.city) {, {{ org()?.city }} }</p>
              @if (org()?.gstin) { <p class="sub">GSTIN {{ org()?.gstin }}</p> }
            </div>
            <div class="statement-title">
              <h2>Statement of account</h2>
              <p class="sub">{{ s.from | date: 'd MMM y' }} to {{ s.to | date: 'd MMM y' }}</p>
            </div>
          </div>
          <div class="statement-to">
            <span class="sub">To</span>
            <strong>{{ s.customer.displayName }}</strong>
            @if (s.customer.gstin) { <span class="sub">GSTIN {{ s.customer.gstin }}</span> }
          </div>
          <div class="statement-summary">
            <div><span class="sub">Opening balance</span><strong>{{ s.opening | currency }}</strong></div>
            <div><span class="sub">Invoiced</span><strong>{{ s.debits | currency }}</strong></div>
            <div><span class="sub">Paid and credited</span><strong>{{ s.credits | currency }}</strong></div>
            <div><span class="sub">Balance due</span><strong>{{ s.closing | currency }}</strong></div>
          </div>
          <div class="table-card">
            <table class="table">
              <thead><tr><th>Date</th><th>Transaction</th><th>Details</th><th class="num">Invoiced</th><th class="num">Paid or credited</th><th class="num">Balance</th></tr></thead>
              <tbody>
                <tr data-kind="heading"><td>{{ s.from | date: 'd MMM y' }}</td><td colspan="4">Opening balance</td><td class="num">{{ s.opening | currency }}</td></tr>
                @for (l of s.lines; track l.type + l.number + l.date) {
                  <tr>
                    <td>{{ l.date | date: 'd MMM y' }}</td>
                    <td><a [routerLink]="l.link" class="strong-link">{{ l.number }}</a></td>
                    <td>{{ l.detail }}</td>
                    <td class="num">{{ l.debit ? (l.debit | currency) : '' }}</td>
                    <td class="num">{{ l.credit ? (l.credit | currency) : '' }}</td>
                    <td class="num">{{ l.balance | currency }}</td>
                  </tr>
                } @empty {
                  <tr><td colspan="6" class="empty-row">No transactions in this period.</td></tr>
                }
              </tbody>
              <tfoot><tr><td colspan="3">Balance due</td><td class="num">{{ s.debits | currency }}</td><td class="num">{{ s.credits | currency }}</td><td class="num">{{ s.closing | currency }}</td></tr></tfoot>
            </table>
          </div>
        </div>
      }
    </section>
  `,
})
export class CustomerStatement implements OnInit {
  private api = inject(Api);
  readonly id = input.required<string>();
  protected org = this.api.org;
  protected readonly presets = RANGE_PRESETS;
  protected st = signal<Statement | null>(null);
  protected error = signal('');
  protected preset = signal('this-fy');
  protected from = presetRange('this-fy').from;
  protected to = presetRange('this-fy').to;

  ngOnInit() {
    this.api.loadOrg().subscribe({ error: () => {} });
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
    this.error.set('');
    this.api.statement(this.id(), this.from, this.to).subscribe({
      next: (s) => this.st.set(s),
      error: (e) => this.error.set(errorMessage(e)),
    });
  }

  protected print() {
    window.print();
  }

  protected exportCsv() {
    const s = this.st();
    if (!s) return;
    downloadCsv(`averqo-statement-${s.customer.displayName.replace(/\W+/g, '-').toLowerCase()}.csv`,
      ['Date', 'Transaction', 'Details', 'Invoiced', 'Paid or credited', 'Balance'],
      [[s.from, 'Opening balance', '', '', '', s.opening.toFixed(2)],
        ...s.lines.map((l) => [l.date, l.number, l.detail, l.debit ? l.debit.toFixed(2) : '', l.credit ? l.credit.toFixed(2) : '', l.balance.toFixed(2)]),
        ['', 'Balance due', '', s.debits.toFixed(2), s.credits.toFixed(2), s.closing.toFixed(2)]]);
  }
}
