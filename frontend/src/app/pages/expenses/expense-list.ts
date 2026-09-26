import { CurrencyPipe, DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, errorMessage } from '../../core/api';
import { MODE_LABEL, downloadCsv } from '../../core/format';
import { Expense, ExpenseCategory } from '../../core/models';
import { RANGE_PRESETS, presetRange } from '../../core/periods';
import { Toasts } from '../../core/toast';

@Component({
  selector: 'app-expense-list',
  imports: [RouterLink, CurrencyPipe, DatePipe, FormsModule],
  template: `
    <section class="page page-wide">
      <div class="page-head">
        <div>
          <h1>Expenses</h1>
          <p class="muted">{{ rows().length }} {{ rows().length === 1 ? 'expense' : 'expenses' }} · {{ totalOf() | currency }} spent · {{ claimOf() | currency }} GST to claim</p>
        </div>
        <div class="head-actions">
          <button type="button" class="btn" (click)="categoriesOpen.set(true)"><i class="ti ti-tags" aria-hidden="true"></i>Categories</button>
          <button type="button" class="btn" (click)="exportCsv()" [disabled]="!rows().length"><i class="ti ti-download" aria-hidden="true"></i>Export CSV</button>
          <a class="btn btn-primary" routerLink="/expenses/new"><i class="ti ti-plus" aria-hidden="true"></i>Record expense</a>
        </div>
      </div>

      <div class="toolbar filters">
        <div class="search-box">
          <i class="ti ti-search" aria-hidden="true"></i>
          <input type="search" placeholder="Search vendor, bill number, or description" [(ngModel)]="query" aria-label="Search expenses" />
        </div>
        <select [ngModel]="preset()" (ngModelChange)="setPreset($event)" aria-label="Period">
          @for (p of presets; track p.key) { @if (p.key !== 'custom') { <option [value]="p.key">{{ p.label }}</option> } }
        </select>
        <select [ngModel]="categoryId()" (ngModelChange)="categoryId.set($event); load()" aria-label="Category">
          <option value="">All categories</option>
          @for (c of categories(); track c.id) { <option [value]="c.id">{{ c.name }}</option> }
        </select>
        <div class="chips" role="radiogroup" aria-label="Billing">
          @for (s of statuses; track s.value) {
            <button type="button" class="chip" [class.active]="status() === s.value" (click)="status.set(s.value); load()">{{ s.label }}</button>
          }
        </div>
      </div>

      @if (error()) {
        <div class="alert" role="alert"><span>{{ error() }}</span><button type="button" class="btn" (click)="load()">Try again</button></div>
      } @else if (loading()) {
        <p class="muted">Loading expenses…</p>
      } @else if (!expenses().length) {
        <div class="empty">
          <i class="ti ti-receipt" aria-hidden="true"></i>
          <h2>No expenses in this period</h2>
          <p>Record what the business spends. Averqo works out the GST you can claim back, and you can bill expenses to customers.</p>
          <a class="btn btn-primary" routerLink="/expenses/new">Record expense</a>
        </div>
      } @else {
        <div class="table-card">
          <table class="table">
            <thead><tr><th>Date</th><th>Category</th><th>Vendor</th><th class="hide-sm">Paid through</th><th>Billing</th><th class="num hide-sm">GST</th><th class="num">Total</th></tr></thead>
            <tbody>
              @for (e of rows(); track e.id) {
                <tr class="clickable" (click)="router.navigate(['/expenses', e.id])">
                  <td><a [routerLink]="['/expenses', e.id]" class="strong-link" (click)="$event.stopPropagation()">{{ e.date | date: 'd MMM y' }}</a></td>
                  <td>{{ e.categoryName }} @if (e.receiptName) { <i class="ti ti-paperclip muted" title="Receipt attached" aria-label="Receipt attached"></i> }
                    @if (e.description) { <div class="sub">{{ e.description }}</div> }</td>
                  <td>{{ e.vendorName || '—' }} @if (e.billNumber) { <div class="sub">Bill {{ e.billNumber }}</div> }</td>
                  <td class="hide-sm">{{ modeLabel[e.paidThrough] }}</td>
                  <td>
                    @if (e.invoiceNumber) { <span class="badge" data-tone="paid">Billed · {{ e.invoiceNumber }}</span> }
                    @else if (e.billable) { <span class="badge" data-tone="sent">To bill · {{ e.customerName }}</span> }
                    @else { <span class="sub">—</span> }
                  </td>
                  <td class="num hide-sm">{{ e.cgst + e.sgst + e.igst | currency }}
                    @if (e.reverseCharge) { <div class="sub">Reverse charge</div> }</td>
                  <td class="num">{{ e.total | currency }}</td>
                </tr>
              } @empty {
                <tr><td colspan="7" class="empty-row">No expenses match "{{ query }}".</td></tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>

    @if (categoriesOpen()) {
      <div class="dialog-backdrop" (click)="categoriesOpen.set(false)">
        <div class="dialog card" role="dialog" aria-modal="true" aria-labelledby="cat-title" (click)="$event.stopPropagation()">
          <div class="dialog-head"><h2 id="cat-title">Expense categories</h2>
            <button type="button" class="icon-btn" aria-label="Close" (click)="categoriesOpen.set(false)"><i class="ti ti-x" aria-hidden="true"></i></button></div>
          <div class="input-with-btn">
            <input type="text" [(ngModel)]="newCategory" placeholder="New category name" maxlength="60" aria-label="New category name" (keydown.enter)="addCategory()" />
            <button type="button" class="btn btn-primary" (click)="addCategory()">Add</button>
          </div>
          <ul class="cat-list">
            @for (c of categories(); track c.id) {
              <li [class.archived]="c.archived">
                <input type="text" [value]="c.name" maxlength="60" [attr.aria-label]="'Rename ' + c.name" (change)="rename(c, $any($event.target).value)" />
                <span class="sub">{{ c.used }} used</span>
                <button type="button" class="link-btn" (click)="toggleArchive(c)">{{ c.archived ? 'Restore' : 'Archive' }}</button>
                @if (!c.used) { <button type="button" class="icon-btn" [attr.aria-label]="'Delete ' + c.name" (click)="removeCategory(c)"><i class="ti ti-trash" aria-hidden="true"></i></button> }
              </li>
            }
          </ul>
          <p class="sub">Archived categories stay on old expenses but aren't offered for new ones.</p>
        </div>
      </div>
    }
  `,
})
export class ExpenseList {
  private api = inject(Api);
  private toasts = inject(Toasts);
  protected router = inject(Router);
  protected readonly modeLabel = MODE_LABEL;
  protected readonly presets = RANGE_PRESETS;
  protected readonly statuses = [
    { value: '', label: 'All' }, { value: 'unbilled', label: 'To bill' }, { value: 'billed', label: 'Billed' },
  ];
  protected expenses = signal<Expense[]>([]);
  protected categories = signal<ExpenseCategory[]>([]);
  protected loading = signal(true);
  protected error = signal('');
  protected preset = signal('this-fy');
  protected categoryId = signal('');
  protected status = signal('');
  protected query = '';
  protected categoriesOpen = signal(false);
  protected newCategory = '';

