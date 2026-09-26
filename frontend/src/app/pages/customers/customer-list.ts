import { CurrencyPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { Api, errorMessage } from '../../core/api';
import { GST_TREATMENT_LABEL, downloadCsv } from '../../core/format';
import { Customer } from '../../core/models';

@Component({
  selector: 'app-customer-list',
  imports: [RouterLink, CurrencyPipe],
  template: `
    <section class="page page-wide">
      <div class="page-head">
        <div>
          <h1>Customers</h1>
          @if (active().length) {
            <p class="muted">{{ active().length }} active. {{ owedTotal() | currency }} outstanding in total.</p>
          }
        </div>
        <div class="head-actions">
          <button type="button" class="btn" (click)="exportCsv()" [disabled]="!customers().length"><i class="ti ti-download" aria-hidden="true"></i>Export CSV</button>
          <a class="btn btn-primary" routerLink="/customers/new"><i class="ti ti-plus" aria-hidden="true"></i>New customer</a>
        </div>
      </div>

      @if (error()) {
        <div class="alert" role="alert"><span>{{ error() }}</span><button type="button" class="btn" (click)="load()">Try again</button></div>
      } @else if (loading()) {
        <p class="muted">Loading customers…</p>
      } @else if (!customers().length) {
        <div class="empty">
          <i class="ti ti-users" aria-hidden="true"></i>
          <h2>Add your first customer</h2>
          <p>Save their GSTIN and state once, and every invoice gets the right GST automatically.</p>
          <a class="btn btn-primary" routerLink="/customers/new">New customer</a>
        </div>
      } @else {
        <div class="toolbar">
          <div class="search-box">
            <i class="ti ti-search" aria-hidden="true"></i>
            <input type="search" placeholder="Search by name, email, or GSTIN" [value]="query()" (input)="query.set($any($event.target).value)" aria-label="Search customers" />
          </div>
          <div class="chips" role="group" aria-label="Show">
            <button type="button" class="chip" [class.on]="!showArchived()" (click)="showArchived.set(false)">Active ({{ active().length }})</button>
            <button type="button" class="chip" [class.on]="showArchived()" (click)="showArchived.set(true)">Archived ({{ customers().length - active().length }})</button>
          </div>
        </div>

        <div class="table-card">
          <table class="table">
            <thead><tr><th>Customer</th><th>GST</th><th>State</th><th class="num">Outstanding</th><th class="num">Received</th></tr></thead>
            <tbody>
              @for (c of filtered(); track c.id) {
                <tr class="clickable" (click)="open(c)">
                  <td>
                    <a [routerLink]="['/customers', c.id]" class="strong-link" (click)="$event.stopPropagation()">{{ c.displayName }}</a>
                    <div class="sub">{{ c.contactPerson || c.email || '—' }}</div>
                  </td>
                  <td>
                    {{ treatment[c.gstTreatment] }}
                    @if (c.gstin) { <div class="sub mono">{{ c.gstin }}</div> }
                  </td>
                  <td>
                    @if (stateName(c.stateCode); as s) { {{ s }} } @else { <span class="badge" data-tone="partial">Add state</span> }
                  </td>
                  <td class="num" [class.text-danger]="c.outstanding > 0">{{ c.outstanding | currency }}</td>
                  <td class="num">{{ c.received | currency }}</td>
                </tr>
              } @empty {
                <tr><td colspan="5" class="empty-row">No customers match "{{ query() }}".</td></tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
})
export class CustomerList {
  private api = inject(Api);
  private router = inject(Router);
  private meta = toSignal(this.api.meta());
  protected readonly treatment = GST_TREATMENT_LABEL;

  protected customers = signal<Customer[]>([]);
  protected loading = signal(true);
  protected error = signal('');
  protected query = signal('');
  protected showArchived = signal(false);

  protected active = computed(() => this.customers().filter((c) => !c.archived));
  protected owedTotal = computed(() => this.active().reduce((s, c) => s + c.outstanding, 0));
  protected filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.customers()
      .filter((c) => c.archived === this.showArchived())
      .filter((c) => !q || [c.displayName, c.email, c.gstin, c.contactPerson].some((v) => v.toLowerCase().includes(q)));
  });

  constructor() {
    this.load();
  }

  protected load() {
    this.loading.set(true);
    this.error.set('');
    this.api.customers().subscribe({
      next: (c) => {
        this.customers.set(c);
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.loading.set(false);
      },
    });
  }

  protected stateName(code: string) {
    return this.meta()?.states.find((s) => s.code === code)?.name ?? '';
  }

  protected open(c: Customer) {
    this.router.navigate(['/customers', c.id]);
  }

  protected exportCsv() {
    downloadCsv(
      'averqo-customers.csv',
      ['Name', 'Contact person', 'Email', 'Phone', 'GST treatment', 'GSTIN', 'State', 'City', 'PIN code', 'Outstanding', 'Received', 'Archived'],
      this.customers().map((c) => [c.displayName, c.contactPerson, c.email, c.phone, this.treatment[c.gstTreatment], c.gstin,
        this.stateName(c.stateCode), c.city, c.pincode, c.outstanding.toFixed(2), c.received.toFixed(2), c.archived ? 'Yes' : 'No']),
    );
  }
}
