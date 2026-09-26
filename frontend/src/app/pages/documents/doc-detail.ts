import { CurrencyPipe, DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Observable } from 'rxjs';
import { Api, errorMessage } from '../../core/api';
import { MODE_LABEL, todayISO } from '../../core/format';
import { DOC_KINDS, DOC_STATUS, docStatus } from '../../core/kinds';
import { DocType, Invoice, SalesDoc } from '../../core/models';
import { SendContext, docSendContext } from '../../core/send-text';
import { Toasts } from '../../core/toast';
import { ActivityList } from '../../shared/activity-list';
import { DocView, PrintDoc, longDate } from '../../shared/doc-view';
import { SendDialog } from '../../shared/send-dialog';

const MOVE_LABEL: Record<string, string> = {
  sent: 'Mark as sent', accepted: 'Mark as accepted', declined: 'Mark as declined', open: 'Issue',
  cancelled: 'Cancel challan', void: 'Void',
};
const MOVES: Record<DocType, Record<string, string[]>> = {
  quote: { draft: ['sent', 'accepted', 'declined'], sent: ['accepted', 'declined'], accepted: ['declined'], declined: ['accepted'] },
  challan: { draft: ['open'], open: ['cancelled'], cancelled: ['open'] },
  credit_note: { draft: ['open'], open: ['void'] },
};

@Component({
  selector: 'app-doc-detail',
  imports: [RouterLink, CurrencyPipe, DatePipe, FormsModule, DocView, SendDialog, ActivityList],
  templateUrl: './doc-detail.html',
})
export class DocDetail implements OnInit {
  readonly kind = input<DocType>('quote');
  readonly id = input.required<string>();

  private api = inject(Api);
  private router = inject(Router);
  private toasts = inject(Toasts);
  protected meta = toSignal(this.api.meta());
  protected org = this.api.org;
  protected readonly statusInfo = DOC_STATUS;
  protected readonly modeLabel = MODE_LABEL;
  protected readonly moveLabel = MOVE_LABEL;

  protected doc = signal<SalesDoc | null>(null);
  protected error = signal('');
  protected busy = signal(false);
  protected menuOpen = signal(false);
  protected sendCtx = signal<SendContext | null>(null);
  protected sendTab = signal<'email' | 'whatsapp'>('email');
  protected dialog = signal<'' | 'apply' | 'refund' | 'convert'>('');
  protected dialogError = signal('');

  // Apply credit
  protected openInvoices = signal<(Invoice & { use: number })[]>([]);
  protected applyDate = todayISO();
  // Refund
  protected refund = { refundDate: todayISO(), amount: 0, mode: 'bank_transfer', reference: '', notes: '' };
  // Convert challans
  protected otherChallans = signal<(SalesDoc & { pick: boolean })[]>([]);

  protected k = computed(() => DOC_KINDS[this.kind()]);
  protected status = computed(() => (this.doc() ? docStatus(this.doc()!) : 'draft'));
  protected moves = computed(() => {
    const d = this.doc();
    return d ? (MOVES[d.type][d.status] ?? []) : [];
  });
  protected editable = computed(() => !['invoiced', 'void', 'cancelled'].includes(this.doc()?.status ?? ''));
  protected canConvert = computed(() => {
    const d = this.doc();
    if (!d) return false;
    return d.type === 'quote' ? !['invoiced', 'declined'].includes(d.status) : d.type === 'challan' && d.status === 'open';
  });
  protected applyTotal = computed(() => this.openInvoices().reduce((s, i) => s + (Number(i.use) || 0), 0));

  protected print = computed<PrintDoc | null>(() => {
    const d = this.doc();
    if (!d) return null;
    const k = this.k();
    const meta: [string, string][] = [[k.numberLabel, d.number], ['Date', longDate(d.issueDate)]];
    if (d.type === 'quote' && d.expiryDate) meta.push(['Valid until', longDate(d.expiryDate)]);
    if (d.type === 'challan') meta.push(['Challan type', this.meta()?.challanTypes.find((t) => t.value === d.challanType)?.label ?? d.challanType]);
    if (d.type === 'credit_note') {
      if (d.invoiceNumber) meta.push(['Against invoice', `${d.invoiceNumber}${d.invoiceDate ? ' (' + longDate(d.invoiceDate) + ')' : ''}`]);
      meta.push(['Reason', this.meta()?.creditReasons.find((r) => r.value === d.reason)?.label ?? d.reason]);
    }
    if (d.reference) meta.push(['Reference', d.reference]);
    const pos = this.meta()?.states.find((s) => s.code === d.placeOfSupply);
    if (pos) meta.push(['Place of supply', `${pos.name} (${pos.code})`]);
    const stamp = { void: 'VOID', cancelled: 'CANCELLED', declined: 'DECLINED' }[d.status] ?? '';
    return {
      title: k.title, meta, partyLabel: d.type === 'challan' ? 'Deliver to' : 'Bill to', customerName: d.customerName,
      billingAddress: d.billingAddress, customerGstin: d.customerGstin, customerEmail: d.customerEmail, lines: d.lines ?? [],
      subtotal: d.subtotal, discountTotal: d.discountTotal, total: d.total, after: [], notes: d.notes, terms: d.terms,
      showPayment: false, qrUrl: '', stamp,
    };
  });

  ngOnInit() {
    if (!this.org()) this.api.loadOrg().subscribe({ error: () => {} });
    this.api.doc(this.k().path, this.id()).subscribe({
      next: (d) => this.doc.set(d),
      error: (e) => this.error.set(errorMessage(e)),
    });
  }

