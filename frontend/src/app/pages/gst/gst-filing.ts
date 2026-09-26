import { CurrencyPipe, DatePipe, DecimalPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { Api, errorMessage } from '../../core/api';
import { downloadCsv, todayISO } from '../../core/format';
import { G1Doc, GSTR1, GSTR3B, GstReturn } from '../../core/models';
import { Period, fyLabel, fyMonths, fyOf, fyQuarters } from '../../core/periods';
import { Toasts } from '../../core/toast';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 2026-09-10 → 10-Sep-2026, the date format the GST offline tool's CSV files use. */
const toolDate = (iso: string) => `${iso.slice(8, 10)}-${MON[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;
const n2 = (v: number) => v.toFixed(2);

@Component({
  selector: 'app-gst-filing',
  imports: [FormsModule, RouterLink, CurrencyPipe, DatePipe, DecimalPipe],
  template: `
    <section class="page page-wide">
      <div class="page-head">
        <div>
          <h1>GST filing</h1>
          <p class="muted">
            @if (org()?.gstin) { GSTIN <span class="mono">{{ org()!.gstin }}</span> · }
            You file {{ quarterly() ? 'quarterly' : 'monthly' }} (<a routerLink="/settings" class="strong-link">change</a>)
          </p>
        </div>
        <div class="head-actions period-picker">
          <select [ngModel]="fy()" (ngModelChange)="setFy(+$event)" aria-label="Financial year">
            @for (y of years; track y) { <option [value]="y">FY {{ label(y) }}</option> }
          </select>
          <select [ngModel]="index()" (ngModelChange)="index.set(+$event); load()" aria-label="Return period">
            @for (p of periods(); track p.from; let i = $index) { <option [value]="i">{{ p.label }}</option> }
          </select>
        </div>
      </div>

      @if (error()) {
        <div class="alert" role="alert"><span>{{ error() }}</span><button type="button" class="btn" (click)="load()">Try again</button></div>
      } @else if (loading() || !g1() || !g3()) {
        <p class="muted">Preparing {{ period().label }}…</p>
      } @else {
        @let one = g1()!;
        @let three = g3()!;

        <div class="filing-row">
          @for (rt of returnTypes; track rt.type) {
            @let filed = filedFor(rt.type);
            <div class="card filing-card" [class.filed]="!!filed">
              <div>
                <strong>{{ rt.label }}</strong>
                @if (filed) {
                  <p class="sub"><i class="ti ti-circle-check text-success" aria-hidden="true"></i> Filed on {{ filed.filedOn | date: 'd MMM y' }}@if (filed.arn) { · ARN <span class="mono">{{ filed.arn }}</span> }</p>
                  @if (rt.type === 'GSTR1') { <p class="sub">Invoices and credit notes dated in this period are locked.</p> }
                } @else {
                  <p class="sub">{{ rt.due }}</p>
                }
              </div>
              @if (filed) {
                <button type="button" class="link-btn" (click)="unmark(filed)">Unmark</button>
              } @else if (marking() === rt.type) {
                <form class="mark-form" (ngSubmit)="mark(rt.type)">
                  <label class="field"><span>Filed on</span><input type="date" name="on" [(ngModel)]="filedOn" /></label>
                  <label class="field"><span>ARN <em class="sub">(optional)</em></span><input type="text" name="arn" [(ngModel)]="arn" maxlength="30" class="mono upper" /></label>
                  <button type="submit" class="btn btn-primary">Save</button>
                  <button type="button" class="btn" (click)="marking.set('')">Cancel</button>
                </form>
              } @else {
                <button type="button" class="btn" (click)="startMark(rt.type)">Mark as filed</button>
              }
            </div>
          }
        </div>

        @if (one.checks.length) {
          <div class="card checks-card">
            <h2>Before you file</h2>
            <ul class="gst-checks">
              @for (c of one.checks; track c.message) {
                <li [attr.data-level]="c.level">
                  <i class="ti" [class.ti-alert-octagon]="c.level === 'error'" [class.ti-alert-triangle]="c.level === 'warning'" [class.ti-info-circle]="c.level === 'info'" aria-hidden="true"></i>
                  <span>{{ c.message }} @if (c.link) { <a [routerLink]="linkPath(c.link)" [queryParams]="linkQuery(c.link)" class="strong-link">Fix</a> }</span>
                </li>
              }
            </ul>
          </div>
        } @else {
          <p class="alert alert-info"><span><i class="ti ti-circle-check" aria-hidden="true"></i> No problems found for {{ period().label }}.</span></p>
        }

        <div class="tabs" role="tablist">
          <button type="button" role="tab" [attr.aria-selected]="tab() === 'gstr1'" [class.active]="tab() === 'gstr1'" (click)="tab.set('gstr1')">GSTR-1 (sales)</button>
          <button type="button" role="tab" [attr.aria-selected]="tab() === 'gstr3b'" [class.active]="tab() === 'gstr3b'" (click)="tab.set('gstr3b')">GSTR-3B (summary and payment)</button>
        </div>

        @if (tab() === 'gstr1') {
          <div class="tiles tiles-3">
            <div class="tile"><span class="tile-label">Invoices</span><span class="tile-value">{{ one.invoices }}</span><span class="tile-sub">sent in {{ period().label }}</span></div>
            <div class="tile"><span class="tile-label">Taxable value</span><span class="tile-value">{{ one.totals.taxable | currency }}</span><span class="tile-sub">net of credit notes</span></div>
            <div class="tile"><span class="tile-label">Tax</span><span class="tile-value">{{ one.totals.igst + one.totals.cgst + one.totals.sgst | currency }}</span>
              <span class="tile-sub">IGST {{ one.totals.igst | currency }} · CGST {{ one.totals.cgst | currency }} · SGST {{ one.totals.sgst | currency }}</span></div>
          </div>
          <div class="help-box">
            <p><strong>Filing GSTR-1:</strong> on the GST portal, open Returns Dashboard, choose this period, then <em>GSTR-1 → Prepare offline → Upload</em> and upload the JSON file. The portal checks it and shows each table for you to review before you submit. You can also enter the figures below by hand. Have your accountant review your first filing.</p>
            <button type="button" class="btn btn-primary" (click)="downloadJson()" [disabled]="!org()?.gstin"><i class="ti ti-file-download" aria-hidden="true"></i>Download GSTR-1 JSON</button>
          </div>

          <details class="card g-section" [open]="one.b2b.length > 0">
            <summary><span>4A · B2B invoices (registered buyers)</span><span class="sub">{{ n(one.b2b.length, 'invoice', 'invoices') }} · {{ sumTaxable(one.b2b) | currency }}</span></summary>
            @if (one.b2b.length) {
              <button type="button" class="btn btn-quiet" (click)="csvB2B(one)"><i class="ti ti-download" aria-hidden="true"></i>b2b.csv</button>
              <div class="table-card"><table class="table">
                <thead><tr><th>GSTIN</th><th>Customer</th><th>Invoice</th><th>Date</th><th>Place of supply</th><th class="num">Value</th><th class="num">Rate</th><th class="num">Taxable</th><th class="num">IGST</th><th class="num">CGST</th><th class="num">SGST</th></tr></thead>
                <tbody>@for (d of one.b2b; track d.id) { @for (it of d.items; track it.rate; let first = $first) {
                  <tr><td class="mono">{{ first ? d.gstin : '' }}</td><td>{{ first ? d.customer : '' }}</td><td>@if (first) { <a [routerLink]="['/invoices', d.id]" class="strong-link">{{ d.number }}</a> }</td>
                    <td>{{ first ? (d.date | date: 'd MMM') : '' }}</td><td>{{ first ? pos(d.pos) : '' }}</td><td class="num">{{ first ? (d.value | currency) : '' }}</td>
                    <td class="num">{{ it.rate }}%</td><td class="num">{{ it.taxable | currency }}</td><td class="num">{{ it.igst | currency }}</td><td class="num">{{ it.cgst | currency }}</td><td class="num">{{ it.sgst | currency }}</td></tr>
                } }</tbody></table></div>
            } @else { <p class="sub">Nothing to report.</p> }
          </details>

          <details class="card g-section" [open]="one.b2cl.length > 0">
            <summary><span>5 · B2C large (unregistered, other state, over ₹1 lakh)</span><span class="sub">{{ n(one.b2cl.length, 'invoice', 'invoices') }} · {{ sumTaxable(one.b2cl) | currency }}</span></summary>
            @if (one.b2cl.length) {
              <button type="button" class="btn btn-quiet" (click)="csvB2CL(one)"><i class="ti ti-download" aria-hidden="true"></i>b2cl.csv</button>
              <div class="table-card"><table class="table">
                <thead><tr><th>Invoice</th><th>Date</th><th>Place of supply</th><th class="num">Value</th><th class="num">Rate</th><th class="num">Taxable</th><th class="num">IGST</th></tr></thead>
                <tbody>@for (d of one.b2cl; track d.id) { @for (it of d.items; track it.rate; let first = $first) {
                  <tr><td>@if (first) { <a [routerLink]="['/invoices', d.id]" class="strong-link">{{ d.number }}</a> }</td><td>{{ first ? (d.date | date: 'd MMM') : '' }}</td><td>{{ first ? pos(d.pos) : '' }}</td>
                    <td class="num">{{ first ? (d.value | currency) : '' }}</td><td class="num">{{ it.rate }}%</td><td class="num">{{ it.taxable | currency }}</td><td class="num">{{ it.igst | currency }}</td></tr>
                } }</tbody></table></div>
            } @else { <p class="sub">Nothing to report.</p> }
          </details>

          <details class="card g-section" [open]="one.b2cs.length > 0">
            <summary><span>7 · B2C small (other unregistered sales, by state and rate)</span><span class="sub">{{ n(one.b2cs.length, 'row', 'rows') }}</span></summary>
            @if (one.b2cs.length) {
              <button type="button" class="btn btn-quiet" (click)="csvB2CS(one)"><i class="ti ti-download" aria-hidden="true"></i>b2cs.csv</button>
              <div class="table-card"><table class="table">
                <thead><tr><th>Type</th><th>Place of supply</th><th class="num">Rate</th><th class="num">Taxable</th><th class="num">IGST</th><th class="num">CGST</th><th class="num">SGST</th></tr></thead>
                <tbody>@for (r of one.b2cs; track r.supplyType + r.pos + r.rate) {
                  <tr><td>{{ r.supplyType === 'INTER' ? 'Inter-state' : 'Intra-state' }}</td><td>{{ pos(r.pos) }}</td><td class="num">{{ r.rate }}%</td><td class="num">{{ r.taxable | currency }}</td>
                    <td class="num">{{ r.igst | currency }}</td><td class="num">{{ r.cgst | currency }}</td><td class="num">{{ r.sgst | currency }}</td></tr>
                }</tbody></table></div>
              <p class="sub">Credit notes to unregistered buyers (other than large inter-state invoices) are subtracted here.</p>
            } @else { <p class="sub">Nothing to report.</p> }
          </details>

          <details class="card g-section" [open]="one.exp.length > 0">
            <summary><span>6A · Exports</span><span class="sub">{{ n(one.exp.length, 'invoice', 'invoices') }} · {{ sumTaxable(one.exp) | currency }}</span></summary>
            @if (one.exp.length) {
              <button type="button" class="btn btn-quiet" (click)="csvEXP(one)"><i class="ti ti-download" aria-hidden="true"></i>exp.csv</button>
              <div class="table-card"><table class="table">
                <thead><tr><th>Invoice</th><th>Date</th><th>Type</th><th class="num">Value</th><th class="num">Rate</th><th class="num">Taxable</th><th class="num">IGST</th></tr></thead>
                <tbody>@for (d of one.exp; track d.id) { @for (it of d.items; track it.rate; let first = $first) {
                  <tr><td>@if (first) { <a [routerLink]="['/invoices', d.id]" class="strong-link">{{ d.number }}</a> }</td><td>{{ first ? (d.date | date: 'd MMM') : '' }}</td>
                    <td>{{ first ? (d.type === 'WPAY' ? 'With IGST' : 'Without IGST (LUT)') : '' }}</td><td class="num">{{ first ? (d.value | currency) : '' }}</td>
                    <td class="num">{{ it.rate }}%</td><td class="num">{{ it.taxable | currency }}</td><td class="num">{{ it.igst | currency }}</td></tr>
                } }</tbody></table></div>
              <p class="sub">Add port code and shipping bill details on the portal for exports of goods.</p>
            } @else { <p class="sub">Nothing to report.</p> }
          </details>

          <details class="card g-section" [open]="one.cdnr.length + one.cdnur.length > 0">
            <summary><span>9B · Credit notes</span><span class="sub">{{ one.cdnr.length }} registered · {{ one.cdnur.length }} unregistered</span></summary>
            @if (one.cdnr.length) {
              <h3 class="subhead">Registered buyers (CDNR)</h3>
              <button type="button" class="btn btn-quiet" (click)="csvCDNR(one)"><i class="ti ti-download" aria-hidden="true"></i>cdnr.csv</button>
              <div class="table-card"><table class="table">
                <thead><tr><th>GSTIN</th><th>Customer</th><th>Note</th><th>Date</th><th>Against</th><th class="num">Value</th><th class="num">Rate</th><th class="num">Taxable</th><th class="num">Tax</th></tr></thead>
                <tbody>@for (d of one.cdnr; track d.id) { @for (it of d.items; track it.rate; let first = $first) {
                  <tr><td class="mono">{{ first ? d.gstin : '' }}</td><td>{{ first ? d.customer : '' }}</td><td>@if (first) { <a [routerLink]="['/credit-notes', d.id]" class="strong-link">{{ d.number }}</a> }</td>
                    <td>{{ first ? (d.date | date: 'd MMM') : '' }}</td><td>{{ first ? d.against : '' }}</td><td class="num">{{ first ? (d.value | currency) : '' }}</td>
                    <td class="num">{{ it.rate }}%</td><td class="num">{{ it.taxable | currency }}</td><td class="num">{{ it.igst + it.cgst + it.sgst | currency }}</td></tr>
                } }</tbody></table></div>
            }
            @if (one.cdnur.length) {
              <h3 class="subhead">Unregistered buyers (CDNUR)</h3>
              <button type="button" class="btn btn-quiet" (click)="csvCDNUR(one)"><i class="ti ti-download" aria-hidden="true"></i>cdnur.csv</button>
              <div class="table-card"><table class="table">
                <thead><tr><th>Type</th><th>Note</th><th>Date</th><th>Against</th><th class="num">Value</th><th class="num">Rate</th><th class="num">Taxable</th><th class="num">IGST</th></tr></thead>
                <tbody>@for (d of one.cdnur; track d.id) { @for (it of d.items; track it.rate; let first = $first) {
                  <tr><td>{{ first ? d.type : '' }}</td><td>@if (first) { <a [routerLink]="['/credit-notes', d.id]" class="strong-link">{{ d.number }}</a> }</td><td>{{ first ? (d.date | date: 'd MMM') : '' }}</td>
                    <td>{{ first ? d.against : '' }}</td><td class="num">{{ first ? (d.value | currency) : '' }}</td><td class="num">{{ it.rate }}%</td><td class="num">{{ it.taxable | currency }}</td><td class="num">{{ it.igst | currency }}</td></tr>
                } }</tbody></table></div>
            }
            @if (!one.cdnr.length && !one.cdnur.length) { <p class="sub">Nothing to report.</p> }
          </details>

          <details class="card g-section" [open]="one.nil.length > 0">
            <summary><span>8 · Nil-rated supplies (0% GST)</span><span class="sub">{{ one.nil.length ? (sumNil(one) | currency) : 'None' }}</span></summary>
            @if (one.nil.length) {
              <div class="table-card"><table class="table">
                <thead><tr><th>Supply</th><th class="num">Nil-rated</th><th class="num">Exempted</th><th class="num">Non-GST</th></tr></thead>
                <tbody>@for (r of one.nil; track r.supplyType) { <tr><td>{{ r.label }}</td><td class="num">{{ r.amount | currency }}</td><td class="num">{{ 0 | currency }}</td><td class="num">{{ 0 | currency }}</td></tr> }</tbody>
              </table></div>
              <p class="sub">Averqo treats 0% lines as nil-rated. If some are exempt or non-GST, move them to the right column on the portal.</p>
            } @else { <p class="sub">Nothing to report.</p> }
          </details>

          <details class="card g-section" [open]="one.hsnB2b.length + one.hsnB2c.length > 0">
            <summary><span>12 · HSN summary</span><span class="sub">{{ n(one.hsnB2b.length, 'B2B row', 'B2B rows') }} · {{ n(one.hsnB2c.length, 'B2C row', 'B2C rows') }}</span></summary>
            @for (part of [{ title: 'B2B (registered buyers)', rows: one.hsnB2b, file: 'hsn(b2b).csv' }, { title: 'B2C (unregistered buyers)', rows: one.hsnB2c, file: 'hsn(b2c).csv' }]; track part.title) {
              @if (part.rows.length) {
                <h3 class="subhead">{{ part.title }}</h3>
                <button type="button" class="btn btn-quiet" (click)="csvHSN(part.rows, part.file)"><i class="ti ti-download" aria-hidden="true"></i>{{ part.file }}</button>
                <div class="table-card"><table class="table">
                  <thead><tr><th>HSN/SAC</th><th>Description</th><th>UQC</th><th class="num">Quantity</th><th class="num">Rate</th><th class="num">Taxable</th><th class="num">IGST</th><th class="num">CGST</th><th class="num">SGST</th></tr></thead>
                  <tbody>@for (h of part.rows; track h.hsn + h.rate + h.uqc) {
                    <tr [class.text-danger]="!h.hsn"><td class="mono">{{ h.hsn || 'Missing' }}</td><td>{{ h.desc }}</td><td>{{ h.uqc }}</td><td class="num">{{ h.qty | number: '1.0-2' }}</td><td class="num">{{ h.rate }}%</td>
                      <td class="num">{{ h.taxable | currency }}</td><td class="num">{{ h.igst | currency }}</td><td class="num">{{ h.cgst | currency }}</td><td class="num">{{ h.sgst | currency }}</td></tr>
                  }</tbody></table></div>
              }
            }
            @if (!one.hsnB2b.length && !one.hsnB2c.length) { <p class="sub">Nothing to report.</p> }
          </details>

          <details class="card g-section" [open]="one.docs.length > 0">
            <summary><span>13 · Documents issued</span><span class="sub">{{ n(one.docs.length, 'series', 'series') }}</span></summary>
            @if (one.docs.length) {
              <button type="button" class="btn btn-quiet" (click)="csvDocs(one)"><i class="ti ti-download" aria-hidden="true"></i>docs.csv</button>
              <div class="table-card"><table class="table">
                <thead><tr><th>Nature of document</th><th>From</th><th>To</th><th class="num">Total</th><th class="num">Cancelled</th><th class="num">Net issued</th></tr></thead>
                <tbody>@for (d of one.docs; track d.nature + d.from) {
                  <tr><td>{{ d.nature }}</td><td class="mono">{{ d.from }}</td><td class="mono">{{ d.to }}</td><td class="num">{{ d.total }}</td><td class="num">{{ d.cancelled }}</td><td class="num">{{ d.total - d.cancelled }}</td></tr>
                }</tbody></table></div>
            } @else { <p class="sub">Nothing to report.</p> }
          </details>
        } @else {
          <div class="help-box"><p><strong>Filing GSTR-3B:</strong> enter these figures in GSTR-3B on the GST portal. The portal fills in parts of it for you from GSTR-1 and GSTR-2B. <strong>Always match your input tax credit with GSTR-2B</strong>: you can only claim GST that your vendors have reported.</p></div>

          <div class="card"><h2>3.1 · Sales, and purchases under reverse charge</h2>
            <div class="table-card"><table class="table">
              <thead><tr><th>Nature of supplies</th><th class="num">Taxable value</th><th class="num">IGST</th><th class="num">CGST</th><th class="num">SGST</th></tr></thead>
              <tbody>
                @for (r of [{ label: '(a) Outward taxable supplies', v: three.outward }, { label: '(b) Zero-rated supplies (exports)', v: three.zeroRated },
                  { label: '(c) Nil-rated and exempted supplies', v: three.nilExempt }, { label: '(d) Inward supplies liable to reverse charge', v: three.reverseCharge }]; track r.label) {
                  <tr><td>{{ r.label }}</td><td class="num">{{ r.v.taxable | currency }}</td><td class="num">{{ r.v.igst | currency }}</td><td class="num">{{ r.v.cgst | currency }}</td><td class="num">{{ r.v.sgst | currency }}</td></tr>
                }
                <tr><td>(e) Non-GST outward supplies</td><td class="num">{{ 0 | currency }}</td><td class="num">—</td><td class="num">—</td><td class="num">—</td></tr>
              </tbody></table></div>
          </div>

          <div class="card"><h2>3.2 · Inter-state sales to unregistered buyers</h2>
            @if (three.interUnregistered.length) {
              <div class="table-card"><table class="table">
                <thead><tr><th>Place of supply</th><th class="num">Taxable value</th><th class="num">IGST</th></tr></thead>
                <tbody>@for (r of three.interUnregistered; track r.pos) { <tr><td>{{ r.pos }}-{{ r.state }}</td><td class="num">{{ r.taxable | currency }}</td><td class="num">{{ r.igst | currency }}</td></tr> }</tbody>
              </table></div>
            } @else { <p class="sub">None.</p> }
          </div>

          <div class="card"><h2>4 · Eligible input tax credit</h2>
            <div class="table-card"><table class="table">
              <thead><tr><th>Details</th><th class="num">IGST</th><th class="num">CGST</th><th class="num">SGST</th></tr></thead>
              <tbody>
                <tr><td>(A)(3) Inward supplies liable to reverse charge</td><td class="num">{{ three.itcReverseCharge.igst | currency }}</td><td class="num">{{ three.itcReverseCharge.cgst | currency }}</td><td class="num">{{ three.itcReverseCharge.sgst | currency }}</td></tr>
                <tr><td>(A)(5) All other ITC</td><td class="num">{{ three.itcOther.igst | currency }}</td><td class="num">{{ three.itcOther.cgst | currency }}</td><td class="num">{{ three.itcOther.sgst | currency }}</td></tr>
                <tr><td>(B) ITC reversed</td><td class="num">{{ 0 | currency }}</td><td class="num">{{ 0 | currency }}</td><td class="num">{{ 0 | currency }}</td></tr>
                <tr class="total-row"><td>(C) Net ITC available</td><td class="num">{{ three.itcNet.igst | currency }}</td><td class="num">{{ three.itcNet.cgst | currency }}</td><td class="num">{{ three.itcNet.sgst | currency }}</td></tr>
              </tbody></table></div>
            <p class="sub">From expenses in this period marked "claim this GST back" that have the vendor's GSTIN (or are reverse charge).</p>
          </div>

          <div class="card"><h2>6.1 · Payment of tax</h2>
            <div class="table-card"><table class="table">
              <thead><tr><th>Tax</th><th class="num">Tax payable</th><th class="num">Paid from IGST credit</th><th class="num">Paid from CGST credit</th><th class="num">Paid from SGST credit</th><th class="num">Pay in cash</th></tr></thead>
              <tbody>
                @for (h of heads; track h.key) {
                  <tr><td>{{ h.label }}</td><td class="num">{{ three.setoff.liability[h.key] | currency }}</td><td class="num">{{ three.setoff.fromIgst[h.key] | currency }}</td>
                    <td class="num">{{ three.setoff.fromCgst[h.key] | currency }}</td><td class="num">{{ three.setoff.fromSgst[h.key] | currency }}</td><td class="num strong">{{ three.setoff.cash[h.key] | currency }}</td></tr>
                }
                @for (h of heads; track h.key) {
                  @if (three.reverseChargeCash[h.key]) {
                    <tr><td>{{ h.label }} (reverse charge)</td><td class="num">{{ three.reverseChargeCash[h.key] | currency }}</td><td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num strong">{{ three.reverseChargeCash[h.key] | currency }}</td></tr>
                  }
                }
                <tr class="total-row"><td>Total to pay in cash</td><td></td><td></td><td></td><td></td><td class="num">{{ cashTotal() | currency }}</td></tr>
              </tbody></table></div>
            <p class="sub">Credit is used in the order the law sets: IGST credit first (against IGST, then CGST and SGST), then CGST credit (CGST, then IGST), then SGST credit (SGST, then IGST). Reverse charge tax is always paid in cash.
              Credit carried forward: IGST {{ three.setoff.creditLeft.igst | currency }}, CGST {{ three.setoff.creditLeft.cgst | currency }}, SGST {{ three.setoff.creditLeft.sgst | currency }}.</p>
          </div>
        }
      }
    </section>
  `,
})
export class GstFiling {
  private api = inject(Api);
  private toasts = inject(Toasts);
  protected org = this.api.org;
  private meta = toSignal(this.api.meta());
  protected readonly label = fyLabel;
  protected readonly years = [0, 1, 2, 3].map((i) => fyOf() - i);
  protected readonly heads = [{ key: 'igst', label: 'IGST' }, { key: 'cgst', label: 'CGST' }, { key: 'sgst', label: 'SGST' }] as const;
  protected readonly returnTypes = [
    { type: 'GSTR1' as const, label: 'GSTR-1', due: 'Due by the 11th of the next month, or the 13th after the quarter for quarterly filers.' },
    { type: 'GSTR3B' as const, label: 'GSTR-3B', due: 'Due by the 20th of the next month. Quarterly filers: the 22nd or 24th after the quarter, depending on your state.' },
  ];

  protected quarterly = computed(() => this.org()?.gstFilingFrequency === 'quarterly');
  protected fy = signal(fyOf());
  protected index = signal(0);
  protected periods = computed<Period[]>(() => (this.quarterly() ? fyQuarters(this.fy()) : fyMonths(this.fy())));
  protected period = computed(() => this.periods()[this.index()] ?? this.periods()[0]);
  protected tab = signal<'gstr1' | 'gstr3b'>('gstr1');
  protected loading = signal(true);
  protected error = signal('');
  protected g1 = signal<GSTR1 | null>(null);
  protected g3 = signal<GSTR3B | null>(null);
  protected returns = signal<GstReturn[]>([]);
  protected marking = signal<'' | 'GSTR1' | 'GSTR3B'>('');
  protected filedOn = todayISO();
  protected arn = '';
  protected cashTotal = computed(() => {
    const g = this.g3();
    if (!g) return 0;
    const c = g.setoff.cash;
    const r = g.reverseChargeCash;
    return c.igst + c.cgst + c.sgst + r.igst + r.cgst + r.sgst;
  });

  constructor() {
    this.api.loadOrg().subscribe({
      next: () => {
        this.pickDefault();
        this.load();
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.loading.set(false);
      },
    });
  }

  /** Start on the latest period that has ended, which is the one usually being filed. */
  private pickDefault() {
    const today = todayISO();
    for (const fy of [fyOf(), fyOf() - 1]) {
      const list = this.quarterly() ? fyQuarters(fy) : fyMonths(fy);
      const i = list.map((p) => p.to < today).lastIndexOf(true);
      if (i >= 0) {
        this.fy.set(fy);
        this.index.set(i);
        return;
      }
    }
  }

  protected setFy(y: number) {
    this.fy.set(y);
    this.index.set(0);
    this.load();
  }

  protected load() {
    const p = this.period();
    this.loading.set(true);
    this.error.set('');
    this.marking.set('');
    forkJoin({ g1: this.api.gstr1(p.from, p.to), g3: this.api.gstr3b(p.from, p.to), returns: this.api.gstReturns() }).subscribe({
      next: ({ g1, g3, returns }) => {
        this.g1.set(g1);
        this.g3.set(g3);
        this.returns.set(returns);
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.loading.set(false);
      },
    });
  }

  protected filedFor(type: 'GSTR1' | 'GSTR3B') {
    const p = this.period();
    return this.returns().find((r) => r.returnType === type && r.periodStart === p.from && r.periodEnd === p.to) ?? null;
  }

  protected startMark(type: 'GSTR1' | 'GSTR3B') {
    this.filedOn = todayISO();
    this.arn = '';
    this.marking.set(type);
  }

  protected mark(type: 'GSTR1' | 'GSTR3B') {
    const p = this.period();
    this.api.markFiled({ returnType: type, periodStart: p.from, periodEnd: p.to, filedOn: this.filedOn, arn: this.arn }).subscribe({
      next: (list) => {
        this.returns.set(list);
        this.marking.set('');
        this.toasts.show(`${type === 'GSTR1' ? 'GSTR-1' : 'GSTR-3B'} for ${p.label} marked as filed`);
      },
      error: (e) => this.toasts.show(errorMessage(e), 'error'),
    });
  }

  protected unmark(r: GstReturn) {
    if (!confirm('Unmark this return as filed? Invoices in this period can be edited again.')) return;
    this.api.unmarkFiled(r.id).subscribe({ next: (list) => this.returns.set(list), error: (e) => this.toasts.show(errorMessage(e), 'error') });
  }

  protected downloadJson() {
    const p = this.period();
    if (this.g1()?.checks.some((c) => c.level === 'error') && !confirm('There are errors to fix before filing. Download the file anyway?')) return;
    this.api.gstr1Json(p.from, p.to).subscribe({
      next: (blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `GSTR1_${this.org()?.gstin}_${p.to.slice(5, 7)}${p.to.slice(0, 4)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      },
      error: (e) => this.toasts.show(errorMessage(e), 'error'),
    });
  }

  protected linkPath(link: string) {
    return link.split('?')[0];
  }

  protected linkQuery(link: string) {
    const q = link.split('?')[1];
    return q ? Object.fromEntries(new URLSearchParams(q)) : {};
  }

  protected pos(code: string) {
    const name = this.meta()?.states.find((s) => s.code === code)?.name ?? '';
    return name ? `${code}-${name}` : code;
  }

  protected n(count: number, one: string, many: string) {
    return `${count} ${count === 1 ? one : many}`;
  }

  protected sumTaxable(docs: G1Doc[]) {
    return docs.reduce((s, d) => s + d.total.taxable, 0);
  }

  protected sumNil(g: GSTR1) {
    return g.nil.reduce((s, r) => s + r.amount, 0);
  }

  // ---------- CSV files laid out like the GST offline tool's templates ----------

  private file(name: string) {
    return `${name.replace('.csv', '')}_${this.period().to.slice(0, 7)}.csv`;
  }

  protected csvB2B(g: GSTR1) {
    downloadCsv(this.file('b2b.csv'), ['GSTIN/UIN of Recipient', 'Receiver Name', 'Invoice Number', 'Invoice date', 'Invoice Value',
      'Place Of Supply', 'Reverse Charge', 'Applicable % of Tax Rate', 'Invoice Type', 'E-Commerce GSTIN', 'Rate', 'Taxable Value', 'Cess Amount'],
      g.b2b.flatMap((d) => d.items.map((it) => [d.gstin, d.customer, d.number, toolDate(d.date), n2(d.value), this.pos(d.pos), 'N', '',
        'Regular B2B', '', it.rate, n2(it.taxable), '0.00'])));
  }

  protected csvB2CL(g: GSTR1) {
    downloadCsv(this.file('b2cl.csv'), ['Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply', 'Applicable % of Tax Rate',
      'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN'],
      g.b2cl.flatMap((d) => d.items.map((it) => [d.number, toolDate(d.date), n2(d.value), this.pos(d.pos), '', it.rate, n2(it.taxable), '0.00', ''])));
  }

  protected csvB2CS(g: GSTR1) {
    downloadCsv(this.file('b2cs.csv'), ['Type', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN'],
      g.b2cs.map((r) => ['OE', this.pos(r.pos), '', r.rate, n2(r.taxable), '0.00', '']));
  }

  protected csvEXP(g: GSTR1) {
    downloadCsv(this.file('exp.csv'), ['Export Type', 'Invoice Number', 'Invoice date', 'Invoice Value', 'Port Code', 'Shipping Bill Number',
      'Shipping Bill Date', 'Rate', 'Taxable Value', 'Cess Amount'],
      g.exp.flatMap((d) => d.items.map((it) => [d.type, d.number, toolDate(d.date), n2(d.value), '', '', '', it.rate, n2(it.taxable), '0.00'])));
  }

  protected csvCDNR(g: GSTR1) {
    downloadCsv(this.file('cdnr.csv'), ['GSTIN/UIN of Recipient', 'Receiver Name', 'Note Number', 'Note Date', 'Note Type', 'Place Of Supply',
      'Reverse Charge', 'Note Supply Type', 'Note Value', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount'],
      g.cdnr.flatMap((d) => d.items.map((it) => [d.gstin, d.customer, d.number, toolDate(d.date), 'C', this.pos(d.pos), 'N', 'Regular B2B',
        n2(d.value), '', it.rate, n2(it.taxable), '0.00'])));
  }

  protected csvCDNUR(g: GSTR1) {
    downloadCsv(this.file('cdnur.csv'), ['UR Type', 'Note Number', 'Note Date', 'Note Type', 'Place Of Supply', 'Note Value',
      'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount'],
      g.cdnur.flatMap((d) => d.items.map((it) => [d.type, d.number, toolDate(d.date), 'C', d.type === 'B2CL' ? this.pos(d.pos) : '', n2(d.value),
        '', it.rate, n2(it.taxable), '0.00'])));
  }

  protected csvHSN(rows: GSTR1['hsnB2b'], name: string) {
    downloadCsv(this.file(name), ['HSN', 'Description', 'UQC', 'Total Quantity', 'Total Value', 'Rate', 'Taxable Value', 'Integrated Tax Amount',
      'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount'],
      rows.map((h) => [h.hsn, h.desc, h.uqc, h.qty, n2(h.taxable + h.igst + h.cgst + h.sgst), h.rate, n2(h.taxable), n2(h.igst), n2(h.cgst), n2(h.sgst), '0.00']));
  }

  protected csvDocs(g: GSTR1) {
    downloadCsv(this.file('docs.csv'), ['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled'],
      g.docs.map((d) => [d.nature, d.from, d.to, d.total, d.cancelled]));
  }
}
