import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { Api, errorMessage } from '../../core/api';
import { addDays, todayISO } from '../../core/format';
import { DOC_KINDS } from '../../core/kinds';
import { Customer, DocType, Invoice, Item, SalesDoc, SalesDocInput } from '../../core/models';
import { Toasts } from '../../core/toast';
import { CustomerPicker } from '../../shared/customer-picker';
import { LinesEditor, lineGroup, linesPayload } from '../../shared/lines-editor';

@Component({
  selector: 'app-doc-form',
  imports: [ReactiveFormsModule, RouterLink, CustomerPicker, LinesEditor],
  templateUrl: './doc-form.html',
})
export class DocForm implements OnInit {
  readonly kind = input<DocType>('quote');
  readonly id = input<string>(); // editing
  readonly customerId = input<string>(); // ?customerId=
  readonly invoiceId = input<string>(); // credit notes: ?invoiceId= starts from that invoice
  readonly from = input<string>(); // ?from= duplicates a document

  private api = inject(Api);
  private router = inject(Router);
  private toasts = inject(Toasts);
  private fb = inject(NonNullableFormBuilder);

  protected meta = toSignal(this.api.meta());
  protected org = this.api.org;
  protected customers = signal<Customer[]>([]);
  protected items = signal<Item[]>([]);
  protected invoices = signal<Invoice[]>([]); // the customer's sent invoices (credit notes)
  protected existing = signal<SalesDoc | null>(null);
  protected loading = signal(true);
  protected saving = signal('');
  protected error = signal('');

  protected form = this.fb.group({
    customerId: this.fb.control<number | null>(null, Validators.required),
    issueDate: [todayISO(), Validators.required],
    expiryDate: [''],
    challanType: ['supply_on_approval'],
    reason: ['sales_return'],
    invoiceId: this.fb.control<number | null>(null),
    applyToInvoice: [true],
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

  protected k = computed(() => DOC_KINDS[this.kind()]);
  protected customer = computed(() => this.customers().find((c) => c.id === Number(this.value().customerId)) ?? null);
  protected gstRegistered = computed(() => this.org()?.gstRegistered ?? true);
  protected orgReady = computed(() => !!this.org()?.stateCode && !!this.org()?.name);
  protected interState = computed(() => {
    const c = this.customer();
    return !!c?.stateCode && c.stateCode !== this.org()?.stateCode;
  });
  protected rates = computed(() => this.meta()?.gstRates ?? [0, 5, 18, 40]);
  protected isDraft = computed(() => !this.existing() || this.existing()!.status === 'draft');
  protected linkedInvoice = computed(() => this.invoices().find((i) => i.id === Number(this.value().invoiceId)) ?? null);
  protected title = computed(() => {
    const e = this.existing();
    return e ? `Edit ${e.number}` : `New ${this.k().label.toLowerCase()}`;
  });

  constructor() {
    const f = this.form.controls;
    f.customerId.valueChanges.subscribe((id) => {
      if (this.kind() === 'credit_note') this.loadInvoices(id);
      if (!this.patching && this.kind() === 'credit_note') f.invoiceId.setValue(null);
    });
    f.issueDate.valueChanges.subscribe((d) => {
      if (this.patching || this.kind() !== 'quote' || !d) return;
      f.expiryDate.setValue(addDays(d, this.org()?.quoteValidityDays ?? 15));
    });
  }

  ngOnInit() {
    const sourceId = this.id() ?? this.from();
    forkJoin({
      customers: this.api.customers(),
      items: this.api.items(),
      org: this.api.loadOrg(),
      source: sourceId ? this.api.doc(this.k().path, sourceId) : of(null),
      invoice: this.invoiceId() ? this.api.invoice(this.invoiceId()!) : of(null),
    }).subscribe({
      next: ({ customers, items, org, source, invoice }) => {
        this.customers.set(customers);
        this.items.set(items);
        this.patching = true;
        if (source) {
          this.fill(source, !!this.id());
        } else {
          if (this.kind() === 'quote') {
            this.form.patchValue({ notes: org.quoteNotes, termsText: org.quoteTerms, expiryDate: addDays(todayISO(), org.quoteValidityDays) });
          }
          if (invoice) this.startFromInvoice(invoice);
          else if (Number(this.customerId())) this.form.controls.customerId.setValue(Number(this.customerId()));
        }
        this.patching = false;
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.loading.set(false);
      },
    });
  }

  private fill(d: SalesDoc, editing: boolean) {
    if (editing) this.existing.set(d);
    this.form.patchValue({
      customerId: d.customerId, issueDate: editing ? d.issueDate : todayISO(), expiryDate: d.expiryDate ?? '',
      challanType: d.challanType || 'supply_on_approval', reason: d.reason || 'sales_return', invoiceId: d.invoiceId,
      applyToInvoice: false, reference: editing ? d.reference : '', notes: d.notes, termsText: d.terms,
    });
    if (!editing && this.kind() === 'quote') this.form.controls.expiryDate.setValue(addDays(todayISO(), this.org()?.quoteValidityDays ?? 15));
    this.setLines(d.lines ?? []);
  }

  /** A credit note from an invoice starts with that invoice's lines; remove what isn't being credited. */
  private startFromInvoice(inv: Invoice) {
    this.form.patchValue({ customerId: inv.customerId, invoiceId: inv.id, reference: '' });
    this.setLines(inv.lines ?? []);
  }

  private setLines(lines: SalesDoc['lines'] & object) {
    this.lines.clear();
    for (const l of lines) this.lines.push(lineGroup(this.fb, l));
    if (!this.lines.length) this.lines.push(lineGroup(this.fb));
  }

  private loadInvoices(customerId: number | null) {
    if (!customerId) {
      this.invoices.set([]);
      return;
    }
    this.api.invoices({ customerId }).subscribe({
      next: (list) => this.invoices.set(list.filter((i) => i.lifecycle === 'sent')),
      error: () => this.invoices.set([]),
    });
  }

  protected save(issue: boolean) {
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
    const k = this.k();
    const body: SalesDocInput = {
      customerId: v.customerId, issueDate: v.issueDate, expiryDate: k.type === 'quote' ? v.expiryDate : '',
      reference: v.reference, notes: v.notes, terms: v.termsText, status: issue ? k.issued : 'draft',
      challanType: k.type === 'challan' ? v.challanType : '', reason: k.type === 'credit_note' ? v.reason : '',
      invoiceId: k.type === 'credit_note' ? v.invoiceId : null,
      applyToInvoice: k.type === 'credit_note' && issue && !!v.invoiceId && v.applyToInvoice, lines,
    };
    this.saving.set(issue ? 'issue' : 'draft');
    const existing = this.existing();
    this.api.saveDoc(k.path, body, existing?.id).subscribe({
      next: (d) => {
        const verb = existing ? 'updated' : issue ? 'created' : 'saved as a draft';
        this.toasts.show(`${d.number} ${verb}${d.applied > 0 && !existing ? ` and used on ${this.linkedInvoice()?.invoiceNumber}` : ''}`);
        this.router.navigate([k.route, d.id]);
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.saving.set('');
      },
    });
  }

  protected cancelLink() {
    const e = this.existing();
    return e ? [this.k().route, e.id] : this.invoiceId() ? ['/invoices', this.invoiceId()] : [this.k().route];
  }
}
