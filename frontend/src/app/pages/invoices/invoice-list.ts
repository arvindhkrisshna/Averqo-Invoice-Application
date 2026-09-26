import { CurrencyPipe, DatePipe } from '@angular/common';
import { Component, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api, errorMessage } from '../../core/api';
import { STATUS_LABEL, downloadCsv, dueText, invoiceStatus, todayISO } from '../../core/format';
import { Invoice } from '../../core/models';
import { StatusBadge } from '../../shared/status-badge';

type Filter = 'all' | 'draft' | 'unpaid' | 'overdue' | 'paid' | 'void';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unpaid', label: 'Unpaid' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'draft', label: 'Drafts' },
  { key: 'paid', label: 'Paid' },
  { key: 'void', label: 'Void' },
];

function matches(inv: Invoice, f: Filter): boolean {
  const s = invoiceStatus(inv);
  switch (f) {
    case 'all': return true;
    case 'unpaid': return s === 'sent' || s === 'partial' || s === 'overdue';
    default: return s === f;
  }
}

@Component({
  selector: 'app-invoice-list',
  imports: [RouterLink, CurrencyPipe, DatePipe, StatusBadge],
  template: `
    <section class="page page-wide">
      <div class="page-head">
        <div>
          <h1>Invoices</h1>
          @if (invoices().length) {
            <p class="muted">{{ shown().length }} {{ shown().length === 1 ? 'invoice' : 'invoices' }} · {{ shownBalance() | currency }} still to collect</p>
          }
        </div>
        <div class="head-actions">
          <button type="button" class="btn" (click)="exportCsv()" [disabled]="!shown().length"><i class="ti ti-download" aria-hidden="true"></i>Export CSV</button>
          <a class="btn btn-primary" routerLink="/invoices/new"><i class="ti ti-plus" aria-hidden="true"></i>New invoice</a>
        </div>
      </div>

      @if (error()) {
        <div class="alert" role="alert"><span>{{ error() }}</span><button type="button" class="btn" (click)="load()">Try again</button></div>
      } @else if (loading()) {
        <p class="muted">Loading invoices…</p>
      } @else if (!invoices().length) {
        <div class="empty">
          <i class="ti ti-file-invoice" aria-hidden="true"></i>
          <h2>Create your first invoice</h2>
          <p>GST, totals, and the amount in words are worked out for you.</p>
          <a class="btn btn-primary" routerLink="/invoices/new">New invoice</a>
        </div>
      } @else {
        <div class="toolbar">
          <div class="search-box">
            <i class="ti ti-search" aria-hidden="true"></i>
            <input type="search" placeholder="Search by number, customer, or reference" [value]="query()" (input)="query.set($any($event.target).value)" aria-label="Search invoices" />
          </div>
          <div class="chips" role="group" aria-label="Filter by status">
            @for (f of filters; track f.key) {
              <a class="chip" [class.on]="filter() === f.key" routerLink="/invoices" [queryParams]="{ status: f.key === 'all' ? null : f.key }">
                {{ f.label }} <span class="chip-count">{{ counts()[f.key] }}</span>
              </a>
            }
          </div>
        </div>

        <div class="table-card">
          <table class="table">
            <thead>
              <tr><th>Invoice</th><th>Customer</th><th>Date</th><th>Due</th><th class="num">Total</th><th class="num">Balance</th><th>Status</th></tr>
            </thead>
            <tbody>
              @for (i of shown(); track i.id) {
                <tr class="clickable" (click)="router.navigate(['/invoices', i.id])">
                  <td><a [routerLink]="['/invoices', i.id]" class="strong-link" (click)="$event.stopPropagation()">{{ i.invoiceNumber }}</a>
                    @if (i.reference) { <div class="sub">{{ i.reference }}</div> }</td>
                  <td>{{ i.customerName }}</td>
                  <td>{{ i.issueDate | date: 'd MMM y' }}</td>
                  <td>
                    {{ i.dueDate | date: 'd MMM y' }}
                    @if (i.lifecycle === 'sent' && i.balance > 0) { <div class="sub" [class.text-danger]="i.dueDate < today">{{ dueText(i.dueDate) }}</div> }
                  </td>
                  <td class="num">{{ i.total | currency }}</td>
                  <td class="num">{{ i.lifecycle === 'sent' ? (i.balance | currency) : '—' }}</td>
                  <td><app-status-badge [invoice]="i" /></td>
                </tr>
              } @empty {
                <tr><td colspan="7" class="empty-row">No invoices match. Try another filter or search.</td></tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
})
export class InvoiceList {
  /** ?status= in the URL, so filtered views can be bookmarked or linked from Home. */
  readonly status = input<string>();

  private api = inject(Api);
  protected router = inject(Router);
  protected readonly filters = FILTERS;
  protected readonly dueText = dueText;
  protected readonly today = todayISO();

  protected invoices = signal<Invoice[]>([]);
  protected loading = signal(true);
  protected error = signal('');
  protected query = signal('');

  protected filter = computed<Filter>(() => {
    const s = this.status() as Filter;
    return FILTERS.some((f) => f.key === s) ? s : 'all';
  });
  protected counts = computed(() => {
    const c = {} as Record<Filter, number>;
    for (const f of FILTERS) c[f.key] = this.invoices().filter((i) => matches(i, f.key)).length;
    return c;
  });
  protected shown = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.invoices()
      .filter((i) => matches(i, this.filter()))
      .filter((i) => !q || [i.invoiceNumber, i.customerName, i.reference].some((v) => v.toLowerCase().includes(q)));
  });
  protected shownBalance = computed(() =>
    this.shown().filter((i) => i.lifecycle === 'sent').reduce((s, i) => s + Math.max(0, i.balance), 0),
  );

  constructor() {
    this.load();
  }

  protected load() {
    this.loading.set(true);
    this.error.set('');
    this.api.invoices().subscribe({
      next: (list) => {
        this.invoices.set(list);
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.loading.set(false);
      },
    });
  }

  protected exportCsv() {
    downloadCsv(
      'averqo-invoices.csv',
      ['Invoice number', 'Customer', 'Invoice date', 'Due date', 'Reference', 'Taxable value', 'CGST', 'SGST', 'IGST', 'Total', 'Paid', 'Balance', 'Status'],
      this.shown().map((i) => [i.invoiceNumber, i.customerName, i.issueDate, i.dueDate, i.reference, i.subtotal.toFixed(2),
        i.cgstTotal.toFixed(2), i.sgstTotal.toFixed(2), i.igstTotal.toFixed(2), i.total.toFixed(2), i.paid.toFixed(2),
        i.balance.toFixed(2), STATUS_LABEL[invoiceStatus(i)]]),
    );
  }
}
