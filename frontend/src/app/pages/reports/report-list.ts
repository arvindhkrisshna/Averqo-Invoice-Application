import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

export const REPORT_GROUPS = [
  { title: 'Sales', icon: 'chart-bar', reports: [
    { key: 'sales-by-customer', name: 'Sales by customer', desc: 'Invoiced, credited, and net sales for each customer.' },
    { key: 'sales-by-item', name: 'Sales by item', desc: 'Quantity and value sold of each item or service.' },
    { key: 'sales-by-month', name: 'Sales by month', desc: 'Invoiced and received, month by month.' },
    { key: 'invoice-details', name: 'Invoice details', desc: 'Every invoice with its status and balance.' },
  ] },
  { title: 'Receivables', icon: 'hourglass', reports: [
    { key: 'receivables-aging', name: 'Receivables aging', desc: 'What each customer owes today, by days overdue.' },
    { key: 'customer-balances', name: 'Customer balances', desc: 'Invoiced, received, and due for every customer.' },
    { key: 'payments-received', name: 'Payments received', desc: 'Every payment with its mode and reference.' },
  ] },
  { title: 'Expenses', icon: 'receipt', reports: [
    { key: 'expenses-by-category', name: 'Expenses by category', desc: 'Spending by category, with GST you can claim.' },
    { key: 'expense-details', name: 'Expense details', desc: 'Every expense with its GST and billing status.' },
  ] },
  { title: 'Accounting and tax', icon: 'scale', reports: [
    { key: 'profit-and-loss', name: 'Profit and loss', desc: 'Income minus expenses, before GST.' },
    { key: 'tax-summary', name: 'Tax summary', desc: 'GST on sales, reverse charge, and claimable GST by month.' },
  ] },
  { title: 'Time', icon: 'clock-hour-4', reports: [
    { key: 'time-by-project', name: 'Time by project', desc: 'Hours logged, billed, and still to bill.' },
  ] },
];

@Component({
  selector: 'app-report-list',
  imports: [RouterLink],
  template: `
    <section class="page page-wide">
      <div class="page-head">
        <div>
          <h1>Reports</h1>
          <p class="muted">Every report can be filtered by date, printed, and exported to CSV.</p>
        </div>
        <div class="head-actions"><a class="btn" routerLink="/gst-filing"><i class="ti ti-building-bank" aria-hidden="true"></i>GST filing</a></div>
      </div>
      <div class="report-groups">
        @for (g of groups; track g.title) {
          <div class="card report-group">
            <h2><i class="ti ti-{{ g.icon }}" aria-hidden="true"></i>{{ g.title }}</h2>
            <ul>
              @for (r of g.reports; track r.key) {
                <li><a [routerLink]="['/reports', r.key]" class="strong-link">{{ r.name }}</a><span class="sub">{{ r.desc }}</span></li>
              }
            </ul>
          </div>
        }
      </div>
    </section>
  `,
})
export class ReportList {
  protected readonly groups = REPORT_GROUPS;
}
