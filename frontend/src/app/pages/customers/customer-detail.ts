import { CurrencyPipe, DatePipe } from '@angular/common';
import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { Api, errorMessage } from '../../core/api';
import { GST_TREATMENT_LABEL, MODE_LABEL } from '../../core/format';
import { Customer, Invoice, Payment } from '../../core/models';
import { Toasts } from '../../core/toast';
import { StatusBadge } from '../../shared/status-badge';

@Component({
  selector: 'app-customer-detail',
  imports: [RouterLink, CurrencyPipe, DatePipe, StatusBadge],
  template: `
    <section class="page page-wide">
      @if (error()) {
        <div class="alert" role="alert"><span>{{ error() }}</span><a class="btn" routerLink="/customers">Back to customers</a></div>
      } @else if (!customer()) {
        <p class="muted">Loading…</p>
      } @else {
        @let c = customer()!;
        <div class="page-head">
          <div>
            <a class="back" routerLink="/customers"><i class="ti ti-arrow-left" aria-hidden="true"></i>Customers</a>
            <h1>{{ c.displayName }} @if (c.archived) { <span class="badge" data-tone="void">Archived</span> }</h1>
            <p class="muted">{{ treatment[c.gstTreatment] }}@if (c.gstin) { · <span class="mono">{{ c.gstin }}</span> }@if (stateName()) { · {{ stateName() }} }</p>
          </div>
          <div class="head-actions">
            <a class="btn" [routerLink]="['/customers', c.id, 'edit']"><i class="ti ti-pencil" aria-hidden="true"></i>Edit</a>
            <a class="btn" [routerLink]="['/customers', c.id, 'statement']"><i class="ti ti-file-text" aria-hidden="true"></i>Statement</a>
            @if (c.outstanding > 0) {
              <a class="btn" routerLink="/payments/new" [queryParams]="{ customerId: c.id }"><i class="ti ti-cash" aria-hidden="true"></i>Record payment</a>
            }
            <a class="btn" routerLink="/quotes/new" [queryParams]="{ customerId: c.id }"><i class="ti ti-file-description" aria-hidden="true"></i>New quote</a>
            <a class="btn btn-primary" routerLink="/invoices/new" [queryParams]="{ customerId: c.id }"><i class="ti ti-plus" aria-hidden="true"></i>New invoice</a>
          </div>
        </div>

        @if (!c.stateCode) {
          <div class="alert alert-warn" role="status">
            <span>Add this customer's state before invoicing them. It decides whether CGST + SGST or IGST applies.</span>
            <a class="btn" [routerLink]="['/customers', c.id, 'edit']">Add state</a>
          </div>
        }

        <div class="tiles tiles-3">
          <div class="tile"><span class="tile-label">Outstanding</span><span class="tile-value" [class.text-danger]="c.outstanding > 0">{{ c.outstanding | currency }}</span></div>
          <div class="tile"><span class="tile-label">Invoiced</span><span class="tile-value">{{ c.invoiced | currency }}</span></div>
          <div class="tile"><span class="tile-label">Received</span><span class="tile-value text-success">{{ c.received | currency }}</span></div>
          @if (c.credits > 0) {
            <a class="tile tile-link" routerLink="/credit-notes" [queryParams]="{ status: 'open' }"><span class="tile-label">Unused credit</span><span class="tile-value">{{ c.credits | currency }}</span></a>
          }
        </div>

        <div class="grid-sidebar">
          <div>
            <div class="card-head"><h2>Invoices</h2></div>
            <div class="table-card">
              <table class="table">
                <thead><tr><th>Invoice</th><th>Date</th><th>Due</th><th class="num">Total</th><th class="num">Balance</th><th>Status</th></tr></thead>
                <tbody>
                  @for (i of invoices(); track i.id) {
                    <tr class="clickable" (click)="router.navigate(['/invoices', i.id])">
                      <td><a [routerLink]="['/invoices', i.id]" class="strong-link" (click)="$event.stopPropagation()">{{ i.invoiceNumber }}</a></td>
                      <td>{{ i.issueDate | date: 'd MMM y' }}</td>
                      <td>{{ i.dueDate | date: 'd MMM y' }}</td>
                      <td class="num">{{ i.total | currency }}</td>
                      <td class="num">{{ i.lifecycle === 'sent' ? (i.balance | currency) : '—' }}</td>
                      <td><app-status-badge [invoice]="i" /></td>
                    </tr>
                  } @empty {
                    <tr><td colspan="6" class="empty-row">No invoices yet. <a routerLink="/invoices/new" [queryParams]="{ customerId: c.id }">Create the first one</a>.</td></tr>
                  }
                </tbody>
              </table>
            </div>

            <div class="card-head"><h2>Payments</h2></div>
            <div class="table-card">
              <table class="table">
                <thead><tr><th>Payment</th><th>Date</th><th>Mode</th><th>Applied to</th><th class="num">Amount</th></tr></thead>
                <tbody>
                  @for (p of payments(); track p.id) {
                    <tr class="clickable" (click)="router.navigate(['/payments', p.id])">
                      <td><a [routerLink]="['/payments', p.id]" class="strong-link" (click)="$event.stopPropagation()">{{ p.paymentNumber }}</a></td>
                      <td>{{ p.paymentDate | date: 'd MMM y' }}</td>
                      <td>{{ modeLabel[p.mode] }}</td>
                      <td class="sub">{{ p.invoiceNumbers }}</td>
                      <td class="num text-success">{{ p.amount | currency }}</td>
                    </tr>
                  } @empty {
                    <tr><td colspan="5" class="empty-row">No payments recorded yet.</td></tr>
                  }
                </tbody>
              </table>
            </div>
          </div>

          <aside class="card details">
            <h2>Details</h2>
            <dl>
              @if (c.contactPerson) { <dt>Contact</dt><dd>{{ c.contactPerson }}</dd> }
              <dt>Email</dt><dd>{{ c.email || '—' }}</dd>
              <dt>Phone</dt><dd>{{ c.phone || '—' }}</dd>
              <dt>Billing address</dt><dd class="pre">{{ address() || '—' }}</dd>
              <dt>Payment terms</dt><dd>{{ c.paymentTermsDays === null ? 'Business default' : c.paymentTermsDays + ' days' }}</dd>
              @if (c.notes) { <dt>Notes</dt><dd class="pre">{{ c.notes }}</dd> }
            </dl>
            <div class="details-actions">
              <button type="button" class="btn btn-quiet" (click)="toggleArchive()">
                <i class="ti" [class.ti-archive]="!c.archived" [class.ti-archive-off]="c.archived" aria-hidden="true"></i>{{ c.archived ? 'Restore' : 'Archive' }}
              </button>
              @if (!invoices().length && !payments().length) {
                <button type="button" class="btn btn-quiet text-danger" (click)="remove()"><i class="ti ti-trash" aria-hidden="true"></i>Delete</button>
              }
            </div>
          </aside>
        </div>
      }
    </section>
  `,
})
export class CustomerDetail implements OnInit {
  readonly id = input.required<string>();
  private api = inject(Api);
  private toasts = inject(Toasts);
  protected router = inject(Router);
  private meta = toSignal(this.api.meta());
  protected readonly treatment = GST_TREATMENT_LABEL;
  protected readonly modeLabel = MODE_LABEL;

