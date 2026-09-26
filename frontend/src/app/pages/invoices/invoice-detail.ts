import { CurrencyPipe, DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { Api, errorMessage } from '../../core/api';
import { MODE_LABEL, dueText, invoiceStatus } from '../../core/format';
import { DOC_KINDS, DOC_STATUS } from '../../core/kinds';
import { DocType, Invoice } from '../../core/models';
import { SendContext, invoiceSendContext } from '../../core/send-text';
import { Toasts } from '../../core/toast';
import { ActivityList } from '../../shared/activity-list';
import { DocView, PrintDoc, longDate } from '../../shared/doc-view';
import { SendDialog } from '../../shared/send-dialog';
import { StatusBadge } from '../../shared/status-badge';

@Component({
  selector: 'app-invoice-detail',
  imports: [RouterLink, CurrencyPipe, DatePipe, StatusBadge, DocView, SendDialog, ActivityList],
  templateUrl: './invoice-detail.html',
})
export class InvoiceDetail implements OnInit {
  readonly id = input.required<string>();

  private api = inject(Api);
  private router = inject(Router);
  private toasts = inject(Toasts);
  private meta = toSignal(this.api.meta());
  protected org = this.api.org;
  protected readonly modeLabel = MODE_LABEL;
  protected readonly dueText = dueText;
  protected readonly docStatus = DOC_STATUS;

  protected invoice = signal<Invoice | null>(null);
  protected error = signal('');
  protected busy = signal(false);
  protected menuOpen = signal(false);
  protected sendCtx = signal<SendContext | null>(null);
  protected sendTab = signal<'email' | 'whatsapp'>('email');

  protected status = computed(() => (this.invoice() ? invoiceStatus(this.invoice()!) : 'draft'));

  protected print = computed<PrintDoc | null>(() => {
    const inv = this.invoice();
    if (!inv) return null;
    const pos = this.meta()?.states.find((s) => s.code === inv.placeOfSupply);
    const meta: [string, string][] = [['Invoice no.', inv.invoiceNumber], ['Date', longDate(inv.issueDate)], ['Due date', longDate(inv.dueDate)]];
    if (inv.reference) meta.push(['Reference', inv.reference]);
    if (pos) meta.push(['Place of supply', `${pos.name} (${pos.code})`]);
    const after: PrintDoc['after'] = [];
    if (inv.paid > 0) after.push({ label: 'Paid', value: inv.paid, minus: true });
    if (inv.credited > 0) after.push({ label: 'Credits applied', value: inv.credited, minus: true });
    if (inv.paid + inv.credited > 0) after.push({ label: 'Balance due', value: inv.balance, grand: true });
    return {
      title: this.org()?.gstRegistered ? 'Tax invoice' : 'Invoice', meta, partyLabel: 'Bill to',
      customerName: inv.customerName, billingAddress: inv.billingAddress, customerGstin: inv.customerGstin,
      customerEmail: inv.customerEmail, lines: inv.lines ?? [], subtotal: inv.subtotal, discountTotal: inv.discountTotal,
      total: inv.total, after, notes: inv.notes, terms: inv.terms, showPayment: inv.lifecycle !== 'void',
      qrUrl: inv.balance > 0 && inv.lifecycle !== 'void' ? `/api/invoices/${inv.id}/upi-qr.png?b=${inv.balance}` : '',
      stamp: inv.lifecycle === 'void' ? 'VOID' : '',
    };
  });

  ngOnInit() {
    if (!this.org()) this.api.loadOrg().subscribe({ error: () => {} });
    this.load();
  }

  private load() {
    this.api.invoice(this.id()).subscribe({
      next: (inv) => this.invoice.set(inv),
      error: (e) => this.error.set(errorMessage(e)),
    });
  }

  protected docLink(type: DocType, id: number) {
    return [DOC_KINDS[type].route, id];
  }

  protected docLabel(type: DocType) {
    return DOC_KINDS[type].label;
  }

  protected openSend(tab: 'email' | 'whatsapp') {
    const inv = this.invoice()!;
    this.menuOpen.set(false);
    this.api.customer(inv.customerId).subscribe({
      next: (c) => {
        this.sendTab.set(tab);
        this.sendCtx.set(invoiceSendContext(inv, this.org(), c.phone));
      },
      error: () => {
        this.sendTab.set(tab);
        this.sendCtx.set(invoiceSendContext(inv, this.org(), ''));
      },
    });
  }

  protected onSent(inv: unknown) {
    this.invoice.set(inv as Invoice);
    this.sendCtx.set(null);
  }

  protected printPage() {
    window.print();
  }

  protected markSent() {
    this.run(this.api.sendInvoice(this.invoice()!.id), 'Marked as sent. It now counts toward what you are owed.');
  }

  protected voidIt() {
    const inv = this.invoice()!;
    if (!confirm(`Void ${inv.invoiceNumber}? It stays in your records but no longer counts as money owed.`)) return;
    this.run(this.api.voidInvoice(inv.id), `${inv.invoiceNumber} is now void`);
  }

  protected remove() {
    const inv = this.invoice()!;
    const hint = inv.lifecycle === 'draft' ? '' : ' If you already sent it to the customer, voiding keeps a clearer record.';
    if (!confirm(`Delete ${inv.invoiceNumber}? This can't be undone.${hint}`)) return;
    this.busy.set(true);
    this.api.deleteInvoice(inv.id).subscribe({
      next: () => {
        this.toasts.show(`${inv.invoiceNumber} deleted`);
        this.router.navigate(['/invoices']);
      },
      error: (e) => {
        this.busy.set(false);
        this.toasts.show(errorMessage(e), 'error');
      },
    });
  }

  private run(req: ReturnType<Api['sendInvoice']>, message: string) {
    this.busy.set(true);
    this.menuOpen.set(false);
    req.subscribe({
      next: (inv) => {
        this.invoice.set(inv);
        this.busy.set(false);
        this.toasts.show(message);
      },
      error: (e) => {
        this.busy.set(false);
        this.toasts.show(errorMessage(e), 'error');
      },
    });
  }
}
