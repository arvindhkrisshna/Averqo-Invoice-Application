import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, errorMessage } from '../../core/api';
import { Item } from '../../core/models';
import { Toasts } from '../../core/toast';

/** Builds the item form group (also used by the invoice form's quick add). */
export function itemForm(fb: NonNullableFormBuilder) {
  return fb.group({
    name: ['', Validators.required],
    kind: ['service' as 'goods' | 'service'],
    hsnSac: ['', Validators.pattern(/^(\d{4}|\d{6}|\d{8})$/)],
    unit: ['nos'],
    rate: [0, [Validators.required, Validators.min(0)]],
    taxRate: [18],
    description: [''],
  });
}

@Component({
  selector: 'app-item-form',
  imports: [ReactiveFormsModule, RouterLink],
  template: `
    <section class="page">
      <div class="page-head">
        <div>
          <a class="back" routerLink="/items"><i class="ti ti-arrow-left" aria-hidden="true"></i>Items</a>
          <h1>{{ id() ? 'Edit item' : 'New item' }} @if (item()?.archived) { <span class="badge" data-tone="void">Archived</span> }</h1>
        </div>
      </div>

      @if (loading()) {
        <p class="muted">Loading…</p>
      } @else {
        <form [formGroup]="form" (ngSubmit)="save()" novalidate>
          <div class="card form-card">
            <div class="form-grid">
              <label class="field span-2"><span>Name</span><input type="text" formControlName="name" placeholder="Website maintenance" /></label>
              <div class="field span-2">
                <span>Type</span>
                <div class="segmented" role="radiogroup" aria-label="Type">
                  <label><input type="radio" formControlName="kind" value="service" /> Service</label>
                  <label><input type="radio" formControlName="kind" value="goods" /> Goods</label>
                </div>
              </div>
              <label class="field">
                <span>{{ isGoods() ? 'HSN code' : 'SAC code' }}</span>
                <input type="text" formControlName="hsnSac" inputmode="numeric" maxlength="8" class="mono"
                       [placeholder]="isGoods() ? '4 to 8 digits, like 4901' : '6 digits, like 998314'"
                       [class.invalid]="form.controls.hsnSac.invalid && form.controls.hsnSac.touched" />
                @if (form.controls.hsnSac.invalid && form.controls.hsnSac.touched) {
                  <small class="field-error">Use 4, 6, or 8 digits.</small>
                } @else {
                  <small class="hint">Needed on GST invoices. Your accountant can confirm the right code.</small>
                }
              </label>
              <label class="field">
                <span>Unit</span>
                <select formControlName="unit">
                  @for (u of meta()?.units ?? []; track u) { <option [value]="u">{{ u }}</option> }
                </select>
              </label>
              <label class="field"><span>Rate (₹, before GST)</span><input type="number" formControlName="rate" min="0" step="0.01" /></label>
              <label class="field">
                <span>GST rate</span>
                <select formControlName="taxRate">
                  @for (r of rates(); track r) { <option [ngValue]="r">{{ r }}%</option> }
                </select>
              </label>
              <label class="field span-2"><span>Description</span><textarea formControlName="description" rows="2" placeholder="Optional. Shown under the item name on invoices."></textarea></label>
            </div>
          </div>

          @if (error()) {
            <div class="alert" role="alert"><span>{{ error() }}</span></div>
          }
          <div class="form-actions sticky-actions">
            @if (item(); as it) {
              <button type="button" class="btn btn-quiet" (click)="toggleArchive(it)">{{ it.archived ? 'Restore' : 'Archive' }}</button>
              @if (it.timesUsed === 0) {
                <button type="button" class="btn btn-quiet text-danger" (click)="remove(it)">Delete</button>
              }
            }
            <span class="spacer"></span>
            <a class="btn" routerLink="/items">Cancel</a>
            <button type="submit" class="btn btn-primary" [disabled]="saving()">{{ saving() ? 'Saving…' : 'Save item' }}</button>
          </div>
        </form>
      }
    </section>
  `,
})
export class ItemForm implements OnInit {
  readonly id = input<string>();
  private api = inject(Api);
  private router = inject(Router);
  private toasts = inject(Toasts);
  protected meta = toSignal(this.api.meta());
  protected form = itemForm(inject(NonNullableFormBuilder));
  private kind = toSignal(this.form.controls.kind.valueChanges, { initialValue: this.form.controls.kind.value });
  protected isGoods = computed(() => this.kind() === 'goods');
  protected item = signal<Item | null>(null);
  protected loading = signal(false);
  protected saving = signal(false);
  protected error = signal('');

  /** Standard rates, plus the item's own rate if it's a custom one. */
  protected rates = computed(() => {
    const base = this.meta()?.gstRates ?? [0, 5, 18, 40];
    const own = this.item()?.taxRate;
    return own !== undefined && !base.includes(own) ? [...base, own].sort((a, b) => a - b) : base;
  });

  ngOnInit() {
    const id = this.id();
    if (!id) return;
    this.loading.set(true);
    this.api.item(id).subscribe({
      next: (it) => {
        this.item.set(it);
        this.form.reset(it);
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
      this.error.set('Check the highlighted fields.');
      return;
    }
    this.saving.set(true);
    this.error.set('');
    const id = this.id() ? Number(this.id()) : undefined;
    this.api.saveItem(this.form.getRawValue(), id).subscribe({
      next: () => {
        this.toasts.show(id ? 'Item updated. Existing invoices keep their original prices.' : 'Item added');
        this.router.navigate(['/items']);
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.saving.set(false);
      },
    });
  }

  protected toggleArchive(it: Item) {
    this.api.archiveItem(it.id, !it.archived).subscribe({
      next: (u) => {
        this.item.set(u);
        this.toasts.show(u.archived ? 'Item archived. It no longer appears on new invoices.' : 'Item restored');
      },
      error: (e) => this.toasts.show(errorMessage(e), 'error'),
    });
  }

  protected remove(it: Item) {
    if (!confirm(`Delete ${it.name}? This can't be undone.`)) return;
    this.api.deleteItem(it.id).subscribe({
      next: () => {
        this.toasts.show('Item deleted');
        this.router.navigate(['/items']);
      },
      error: (e) => this.toasts.show(errorMessage(e), 'error'),
    });
  }
}
