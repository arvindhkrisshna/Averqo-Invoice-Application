import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { Api, errorMessage } from '../../core/api';
import { addDays, daysBetween, todayISO } from '../../core/format';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { Customer, Invoice, InvoiceInput, Item, Unbilled, UnbilledExpense, UnbilledTime } from '../../core/models';
import { Toasts } from '../../core/toast';
import { CustomerPicker } from '../../shared/customer-picker';
import { LinesEditor, lineGroup, linesPayload } from '../../shared/lines-editor';

export const TERM_OPTIONS = [
  { value: '0', label: 'Due on receipt' },
  { value: '7', label: 'Net 7' },
  { value: '15', label: 'Net 15' },
  { value: '30', label: 'Net 30' },
  { value: '45', label: 'Net 45' },
  { value: '60', label: 'Net 60' },
];

@Component({
  selector: 'app-invoice-form',
  imports: [ReactiveFormsModule, RouterLink, CustomerPicker, LinesEditor, CurrencyPipe, DatePipe],
  templateUrl: './invoice-form.html',
})
export class InvoiceForm implements OnInit {
  readonly id = input<string>(); // editing /invoices/:id/edit
  readonly customerId = input<string>(); // ?customerId= from a customer page
  readonly from = input<string>(); // ?from= duplicates an invoice

  private api = inject(Api);
  private router = inject(Router);
  private toasts = inject(Toasts);
  private fb = inject(NonNullableFormBuilder);

  protected readonly termOptions = TERM_OPTIONS;
  protected meta = toSignal(this.api.meta());
  protected org = this.api.org;
  protected customers = signal<Customer[]>([]);
  protected items = signal<Item[]>([]);
  protected existing = signal<Invoice | null>(null);
  protected loading = signal(true);
  protected saving = signal<'' | 'draft' | 'sent'>('');
  protected error = signal('');

  protected form = this.fb.group({
    customerId: this.fb.control<number | null>(null, Validators.required),
    issueDate: [todayISO(), Validators.required],
    terms: ['15'],
    dueDate: [todayISO(15), Validators.required],
    reference: [''],
    notes: [''],
    termsText: [''],
    lines: this.fb.array([lineGroup(this.fb)]),
  });
  private value = toSignal(this.form.valueChanges, { initialValue: this.form.getRawValue() });
  private patching = false;

  protected get lines() {
    return this.form.controls.lines;
  }

  protected customer = computed(() => this.customers().find((c) => c.id === Number(this.value().customerId)) ?? null);
  protected gstRegistered = computed(() => this.org()?.gstRegistered ?? true);
  protected orgReady = computed(() => !!this.org()?.stateCode && !!this.org()?.name);
  protected interState = computed(() => {
    const c = this.customer();
    return !!c?.stateCode && c.stateCode !== this.org()?.stateCode;
  });
  protected rates = computed(() => this.meta()?.gstRates ?? [0, 5, 18, 40]);
  protected isDraft = computed(() => !this.existing() || this.existing()!.lifecycle === 'draft');
  protected title = computed(() => {
    const e = this.existing();
    if (e) return `Edit ${e.invoiceNumber}`;
    return this.from() ? 'Duplicate invoice' : 'New invoice';
  });

  constructor() {
    const f = this.form.controls;
    f.customerId.valueChanges.subscribe(() => {
      if (this.patching) return;
      const c = this.customers().find((x) => x.id === f.customerId.value);
      const days = c?.paymentTermsDays ?? this.org()?.paymentTermsDays;
      if (days !== undefined && days !== null) this.setTerms(days);
    });
    f.customerId.valueChanges.subscribe((id) => this.loadUnbilled(id));
    f.issueDate.valueChanges.subscribe(() => this.recalcDue());
    f.terms.valueChanges.subscribe(() => this.recalcDue());
  }

  ngOnInit() {
    forkJoin({ customers: this.api.customers(), items: this.api.items(), org: this.api.loadOrg() }).subscribe({
      next: ({ customers, items, org }) => {
        this.customers.set(customers);
        this.items.set(items);
        const sourceId = this.id() ?? this.from();
        if (sourceId) {
          this.api.invoice(sourceId).subscribe({
            next: (inv) => this.fillFrom(inv, !!this.id()),
            error: (e) => this.fail(e),
          });
          return;
        }
        this.patching = true;
        this.form.patchValue({ notes: org.invoiceNotes, termsText: org.invoiceTerms });
        this.patching = false;
        this.setTerms(org.paymentTermsDays);
        const cid = Number(this.customerId());
        if (cid) this.form.controls.customerId.setValue(cid);
        this.loading.set(false);
      },
      error: (e) => this.fail(e),
    });
  }

  private fail(e: unknown) {
    this.error.set(errorMessage(e));
    this.loading.set(false);
  }

