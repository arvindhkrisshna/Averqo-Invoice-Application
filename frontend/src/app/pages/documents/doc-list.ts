import { CurrencyPipe, DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api, errorMessage } from '../../core/api';
import { downloadCsv, todayISO } from '../../core/format';
import { DOC_KINDS, DOC_STATUS, docStatus } from '../../core/kinds';
import { DocType, SalesDoc } from '../../core/models';

const FILTERS: Record<DocType, string[]> = {
  quote: ['all', 'draft', 'sent', 'accepted', 'declined', 'expired', 'invoiced'],
  challan: ['all', 'draft', 'open', 'invoiced', 'cancelled'],
  credit_note: ['all', 'draft', 'open', 'closed', 'void'],
};

@Component({
  selector: 'app-doc-list',
  imports: [RouterLink, CurrencyPipe, DatePipe],
  template: `
    @let k = kindInfo();
    <section class="page page-wide">
      <div class="page-head">
        <div>
          <h1>{{ k.plural }}</h1>
          @if (docs().length) { <p class="muted">{{ shown().length }} shown · {{ shownTotal() | currency }}</p> }
        </div>
        <div class="head-actions">
          <button type="button" class="btn" (click)="exportCsv()" [disabled]="!shown().length"><i class="ti ti-download" aria-hidden="true"></i>Export CSV</button>
          <a class="btn btn-primary" [routerLink]="k.route + '/new'"><i class="ti ti-plus" aria-hidden="true"></i>New {{ k.label.toLowerCase() }}</a>
        </div>
      </div>

      @if (error()) {
        <div class="alert" role="alert"><span>{{ error() }}</span><button type="button" class="btn" (click)="load()">Try again</button></div>
      } @else if (loading()) {
        <p class="muted">Loading…</p>
      } @else if (!docs().length) {
        <div class="empty">
          <i class="ti ti-{{ k.icon }}" aria-hidden="true"></i>
          <h2>Create your first {{ k.label.toLowerCase() }}</h2>
          <p>{{ k.empty }}</p>
          <a class="btn btn-primary" [routerLink]="k.route + '/new'">New {{ k.label.toLowerCase() }}</a>
        </div>
      } @else {
        <div class="toolbar">
          <div class="search-box">
            <i class="ti ti-search" aria-hidden="true"></i>
            <input type="search" placeholder="Search by number, customer, or reference" [value]="query()" (input)="query.set($any($event.target).value)" [attr.aria-label]="'Search ' + k.plural.toLowerCase()" />
          </div>
          <div class="chips" role="group" aria-label="Filter by status">
            @for (f of filters(); track f) {
              <a class="chip" [class.on]="filter() === f" [routerLink]="k.route" [queryParams]="{ status: f === 'all' ? null : f }">
                {{ f === 'all' ? 'All' : statusInfo[f].label }} <span class="chip-count">{{ counts()[f] }}</span>
              </a>
            }
          </div>
        </div>

        <div class="table-card">
          <table class="table">
            <thead>
              <tr>
                <th>{{ k.numberLabel }}</th><th>Customer</th><th>Date</th>
                <th>{{ k.type === 'quote' ? 'Valid until' : k.type === 'challan' ? 'Invoice' : 'Against invoice' }}</th>
                <th class="num">Total</th>
                @if (k.type === 'credit_note') { <th class="num">Credit left</th> }
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              @for (d of shown(); track d.id) {
                <tr class="clickable" (click)="router.navigate([k.route, d.id])">
                  <td><a [routerLink]="[k.route, d.id]" class="strong-link" (click)="$event.stopPropagation()">{{ d.number }}</a>
                    @if (d.reference) { <div class="sub">{{ d.reference }}</div> }</td>
                  <td>{{ d.customerName }}</td>
                  <td>{{ d.issueDate | date: 'd MMM y' }}</td>
                  <td>
                    @if (k.type === 'quote') { {{ d.expiryDate ? (d.expiryDate | date: 'd MMM y') : '—' }} }
                    @else { {{ d.invoiceNumber || '—' }} }
                  </td>
                  <td class="num">{{ d.total | currency }}</td>
                  @if (k.type === 'credit_note') { <td class="num">{{ d.status === 'open' ? (d.balance | currency) : '—' }}</td> }
                  <td><span class="badge" [attr.data-tone]="statusInfo[st(d)].tone">{{ statusInfo[st(d)].label }}</span></td>
                </tr>
              } @empty {
                <tr><td colspan="7" class="empty-row">Nothing matches. Try another filter or search.</td></tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
})
export class DocList implements OnInit {
  readonly kind = input<DocType>('quote');
  readonly status = input<string>();

  private api = inject(Api);
  protected router = inject(Router);
  protected readonly statusInfo = DOC_STATUS;
  protected docs = signal<SalesDoc[]>([]);
  protected loading = signal(true);
  protected error = signal('');
  protected query = signal('');

  protected kindInfo = computed(() => DOC_KINDS[this.kind()]);
  protected filters = computed(() => FILTERS[this.kind()]);
  protected filter = computed(() => (this.filters().includes(this.status() ?? '') ? this.status()! : 'all'));
  protected st = docStatus;
  protected counts = computed(() => {
    const c: Record<string, number> = {};
    for (const f of this.filters()) c[f] = f === 'all' ? this.docs().length : this.docs().filter((d) => docStatus(d) === f).length;
    return c;
  });
  protected shown = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.docs().filter((d) =>
      (this.filter() === 'all' || docStatus(d) === this.filter()) &&
      (!q || [d.number, d.customerName, d.reference].some((v) => v.toLowerCase().includes(q))));
  });
  protected shownTotal = computed(() => this.shown().reduce((s, d) => s + d.total, 0));

  ngOnInit() {
    this.load();
  }

  protected load() {
    this.loading.set(true);
    this.error.set('');
    this.api.docs(this.kindInfo().path).subscribe({
      next: (d) => {
        this.docs.set(d);
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.loading.set(false);
      },
    });
  }

  protected exportCsv() {
    const k = this.kindInfo();
    downloadCsv(`${k.path}-${todayISO()}.csv`,
      [k.numberLabel, 'Customer', 'Date', 'Valid until', 'Linked invoice', 'Reference', 'Taxable value', 'CGST', 'SGST', 'IGST', 'Total', 'Status'],
      this.shown().map((d) => [d.number, d.customerName, d.issueDate, d.expiryDate ?? '', d.invoiceNumber ?? '', d.reference,
        d.subtotal, d.cgstTotal, d.sgstTotal, d.igstTotal, d.total, DOC_STATUS[docStatus(d)].label]));
  }
}
