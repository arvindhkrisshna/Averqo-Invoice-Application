import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { Api, errorMessage } from '../../core/api';
import { FREQUENCY_LABEL, todayISO } from '../../core/format';
import { Customer, Frequency, Item, RecurringProfile } from '../../core/models';
import { Toasts } from '../../core/toast';
import { CustomerPicker } from '../../shared/customer-picker';
import { LinesEditor, lineGroup, linesPayload } from '../../shared/lines-editor';
import { TERM_OPTIONS } from '../invoices/invoice-form';

@Component({
  selector: 'app-recurring-form',
  imports: [ReactiveFormsModule, RouterLink, CustomerPicker, LinesEditor],
  template: `
    <section class="page page-wide">
      <div class="page-head">
        <div>
          <a class="back" [routerLink]="existing() ? ['/recurring-invoices', existing()!.id] : ['/recurring-invoices']"><i class="ti ti-arrow-left" aria-hidden="true"></i>{{ existing()?.profileName ?? 'Recurring invoices' }}</a>
          <h1>{{ existing() ? 'Edit schedule' : 'New recurring schedule' }}</h1>
        </div>
      </div>

      @if (loading()) {
        <p class="muted">Loading…</p>
      } @else {
        <form [formGroup]="form" novalidate>
          <div class="card form-card">
            <div class="form-grid form-grid-4">
              <label class="field span-2"><span>Schedule name</span><input type="text" formControlName="profileName" placeholder="e.g. Monthly retainer" maxlength="100" /></label>
              <div class="field span-2">
                <label for="customer">Customer</label>
                <app-customer-picker [control]="form.controls.customerId" [(customers)]="customers" [states]="meta()?.states ?? []"
                  [orgState]="org()?.stateCode ?? ''" [gstRegistered]="gstRegistered()" />
              </div>
              <label class="field">
                <span>How often</span>
                <select formControlName="frequency">
                  @for (f of frequencies; track f[0]) { <option [value]="f[0]">{{ f[1] }}</option> }
                </select>
              </label>
              <label class="field"><span>First invoice date</span><input type="date" formControlName="startDate" [min]="existing() ? '' : today" /></label>
              <label class="field"><span>End date <small class="muted">(optional)</small></span><input type="date" formControlName="endDate" /></label>
              <label class="field">
                <span>Payment terms</span>
                <select formControlName="paymentTermsDays">
                  @for (o of termOptions; track o.value) { <option [value]="o.value">{{ o.label }}</option> }
                </select>
              </label>
            </div>
            <fieldset class="radio-group">
              <legend>Each new invoice is</legend>
              <label class="check"><input type="radio" formControlName="createAs" value="draft" /><span><strong>A draft</strong> to check before sending</span></label>
              <label class="check"><input type="radio" formControlName="createAs" value="sent" /><span><strong>Ready to send</strong>, counted as owed straight away</span></label>
            </fieldset>
            <p class="hint">{{ scheduleHint() }}</p>
          </div>

          <div class="card form-card">
            <div class="card-head"><h2>Items on each invoice</h2><span class="muted">The same lines are used every time. GST follows the customer's state on each date.</span></div>
            <app-lines-editor [lines]="lines" [(items)]="items" [interState]="interState()" [gstRegistered]="gstRegistered()" [rates]="rates()" />
          </div>

          <div class="card form-card">
            <div class="form-grid">
              <label class="field"><span>Reference <small class="muted">(optional)</small></span><input type="text" formControlName="reference" /></label>
              <span></span>
              <label class="field"><span>Notes for the customer</span><textarea formControlName="notes" rows="3"></textarea></label>
              <label class="field"><span>Terms and conditions</span><textarea formControlName="termsText" rows="3"></textarea></label>
            </div>
          </div>

          @if (error()) { <div class="alert" role="alert"><span>{{ error() }}</span></div> }
          <div class="form-actions sticky-actions">
            <a class="btn" [routerLink]="existing() ? ['/recurring-invoices', existing()!.id] : ['/recurring-invoices']">Cancel</a>
            <button type="button" class="btn btn-primary" [disabled]="saving()" (click)="save()">{{ saving() ? 'Saving…' : existing() ? 'Save changes' : 'Start schedule' }}</button>
          </div>
        </form>
      }
    </section>
  `,
})
export class RecurringForm implements OnInit {
  readonly id = input<string>();
  readonly customerId = input<string>();

  private api = inject(Api);
  private router = inject(Router);
  private toasts = inject(Toasts);
  private fb = inject(NonNullableFormBuilder);

