import { CurrencyPipe } from '@angular/common';
import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { forkJoin, map, startWith } from 'rxjs';
import { Api, errorMessage } from '../../core/api';
import { calcLine, todayISO, validGstin } from '../../core/format';
import { Customer, Expense, ExpenseCategory, ExpenseInput, Vendor } from '../../core/models';
import { Toasts } from '../../core/toast';

const roundDiv = (a: number, b: number) => Math.floor((2 * a + b) / (2 * b));

@Component({
  selector: 'app-expense-form',
  imports: [ReactiveFormsModule, RouterLink, CurrencyPipe],
  template: `
    <section class="page page-wide">
      <div class="page-head">
        <div>
          <a class="back" routerLink="/expenses"><i class="ti ti-arrow-left" aria-hidden="true"></i>Expenses</a>
          <h1>{{ existing() ? 'Expense' : 'Record expense' }}</h1>
        </div>
        @if (existing(); as e) {
          <div class="head-actions">
            <button type="button" class="btn" (click)="remove()" [disabled]="!!e.invoiceId"><i class="ti ti-trash" aria-hidden="true"></i>Delete</button>
          </div>
        }
      </div>

      @if (loading()) {
        <p class="muted">Loading…</p>
      } @else {
        @if (existing()?.invoiceId) {
          <div class="alert alert-info"><span>This expense is billed on
            <a [routerLink]="['/invoices', existing()!.invoiceId]" class="strong-link">{{ existing()!.invoiceNumber }}</a>.
            Its customer can't change unless you remove it from that invoice.</span></div>
        }
        <form [formGroup]="form" (ngSubmit)="save()" novalidate class="side-form">
          <div>
            <div class="card form-card">
              <h2>What you paid</h2>
              <div class="form-grid">
                <label class="field"><span>Date</span><input type="date" formControlName="date" /></label>
                <label class="field"><span>Category</span>
                  <select formControlName="categoryId">
                    <option [ngValue]="null" disabled>Choose a category</option>
                    @for (c of categoryOptions(); track c.id) { <option [ngValue]="c.id">{{ c.name }}</option> }
                  </select>
                </label>
                <label class="field"><span>Amount (₹)</span>
                  <input type="number" formControlName="amount" min="0" step="0.01" inputmode="decimal" placeholder="0.00" /></label>
                <div class="field">
                  <span>The amount is</span>
                  <div class="segmented" role="radiogroup" aria-label="Does the amount include GST">
                    <label><input type="radio" formControlName="amountIncludesTax" [value]="true" /> Including GST</label>
                    <label><input type="radio" formControlName="amountIncludesTax" [value]="false" /> Before GST</label>
                  </div>
                  @if (value().reverseCharge) { <small class="hint">Under reverse charge the bill has no GST, so the amount is before GST.</small> }
                </div>
                <label class="field"><span>GST rate on the bill</span>
                  <select formControlName="gstRate">@for (r of rates(); track r) { <option [ngValue]="r">{{ r }}%</option> }</select></label>
                <label class="field"><span>Paid through</span>
                  <select formControlName="paidThrough">@for (m of modes(); track m.value) { <option [value]="m.value">{{ m.label }}</option> }</select></label>
                <label class="field"><span>Reference <em class="sub">(optional)</em></span><input type="text" formControlName="reference" maxlength="100" placeholder="UPI or cheque number" /></label>
                <label class="field"><span>HSN/SAC <em class="sub">(optional)</em></span><input type="text" formControlName="hsnSac" class="mono" maxlength="8" inputmode="numeric" /></label>
                <label class="field span-2"><span>Description <em class="sub">(optional)</em></span><input type="text" formControlName="description" maxlength="500" placeholder="What was this for?" /></label>
              </div>
            </div>

            <div class="card form-card">
              <h2>Vendor</h2>
              <datalist id="vendor-options">@for (v of vendors(); track v.name) { <option [value]="v.name"></option> }</datalist>
              <div class="form-grid">
                <label class="field span-2"><span>Vendor name <em class="sub">(optional)</em></span><input type="text" formControlName="vendorName" list="vendor-options" maxlength="255" /></label>
                <label class="field"><span>Vendor GSTIN <em class="sub">(for claiming GST)</em></span>
                  <input type="text" formControlName="vendorGstin" class="mono upper" maxlength="15" placeholder="33ABCDE1234F1Z5" />
                  @if (gstinBad()) { <small class="field-error">This GSTIN isn't valid. Check it against the bill.</small> }</label>
                <label class="field"><span>Vendor's state</span>
                  <select formControlName="vendorState">
                    <option value="">Same as your business</option>
                    @for (s of states(); track s.code) { <option [value]="s.code">{{ s.name }}</option> }
                  </select></label>
                <label class="field"><span>Bill number <em class="sub">(optional)</em></span><input type="text" formControlName="billNumber" maxlength="50" /></label>
              </div>
            </div>

            @if (gstRegistered()) {
              <div class="card form-card">
                <h2>GST</h2>
                <label class="check"><input type="checkbox" formControlName="itcEligible" />
                  <span>Claim this GST back (input tax credit)<small class="hint">Leave this off for things you can't claim, like food and personal use.</small></span></label>
                <label class="check"><input type="checkbox" formControlName="reverseCharge" />
                  <span>Reverse charge<small class="hint">You pay this GST to the government instead of the vendor, for example on legal fees or goods transport. It's shown in GSTR-3B.</small></span></label>
                @if (value().itcEligible && !value().reverseCharge && breakdown().tax > 0 && !validGstin(value().vendorGstin)) {
                  <p class="alert alert-warn"><span>Add the vendor's GSTIN to claim this GST. Without it, GST filing leaves it out of your input tax credit.</span></p>
                }
              </div>
            }

            <div class="card form-card">
              <h2>Bill to a customer</h2>
              <label class="check"><input type="checkbox" formControlName="billable" />
                <span>Bill this expense to a customer<small class="hint">It's offered on their next invoice, at the amount before GST plus any markup.</small></span></label>
              @if (value().billable) {
                <div class="form-grid">
                  <label class="field"><span>Customer</span>
                    <select formControlName="customerId">
                      <option [ngValue]="null" disabled>Choose a customer</option>
                      @for (c of customerOptions(); track c.id) { <option [ngValue]="c.id">{{ c.displayName }}</option> }
                    </select></label>
                  <label class="field"><span>Markup %</span><input type="number" formControlName="markupPct" min="0" max="1000" step="0.01" /></label>
                </div>
              }
            </div>

            <div class="card form-card">
              <h2>Receipt</h2>
              @if (existing()?.receiptName) {
                <div class="attach">
                  <a [href]="'/api/expenses/' + existing()!.id + '/receipt'" target="_blank" rel="noopener" class="strong-link"><i class="ti ti-paperclip" aria-hidden="true"></i>{{ existing()!.receiptName }}</a>
                  <button type="button" class="link-btn" (click)="removeReceipt()">Remove</button>
                </div>
              }
              <label class="field"><span>{{ existing()?.receiptName ? 'Replace with another file' : 'Attach the bill or receipt' }}</span>
                <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" (change)="pickFile($event)" />
                <small class="hint">JPG, PNG, WebP, or PDF, up to 5 MB. {{ existing() ? 'It uploads straight away.' : 'It uploads when you save.' }}</small></label>
              @if (pendingFile(); as f) { <p class="sub">Ready to upload: {{ f.name }}</p> }
            </div>
          </div>

          <aside>
            <div class="card summary-card">
              <h2>Summary</h2>
              <dl class="sum-list">
                <div><dt>Before GST</dt><dd>{{ breakdown().subtotal | currency }}</dd></div>
                @if (breakdown().inter) {
                  <div><dt>IGST</dt><dd>{{ breakdown().igst | currency }}</dd></div>
                } @else {
                  <div><dt>CGST</dt><dd>{{ breakdown().cgst | currency }}</dd></div>
                  <div><dt>SGST</dt><dd>{{ breakdown().sgst | currency }}</dd></div>
                }
                <div class="total"><dt>Total</dt><dd>{{ breakdown().total | currency }}</dd></div>
              </dl>
              <p class="sub">{{ breakdown().inter ? 'Vendor is in another state, so the GST is IGST.' : 'Vendor is in your state, so the GST is CGST + SGST.' }}</p>
              @if (gstRegistered() && breakdown().tax > 0) {
                <p class="sub">GST you can claim: <strong>{{ breakdown().claim | currency }}</strong></p>
              }
              @if (value().billable) { <p class="sub">To bill the customer: <strong>{{ breakdown().rebill | currency }}</strong> + their GST</p> }
            </div>
            @if (error()) { <div class="alert" role="alert"><span>{{ error() }}</span></div> }
            <div class="form-actions">
              <a class="btn" routerLink="/expenses">Cancel</a>
              <button type="submit" class="btn btn-primary" [disabled]="saving()">{{ saving() ? 'Saving…' : 'Save expense' }}</button>
            </div>
          </aside>
        </form>
      }
    </section>
  `,
})
export class ExpenseForm implements OnInit {
  private api = inject(Api);
  private fb = inject(NonNullableFormBuilder);
  private router = inject(Router);
  private toasts = inject(Toasts);
  readonly id = input<string>(); // /expenses/:id
  readonly customerId = input<string>(); // ?customerId=
  protected readonly validGstin = validGstin;