  /** Loads an invoice into the form, either to edit it or as a template. */
  private fillFrom(inv: Invoice, editing: boolean) {
    this.patching = true;
    if (editing) this.existing.set(inv);
    const issueDate = editing ? inv.issueDate : todayISO();
    const days = daysBetween(inv.issueDate, inv.dueDate);
    this.form.patchValue({
      customerId: inv.customerId,
      issueDate,
      dueDate: addDays(issueDate, days),
      terms: TERM_OPTIONS.some((o) => o.value === String(days)) ? String(days) : 'custom',
      reference: editing ? inv.reference : '',
      notes: inv.notes,
      termsText: inv.terms,
    });
    this.lines.clear();
    // A duplicate must not re-bill hours or expenses already on the original.
    for (const l of inv.lines ?? []) this.lines.push(lineGroup(this.fb, editing ? l : { ...l, timeEntryIds: [], expenseId: null }));
    if (!this.lines.length) this.lines.push(lineGroup(this.fb));
    this.patching = false;
    this.loading.set(false);
    if (inv.lifecycle === 'draft' || !editing) this.loadUnbilled(inv.customerId);
  }

  // ---------- Unbilled hours and expenses ----------

  protected unbilled = signal<Unbilled | null>(null);

  private loadUnbilled(customerId: number | null) {
    this.unbilled.set(null);
    if (!customerId || !this.isDraft()) return;
    this.api.unbilled(customerId).subscribe({ next: (u) => this.unbilled.set(u), error: () => {} });
  }

  /** Unbilled work not already on this invoice. */
  protected offered() {
    const u = this.unbilled();
    if (!u) return { time: [] as UnbilledTime[], expenses: [] as UnbilledExpense[], total: 0 };
    const lines = this.lines.getRawValue();
    const onForm = new Set(lines.flatMap((l) => l.timeEntryIds ?? []));
    const expenses = new Set(lines.map((l) => l.expenseId).filter(Boolean));
    const time = u.time.filter((t) => !t.entryIds.some((id) => onForm.has(id)));
    const ex = u.expenses.filter((e) => !expenses.has(e.id));
    return { time, expenses: ex, total: time.reduce((s, t) => s + t.amount, 0) + ex.reduce((s, e) => s + e.amount, 0) };
  }

  private pushLine(l: Parameters<typeof lineGroup>[1]) {
    const last = this.lines.at(this.lines.length - 1);
    if (this.lines.length === 1 && last && !last.controls.description.value.trim() && !Number(last.controls.rate.value)) this.lines.removeAt(0);
    this.lines.push(lineGroup(this.fb, l));
  }

  protected addTime(t: UnbilledTime) {
    const range = t.from === t.to ? t.from : `${t.from} to ${t.to}`;
    this.pushLine({ description: `${t.projectName}: ${t.hours} hrs (${range})`, hsnSac: t.sac, unit: 'hrs', quantity: t.hours,
      rate: t.rate, discountPct: 0, taxRate: this.gstRegistered() ? t.taxRate : 0, timeEntryIds: t.entryIds });
  }

  protected addExpense(e: UnbilledExpense) {
    this.pushLine({ description: e.description, hsnSac: e.hsnSac, unit: 'nos', quantity: 1, rate: e.amount, discountPct: 0,
      taxRate: this.gstRegistered() ? e.taxRate : 0, expenseId: e.id });
  }

  protected addAllUnbilled() {
    const o = this.offered();
    o.time.forEach((t) => this.addTime(t));
    o.expenses.forEach((e) => this.addExpense(e));
  }

  // ---------- Dates and terms ----------

  private setTerms(days: number) {
    const v = String(days);
    this.form.controls.terms.setValue(TERM_OPTIONS.some((o) => o.value === v) ? v : 'custom', { emitEvent: false });
    this.form.controls.dueDate.setValue(addDays(this.form.controls.issueDate.value, days));
  }

  private recalcDue() {
    if (this.patching) return;
    const t = this.form.controls.terms.value;
    if (t !== 'custom') this.form.controls.dueDate.setValue(addDays(this.form.controls.issueDate.value, Number(t)));
  }

  protected dueEdited() {
    const days = daysBetween(this.form.controls.issueDate.value, this.form.controls.dueDate.value);
    const v = String(days);
    this.form.controls.terms.setValue(TERM_OPTIONS.some((o) => o.value === v) ? v : 'custom', { emitEvent: false });
  }

  // ---------- Save ----------

  protected save(status: 'draft' | 'sent') {
    this.error.set('');
    const v = this.form.getRawValue();
    if (!v.customerId) {
      this.error.set('Choose a customer, or add a new one.');
      return;
    }
    const lines = linesPayload(this.lines, this.gstRegistered());
    if (!lines.length) {
      this.error.set('Add at least one line item.');
      return;
    }
    const body: InvoiceInput = {
      customerId: v.customerId, issueDate: v.issueDate, dueDate: v.dueDate, reference: v.reference,
      notes: v.notes, terms: v.termsText, status, lines,
    };
    this.saving.set(status);
    const existing = this.existing();
    this.api.saveInvoice(body, existing?.id).subscribe({
      next: (inv) => {
        const verb = existing ? 'updated' : status === 'draft' ? 'saved as a draft' : 'created';
        this.toasts.show(`${inv.invoiceNumber} ${verb}`);
        this.router.navigate(['/invoices', inv.id]);
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.saving.set('');
      },
    });
  }

  protected cancelLink() {
    return this.existing() ? ['/invoices', this.existing()!.id] : ['/invoices'];
  }
}
