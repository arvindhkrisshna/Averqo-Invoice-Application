import { CurrencyPipe } from '@angular/common';
import { Component, DestroyRef, OnInit, computed, inject, input, model, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormArray, FormGroup, NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { startWith } from 'rxjs';
import { Api, errorMessage } from '../core/api';
import { amountInWords, calcLine } from '../core/format';
import { InvoiceLine, Item } from '../core/models';
import { Toasts } from '../core/toast';

/** One line's form group. Used by invoices, quotes, challans, credit notes, and recurring schedules. */
export function lineGroup(fb: NonNullableFormBuilder, l?: Partial<InvoiceLine>) {
  return fb.group({
    itemId: fb.control<number | null>(l?.itemId ?? null),
    description: [l?.description ?? ''],
    hsnSac: [l?.hsnSac ?? ''],
    unit: [l?.unit ?? 'nos'],
    quantity: [l?.quantity ?? 1],
    rate: [l?.rate ?? 0],
    discountPct: [l?.discountPct ?? 0],
    taxRate: [l?.taxRate ?? 18],
    timeEntryIds: fb.control<number[]>(l?.timeEntryIds ?? []),
    expenseId: fb.control<number | null>(l?.expenseId ?? null),
  });
}
export type LineGroup = ReturnType<typeof lineGroup>;

/** Form lines → API lines (blank rows dropped, numbers made numbers). */
export function linesPayload(lines: FormArray<LineGroup>, gstRegistered: boolean): InvoiceLine[] {
  return lines.getRawValue()
    .filter((l) => l.description.trim() || Number(l.rate))
    .map((l) => ({
      itemId: l.itemId, description: l.description, hsnSac: l.hsnSac, unit: l.unit,
      quantity: Number(l.quantity) || 0, rate: Number(l.rate) || 0, discountPct: Number(l.discountPct) || 0,
      taxRate: gstRegistered ? Number(l.taxRate) || 0 : 0,
      ...(l.timeEntryIds?.length ? { timeEntryIds: l.timeEntryIds } : {}),
      ...(l.expenseId ? { expenseId: l.expenseId } : {}),
    }));
}

@Component({
  selector: 'app-lines-editor',
  imports: [ReactiveFormsModule, CurrencyPipe],
  template: `
    <datalist id="item-options">
      @for (it of activeItems(); track it.id) { <option [value]="it.name"></option> }
    </datalist>

    <div class="lines" [class.no-gst]="!gstRegistered()">
      <div class="line line-head" aria-hidden="true">
        <span>Item or description</span><span>HSN/SAC</span><span>Qty</span><span>Rate (₹)</span><span>Disc %</span>
        @if (gstRegistered()) { <span>GST</span> }
        <span class="num">Amount</span><span></span>
      </div>
      @for (line of lines().controls; track line; let i = $index) {
        <div class="line" [formGroup]="asGroup(line)">
          <label class="cell cell-desc">
            <span class="cell-label">Item or description</span>
            <input type="text" formControlName="description" list="item-options" placeholder="Start typing an item" (change)="pickItem(i)" />
            @if (line.controls.timeEntryIds.value.length) {
              <span class="source-tag"><i class="ti ti-clock-hour-4" aria-hidden="true"></i>Bills {{ line.controls.timeEntryIds.value.length }} timesheet {{ line.controls.timeEntryIds.value.length === 1 ? 'entry' : 'entries' }}</span>
            } @else if (line.controls.expenseId.value) {
              <span class="source-tag"><i class="ti ti-receipt" aria-hidden="true"></i>Bills an expense</span>
            } @else if (!line.controls.itemId.value && line.controls.description.value.trim()) {
              <button type="button" class="link-btn" (click)="saveAsItem(i)"><i class="ti ti-bookmark-plus" aria-hidden="true"></i>Save to items</button>
            }
          </label>
          <label class="cell"><span class="cell-label">HSN/SAC</span><input type="text" formControlName="hsnSac" inputmode="numeric" maxlength="8" class="mono" /></label>
          <label class="cell">
            <span class="cell-label">Qty</span>
            <span class="qty"><input type="number" formControlName="quantity" min="0" step="any" /><small>{{ line.controls.unit.value }}</small></span>
          </label>
          <label class="cell"><span class="cell-label">Rate (₹)</span><input type="number" formControlName="rate" min="0" step="0.01" /></label>
          <label class="cell"><span class="cell-label">Disc %</span><input type="number" formControlName="discountPct" min="0" max="100" step="any" /></label>
          @if (gstRegistered()) {
            <label class="cell">
              <span class="cell-label">GST</span>
              <select formControlName="taxRate">
                @for (r of rates(); track r) { <option [ngValue]="r">{{ r }}%</option> }
                @if (!rates().includes(line.controls.taxRate.value)) {
                  <option [ngValue]="line.controls.taxRate.value">{{ line.controls.taxRate.value }}%</option>
                }
              </select>
            </label>
          }
          <span class="cell num line-amount"><span class="cell-label">Amount</span>{{ preview().lines[i] | currency }}</span>
          <button type="button" class="icon-btn" (click)="removeLine(i)" [attr.aria-label]="'Remove line ' + (i + 1)"><i class="ti ti-trash" aria-hidden="true"></i></button>
        </div>
      }
    </div>
    <button type="button" class="btn btn-quiet" (click)="addLine()"><i class="ti ti-plus" aria-hidden="true"></i>Add line</button>

    @if (showTotals()) {
      <div class="totals-wrap">
        <p class="words muted">{{ preview().words }}</p>
        <dl class="totals">
          <dt>Taxable value</dt><dd>{{ preview().subtotal | currency }}</dd>
          @if (preview().discount > 0) {
            <dt class="muted">Includes discount of</dt><dd class="muted">{{ preview().discount | currency }}</dd>
          }
          @for (g of preview().taxGroups; track g.rate) {
            @if (interState()) {
              <dt>IGST {{ g.rate }}%</dt><dd>{{ g.amount | currency }}</dd>
            } @else {
              <dt>CGST {{ g.rate / 2 }}%</dt><dd>{{ g.amount | currency }}</dd>
              <dt>SGST {{ g.rate / 2 }}%</dt><dd>{{ g.amount | currency }}</dd>
            }
          }
          <dt class="grand">Total</dt><dd class="grand">{{ preview().total | currency }}</dd>
        </dl>
      </div>
    } @else {
      <p class="hint">GST is worked out on each invoice, using the customer's state at that time.</p>
    }
  `,
})
export class LinesEditor implements OnInit {
  readonly lines = input.required<FormArray<LineGroup>>();
  readonly items = model<Item[]>([]);
  readonly interState = input(false);
  readonly gstRegistered = input(true);
  readonly rates = input<number[]>([0, 5, 18, 40]);
  readonly showTotals = input(true);

  private api = inject(Api);
  private toasts = inject(Toasts);
  private fb = inject(NonNullableFormBuilder);
  private destroyRef = inject(DestroyRef);
  private value = signal<ReturnType<FormArray<LineGroup>['getRawValue']>>([]);

  protected activeItems = computed(() => this.items().filter((i) => !i.archived));

  /** Live totals, calculated in paise exactly as the server will. */
  protected preview = computed(() => {
    const raw = this.value();
    const calc = raw.map((l) => calcLine(l, this.interState(), this.gstRegistered()));
    const sum = (k: 'taxable' | 'discount' | 'cgst' | 'sgst' | 'igst') => calc.reduce((s, l) => s + l[k], 0) / 100;
    const groups = new Map<number, number>();
    raw.forEach((l, i) => {
      const tax = calc[i].cgst + calc[i].igst;
      if (tax) groups.set(Number(l.taxRate) || 0, (groups.get(Number(l.taxRate) || 0) ?? 0) + tax);
    });
    const total = Math.round((sum('taxable') + sum('cgst') + sum('sgst') + sum('igst')) * 100) / 100;
    return {
      lines: calc.map((l) => l.taxable / 100),
      subtotal: sum('taxable'),
      discount: sum('discount'),
      taxGroups: [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([rate, p]) => ({ rate, amount: p / 100 })),
      total,
      words: amountInWords(total),
    };
  });

  ngOnInit() {
    const arr = this.lines();
    arr.valueChanges.pipe(startWith(null), takeUntilDestroyed(this.destroyRef)).subscribe(() => this.value.set(arr.getRawValue()));
  }

  protected asGroup(c: LineGroup): FormGroup {
    return c;
  }

  protected addLine() {
    this.lines().push(lineGroup(this.fb));
  }

  protected removeLine(i: number) {
    const arr = this.lines();
    if (arr.length > 1) arr.removeAt(i);
    else arr.at(0).reset();
  }

  /** Typing or picking an item's name fills in its rate, unit, HSN/SAC, and GST. */
  protected pickItem(i: number) {
    const line = this.lines().at(i);
    const name = line.controls.description.value.trim().toLowerCase();
    const item = this.activeItems().find((it) => it.name.toLowerCase() === name);
    if (item) {
      line.patchValue({ itemId: item.id, description: item.name, hsnSac: item.hsnSac, unit: item.unit, rate: item.rate, taxRate: item.taxRate });
    } else if (line.controls.itemId.value) {
      line.controls.itemId.setValue(null);
    }
  }

  /** Saves a typed-in line as a reusable item. */
  protected saveAsItem(i: number) {
    const l = this.lines().at(i).getRawValue();
    this.api.saveItem({
      name: l.description.trim(), kind: l.hsnSac.startsWith('99') || !l.hsnSac ? 'service' : 'goods', hsnSac: l.hsnSac.trim(),
      unit: l.unit || 'nos', rate: Number(l.rate) || 0, taxRate: Number(l.taxRate) || 0, description: '',
    }).subscribe({
      next: (item) => {
        this.items.update((list) => [...list, item]);
        this.lines().at(i).controls.itemId.setValue(item.id);
        this.toasts.show(`"${item.name}" saved to your items`);
      },
      error: (e) => this.toasts.show(errorMessage(e), 'error'),
    });
  }
}