  protected meta = toSignal(this.api.meta());
  protected org = this.api.org;
  protected loading = signal(true);
  protected saving = signal(false);
  protected error = signal('');
  protected existing = signal<Expense | null>(null);
  protected categories = signal<ExpenseCategory[]>([]);
  protected customers = signal<Customer[]>([]);
  protected vendors = signal<Vendor[]>([]);
  protected pendingFile = signal<File | null>(null);

  protected form = this.fb.group({
    date: [todayISO()],
    categoryId: this.fb.control<number | null>(null),
    amount: this.fb.control<number | null>(null),
    amountIncludesTax: [true],
    gstRate: [18],
    paidThrough: ['bank_transfer'],
    reference: [''],
    hsnSac: [''],
    description: [''],
    vendorName: [''],
    vendorGstin: [''],
    vendorState: [''],
    billNumber: [''],
    itcEligible: [true],
    reverseCharge: [false],
    billable: [false],
    customerId: this.fb.control<number | null>(null),
    markupPct: [0],
  });
  /** Every field, including disabled ones, as a signal. */
  protected value = toSignal(this.form.valueChanges.pipe(map(() => this.form.getRawValue()), startWith(this.form.getRawValue())),
    { initialValue: this.form.getRawValue() });

  protected states = computed(() => (this.meta()?.states ?? []).filter((s) => s.code !== '96'));
  protected rates = computed(() => this.meta()?.gstRates ?? [0, 5, 18, 40]);
  protected modes = computed(() => this.meta()?.paymentModes ?? []);
  protected gstRegistered = computed(() => this.org()?.gstRegistered ?? true);
  protected categoryOptions = computed(() => this.categories().filter((c) => !c.archived || c.id === this.existing()?.categoryId));
  protected customerOptions = computed(() => this.customers().filter((c) => !c.archived || c.id === this.existing()?.customerId));
  protected gstinBad = computed(() => {
    const g = (this.value().vendorGstin ?? '').trim();
    return g.length > 0 && !validGstin(g.toUpperCase());
  });

