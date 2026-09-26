import { CurrencyPipe, DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { Api, errorMessage } from '../../core/api';
import { dueText, todayISO } from '../../core/format';
import { Customer, Invoice } from '../../core/models';
import { Toasts } from '../../core/toast';

const paise = (n: unknown) => Math.round((Number(n) || 0) * 100);

@Component({
  selector: 'app-payment-form',
  imports: [RouterLink, CurrencyPipe, DatePipe],
  templateUrl: './payment-form.html',
})
export class PaymentForm implements OnInit {
  readonly customerId = input<string>(); // ?customerId=
  readonly invoiceId = input<string>(); // ?invoiceId= pays that invoice

  private api = inject(Api);
  private router = inject(Router);
  private toasts = inject(Toasts);
  protected meta = toSignal(this.api.meta());
  protected readonly dueText = dueText;

  protected customers = signal<Customer[]>([]);
  protected selectedId = signal<number | null>(null);
  protected open = signal<Invoice[]>([]);
  protected loadingInvoices = signal(false);

  protected amount = signal<number | null>(null);
  protected date = signal(todayISO());
  protected mode = signal('bank_transfer');
  protected reference = signal('');
  protected notes = signal('');
  /** Amount applied to each open invoice, keyed by invoice id. */
  protected applied = signal<Record<number, number>>({});
  private manual = false;

  protected saving = signal(false);
  protected error = signal('');

  protected customer = computed(() => this.customers().find((c) => c.id === this.selectedId()) ?? null);
  protected withBalance = computed(() => this.customers().filter((c) => !c.archived && c.outstanding > 0));
  protected others = computed(() => this.customers().filter((c) => !c.archived && c.outstanding <= 0));
  protected appliedTotal = computed(() => Object.values(this.applied()).reduce((s, v) => s + paise(v), 0) / 100);
  protected remaining = computed(() => (paise(this.amount()) - paise(this.appliedTotal())) / 100);
  protected openTotal = computed(() => this.open().reduce((s, i) => s + i.balance, 0));
  protected overApplied = computed(() => this.open().filter((i) => paise(this.applied()[i.id]) > paise(i.balance)));
  protected canSave = computed(
    () => !!this.selectedId() && paise(this.amount()) > 0 && this.remaining() === 0 && !this.overApplied().length && !this.saving(),
  );

  ngOnInit() {
    this.api.customers().subscribe({
      next: (list) => {
        this.customers.set(list);
        const cid = Number(this.customerId());
        if (cid) this.selectCustomer(cid);
      },
      error: (e) => this.error.set(errorMessage(e)),
    });
  }

  protected selectCustomer(id: number | null) {
    this.selectedId.set(id);
    this.open.set([]);
    this.applied.set({});
    this.manual = false;
    if (!id) return;
    this.loadingInvoices.set(true);
    this.api.invoices({ customerId: id, open: true }).subscribe({
      next: (list) => {
        this.open.set(list);
        this.loadingInvoices.set(false);
        const target = list.find((i) => i.id === Number(this.invoiceId()));
        if (target) {
          // Came from "Record payment" on an invoice: pay that invoice in full.
          this.amount.set(target.balance);
          this.applied.set({ [target.id]: target.balance });
          this.manual = true;
        } else if (this.amount()) {
          this.autoApply();
        }
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.loadingInvoices.set(false);
      },
    });
  }

  protected setAmount(v: string) {
    this.amount.set(v === '' ? null : Number(v));
    if (!this.manual) this.autoApply();
  }

  /** Spreads the amount across open invoices, oldest due date first. */
  protected autoApply() {
    let left = paise(this.amount());
    const next: Record<number, number> = {};
    for (const inv of this.open()) {
      const take = Math.min(left, paise(inv.balance));
      if (take > 0) next[inv.id] = take / 100;
      left -= take;
    }
    this.applied.set(next);
    this.manual = false;
  }

  protected setApplied(id: number, v: string) {
    this.manual = true;
    this.applied.update((a) => ({ ...a, [id]: v === '' ? 0 : Number(v) }));
  }

  protected paiseGt(a: unknown, b: unknown) {
    return paise(a) > paise(b);
  }

  protected payInFull(inv: Invoice) {
    this.setApplied(inv.id, String(inv.balance));
  }

  protected save() {
    if (!this.canSave()) return;
    this.saving.set(true);
    this.error.set('');
    const allocations = Object.entries(this.applied())
      .map(([invoiceId, amount]) => ({ invoiceId: Number(invoiceId), amount: Number(amount) || 0 }))
      .filter((a) => a.amount > 0);
    this.api
      .createPayment({
        customerId: this.selectedId()!,
        paymentDate: this.date(),
        amount: Number(this.amount()),
        mode: this.mode(),
        reference: this.reference(),
        notes: this.notes(),
        allocations,
      })
      .subscribe({
        next: (p) => {
          this.toasts.show(`${p.paymentNumber} recorded`);
          const back = Number(this.invoiceId());
          this.router.navigate(back ? ['/invoices', back] : ['/payments', p.id]);
        },
        error: (e) => {
          this.error.set(errorMessage(e));
          this.saving.set(false);
        },
      });
  }
}
