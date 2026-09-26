import { Component, ElementRef, OnDestroy, computed, inject, output, signal, viewChild, AfterViewInit } from '@angular/core';
import { Router } from '@angular/router';
import { Subject, debounceTime, switchMap, of, catchError } from 'rxjs';
import { Api } from '../core/api';
import { SearchResult } from '../core/models';

interface Command {
  icon: string;
  title: string;
  subtitle: string;
  path: string;
}

const ACTIONS: Command[] = [
  { icon: 'file-plus', title: 'New invoice', subtitle: 'Create', path: '/invoices/new' },
  { icon: 'file-description', title: 'New quote', subtitle: 'Create', path: '/quotes/new' },
  { icon: 'truck-delivery', title: 'New delivery challan', subtitle: 'Create', path: '/delivery-challans/new' },
  { icon: 'receipt-refund', title: 'New credit note', subtitle: 'Create', path: '/credit-notes/new' },
  { icon: 'repeat', title: 'New recurring schedule', subtitle: 'Create', path: '/recurring-invoices/new' },
  { icon: 'user-plus', title: 'New customer', subtitle: 'Create', path: '/customers/new' },
  { icon: 'package', title: 'New item', subtitle: 'Create', path: '/items/new' },
  { icon: 'cash', title: 'Record payment', subtitle: 'Create', path: '/payments/new' },
  { icon: 'receipt', title: 'Record expense', subtitle: 'Create', path: '/expenses/new' },
  { icon: 'clock-plus', title: 'Log time or start the timer', subtitle: 'Create', path: '/time-tracking' },
  { icon: 'briefcase', title: 'New project', subtitle: 'Create', path: '/time-tracking/projects/new' },
  { icon: 'home', title: 'Home', subtitle: 'Go to', path: '/home' },
  { icon: 'file-invoice', title: 'Invoices', subtitle: 'Go to', path: '/invoices' },
  { icon: 'users', title: 'Customers', subtitle: 'Go to', path: '/customers' },
  { icon: 'package', title: 'Items', subtitle: 'Go to', path: '/items' },
  { icon: 'cash', title: 'Payments received', subtitle: 'Go to', path: '/payments' },
  { icon: 'file-description', title: 'Quotes', subtitle: 'Go to', path: '/quotes' },
  { icon: 'truck-delivery', title: 'Delivery challans', subtitle: 'Go to', path: '/delivery-challans' },
  { icon: 'receipt-refund', title: 'Credit notes', subtitle: 'Go to', path: '/credit-notes' },
  { icon: 'repeat', title: 'Recurring invoices', subtitle: 'Go to', path: '/recurring-invoices' },
  { icon: 'receipt', title: 'Expenses', subtitle: 'Go to', path: '/expenses' },
  { icon: 'clock-hour-4', title: 'Timesheet', subtitle: 'Go to', path: '/time-tracking' },
  { icon: 'briefcase', title: 'Projects', subtitle: 'Go to', path: '/time-tracking/projects' },
  { icon: 'building-bank', title: 'GST filing (GSTR-1 and GSTR-3B)', subtitle: 'Go to', path: '/gst-filing' },
  { icon: 'chart-bar', title: 'Reports', subtitle: 'Go to', path: '/reports' },
  { icon: 'chart-line', title: 'Profit and loss', subtitle: 'Report', path: '/reports/profit-and-loss' },
  { icon: 'hourglass', title: 'Receivables aging', subtitle: 'Report', path: '/reports/receivables-aging' },
  { icon: 'rocket', title: 'Getting started', subtitle: 'Go to', path: '/getting-started' },
  { icon: 'settings', title: 'Settings', subtitle: 'Go to', path: '/settings' },
];

