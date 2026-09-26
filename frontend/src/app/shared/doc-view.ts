import { CurrencyPipe } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Api } from '../core/api';
import { amountInWords } from '../core/format';
import { InvoiceLine } from '../core/models';

/** What the printable view shows, whatever the document type. */
export interface PrintDoc {
  title: string;
  meta: [string, string][];
  partyLabel: string;
  customerName: string;
  billingAddress: string;
  customerGstin: string;
  customerEmail: string;
  lines: InvoiceLine[];
  subtotal: number;
  discountTotal: number;
  total: number;
  after: { label: string; value: number; minus?: boolean; grand?: boolean }[];
  notes: string;
  terms: string;
  showPayment: boolean;
  qrUrl: string; // UPI "scan to pay" image, or ''
  stamp: string; // VOID, DECLINED...
}

@Component({
  selector: 'app-doc-view',
  imports: [CurrencyPipe],
  template: `
    @let d = doc();
    @let o = org();
    <article class="doc" [class.is-void]="!!d.stamp">
      @if (d.stamp) { <div class="void-stamp" aria-hidden="true">{{ d.stamp }}</div> }

      <header class="doc-head">
        <div class="doc-from">
          <h2>{{ o?.name || 'Your business name' }}</h2>
          @if (o?.address) { <p class="pre">{{ o!.address }}</p> }
          <p>{{ join(', ', join(' ', o?.city, o?.pincode), orgState()) }}</p>
          @if (o?.gstin) { <p><strong>GSTIN</strong>&nbsp;<span class="mono">{{ o!.gstin }}</span></p> }
          @if (o?.email || o?.phone) { <p class="muted">{{ join(' · ', o?.email, o?.phone) }}</p> }
        </div>
        <div class="doc-title">
          <h1>{{ d.title }}</h1>
          <dl>
            @for (m of d.meta; track m[0]) { <dt>{{ m[0] }}</dt><dd>{{ m[1] }}</dd> }
          </dl>
        </div>
      </header>

      <section class="doc-bill">
        <h3>{{ d.partyLabel }}</h3>
        <p><strong>{{ d.customerName }}</strong></p>
        @if (d.billingAddress) { <p class="pre">{{ d.billingAddress }}</p> }
        @if (d.customerGstin) { <p><strong>GSTIN</strong>&nbsp;<span class="mono">{{ d.customerGstin }}</span></p> }
        @if (d.customerEmail) { <p class="muted">{{ d.customerEmail }}</p> }
      </section>

      <div class="doc-table-wrap">
        <table class="doc-table">
          <thead>
            <tr>
              <th>#</th><th>Item</th><th>HSN/SAC</th><th class="num">Qty</th><th class="num">Rate</th>
              @if (d.discountTotal > 0) { <th class="num">Disc</th> }
              @if (hasTax()) { <th class="num">GST</th> }
              <th class="num">Taxable value</th>
            </tr>
          </thead>
          <tbody>
            @for (l of d.lines; track $index; let i = $index) {
              <tr>
                <td>{{ i + 1 }}</td>
                <td>{{ l.description }}</td>
                <td class="mono">{{ l.hsnSac || '—' }}</td>
                <td class="num">{{ l.quantity }} {{ l.unit }}</td>
                <td class="num">{{ l.rate | currency }}</td>
                @if (d.discountTotal > 0) { <td class="num">{{ l.discountPct ? l.discountPct + '%' : '—' }}</td> }
                @if (hasTax()) { <td class="num">{{ l.taxRate }}%</td> }
                <td class="num">{{ l.taxableAmount | currency }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <div class="doc-summary">
        <div class="doc-words">
          <h3>Amount in words</h3>
          <p>{{ words() }}</p>
        </div>
        <dl class="totals">
          <dt>Taxable value</dt><dd>{{ d.subtotal | currency }}</dd>
          @for (g of taxGroups(); track g.rate) {
            @if (g.igst > 0) {
              <dt>IGST {{ g.rate }}%</dt><dd>{{ g.igst | currency }}</dd>
            } @else {
              <dt>CGST {{ g.rate / 2 }}%</dt><dd>{{ g.cgst | currency }}</dd>
              <dt>SGST {{ g.rate / 2 }}%</dt><dd>{{ g.sgst | currency }}</dd>
            }
          }
          <dt class="grand">Total</dt><dd class="grand">{{ d.total | currency }}</dd>
          @for (a of d.after; track a.label) {
            <dt [class.grand]="a.grand">{{ a.label }}</dt><dd [class.grand]="a.grand">{{ a.minus ? '−' : '' }}{{ a.value | currency }}</dd>
          }
        </dl>
      </div>

      <footer class="doc-foot" [class.has-qr]="!!d.qrUrl && d.showPayment">
        @if (d.showPayment && (o?.bankAccountNumber || o?.upiId)) {
          <div class="doc-pay">
            <div>
              <h3>How to pay</h3>
              @if (o?.bankAccountNumber) {
                <p>{{ o!.bankName }} · A/c <span class="mono">{{ o!.bankAccountNumber }}</span>@if (o?.bankIfsc) { · IFSC <span class="mono">{{ o!.bankIfsc }}</span> }</p>
              }
              @if (o?.upiId) { <p>UPI: <span class="mono">{{ o!.upiId }}</span></p> }
            </div>
            @if (d.qrUrl && o?.upiId) {
              <figure class="upi-qr">
                <img [src]="d.qrUrl" alt="UPI QR code to pay the balance due" width="116" height="116" />
                <figcaption>Scan to pay with any UPI app</figcaption>
              </figure>
            }
          </div>
        }
        @if (d.notes) { <div><h3>Notes</h3><p class="pre">{{ d.notes }}</p></div> }
        @if (d.terms) { <div><h3>Terms and conditions</h3><p class="pre">{{ d.terms }}</p></div> }
        <div class="signature">
          <p>For {{ o?.name || 'your business' }}</p>
          <p class="sign-line">Authorised signatory</p>
        </div>
      </footer>
    </article>
  `,
})
export class DocView {
  readonly doc = input.required<PrintDoc>();
  private api = inject(Api);
  private meta = toSignal(this.api.meta());
  protected org = this.api.org;

  protected orgState = computed(() => this.meta()?.states.find((s) => s.code === this.org()?.stateCode)?.name ?? '');
  protected hasTax = computed(() => this.doc().lines.some((l) => (l.cgst ?? 0) + (l.sgst ?? 0) + (l.igst ?? 0) > 0));
  protected words = computed(() => amountInWords(this.doc().total));
  protected taxGroups = computed(() => {
    const m = new Map<number, { rate: number; cgst: number; sgst: number; igst: number }>();
    for (const l of this.doc().lines) {
      if (!((l.cgst ?? 0) + (l.sgst ?? 0) + (l.igst ?? 0))) continue;
      const g = m.get(l.taxRate) ?? { rate: l.taxRate, cgst: 0, sgst: 0, igst: 0 };
      g.cgst += (l.cgst ?? 0);
      g.sgst += (l.sgst ?? 0);
      g.igst += (l.igst ?? 0);
      m.set(l.taxRate, g);
    }
    return [...m.values()].sort((a, b) => a.rate - b.rate);
  });

  protected join(sep: string, ...parts: (string | undefined)[]) {
    return parts.filter((p) => !!p && p.trim()).join(sep);
  }
}

/** Formats a date like the rest of the app: 25 Sept 2026. */
export function longDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
