import { CurrencyPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api, errorMessage } from '../../core/api';
import { downloadCsv } from '../../core/format';
import { Item } from '../../core/models';

@Component({
  selector: 'app-item-list',
  imports: [RouterLink, CurrencyPipe],
  template: `
    <section class="page page-wide">
      <div class="page-head">
        <div>
          <h1>Items</h1>
          <p class="muted">Products and services you sell. Rates and GST fill in automatically on invoices.</p>
        </div>
        <div class="head-actions">
          <button type="button" class="btn" (click)="exportCsv()" [disabled]="!items().length"><i class="ti ti-download" aria-hidden="true"></i>Export CSV</button>
          <a class="btn btn-primary" routerLink="/items/new"><i class="ti ti-plus" aria-hidden="true"></i>New item</a>
        </div>
      </div>

      @if (error()) {
        <div class="alert" role="alert"><span>{{ error() }}</span><button type="button" class="btn" (click)="load()">Try again</button></div>
      } @else if (loading()) {
        <p class="muted">Loading items…</p>
      } @else if (!items().length) {
        <div class="empty">
          <i class="ti ti-package" aria-hidden="true"></i>
          <h2>Add what you sell</h2>
          <p>Save each product or service once with its rate, HSN/SAC code, and GST rate.</p>
          <a class="btn btn-primary" routerLink="/items/new">New item</a>
        </div>
      } @else {
        <div class="toolbar">
          <div class="search-box">
            <i class="ti ti-search" aria-hidden="true"></i>
            <input type="search" placeholder="Search by name or HSN/SAC" [value]="query()" (input)="query.set($any($event.target).value)" aria-label="Search items" />
          </div>
          <div class="chips" role="group" aria-label="Show">
            <button type="button" class="chip" [class.on]="!showArchived()" (click)="showArchived.set(false)">Active ({{ activeCount() }})</button>
            <button type="button" class="chip" [class.on]="showArchived()" (click)="showArchived.set(true)">Archived ({{ items().length - activeCount() }})</button>
          </div>
        </div>
        <div class="table-card">
          <table class="table">
            <thead><tr><th>Item</th><th>Type</th><th>HSN/SAC</th><th class="num">Rate</th><th class="num">GST</th><th class="num">Used on</th></tr></thead>
            <tbody>
              @for (it of filtered(); track it.id) {
                <tr class="clickable" (click)="router.navigate(['/items', it.id, 'edit'])">
                  <td>
                    <a [routerLink]="['/items', it.id, 'edit']" class="strong-link" (click)="$event.stopPropagation()">{{ it.name }}</a>
                    @if (it.description) { <div class="sub">{{ it.description }}</div> }
                  </td>
                  <td>{{ it.kind === 'goods' ? 'Goods' : 'Service' }}</td>
                  <td class="mono">{{ it.hsnSac || '—' }}</td>
                  <td class="num">{{ it.rate | currency }} <span class="sub">/ {{ it.unit }}</span></td>
                  <td class="num">{{ it.taxRate }}%</td>
                  <td class="num">{{ it.timesUsed }} {{ it.timesUsed === 1 ? 'line' : 'lines' }}</td>
                </tr>
              } @empty {
                <tr><td colspan="6" class="empty-row">No items match "{{ query() }}".</td></tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
})
export class ItemList {
  private api = inject(Api);
  protected router = inject(Router);
  protected items = signal<Item[]>([]);
  protected loading = signal(true);
  protected error = signal('');
  protected query = signal('');
  protected showArchived = signal(false);

  protected activeCount = computed(() => this.items().filter((i) => !i.archived).length);
  protected filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.items()
      .filter((i) => i.archived === this.showArchived())
      .filter((i) => !q || i.name.toLowerCase().includes(q) || i.hsnSac.includes(q));
  });

  constructor() {
    this.load();
  }

  protected load() {
    this.loading.set(true);
    this.error.set('');
    this.api.items().subscribe({
      next: (i) => {
        this.items.set(i);
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.loading.set(false);
      },
    });
  }

  protected exportCsv() {
    downloadCsv(
      'averqo-items.csv',
      ['Name', 'Type', 'HSN/SAC', 'Unit', 'Rate', 'GST %', 'Description', 'Archived'],
      this.items().map((i) => [i.name, i.kind, i.hsnSac, i.unit, i.rate.toFixed(2), i.taxRate, i.description, i.archived ? 'Yes' : 'No']),
    );
  }
}
