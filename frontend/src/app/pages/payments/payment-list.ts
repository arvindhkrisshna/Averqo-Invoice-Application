import { CurrencyPipe, DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api, errorMessage } from '../../core/api';
import { MODE_LABEL, downloadCsv } from '../../core/format';
import { Payment } from '../../core/models';

@Component({
  selector: 'app-payment-list',
  imports: [RouterLink, CurrencyPipe, DatePipe],
  template: `
    <section class="page page-wide">
      <div class="page-head">
        <div>
          <h1>Payments received</h1>
          @if (payments().length) {
            <p class="muted">{{ shown().length }} {{ shown().length === 1 ? 'payment' : 'payments' }} · {{ shownTotal() | currency }} in total</p>
          }
        </div>
        <div class="head-actions">
          <button type="button" class="btn" (click)="exportCsv()" [disabled]="!shown().length"><i class="ti ti-download" aria-hidden="true"></i>Export CSV</button>
          <a class="btn btn-primary" routerLink="/payments/new"><i class="ti ti-plus" aria-hidden="true"></i>Record payment</a>
        </div>
      </div>

      @if (error()) {
        <div class="alert" role="alert"><span>{{ error() }}</span><button type="button" class="btn" (click)="load()">Try again</button></div>
      } @else if (loading()) {
        <p class="muted">Loading payments…</p>
      } @else if (!payments().length) {
        <div class="empty">
          <i class="ti ti-cash" aria-hidden="true"></i>
          <h2>No payments recorded yet</h2>
          <p>When a customer pays, record it here. One payment can settle several invoices at once.</p>
          <a class="btn btn-primary" routerLink="/payments/new">Record payment</a>
        </div>
      } @else {
        <div class="toolbar">
          <div class="search-box">
            <i class="ti ti-search" aria-hidden="true"></i>
            <input type="search" placeholder="Search by customer, number, reference, or invoice" [value]="query()" (input)="query.set($any($event.target).value)" aria-label="Search payments" />
          </div>
        </div>
        <div class="table-card">
          <table class="table">
            <thead><tr><th>Payment</th><th>Date</th><th>Customer</th><th>Mode</th><th>Applied to</th><th class="num">Amount</th></tr></thead>
            <tbody>
              @for (p of shown(); track p.id) {
                <tr class="clickable" (click)="router.navigate(['/payments', p.id])">
                  <td><a [routerLink]="['/payments', p.id]" class="strong-link" (click)="$event.stopPropagation()">{{ p.paymentNumber }}</a>
                    @if (p.reference) { <div class="sub">{{ p.reference }}</div> }</td>
                  <td>{{ p.paymentDate | date: 'd MMM y' }}</td>
                  <td>{{ p.customerName }}</td>
                  <td>{{ modeLabel[p.mode] }}</td>
                  <td class="sub">{{ p.invoiceNumbers }}</td>
                  <td class="num text-success">{{ p.amount | currency }}</td>
                </tr>
              } @empty {
                <tr><td colspan="6" class="empty-row">No payments match "{{ query() }}".</td></tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
})
export class PaymentList {
  private api = inject(Api);
  protected router = inject(Router);
  protected readonly modeLabel = MODE_LABEL;
  protected payments = signal<Payment[]>([]);
  protected loading = signal(true);
  protected error = signal('');
  protected query = signal('');

  protected shown = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.payments().filter(
      (p) => !q || [p.paymentNumber, p.customerName, p.reference, p.invoiceNumbers].some((v) => v.toLowerCase().includes(q)),
    );
  });
  protected shownTotal = computed(() => this.shown().reduce((s, p) => s + p.amount, 0));

  constructor() {
    this.load();
  }

  protected load() {
    this.loading.set(true);
    this.error.set('');
    this.api.payments().subscribe({
      next: (p) => {
        this.payments.set(p);
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
      'averqo-payments.csv',
      ['Payment number', 'Date', 'Customer', 'Mode', 'Reference', 'Invoices', 'Amount', 'Notes'],
      this.shown().map((p) => [p.paymentNumber, p.paymentDate, p.customerName, this.modeLabel[p.mode], p.reference,
        p.invoiceNumbers, p.amount.toFixed(2), p.notes]),
    );
  }
}
