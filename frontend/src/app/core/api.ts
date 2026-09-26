import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, shareReplay, tap } from 'rxjs';
import {
  Customer, Dashboard, EmailStatus, Expense, ExpenseCategory, ExpenseInput, GSTR1, GSTR3B, GstReturn, Invoice, InvoiceInput,
  Item, Meta, Organization, Payment, PaymentInput, Project, ProjectInput, RecurringInput, RecurringProfile, Report, SalesDoc,
  SalesDocInput, SearchResult, Statement, TimeEntry, TimeEntryInput, Unbilled, User, Vendor,
} from './models';
import { todayISO } from './format';

// Every call goes to /api/..., which `ng serve` forwards to the Go server
// on port 8080 (see proxy.conf.json).
@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);

  // ---------- Reference data and business profile (cached) ----------
  private meta$?: Observable<Meta>;
  meta(): Observable<Meta> {
    return (this.meta$ ??= this.http.get<Meta>('/api/meta').pipe(shareReplay(1)));
  }

  /** The business profile, kept in a signal so every page sees updates. */
  readonly org = signal<Organization | null>(null);
  loadOrg() {
    return this.http.get<Organization>('/api/organization').pipe(tap((o) => this.org.set(o)));
  }
  saveOrg(o: Organization) {
    return this.http.put<Organization>('/api/organization', o).pipe(tap((saved) => this.org.set(saved)));
  }

  dashboard() {
    return this.http.get<Dashboard>('/api/dashboard', { params: { today: todayISO() } });
  }
  search(q: string) {
    return this.http.get<SearchResult[]>('/api/search', { params: { q } });
  }

  // ---------- Customers ----------
  customers() {
    return this.http.get<Customer[]>('/api/customers');
  }
  customer(id: number | string) {
    return this.http.get<Customer>(`/api/customers/${id}`);
  }
  saveCustomer(c: Partial<Customer>, id?: number) {
    return id
      ? this.http.put<Customer>(`/api/customers/${id}`, c)
      : this.http.post<Customer>('/api/customers', c);
  }
  archiveCustomer(id: number, archived: boolean) {
    return this.http.patch<Customer>(`/api/customers/${id}/archive`, { archived });
  }
  deleteCustomer(id: number) {
    return this.http.delete<void>(`/api/customers/${id}`);
  }

  // ---------- Items ----------
  items() {
    return this.http.get<Item[]>('/api/items');
  }
  item(id: number | string) {
    return this.http.get<Item>(`/api/items/${id}`);
  }
  saveItem(it: Partial<Item>, id?: number) {
    return id ? this.http.put<Item>(`/api/items/${id}`, it) : this.http.post<Item>('/api/items', it);
  }
  archiveItem(id: number, archived: boolean) {
    return this.http.patch<Item>(`/api/items/${id}/archive`, { archived });
  }
  deleteItem(id: number) {
    return this.http.delete<void>(`/api/items/${id}`);
  }

  // ---------- Invoices ----------
  invoices(filter: { customerId?: number; open?: boolean } = {}) {
    const params: Record<string, string> = {};
    if (filter.customerId) params['customerId'] = String(filter.customerId);
    if (filter.open) params['open'] = '1';
    return this.http.get<Invoice[]>('/api/invoices', { params });
  }
  invoice(id: number | string) {
    return this.http.get<Invoice>(`/api/invoices/${id}`);
  }
  saveInvoice(input: InvoiceInput, id?: number) {
    return id
      ? this.http.put<Invoice>(`/api/invoices/${id}`, input)
      : this.http.post<Invoice>('/api/invoices', input);
  }
  sendInvoice(id: number) {
    return this.http.post<Invoice>(`/api/invoices/${id}/send`, {});
  }
  voidInvoice(id: number) {
    return this.http.post<Invoice>(`/api/invoices/${id}/void`, {});
  }
  deleteInvoice(id: number) {
    return this.http.delete<void>(`/api/invoices/${id}`);
  }

  // ---------- Quotes, challans, credit notes (path: quotes | challans | credit-notes) ----------
  docs(path: string, customerId?: number) {
    const params: Record<string, string> = customerId ? { customerId: String(customerId) } : {};
    return this.http.get<SalesDoc[]>(`/api/${path}`, { params });
  }
  doc(path: string, id: number | string) {
    return this.http.get<SalesDoc>(`/api/${path}/${id}`);
  }
  saveDoc(path: string, input: SalesDocInput, id?: number) {
    return id ? this.http.put<SalesDoc>(`/api/${path}/${id}`, input) : this.http.post<SalesDoc>(`/api/${path}`, input);
  }
  setDocStatus(path: string, id: number, status: string) {
    return this.http.post<SalesDoc>(`/api/${path}/${id}/status`, { status });
  }
  deleteDoc(path: string, id: number) {
    return this.http.delete<void>(`/api/${path}/${id}`);
  }
  convertQuote(id: number) {
    return this.http.post<Invoice>(`/api/quotes/${id}/convert`, {});
  }
  convertChallans(ids: number[]) {
    return this.http.post<Invoice>('/api/challans/convert', { ids });
  }
  applyCredit(id: number, allocations: { invoiceId: number; amount: number }[], date: string) {
    return this.http.post<SalesDoc>(`/api/credit-notes/${id}/apply`, { allocations, date });
  }
  removeCreditAllocation(id: number, allocId: number) {
    return this.http.delete<SalesDoc>(`/api/credit-notes/${id}/allocations/${allocId}`);
  }
  addRefund(id: number, r: { refundDate: string; amount: number; mode: string; reference: string; notes: string }) {
    return this.http.post<SalesDoc>(`/api/credit-notes/${id}/refunds`, r);
  }
  removeRefund(id: number, refundId: number) {
    return this.http.delete<SalesDoc>(`/api/credit-notes/${id}/refunds/${refundId}`);
  }

  // ---------- Recurring invoices ----------
  recurringList() {
    return this.http.get<RecurringProfile[]>('/api/recurring');
  }
  recurring(id: number | string) {
    return this.http.get<RecurringProfile>(`/api/recurring/${id}`);
  }
  saveRecurring(input: RecurringInput, id?: number) {
    return id ? this.http.put<RecurringProfile>(`/api/recurring/${id}`, input) : this.http.post<RecurringProfile>('/api/recurring', input);
  }
  setRecurringStatus(id: number, status: 'active' | 'paused') {
    return this.http.post<RecurringProfile>(`/api/recurring/${id}/status`, { status });
  }
  runRecurring(id: number) {
    return this.http.post<Invoice>(`/api/recurring/${id}/run`, {});
  }
  deleteRecurring(id: number) {
    return this.http.delete<void>(`/api/recurring/${id}`);
  }
  recurringInvoices(recurringId: number) {
    return this.http.get<Invoice[]>('/api/invoices', { params: { recurringId: String(recurringId) } });
  }

  // ---------- Sending (path: invoices | quotes | challans | credit-notes) ----------
  emailStatus() {
    return this.http.get<EmailStatus>('/api/email/status');
  }
  testEmail(to: string) {
    return this.http.post<{ status: string }>('/api/email/test', { to });
  }
  emailDoc<T>(path: string, id: number, body: { to: string; cc: string; subject: string; message: string }) {
    return this.http.post<T>(`/api/${path}/${id}/email`, body);
  }
  markShared<T>(path: string, id: number, channel: 'whatsapp' | 'email_app', to: string) {
    return this.http.post<T>(`/api/${path}/${id}/shared`, { channel, to });
  }
  pdfBlob(path: string, id: number) {
    return this.http.get(`/api/${path}/${id}/pdf`, { responseType: 'blob' });
  }

  // ---------- Payments ----------
  payments(customerId?: number) {
    const params: Record<string, string> = customerId ? { customerId: String(customerId) } : {};
    return this.http.get<Payment[]>('/api/payments', { params });
  }
  payment(id: number | string) {
    return this.http.get<Payment>(`/api/payments/${id}`);
  }
  createPayment(p: PaymentInput) {
    return this.http.post<Payment>('/api/payments', p);
  }
  deletePayment(id: number) {
    return this.http.delete<void>(`/api/payments/${id}`);
  }

  // ---------- Expenses ----------
  expenses(filter: { from?: string; to?: string; categoryId?: number; customerId?: number; status?: string } = {}) {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(filter)) if (v !== undefined && v !== null && v !== '') params[k] = String(v);
    return this.http.get<Expense[]>('/api/expenses', { params });
  }
  expense(id: number | string) {
    return this.http.get<Expense>(`/api/expenses/${id}`);
  }
  saveExpense(e: ExpenseInput, id?: number) {
    return id ? this.http.put<Expense>(`/api/expenses/${id}`, e) : this.http.post<Expense>('/api/expenses', e);
  }
  deleteExpense(id: number) {
    return this.http.delete<void>(`/api/expenses/${id}`);
  }
  uploadReceipt(id: number, file: File) {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<Expense>(`/api/expenses/${id}/receipt`, form);
  }
  deleteReceipt(id: number) {
    return this.http.delete<Expense>(`/api/expenses/${id}/receipt`);
  }
  expenseCategories() {
    return this.http.get<ExpenseCategory[]>('/api/expense-categories');
  }
  saveExpenseCategory(c: { name: string; archived?: boolean }, id?: number) {
    return id
      ? this.http.put<ExpenseCategory[]>(`/api/expense-categories/${id}`, c)
      : this.http.post<ExpenseCategory[]>('/api/expense-categories', c);
  }
  deleteExpenseCategory(id: number) {
    return this.http.delete<ExpenseCategory[]>(`/api/expense-categories/${id}`);
  }
  vendors() {
    return this.http.get<Vendor[]>('/api/vendors');
  }

  // ---------- Time tracking ----------
  projects(customerId?: number) {
    const params: Record<string, string> = customerId ? { customerId: String(customerId) } : {};
    return this.http.get<Project[]>('/api/projects', { params });
  }
  project(id: number | string) {
    return this.http.get<Project>(`/api/projects/${id}`);
  }
  saveProject(p: ProjectInput, id?: number) {
    return id ? this.http.put<Project>(`/api/projects/${id}`, p) : this.http.post<Project>('/api/projects', p);
  }
  deleteProject(id: number) {
    return this.http.delete<void>(`/api/projects/${id}`);
  }
  timeEntries(filter: { from?: string; to?: string; projectId?: number; customerId?: number; unbilled?: boolean } = {}) {
    const params: Record<string, string> = {};
    if (filter.from) params['from'] = filter.from;
    if (filter.to) params['to'] = filter.to;
    if (filter.projectId) params['projectId'] = String(filter.projectId);
    if (filter.customerId) params['customerId'] = String(filter.customerId);
    if (filter.unbilled) params['unbilled'] = '1';
    return this.http.get<TimeEntry[]>('/api/time-entries', { params });
  }
  saveTimeEntry(t: TimeEntryInput, id?: number) {
    return id ? this.http.put<TimeEntry>(`/api/time-entries/${id}`, t) : this.http.post<TimeEntry>('/api/time-entries', t);
  }
  deleteTimeEntry(id: number) {
    return this.http.delete<void>(`/api/time-entries/${id}`);
  }
  timer() {
    return this.http.get<TimeEntry | null>('/api/timer');
  }
  startTimer(body: { projectId: number; task: string; billable: boolean }) {
    return this.http.post<TimeEntry>('/api/timer/start', body);
  }
  stopTimer() {
    return this.http.post<TimeEntry>('/api/timer/stop', {});
  }
  unbilled(customerId: number) {
    return this.http.get<Unbilled>(`/api/customers/${customerId}/unbilled`);
  }

  // ---------- GST filing ----------
  gstr1(from: string, to: string) {
    return this.http.get<GSTR1>('/api/gst/gstr1', { params: { from, to } });
  }
  gstr1Json(from: string, to: string) {
    return this.http.get('/api/gst/gstr1.json', { params: { from, to }, responseType: 'blob' });
  }
  gstr3b(from: string, to: string) {
    return this.http.get<GSTR3B>('/api/gst/gstr3b', { params: { from, to } });
  }
  gstReturns() {
    return this.http.get<GstReturn[]>('/api/gst/returns');
  }
  markFiled(body: { returnType: string; periodStart: string; periodEnd: string; filedOn: string; arn: string }) {
    return this.http.post<GstReturn[]>('/api/gst/returns', body);
  }
  unmarkFiled(id: number) {
    return this.http.delete<GstReturn[]>(`/api/gst/returns/${id}`);
  }

  // ---------- Reports ----------
  report(key: string, from: string, to: string) {
    return this.http.get<Report>(`/api/reports/${key}`, { params: { from, to } });
  }
  statement(customerId: number | string, from: string, to: string) {
    return this.http.get<Statement>(`/api/customers/${customerId}/statement`, { params: { from, to } });
  }

  // ---------- Team (owner only) ----------
  users() {
    return this.http.get<User[]>('/api/users');
  }
  saveUser(u: { name: string; email: string; role: string; active?: boolean; password?: string }, id?: number) {
    return id ? this.http.put<User>(`/api/users/${id}`, u) : this.http.post<User>('/api/users', u);
  }
  resetUserPassword(id: number, password: string) {
    return this.http.post<{ status: string }>(`/api/users/${id}/password`, { password });
  }
  deleteUser(id: number) {
    return this.http.delete<void>(`/api/users/${id}`);
  }
}

/** Turns an HTTP error into a sentence that tells the user what to do. */
export function errorMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const body = err.error as { error?: unknown } | null;
    if (body && typeof body === 'object' && typeof body.error === 'string') return body.error;
    if (err.status === 0 || err.status >= 500) {
      return "Can't reach the Averqo server. Start it in a terminal with: cd backend && go run .";
    }
  }
  return 'Something went wrong. Try again.';
}
