import { CurrencyPipe, DatePipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api, errorMessage } from '../../core/api';
import { FREQUENCY_LABEL } from '../../core/format';
import { RecurringProfile } from '../../core/models';

export const RECURRING_STATUS: Record<string, { label: string; tone: string }> = {
  active: { label: 'Active', tone: 'paid' },
  paused: { label: 'Paused', tone: 'partial' },
  ended: { label: 'Ended', tone: 'void' },
};

@Component({
  selector: 'app-recurring-list',
  imports: [RouterLink, CurrencyPipe, DatePipe],
  template: `
    <section class="page page-wide">
      <div class="page-head">
        <div>
          <h1>Recurring invoices</h1>
          <p class="muted">Invoices created automatically on a schedule, for retainers, rent, and subscriptions.</p>
        </div>
        <div class="head-actions">
          <a class="btn btn-primary" routerLink="/recurring-invoices/new"><i class="ti ti-plus" aria-hidden="true"></i>New schedule</a>
        </div>
      </div>

      @if (error()) {
        <div class="alert" role="alert"><span>{{ error() }}</span><button type="button" class="btn" (click)="load()">Try again</button></div>
      } @else if (loading()) {
        <p class="muted">Loading…</p>
      } @else if (!list().length) {
        <div class="empty">
          <i class="ti ti-repeat" aria-hidden="true"></i>
          <h2>Bill regular customers automatically</h2>
          <p>Set up the invoice once, choose how often, and Averqo creates each one on its date, as a draft to check or ready to send.</p>
          <a class="btn btn-primary" routerLink="/recurring-invoices/new">New schedule</a>
        </div>
      } @else {
        <div class="alert alert-info" role="status">
          <span>Invoices are created while Averqo's backend is running. If your Codespace was stopped on a due date, the missed invoices are created, with their original dates, the next time it starts.</span>
        </div>
        <div class="table-card">
          <table class="table">
            <thead>
              <tr><th>Schedule</th><th>Customer</th><th>How often</th><th>Next invoice</th><th class="num">Amount</th><th class="num">Created</th><th>Status</th></tr>
            </thead>
            <tbody>
              @for (p of list(); track p.id) {
                <tr class="clickable" (click)="router.navigate(['/recurring-invoices', p.id])">
                  <td><a [routerLink]="['/recurring-invoices', p.id]" class="strong-link" (click)="$event.stopPropagation()">{{ p.profileName }}</a>
                    @if (p.lastError) { <div class="sub text-danger"><i class="ti ti-alert-triangle" aria-hidden="true"></i> Needs attention</div> }</td>
                  <td>{{ p.customerName }}</td>
                  <td>{{ freq[p.frequency] }}</td>
                  <td>{{ p.status === 'active' && p.nextRunDate ? (p.nextRunDate | date: 'd MMM y') : '—' }}</td>
                  <td class="num">{{ p.subtotal | currency }}<div class="sub">+ GST</div></td>
                  <td class="num">{{ p.invoiceCount }}</td>
                  <td><span class="badge" [attr.data-tone]="status[p.status].tone">{{ status[p.status].label }}</span></td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
})
export class RecurringList implements OnInit {
  private api = inject(Api);
  protected router = inject(Router);
  protected readonly freq = FREQUENCY_LABEL;
  protected readonly status = RECURRING_STATUS;
  protected list = signal<RecurringProfile[]>([]);
  protected loading = signal(true);
  protected error = signal('');

  ngOnInit() {
    this.load();
  }

  protected load() {
    this.loading.set(true);
    this.api.recurringList().subscribe({
      next: (l) => {
        this.list.set(l);
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.loading.set(false);
      },
    });
  }
}
