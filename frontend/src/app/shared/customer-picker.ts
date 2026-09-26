import { Component, DestroyRef, OnInit, computed, inject, input, model, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { startWith } from 'rxjs';
import { Api, errorMessage } from '../core/api';
import { Customer, State } from '../core/models';
import { Toasts } from '../core/toast';
import { CustomerFields, customerForm, customerPayload } from '../pages/customers/customer-fields';

/** Customer dropdown with "New customer" and a quick fix for a missing state. */
@Component({
  selector: 'app-customer-picker',
  imports: [ReactiveFormsModule, CustomerFields],
  template: `
    <div class="input-with-btn">
      <select id="customer" [formControl]="control()" aria-label="Customer">
        <option [ngValue]="null" disabled>Choose a customer</option>
        @for (c of selectable(); track c.id) { <option [ngValue]="c.id">{{ c.displayName }}</option> }
      </select>
      <button type="button" class="btn" (click)="openDialog()" [disabled]="control().disabled"><i class="ti ti-user-plus" aria-hidden="true"></i>New</button>
    </div>
    @if (customer(); as c) {
      @if (!c.stateCode) {
        <div class="inline-fix">
          <span>This customer has no state yet. It's needed for GST.</span>
          <select (change)="fixState.set($any($event.target).value)" aria-label="Customer state">
            <option value="">Choose state</option>
            @for (s of indianStates(); track s.code) { <option [value]="s.code" [selected]="s.code === fixState()">{{ s.name }}</option> }
          </select>
          <button type="button" class="btn" [disabled]="!fixState()" (click)="saveState(c)">Save</button>
        </div>
      } @else {
        <small class="hint">
          {{ stateName(c.stateCode) }}@if (c.gstin) { · <span class="mono">{{ c.gstin }}</span> }
          @if (gstRegistered()) { · <span class="gst-type">{{ c.stateCode !== orgState() ? 'Other state: IGST' : 'Same state: CGST + SGST' }}</span> }
        </small>
      }
    }

    @if (dialogOpen()) {
      <div class="dialog-backdrop" (click)="dialogOpen.set(false)">
        <div class="dialog" role="dialog" aria-labelledby="quick-title" (click)="$event.stopPropagation()">
          <div class="dialog-head">
            <h2 id="quick-title">New customer</h2>
            <button type="button" class="icon-btn" aria-label="Close" (click)="dialogOpen.set(false)"><i class="ti ti-x" aria-hidden="true"></i></button>
          </div>
          <form [formGroup]="quickForm" (ngSubmit)="create()" novalidate>
            <app-customer-fields [form]="quickForm" [states]="states()" [compact]="true" />
            <p class="hint">Add their phone to send on WhatsApp. Other details can wait for the customer page.</p>
            @if (error()) { <div class="alert" role="alert"><span>{{ error() }}</span></div> }
            <div class="form-actions">
              <button type="button" class="btn" (click)="dialogOpen.set(false)">Cancel</button>
              <button type="submit" class="btn btn-primary" [disabled]="saving()">{{ saving() ? 'Adding…' : 'Add customer' }}</button>
            </div>
          </form>
        </div>
      </div>
    }
  `,
})
export class CustomerPicker implements OnInit {
  readonly control = input.required<FormControl<number | null>>();
  readonly customers = model<Customer[]>([]);
  readonly states = input<State[]>([]);
  readonly orgState = input('');
  readonly gstRegistered = input(true);

  private api = inject(Api);
  private toasts = inject(Toasts);
  private destroyRef = inject(DestroyRef);
  private selectedId = signal<number | null>(null);
  protected fixState = signal('');
  protected dialogOpen = signal(false);
  protected quickForm = customerForm(inject(NonNullableFormBuilder));
  protected error = signal('');
  protected saving = signal(false);

  protected customer = computed(() => this.customers().find((c) => c.id === this.selectedId()) ?? null);
  protected selectable = computed(() => this.customers().filter((c) => !c.archived || c.id === this.selectedId()));
  protected indianStates = computed(() => this.states().filter((s) => s.code !== '96'));

  ngOnInit() {
    const c = this.control();
    c.valueChanges.pipe(startWith(c.value), takeUntilDestroyed(this.destroyRef)).subscribe((v) => this.selectedId.set(v));
  }

  protected stateName(code: string) {
    return this.states().find((s) => s.code === code)?.name ?? '';
  }

  protected openDialog() {
    this.quickForm.reset({ gstTreatment: 'unregistered', stateCode: this.orgState() });
    this.error.set('');
    this.dialogOpen.set(true);
  }

  protected create() {
    if (this.quickForm.invalid) {
      this.quickForm.markAllAsTouched();
      this.error.set('Enter the customer name (and a valid email if you add one).');
      return;
    }
    this.saving.set(true);
    this.api.saveCustomer(customerPayload(this.quickForm)).subscribe({
      next: (c) => {
        this.customers.update((list) => [...list, c].sort((a, b) => a.displayName.localeCompare(b.displayName)));
        this.control().setValue(c.id);
        this.dialogOpen.set(false);
        this.saving.set(false);
        this.toasts.show(`${c.displayName} added`);
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.saving.set(false);
      },
    });
  }

  protected saveState(c: Customer) {
    this.api.saveCustomer({ ...c, stateCode: this.fixState() }, c.id).subscribe({
      next: (u) => {
        this.customers.update((list) => list.map((x) => (x.id === u.id ? u : x)));
        this.fixState.set('');
        this.toasts.show(`State saved for ${u.displayName}`);
      },
      error: (e) => this.toasts.show(errorMessage(e), 'error'),
    });
  }
}
