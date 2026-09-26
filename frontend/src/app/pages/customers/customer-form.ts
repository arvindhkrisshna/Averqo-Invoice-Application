import { Component, inject, input, OnInit, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, errorMessage } from '../../core/api';
import { Toasts } from '../../core/toast';
import { CustomerFields, customerForm, customerPayload } from './customer-fields';

@Component({
  selector: 'app-customer-form',
  imports: [ReactiveFormsModule, RouterLink, CustomerFields],
  template: `
    <section class="page">
      <div class="page-head">
        <div>
          <a class="back" [routerLink]="id() ? ['/customers', id()] : '/customers'"><i class="ti ti-arrow-left" aria-hidden="true"></i>{{ id() ? 'Customer' : 'Customers' }}</a>
          <h1>{{ id() ? 'Edit customer' : 'New customer' }}</h1>
        </div>
      </div>

      @if (loading()) {
        <p class="muted">Loading…</p>
      } @else {
        <form [formGroup]="form" (ngSubmit)="save()" novalidate>
          <div class="card form-card">
            <app-customer-fields [form]="form" [states]="meta()?.states ?? []" />
          </div>
          @if (error()) {
            <div class="alert" role="alert"><span>{{ error() }}</span></div>
          }
          <div class="form-actions sticky-actions">
            <a class="btn" [routerLink]="id() ? ['/customers', id()] : '/customers'">Cancel</a>
            <button type="submit" class="btn btn-primary" [disabled]="saving()">{{ saving() ? 'Saving…' : 'Save customer' }}</button>
          </div>
        </form>
      }
    </section>
  `,
})
export class CustomerForm implements OnInit {
  readonly id = input<string>(); // from the URL, when editing

  private api = inject(Api);
  private router = inject(Router);
  private toasts = inject(Toasts);
  protected meta = toSignal(this.api.meta());
  protected form = customerForm(inject(NonNullableFormBuilder));
  protected loading = signal(false);
  protected saving = signal(false);
  protected error = signal('');

  ngOnInit() {
    const id = this.id();
    if (!id) return;
    this.loading.set(true);
    this.api.customer(id).subscribe({
      next: (c) => {
        this.form.reset(c);
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.loading.set(false);
      },
    });
  }

  protected save() {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.error.set('Enter the customer name and a valid email (if you add one).');
      return;
    }
    this.saving.set(true);
    this.error.set('');
    const id = this.id() ? Number(this.id()) : undefined;
    this.api.saveCustomer(customerPayload(this.form), id).subscribe({
      next: (c) => {
        this.toasts.show(id ? 'Customer updated' : 'Customer added');
        this.router.navigate(['/customers', c.id]);
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.saving.set(false);
      },
    });
  }
}
