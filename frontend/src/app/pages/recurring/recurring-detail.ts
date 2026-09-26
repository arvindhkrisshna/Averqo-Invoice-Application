import { CurrencyPipe, DatePipe } from '@angular/common';
import { Component, OnInit, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api, errorMessage } from '../../core/api';
import { FREQUENCY_LABEL } from '../../core/format';
import { Invoice, RecurringProfile } from '../../core/models';
import { Toasts } from '../../core/toast';
import { ActivityList } from '../../shared/activity-list';
import { StatusBadge } from '../../shared/status-badge';
import { RECURRING_STATUS } from './recurring-list';

@Component({
  selector: 'app-recurring-detail',
  imports: [RouterLink, CurrencyPipe, DatePipe, StatusBadge, ActivityList],
  template: `
    <section class="page page-wide">
      @if (error()) {
        <div class="alert" role="alert"><span>{{ error() }}</span><a class="btn" routerLink="/recurring-invoices">Back</a></div>
      } @else if (!p()) {
        <p class="muted">Loading…</p>
      } @else {
        @let r = p()!;
        <div class="page-head">
          <div>
            <a class="back" routerLink="/recurring-invoices"><i class="ti ti-arrow-left" aria-hidden="true"></i>Recurring invoices</a>
            <h1>{{ r.profileName }} <span class="badge" [attr.data-tone]="status[r.status].tone">{{ status[r.status].label }}</span></h1>
            <p class="muted"><a [routerLink]="['/customers', r.customerId]">{{ r.customerName }}</a> · {{ freq[r.frequency] }} · {{ r.subtotal | currency }} + GST</p>
          </div>
          <div class="head-actions">
            <a class="btn" [routerLink]="['/recurring-invoices', r.id, 'edit']"><i class="ti ti-pencil" aria-hidden="true"></i>Edit</a>
            <button type="button" class="btn btn-quiet text-danger" (click)="remove()"><i class="ti ti-trash" aria-hidden="true"></i>Delete</button>
            @if (r.status === 'active') {
              <button type="button" class="btn" [disabled]="busy()" (click)="setStatus('paused')"><i class="ti ti-player-pause" aria-hidden="true"></i>Pause</button>
              <button type="button" class="btn btn-primary" [disabled]="busy()" (click)="runNow()"><i class="ti ti-bolt" aria-hidden="true"></i>Create next invoice now</button>
            } @else if (r.status === 'paused') {
              <button type="button" class="btn btn-primary" [disabled]="busy()" (click)="setStatus('active')"><i class="ti ti-player-play" aria-hidden="true"></i>Resume</button>
            }
          </div>
        </div>

        @if (r.lastError) {
          <div class="alert" role="alert"><span><strong>The last invoice couldn't be created:</strong> {{ r.lastError }} Fix it, then use "Create next invoice now" or wait for the next check.</span></div>
        }

        <div class="stat-grid">
          <div class="stat"><span class="stat-label">Next invoice</span><strong>{{ r.status === 'active' && r.nextRunDate ? (r.nextRunDate | date: 'd MMM y') : '—' }}</strong>
            <span class="muted">{{ r.status === 'paused' ? 'Paused. Missed dates are skipped when resumed.' : r.status === 'ended' ? 'This schedule has ended' : 'Created as ' + (r.createAs === 'draft' ? 'a draft' : 'ready to send') }}</span></div>
          <div class="stat"><span class="stat-label">Started</span><strong>{{ r.startDate | date: 'd MMM y' }}</strong><span class="muted">{{ r.endDate ? 'Ends ' + (r.endDate | date: 'd MMM y') : 'No end date' }}</span></div>
          <div class="stat"><span class="stat-label">Invoices created</span><strong>{{ r.invoiceCount }}</strong><span class="muted">Payment due {{ r.paymentTermsDays ? r.paymentTermsDays + ' days after each date' : 'on receipt' }}</span></div>
        </div>

        <div class="detail-grid">
          <div class="card">
            <div class="card-head"><h2>Invoices from this schedule</h2></div>
            @if (!invoices().length) {
              <p class="empty-inline">None yet. The first one is created on {{ r.nextRunDate | date: 'd MMM y' }}.</p>
            } @else {
              <ul class="rows">
                @for (i of invoices(); track i.id) {
                  <li><a [routerLink]="['/invoices', i.id]">
                    <span class="row-main"><strong>{{ i.invoiceNumber }}</strong> <span class="muted">{{ i.issueDate | date: 'd MMM y' }}</span></span>
                    <span class="num">{{ i.total | currency }}</span>
                    <app-status-badge [invoice]="i" />
                  </a></li>
                }
              </ul>
            }
            <h3 class="subhead">Items on each invoice</h3>
            <ul class="rows">
              @for (l of r.lines; track $index) {
                <li><div class="row-static"><span class="row-main">{{ l.description }} <span class="muted">{{ l.quantity }} {{ l.unit }} × {{ l.rate | currency }}@if (l.taxRate) { · GST {{ l.taxRate }}% }</span></span></div></li>
              }
            </ul>
          </div>
          <app-activity-list [entries]="r.activity ?? []" />
        </div>
      }
    </section>
  `,
})
export class RecurringDetail implements OnInit {
  readonly id = input.required<string>();
  private api = inject(Api);
  private router = inject(Router);
  private toasts = inject(Toasts);
  protected readonly freq = FREQUENCY_LABEL;
  protected readonly status = RECURRING_STATUS;
  protected p = signal<RecurringProfile | null>(null);
  protected invoices = signal<Invoice[]>([]);
  protected error = signal('');
  protected busy = signal(false);

  ngOnInit() {
    this.load();
  }

  private load() {
    this.api.recurring(this.id()).subscribe({
      next: (p) => this.p.set(p),
      error: (e) => this.error.set(errorMessage(e)),
    });
    this.api.recurringInvoices(Number(this.id())).subscribe({ next: (l) => this.invoices.set(l), error: () => {} });
  }

  protected setStatus(s: 'active' | 'paused') {
    this.busy.set(true);
    this.api.setRecurringStatus(this.p()!.id, s).subscribe({
      next: (p) => {
        this.p.set(p);
        this.busy.set(false);
        this.toasts.show(s === 'paused' ? 'Schedule paused' : 'Schedule resumed');
        this.load();
      },
      error: (e) => {
        this.busy.set(false);
        this.toasts.show(errorMessage(e), 'error');
      },
    });
  }

  protected runNow() {
    this.busy.set(true);
    this.api.runRecurring(this.p()!.id).subscribe({
      next: (inv) => {
        this.busy.set(false);
        this.toasts.show(`${inv.invoiceNumber} created`);
        this.load();
      },
      error: (e) => {
        this.busy.set(false);
        this.toasts.show(errorMessage(e), 'error');
        this.load();
      },
    });
  }

  protected remove() {
    const r = this.p()!;
    if (!confirm(`Delete the schedule "${r.profileName}"? Invoices it already created are kept.`)) return;
    this.api.deleteRecurring(r.id).subscribe({
      next: () => {
        this.toasts.show('Schedule deleted');
        this.router.navigate(['/recurring-invoices']);
      },
      error: (e) => this.toasts.show(errorMessage(e), 'error'),
    });
  }
}
