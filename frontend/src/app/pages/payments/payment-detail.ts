import { CurrencyPipe, DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api, errorMessage } from '../../core/api';
import { MODE_LABEL, amountInWords } from '../../core/format';
import { Payment } from '../../core/models';
import { Toasts } from '../../core/toast';

@Component({
  selector: 'app-payment-detail',
  imports: [RouterLink, CurrencyPipe, DatePipe],
  template: `
    <section class="page">
      @if (error()) {
        <div class="alert" role="alert"><span>{{ error() }}</span><a class="btn" routerLink="/payments">Back to payments</a></div>
      } @else if (!payment()) {
        <p class="muted">Loading…</p>
      } @else {
        @let p = payment()!;
        @let o = org();
        <div class="page-head no-print">
          <div>
            <a class="back" routerLink="/payments"><i class="ti ti-arrow-left" aria-hidden="true"></i>Payments received</a>
            <h1>{{ p.paymentNumber }}</h1>
            <p class="muted"><a [routerLink]="['/customers', p.customerId]">{{ p.customerName }}</a> · {{ p.paymentDate | date: 'd MMM y' }}</p>
          </div>
          <div class="head-actions">
            <button type="button" class="btn btn-quiet text-danger" [disabled]="busy()" (click)="remove()"><i class="ti ti-trash" aria-hidden="true"></i>Delete</button>
            <button type="button" class="btn btn-primary" (click)="print()"><i class="ti ti-printer" aria-hidden="true"></i>Print receipt</button>
          </div>
        </div>

        <article class="doc receipt">
          <header class="doc-head">
            <div class="doc-from">
              <h2>{{ o?.name || 'Your business name' }}</h2>
              @if (o?.gstin) { <p><strong>GSTIN</strong>&nbsp;<span class="mono">{{ o!.gstin }}</span></p> }
              @if (o?.email || o?.phone) { <p class="muted">{{ join(' · ', o?.email, o?.phone) }}</p> }
            </div>
            <div class="doc-title">
              <h1>Payment receipt</h1>
              <dl>
                <dt>Receipt no.</dt><dd class="mono">{{ p.paymentNumber }}</dd>
                <dt>Date</dt><dd>{{ p.paymentDate | date: 'd MMM y' }}</dd>
                <dt>Paid by</dt><dd>{{ modeLabel[p.mode] }}</dd>
                @if (p.reference) { <dt>Reference</dt><dd class="mono">{{ p.reference }}</dd> }
              </dl>
            </div>
          </header>

          <div class="receipt-amount">
            <span class="muted">Received from <strong>{{ p.customerName }}</strong></span>
            <span class="receipt-value">{{ p.amount | currency }}</span>
            <span class="muted">{{ words() }}</span>
          </div>

          <div class="doc-table-wrap">
            <table class="doc-table">
              <thead><tr><th>Invoice</th><th class="num">Amount applied</th></tr></thead>
              <tbody>
                @for (a of p.allocations; track a.invoiceId) {
                  <tr>
                    <td><a [routerLink]="['/invoices', a.invoiceId]">{{ a.invoiceNumber }}</a></td>
                    <td class="num">{{ a.amount | currency }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>

          @if (p.notes) { <p class="muted no-print">Note: {{ p.notes }}</p> }
          <footer class="doc-foot">
            <div class="signature">
              <p>For {{ o?.name || 'your business' }}</p>
              <p class="sign-line">Authorised signatory</p>
            </div>
          </footer>
        </article>
      }
    </section>
  `,
})
export class PaymentDetail implements OnInit {
  readonly id = input.required<string>();
  private api = inject(Api);
  private router = inject(Router);
  private toasts = inject(Toasts);
  protected org = this.api.org;
  protected readonly modeLabel = MODE_LABEL;
  protected payment = signal<Payment | null>(null);
  protected error = signal('');
  protected busy = signal(false);
  protected words = computed(() => amountInWords(this.payment()?.amount ?? 0));

  ngOnInit() {
    if (!this.org()) this.api.loadOrg().subscribe({ error: () => {} });
    this.api.payment(this.id()).subscribe({
      next: (p) => this.payment.set(p),
      error: (e) => this.error.set(errorMessage(e)),
    });
  }

  protected join(sep: string, ...parts: (string | undefined)[]) {
    return parts.filter((x) => !!x).join(sep);
  }

  protected print() {
    window.print();
  }

  protected remove() {
    const p = this.payment()!;
    const invoices = p.invoiceNumbers ? ` ${p.invoiceNumbers} will show as unpaid again.` : '';
    if (!confirm(`Delete ${p.paymentNumber} for ${p.amount.toFixed(2)}?${invoices}`)) return;
    this.busy.set(true);
    this.api.deletePayment(p.id).subscribe({
      next: () => {
        this.toasts.show(`${p.paymentNumber} deleted`);
        this.router.navigate(['/payments']);
      },
      error: (e) => {
        this.busy.set(false);
        this.toasts.show(errorMessage(e), 'error');
      },
    });
  }
}
