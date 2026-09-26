import { Component, computed, input } from '@angular/core';
import { FormGroup, NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { validGstin } from '../../core/format';
import { Customer, GstTreatment, State } from '../../core/models';

/**
 * The customer fields, shared by the full customer form and the quick
 * "New customer" dialog inside the invoice form.
 */
@Component({
  selector: 'app-customer-fields',
  imports: [ReactiveFormsModule],
  template: `
    <div [formGroup]="form()" class="form-grid">
      <label class="field span-2">
        <span>Customer name</span>
        <input type="text" formControlName="displayName" placeholder="Kaveri Textiles Pvt Ltd" />
      </label>

      <div class="field span-2">
        <span>GST treatment</span>
        <div class="segmented wrap" role="radiogroup" aria-label="GST treatment">
          <label><input type="radio" formControlName="gstTreatment" value="registered" /> Registered business</label>
          <label><input type="radio" formControlName="gstTreatment" value="unregistered" /> Unregistered business</label>
          <label><input type="radio" formControlName="gstTreatment" value="consumer" /> Consumer</label>
          <label><input type="radio" formControlName="gstTreatment" value="overseas" /> Overseas</label>
        </div>
      </div>

      @if (treatment() === 'registered') {
        <label class="field">
          <span>GSTIN</span>
          <input type="text" formControlName="gstin" maxlength="15" class="mono upper" placeholder="29ABCDE1234F1Z5"
                 [class.invalid]="gstinState() === 'invalid'" />
          @if (gstinState() === 'invalid') {
            <small class="field-error">This GSTIN doesn't look right. Check each character.</small>
          } @else if (gstinState() === 'valid') {
            <small class="hint text-success"><i class="ti ti-circle-check" aria-hidden="true"></i> Valid GSTIN. State filled in.</small>
          }
        </label>
      }
      @if (treatment() !== 'overseas') {
        <label class="field">
          <span>State (place of supply)</span>
          <select formControlName="stateCode">
            <option value="">Choose a state</option>
            @for (s of indianStates(); track s.code) {
              <option [value]="s.code">{{ s.name }}</option>
            }
          </select>
        </label>
      } @else {
        <p class="hint span-2">Overseas sales are billed with IGST as exports.</p>
      }

      @if (!compact()) {
        <label class="field"><span>Contact person</span><input type="text" formControlName="contactPerson" /></label>
      }
      <label class="field"><span>Email</span><input type="email" formControlName="email" placeholder="accounts@customer.in" /></label>
      @if (!compact()) {
        <label class="field"><span>Phone</span><input type="tel" formControlName="phone" /></label>
        <label class="field span-2"><span>Billing address</span><textarea formControlName="address" rows="2"></textarea></label>
        <label class="field"><span>City</span><input type="text" formControlName="city" /></label>
        <label class="field"><span>PIN code</span><input type="text" formControlName="pincode" inputmode="numeric" maxlength="6" /></label>
        <label class="field">
          <span>Payment terms (days)</span>
          <input type="number" formControlName="paymentTermsDays" min="0" max="365" placeholder="Use business default" />
        </label>
        <label class="field span-2"><span>Notes</span><textarea formControlName="notes" rows="2" placeholder="Only visible to you"></textarea></label>
      }
    </div>
  `,
})
export class CustomerFields {
  readonly form = input.required<FormGroup>();
  readonly states = input<State[]>([]);
  readonly compact = input(false);

  protected indianStates = computed(() => this.states().filter((s) => s.code !== '96'));

  // Read straight from the form, so the template updates as the user types.
  protected treatment(): string {
    return this.form().get('gstTreatment')?.value ?? '';
  }

  protected gstinState(): 'empty' | 'valid' | 'invalid' {
    const g = String(this.form().get('gstin')?.value ?? '').trim().toUpperCase();
    return !g ? 'empty' : validGstin(g) ? 'valid' : 'invalid';
  }
}

/** Builds the customer form group; a valid GSTIN fills in the state. */
export function customerForm(fb: NonNullableFormBuilder) {
  const form = fb.group({
    displayName: ['', Validators.required],
    gstTreatment: ['unregistered' as GstTreatment],
    gstin: [''],
    stateCode: [''],
    contactPerson: [''],
    email: ['', Validators.email],
    phone: [''],
    address: [''],
    city: [''],
    pincode: [''],
    paymentTermsDays: [null as number | null],
    notes: [''],
  });
  form.controls.gstin.valueChanges.subscribe((g) => {
    const v = g.trim().toUpperCase();
    if (validGstin(v)) form.controls.stateCode.setValue(v.slice(0, 2));
  });
  return form;
}

export type CustomerFormGroup = ReturnType<typeof customerForm>;

/** Form value → API body (empty payment terms means "use the default"). */
export function customerPayload(form: CustomerFormGroup): Partial<Customer> {
  const v = form.getRawValue();
  const terms = v.paymentTermsDays as unknown;
  return {
    ...v,
    gstin: v.gstin.trim().toUpperCase(),
    paymentTermsDays: terms === null || terms === '' ? null : Number(terms),
  };
}