  protected shown = computed(() => this.expenses());
  protected totalOf() {
    return this.filtered().reduce((s, e) => s + e.total, 0);
  }
  protected claimOf() {
    return this.filtered().filter((e) => e.itcEligible && (e.vendorGstin || e.reverseCharge)).reduce((s, e) => s + e.cgst + e.sgst + e.igst, 0);
  }

  constructor() {
    this.load();
    this.loadCategories();
  }

  /** Rows after the search box (re-read on every change detection, like the totals). */
  protected rows() {
    return this.filtered();
  }

  private filtered() {
    const q = this.query.trim().toLowerCase();
    return this.expenses().filter((e) => !q || [e.vendorName, e.billNumber, e.description, e.categoryName, e.reference]
      .some((v) => v.toLowerCase().includes(q)));
  }

  protected setPreset(key: string) {
    this.preset.set(key);
    this.load();
  }

  protected load() {
    this.loading.set(true);
    this.error.set('');
    const r = presetRange(this.preset());
    this.api.expenses({ from: r.from, to: r.to, categoryId: Number(this.categoryId()) || undefined, status: this.status() }).subscribe({
      next: (list) => {
        this.expenses.set(list);
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.loading.set(false);
      },
    });
  }

  private loadCategories() {
    this.api.expenseCategories().subscribe({ next: (c) => this.categories.set(c), error: () => {} });
  }

  private updated = {
    next: (c: ExpenseCategory[]) => this.categories.set(c),
    error: (e: unknown) => this.toasts.show(errorMessage(e), 'error'),
  };

  protected addCategory() {
    const name = this.newCategory.trim();
    if (!name) return;
    this.api.saveExpenseCategory({ name }).subscribe({ ...this.updated, next: (c) => { this.categories.set(c); this.newCategory = ''; } });
  }

  protected rename(c: ExpenseCategory, name: string) {
    if (name.trim() && name.trim() !== c.name) this.api.saveExpenseCategory({ name: name.trim(), archived: c.archived }, c.id).subscribe(this.updated);
  }

  protected toggleArchive(c: ExpenseCategory) {
    this.api.saveExpenseCategory({ name: c.name, archived: !c.archived }, c.id).subscribe(this.updated);
  }

  protected removeCategory(c: ExpenseCategory) {
    this.api.deleteExpenseCategory(c.id).subscribe(this.updated);
  }

  protected exportCsv() {
    downloadCsv(
      'averqo-expenses.csv',
      ['Date', 'Category', 'Vendor', 'Vendor GSTIN', 'Bill number', 'HSN/SAC', 'Description', 'Before GST', 'CGST', 'SGST', 'IGST',
        'Total', 'Claim GST', 'Reverse charge', 'Paid through', 'Reference', 'Customer', 'Billed on'],
      this.filtered().map((e) => [e.date, e.categoryName, e.vendorName, e.vendorGstin, e.billNumber, e.hsnSac, e.description,
        e.subtotal.toFixed(2), e.cgst.toFixed(2), e.sgst.toFixed(2), e.igst.toFixed(2), e.total.toFixed(2), e.itcEligible ? 'Yes' : 'No',
        e.reverseCharge ? 'Yes' : 'No', this.modeLabel[e.paidThrough], e.reference, e.customerName ?? '', e.invoiceNumber ?? '']),
    );
  }
}