  /** The same maths as the server: when the amount includes GST, the value is worked back so value + GST = the bill. */
  protected breakdown = computed(() => {
    const v = this.value();
    const orgState = this.org()?.stateCode ?? '';
    const gstin = (v.vendorGstin ?? '').toUpperCase();
    const vendorState = v.vendorState || (validGstin(gstin) ? gstin.slice(0, 2) : '') || orgState;
    const inter = vendorState !== orgState;
    const amount = Math.round((Number(v.amount) || 0) * 100);
    const rate = Math.round((Number(v.gstRate) || 0) * 100);
    const includes = v.amountIncludesTax && !v.reverseCharge;
    let sub = includes && rate > 0 ? roundDiv(amount * 10000, 10000 + rate) : amount;
    const t = calcLine({ quantity: 1, rate: sub / 100, discountPct: 0, taxRate: rate / 100 }, inter, true);
    if (includes && rate > 0) sub += amount - (sub + t.cgst + t.sgst + t.igst);
    const tax = t.cgst + t.sgst + t.igst;
    const claimable = this.gstRegistered() && v.itcEligible && (v.reverseCharge || validGstin(gstin));
    const markup = Math.round((Number(v.markupPct) || 0) * 100);
    return {
      inter, subtotal: sub / 100, cgst: t.cgst / 100, sgst: t.sgst / 100, igst: t.igst / 100, tax: tax / 100,
      total: (sub + tax) / 100, claim: claimable ? tax / 100 : 0, rebill: (sub + roundDiv(sub * markup, 10000)) / 100,
    };
  });

  constructor() {
    const f = this.form.controls;
    f.vendorGstin.valueChanges.subscribe((g) => {
      const up = g.toUpperCase();
      if (validGstin(up) && f.vendorState.value !== up.slice(0, 2)) f.vendorState.setValue(up.slice(0, 2));
    });
    f.vendorName.valueChanges.subscribe((name) => {
      const known = this.vendors().find((v) => v.name.toLowerCase() === name.trim().toLowerCase());
      if (known && !f.vendorGstin.value) this.form.patchValue({ vendorGstin: known.gstin, vendorState: known.state });
    });
  }