  protected readonly frequencies = Object.entries(FREQUENCY_LABEL);
  protected readonly termOptions = TERM_OPTIONS;
  protected readonly today = todayISO();
  protected meta = toSignal(this.api.meta());
  protected org = this.api.org;
  protected customers = signal<Customer[]>([]);
  protected items = signal<Item[]>([]);
  protected existing = signal<RecurringProfile | null>(null);
  protected loading = signal(true);
  protected saving = signal(false);
  protected error = signal('');

  protected form = this.fb.group({
    profileName: ['', Validators.required],
    customerId: this.fb.control<number | null>(null, Validators.required),
    frequency: this.fb.control<Frequency>('monthly'),
    startDate: [todayISO()],
    endDate: [''],
    paymentTermsDays: ['15'],
    createAs: this.fb.control<'draft' | 'sent'>('draft'),
    reference: [''],
    notes: [''],
    termsText: [''],
    lines: this.fb.array([lineGroup(this.fb)]),
  });
  private value = toSignal(this.form.valueChanges, { initialValue: this.form.getRawValue() });

  protected get lines() {
    return this.form.controls.lines;
  }

  protected customer = computed(() => this.customers().find((c) => c.id === Number(this.value().customerId)) ?? null);
  protected gstRegistered = computed(() => this.org()?.gstRegistered ?? true);
  protected interState = computed(() => {
    const c = this.customer();
    return !!c?.stateCode && c.stateCode !== this.org()?.stateCode;
  });
  protected rates = computed(() => this.meta()?.gstRates ?? [0, 5, 18, 40]);
  protected scheduleHint = computed(() => {
    const v = this.value();
    const start = v.startDate ? new Date(v.startDate + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    const often = (FREQUENCY_LABEL[v.frequency ?? 'monthly'] ?? '').toLowerCase();
    const first = v.startDate === this.today && !this.existing() ? 'The first invoice is created as soon as you save' : `The first invoice is on ${start}`;
    return `${first}, then ${often}${v.endDate ? ' until ' + new Date(v.endDate + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : ', until you pause or end it'}. On the 29th to 31st, shorter months use their last day.`;
  });

  constructor() {
    this.form.controls.customerId.valueChanges.subscribe((id) => {
      const c = this.customers().find((x) => x.id === id);
      if (!this.existing() && c) {
        const days = String(c.paymentTermsDays ?? this.org()?.paymentTermsDays ?? 15);
        if (TERM_OPTIONS.some((o) => o.value === days)) this.form.controls.paymentTermsDays.setValue(days);
      }
    });
  }

  ngOnInit() {
    forkJoin({
      customers: this.api.customers(), items: this.api.items(), org: this.api.loadOrg(),
      existing: this.id() ? this.api.recurring(this.id()!) : of(null),
    }).subscribe({
      next: ({ customers, items, org, existing }) => {
        this.customers.set(customers);
        this.items.set(items);
        if (existing) {
          this.existing.set(existing);
          this.form.patchValue({
            profileName: existing.profileName, customerId: existing.customerId, frequency: existing.frequency,
            startDate: existing.startDate, endDate: existing.endDate ?? '', paymentTermsDays: String(existing.paymentTermsDays),
            createAs: existing.createAs, reference: existing.reference, notes: existing.notes, termsText: existing.terms,
          });
          this.lines.clear();
          for (const l of existing.lines ?? []) this.lines.push(lineGroup(this.fb, l));
          if (!this.lines.length) this.lines.push(lineGroup(this.fb));
        } else {
          this.form.patchValue({ notes: org.invoiceNotes, termsText: org.invoiceTerms, paymentTermsDays: String(org.paymentTermsDays) });
          if (Number(this.customerId())) this.form.controls.customerId.setValue(Number(this.customerId()));
        }
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.loading.set(false);
      },
    });
  }

  protected save() {
    this.error.set('');
    const v = this.form.getRawValue();
    if (!v.profileName.trim()) {
      this.error.set('Give this schedule a short name, like "Monthly retainer".');
      return;
    }
    if (!v.customerId) {
      this.error.set('Choose a customer, or add a new one.');
      return;
    }
    const lines = linesPayload(this.lines, this.gstRegistered());
    if (!lines.length) {
      this.error.set('Add at least one line item.');
      return;
    }
    this.saving.set(true);
    const existing = this.existing();
    this.api.saveRecurring({
      profileName: v.profileName, customerId: v.customerId, frequency: v.frequency, startDate: v.startDate, endDate: v.endDate,
      createAs: v.createAs, paymentTermsDays: Number(v.paymentTermsDays), reference: v.reference, notes: v.notes, terms: v.termsText, lines,
    }, existing?.id).subscribe({
      next: (p) => {
        this.toasts.show(existing ? 'Schedule updated' : p.invoiceCount ? `Schedule started. The first invoice has been created.` : 'Schedule started');
        this.router.navigate(['/recurring-invoices', p.id]);
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.saving.set(false);
      },
    });
  }
}