const RESULT_META: Record<SearchResult['type'], { icon: string; base: string; label: string }> = {
  customer: { icon: 'user', base: '/customers/', label: 'Customer' },
  invoice: { icon: 'file-invoice', base: '/invoices/', label: 'Invoice' },
  item: { icon: 'package', base: '/items/', label: 'Item' },
  payment: { icon: 'cash', base: '/payments/', label: 'Payment' },
  quote: { icon: 'file-description', base: '/quotes/', label: 'Quote' },
  challan: { icon: 'truck-delivery', base: '/delivery-challans/', label: 'Delivery challan' },
  credit_note: { icon: 'receipt-refund', base: '/credit-notes/', label: 'Credit note' },
};

/** Ctrl+K: jump to any page, create anything, or find a record by name or number. */
@Component({
  selector: 'app-command-palette',
  template: `
    <div class="palette-backdrop" (click)="closed.emit()">
      <div class="palette" role="dialog" aria-label="Search and commands" (click)="$event.stopPropagation()">
        <div class="palette-input">
          <i class="ti ti-search" aria-hidden="true"></i>
          <input #box type="text" placeholder="Search customers, invoices, items, or type a command"
                 [value]="query()" (input)="onInput(box.value)" (keydown)="onKey($event)"
                 aria-label="Search" autocomplete="off" />
          <kbd>Esc</kbd>
        </div>
        <ul class="palette-list" role="listbox">
          @for (c of commands(); track c.path + c.title; let i = $index) {
            <li role="option" [attr.aria-selected]="i === active()" [class.active]="i === active()"
                (mouseenter)="active.set(i)" (click)="go(c)">
              <i class="ti ti-{{ c.icon }}" aria-hidden="true"></i>
              <span class="palette-title">{{ c.title }}</span>
              <span class="palette-sub">{{ c.subtitle }}</span>
            </li>
          } @empty {
            <li class="palette-empty">No matches for "{{ query() }}". Try a customer name or invoice number.</li>
          }
        </ul>
      </div>
    </div>
  `,
})
export class CommandPalette implements AfterViewInit, OnDestroy {
  readonly closed = output<void>();
  private api = inject(Api);
  private router = inject(Router);
  private box = viewChild.required<ElementRef<HTMLInputElement>>('box');

  protected query = signal('');
  protected active = signal(0);
  private results = signal<SearchResult[]>([]);
  private search$ = new Subject<string>();
  private sub = this.search$
    .pipe(
      debounceTime(180),
      switchMap((q) => (q.trim() ? this.api.search(q).pipe(catchError(() => of([]))) : of([]))),
    )
    .subscribe((r) => this.results.set(r));

  protected commands = computed<Command[]>(() => {
    const q = this.query().trim().toLowerCase();
    const actions = q ? ACTIONS.filter((a) => a.title.toLowerCase().includes(q)) : ACTIONS;
    const found = this.results().map((r) => ({
      icon: RESULT_META[r.type].icon,
      title: r.title,
      subtitle: [RESULT_META[r.type].label, r.subtitle].filter(Boolean).join(' · '),
      path: r.type === 'item' ? `/items/${r.id}/edit` : RESULT_META[r.type].base + r.id,
    }));
    return [...found, ...actions];
  });

  ngAfterViewInit() {
    this.box().nativeElement.focus();
  }

  ngOnDestroy() {
    this.sub.unsubscribe();
  }

  protected onInput(v: string) {
    this.query.set(v);
    this.active.set(0);
    this.search$.next(v);
  }

  protected onKey(e: KeyboardEvent) {
    const n = this.commands().length;
    if (e.key === 'Escape') this.closed.emit();
    else if (e.key === 'ArrowDown' && n) {
      e.preventDefault();
      this.active.update((i) => (i + 1) % n);
    } else if (e.key === 'ArrowUp' && n) {
      e.preventDefault();
      this.active.update((i) => (i - 1 + n) % n);
    } else if (e.key === 'Enter' && n) {
      e.preventDefault();
      this.go(this.commands()[this.active()]);
    }
  }

  protected go(c: Command) {
    this.closed.emit();
    this.router.navigateByUrl(c.path);
  }
}