  ngOnInit() {
    forkJoin({
      categories: this.api.expenseCategories(), customers: this.api.customers(), vendors: this.api.vendors(), org: this.api.loadOrg(),
    }).subscribe({
      next: ({ categories, customers, vendors }) => {
        this.categories.set(categories);
        this.customers.set(customers);
        this.vendors.set(vendors);
        const id = this.id();
        if (id) {
          this.api.expense(id).subscribe({ next: (e) => this.fill(e), error: (e) => this.fail(e) });
          return;
        }
        const cid = Number(this.customerId());
        if (cid) this.form.patchValue({ billable: true, customerId: cid });
        this.loading.set(false);
      },
      error: (e) => this.fail(e),
    });
  }

  private fail(e: unknown) {
    this.error.set(errorMessage(e));
    this.loading.set(false);
  }

  private fill(e: Expense) {
    this.existing.set(e);
    this.form.patchValue({
      date: e.date, categoryId: e.categoryId, amount: e.amountIncludesTax ? e.total : e.subtotal,
      amountIncludesTax: e.amountIncludesTax, gstRate: e.gstRate, paidThrough: e.paidThrough, reference: e.reference,
      hsnSac: e.hsnSac, description: e.description, vendorName: e.vendorName, vendorGstin: e.vendorGstin,
      vendorState: e.vendorState, billNumber: e.billNumber, itcEligible: e.itcEligible, reverseCharge: e.reverseCharge,
      billable: e.billable, customerId: e.customerId, markupPct: e.markupPct,
    });
    if (e.invoiceId) {
      this.form.controls.billable.disable();
      this.form.controls.customerId.disable();
    }
    this.loading.set(false);
  }

  protected pickFile(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      this.toasts.show('Receipts can be up to 5 MB.', 'error');
      input.value = '';
      return;
    }
    const e = this.existing();
    if (!e) {
      this.pendingFile.set(file);
      return;
    }
    this.api.uploadReceipt(e.id, file).subscribe({
      next: (saved) => {
        this.existing.set(saved);
        input.value = '';
        this.toasts.show('Receipt attached');
      },
      error: (err) => this.toasts.show(errorMessage(err), 'error'),
    });
  }

  protected removeReceipt() {
    const e = this.existing();
    if (!e) return;
    this.api.deleteReceipt(e.id).subscribe({ next: (saved) => this.existing.set(saved), error: (err) => this.toasts.show(errorMessage(err), 'error') });
  }

  protected save() {
    this.error.set('');
    const v = this.form.getRawValue();
    if (!v.categoryId) return this.error.set('Choose a category.');
    if (!(Number(v.amount) > 0)) return this.error.set('Enter the amount you paid.');
    if (this.gstinBad()) return this.error.set("The vendor's GSTIN isn't valid.");
    if (v.billable && !v.customerId) return this.error.set('Choose the customer to bill this expense to.');
    const body: ExpenseInput = {
      date: v.date, categoryId: v.categoryId, vendorName: v.vendorName, vendorGstin: v.vendorGstin.toUpperCase().trim(),
      vendorState: v.vendorState, billNumber: v.billNumber, hsnSac: v.hsnSac, description: v.description,
      amount: Number(v.amount), amountIncludesTax: v.amountIncludesTax, gstRate: Number(v.gstRate),
      itcEligible: v.itcEligible, reverseCharge: v.reverseCharge, paidThrough: v.paidThrough, reference: v.reference,
      customerId: v.billable ? v.customerId : null, billable: v.billable, markupPct: v.billable ? Number(v.markupPct) || 0 : 0,
    };
    this.saving.set(true);
    const existing = this.existing();
    this.api.saveExpense(body, existing?.id).subscribe({
      next: (saved) => {
        const file = this.pendingFile();
        const done = () => {
          this.toasts.show(existing ? 'Expense updated' : 'Expense recorded');
          this.router.navigate(['/expenses']);
        };
        if (!file) return done();
        this.api.uploadReceipt(saved.id, file).subscribe({
          next: done,
          error: (e) => {
            this.toasts.show(`Expense saved, but the receipt didn't upload: ${errorMessage(e)}`, 'error');
            this.router.navigate(['/expenses', saved.id]);
          },
        });
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.saving.set(false);
      },
    });
  }

  protected remove() {
    const e = this.existing();
    if (!e || !confirm('Delete this expense? This can\'t be undone.')) return;
    this.api.deleteExpense(e.id).subscribe({
      next: () => {
        this.toasts.show('Expense deleted');
        this.router.navigate(['/expenses']);
      },
      error: (err) => this.toasts.show(errorMessage(err), 'error'),
    });
  }
}