  protected customer = signal<Customer | null>(null);
  protected invoices = signal<Invoice[]>([]);
  protected payments = signal<Payment[]>([]);
  protected error = signal('');

  protected stateName = computed(() => this.meta()?.states.find((s) => s.code === this.customer()?.stateCode)?.name ?? '');
  protected address = computed(() => {
    const c = this.customer();
    return c ? [c.address, [c.city, c.pincode].filter(Boolean).join(' ')].filter(Boolean).join('\n') : '';
  });

  ngOnInit() {
    const id = Number(this.id());
    forkJoin({ c: this.api.customer(id), i: this.api.invoices({ customerId: id }), p: this.api.payments(id) }).subscribe({
      next: ({ c, i, p }) => {
        this.customer.set(c);
        this.invoices.set(i);
        this.payments.set(p);
      },
      error: (e) => this.error.set(errorMessage(e)),
    });
  }

  protected toggleArchive() {
    const c = this.customer()!;
    this.api.archiveCustomer(c.id, !c.archived).subscribe({
      next: (u) => {
        this.customer.set(u);
        this.toasts.show(u.archived ? 'Customer archived. It no longer appears on new invoices.' : 'Customer restored');
      },
      error: (e) => this.toasts.show(errorMessage(e), 'error'),
    });
  }

  protected remove() {
    const c = this.customer()!;
    if (!confirm(`Delete ${c.displayName}? This can't be undone.`)) return;
    this.api.deleteCustomer(c.id).subscribe({
      next: () => {
        this.toasts.show('Customer deleted');
        this.router.navigate(['/customers']);
      },
      error: (e) => this.toasts.show(errorMessage(e), 'error'),
    });
  }
}
