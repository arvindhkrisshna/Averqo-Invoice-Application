import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule, NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Api, errorMessage } from '../../core/api';
import { Auth } from '../../core/auth';
import { AccountSettings } from './account-settings';
import { validGstin } from '../../core/format';
import { Organization } from '../../core/models';
import { Toasts } from '../../core/toast';

@Component({
  selector: 'app-settings',
  imports: [ReactiveFormsModule, FormsModule, AccountSettings],
  templateUrl: './settings.html',
})
export class Settings {
  protected auth = inject(Auth);
  private api = inject(Api);
  private toasts = inject(Toasts);
  private fb = inject(NonNullableFormBuilder);

  protected meta = toSignal(this.api.meta());
  protected states = computed(() => (this.meta()?.states ?? []).filter((s) => s.code !== '96'));
  protected loading = signal(true);
  protected saving = signal(false);
  protected error = signal('');

  protected form = this.fb.group({
    name: ['', Validators.required],
    gstRegistered: [true],
    gstin: [''],
    stateCode: ['', Validators.required],
    address: [''],
    city: [''],
    pincode: [''],
    email: ['', Validators.email],
    phone: [''],
    bankName: [''],
    bankAccountNumber: [''],
    bankIfsc: [''],
    upiId: [''],
    invoicePrefix: ['INV-', Validators.required],
    nextInvoiceNumber: [1, [Validators.required, Validators.min(1)]],
    paymentPrefix: ['PAY-', Validators.required],
    nextPaymentNumber: [1, [Validators.required, Validators.min(1)]],
    quotePrefix: ['QT-', Validators.required],
    nextQuoteNumber: [1, [Validators.required, Validators.min(1)]],
    challanPrefix: ['DC-', Validators.required],
    nextChallanNumber: [1, [Validators.required, Validators.min(1)]],
    creditPrefix: ['CN-', Validators.required],
    nextCreditNumber: [1, [Validators.required, Validators.min(1)]],
    paymentTermsDays: [15, [Validators.required, Validators.min(0), Validators.max(365)]],
    quoteValidityDays: [15, [Validators.required, Validators.min(0), Validators.max(365)]],
    invoiceNotes: [''],
    invoiceTerms: [''],
    quoteNotes: [''],
    quoteTerms: [''],
    smtpHost: [''],
    smtpPort: [587],
    smtpUsername: [''],
    smtpPassword: [''],
    smtpFromEmail: [''],
    smtpFromName: [''],
    gstFilingFrequency: ['monthly'],
  });
  protected passwordSet = signal(false);
  protected testTo = '';
  protected testing = signal(false);

  /** Fills in Gmail's settings; the person only adds their address and App Password. */
  protected useGmail() {
    const email = this.form.controls.smtpFromEmail.value || this.form.controls.email.value;
    this.form.patchValue({ smtpHost: 'smtp.gmail.com', smtpPort: 587, smtpUsername: email, smtpFromEmail: email });
  }

  protected sendTest() {
    const to = this.testTo.trim() || this.form.controls.smtpFromEmail.value;
    this.testing.set(true);
    this.api.testEmail(to).subscribe({
      next: () => {
        this.testing.set(false);
        this.toasts.show(`Test email sent to ${to}. Check that inbox (and spam).`);
      },
      error: (e) => {
        this.testing.set(false);
        this.toasts.show(errorMessage(e), 'error');
      },
    });
  }

  private value = toSignal(this.form.valueChanges, { initialValue: this.form.getRawValue() });
  protected registered = computed(() => this.value().gstRegistered);
  protected gstinState = computed(() => {
    const g = (this.value().gstin ?? '').trim().toUpperCase();
    if (!g) return 'empty';
    return validGstin(g) ? 'valid' : 'invalid';
  });

  constructor() {
    this.api.loadOrg().subscribe({
      next: (o) => {
        this.form.reset(o);
        this.passwordSet.set(o.smtpPasswordSet);
        this.testTo = o.email;
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.loading.set(false);
      },
    });
    // A valid GSTIN tells us the state, so fill it in automatically.
    this.form.controls.gstin.valueChanges.subscribe((g) => {
      const v = g.trim().toUpperCase();
      if (validGstin(v)) this.form.controls.stateCode.setValue(v.slice(0, 2));
    });
  }

  protected save() {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.error.set('Fill in the highlighted fields first.');
      return;
    }
    this.saving.set(true);
    this.error.set('');
    this.api.saveOrg(this.form.getRawValue() as Organization).subscribe({
      next: (o) => {
        this.form.reset(o);
        this.passwordSet.set(o.smtpPasswordSet);
        this.saving.set(false);
        this.toasts.show('Settings saved');
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.saving.set(false);
      },
    });
  }
}