  private run<T>(req: Observable<T>, message: string, then?: (r: T) => void) {
    this.busy.set(true);
    this.menuOpen.set(false);
    req.subscribe({
      next: (r) => {
        this.busy.set(false);
        this.toasts.show(message);
        if (then) then(r);
        else this.doc.set(r as SalesDoc);
      },
      error: (e) => {
        this.busy.set(false);
        this.toasts.show(errorMessage(e), 'error');
      },
    });
  }

  protected move(to: string) {
    const d = this.doc()!;
    if (to === 'void' && !confirm(`Void ${d.number}? It stays in your records but can't be used any more.`)) return;
    if (to === 'cancelled' && !confirm(`Cancel ${d.number}? You can reopen it later.`)) return;
    const done: Record<string, string> = { sent: 'marked as sent', accepted: 'marked as accepted', declined: 'marked as declined',
      open: 'issued', cancelled: 'cancelled', void: 'is now void' };
    this.run(this.api.setDocStatus(this.k().path, d.id, to), `${d.number} ${done[to]}`);
  }

  protected remove() {
    const d = this.doc()!;
    if (!confirm(`Delete ${d.number}? This can't be undone.`)) return;
    this.run(this.api.deleteDoc(this.k().path, d.id), `${d.number} deleted`, () => this.router.navigate([this.k().route]));
  }

  protected convert() {
    const d = this.doc()!;
    if (d.type === 'quote') {
      this.run(this.api.convertQuote(d.id), `Invoice created from ${d.number}. Review it, then send it.`, (inv) =>
        this.router.navigate(['/invoices', inv.id]));
      return;
    }
    this.api.docs('challans', d.customerId).subscribe((list) => {
      const others = list.filter((c) => c.status === 'open' && c.id !== d.id).map((c) => ({ ...c, pick: false }));
      if (!others.length) {
        this.convertChallans([d.id]);
        return;
      }
      this.otherChallans.set(others);
      this.dialogError.set('');
      this.dialog.set('convert');
    });
  }

  protected convertChallans(ids: number[]) {
    this.dialog.set('');
    this.run(this.api.convertChallans(ids), ids.length > 1 ? `One invoice created from ${ids.length} challans` : 'Invoice created from the challan',
      (inv) => this.router.navigate(['/invoices', inv.id]));
  }

  protected pickedChallanIds() {
    return [this.doc()!.id, ...this.otherChallans().filter((c) => c.pick).map((c) => c.id)];
  }

  // ---------- Credit notes ----------

  protected openApply() {
    const d = this.doc()!;
    this.api.invoices({ customerId: d.customerId, open: true }).subscribe({
      next: (list) => {
        let left = d.balance;
        this.openInvoices.set(list.map((i) => {
          const use = Math.min(left, i.balance);
          left = Math.round((left - use) * 100) / 100;
          return { ...i, use };
        }));
        this.applyDate = todayISO();
        this.dialogError.set('');
        this.dialog.set('apply');
      },
      error: (e) => this.toasts.show(errorMessage(e), 'error'),
    });
  }

  protected apply() {
    const d = this.doc()!;
    const allocations = this.openInvoices().filter((i) => Number(i.use) > 0).map((i) => ({ invoiceId: i.id, amount: Number(i.use) }));
    if (!allocations.length) {
      this.dialogError.set('Enter an amount for at least one invoice.');
      return;
    }
    this.api.applyCredit(d.id, allocations, this.applyDate).subscribe({
      next: (u) => {
        this.doc.set(u);
        this.dialog.set('');
        this.toasts.show(`Credit used on ${allocations.length === 1 ? '1 invoice' : allocations.length + ' invoices'}`);
      },
      error: (e) => this.dialogError.set(errorMessage(e)),
    });
  }

  protected removeAllocation(allocId: number, number: string) {
    if (!confirm(`Stop using this credit on ${number}? The invoice will be owed again.`)) return;
    this.run(this.api.removeCreditAllocation(this.doc()!.id, allocId), `Credit removed from ${number}`);
  }

  protected openRefund() {
    this.refund = { refundDate: todayISO(), amount: this.doc()!.balance, mode: 'bank_transfer', reference: '', notes: '' };
    this.dialogError.set('');
    this.dialog.set('refund');
  }

  protected saveRefund() {
    this.api.addRefund(this.doc()!.id, { ...this.refund, amount: Number(this.refund.amount) }).subscribe({
      next: (u) => {
        this.doc.set(u);
        this.dialog.set('');
        this.toasts.show('Refund recorded');
      },
      error: (e) => this.dialogError.set(errorMessage(e)),
    });
  }

  protected removeRefund(refundId: number) {
    if (!confirm('Remove this refund? The credit becomes available again.')) return;
    this.run(this.api.removeRefund(this.doc()!.id, refundId), 'Refund removed');
  }

  // ---------- Sending ----------

  protected openSend(tab: 'email' | 'whatsapp') {
    const d = this.doc()!;
    this.menuOpen.set(false);
    this.api.customer(d.customerId).subscribe({
      next: (c) => {
        this.sendTab.set(tab);
        this.sendCtx.set(docSendContext(d, this.k(), this.org(), c.phone));
      },
      error: () => {
        this.sendTab.set(tab);
        this.sendCtx.set(docSendContext(d, this.k(), this.org(), ''));
      },
    });
  }

  protected onSent(d: unknown) {
    this.doc.set(d as SalesDoc);
    this.sendCtx.set(null);
  }

  protected printPage() {
    window.print();
  }
}
