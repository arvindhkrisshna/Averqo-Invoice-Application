import { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/auth';

// Each page loads only when it's first opened, which keeps the app quick.
const page = {
  login: () => import('./pages/auth/login').then((m) => m.Login),
  setup: () => import('./pages/auth/setup').then((m) => m.Setup),
  home: () => import('./pages/home/home').then((m) => m.Home),
  gettingStarted: () => import('./pages/getting-started/getting-started').then((m) => m.GettingStarted),
  settings: () => import('./pages/settings/settings').then((m) => m.Settings),
  customerList: () => import('./pages/customers/customer-list').then((m) => m.CustomerList),
  customerForm: () => import('./pages/customers/customer-form').then((m) => m.CustomerForm),
  customerDetail: () => import('./pages/customers/customer-detail').then((m) => m.CustomerDetail),
  customerStatement: () => import('./pages/customers/customer-statement').then((m) => m.CustomerStatement),
  itemList: () => import('./pages/items/item-list').then((m) => m.ItemList),
  itemForm: () => import('./pages/items/item-form').then((m) => m.ItemForm),
  invoiceList: () => import('./pages/invoices/invoice-list').then((m) => m.InvoiceList),
  invoiceForm: () => import('./pages/invoices/invoice-form').then((m) => m.InvoiceForm),
  invoiceDetail: () => import('./pages/invoices/invoice-detail').then((m) => m.InvoiceDetail),
  paymentList: () => import('./pages/payments/payment-list').then((m) => m.PaymentList),
  paymentForm: () => import('./pages/payments/payment-form').then((m) => m.PaymentForm),
  paymentDetail: () => import('./pages/payments/payment-detail').then((m) => m.PaymentDetail),
  docList: () => import('./pages/documents/doc-list').then((m) => m.DocList),
  docForm: () => import('./pages/documents/doc-form').then((m) => m.DocForm),
  docDetail: () => import('./pages/documents/doc-detail').then((m) => m.DocDetail),
  recurringList: () => import('./pages/recurring/recurring-list').then((m) => m.RecurringList),
  recurringForm: () => import('./pages/recurring/recurring-form').then((m) => m.RecurringForm),
  recurringDetail: () => import('./pages/recurring/recurring-detail').then((m) => m.RecurringDetail),
  expenseList: () => import('./pages/expenses/expense-list').then((m) => m.ExpenseList),
  expenseForm: () => import('./pages/expenses/expense-form').then((m) => m.ExpenseForm),
  timesheet: () => import('./pages/time/timesheet').then((m) => m.Timesheet),
  projectList: () => import('./pages/time/project-list').then((m) => m.ProjectList),
  projectForm: () => import('./pages/time/project-form').then((m) => m.ProjectForm),
  projectDetail: () => import('./pages/time/project-detail').then((m) => m.ProjectDetail),
  gstFiling: () => import('./pages/gst/gst-filing').then((m) => m.GstFiling),
  reportList: () => import('./pages/reports/report-list').then((m) => m.ReportList),
  reportView: () => import('./pages/reports/report-view').then((m) => m.ReportView),
};

// Quotes, delivery challans, and credit notes share one set of pages.
const docRoutes = (path: string, kind: string, one: string, many: string) => [
  { path, loadComponent: page.docList, title: `${many} · Averqo`, data: { kind } },
  { path: `${path}/new`, loadComponent: page.docForm, title: `New ${one.toLowerCase()} · Averqo`, data: { kind } },
  { path: `${path}/:id`, loadComponent: page.docDetail, title: `${one} · Averqo`, data: { kind } },
  { path: `${path}/:id/edit`, loadComponent: page.docForm, title: `Edit ${one.toLowerCase()} · Averqo`, data: { kind } },
];

export const routes: Routes = [
  { path: 'login', loadComponent: page.login, title: 'Sign in · Averqo', canActivate: [guestGuard] },
  { path: 'setup', loadComponent: page.setup, title: 'Set up Averqo', canActivate: [guestGuard] },
  {
    path: '',
    canActivateChild: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'home' },
      { path: 'home', loadComponent: page.home, title: 'Home · Averqo' },
      { path: 'getting-started', loadComponent: page.gettingStarted, title: 'Getting started · Averqo' },
      { path: 'settings', loadComponent: page.settings, title: 'Settings · Averqo' },

      { path: 'customers', loadComponent: page.customerList, title: 'Customers · Averqo' },
      { path: 'customers/new', loadComponent: page.customerForm, title: 'New customer · Averqo' },
      { path: 'customers/:id', loadComponent: page.customerDetail, title: 'Customer · Averqo' },
      { path: 'customers/:id/edit', loadComponent: page.customerForm, title: 'Edit customer · Averqo' },
      { path: 'customers/:id/statement', loadComponent: page.customerStatement, title: 'Customer statement · Averqo' },

      { path: 'items', loadComponent: page.itemList, title: 'Items · Averqo' },
      { path: 'items/new', loadComponent: page.itemForm, title: 'New item · Averqo' },
      { path: 'items/:id/edit', loadComponent: page.itemForm, title: 'Edit item · Averqo' },

      { path: 'invoices', loadComponent: page.invoiceList, title: 'Invoices · Averqo' },
      { path: 'invoices/new', loadComponent: page.invoiceForm, title: 'New invoice · Averqo' },
      { path: 'invoices/:id', loadComponent: page.invoiceDetail, title: 'Invoice · Averqo' },
      { path: 'invoices/:id/edit', loadComponent: page.invoiceForm, title: 'Edit invoice · Averqo' },

      { path: 'payments', loadComponent: page.paymentList, title: 'Payments received · Averqo' },
      { path: 'payments/new', loadComponent: page.paymentForm, title: 'Record payment · Averqo' },
      { path: 'payments/:id', loadComponent: page.paymentDetail, title: 'Payment · Averqo' },

      ...docRoutes('quotes', 'quote', 'Quote', 'Quotes'),
      ...docRoutes('delivery-challans', 'challan', 'Delivery challan', 'Delivery challans'),
      ...docRoutes('credit-notes', 'credit_note', 'Credit note', 'Credit notes'),

      { path: 'recurring-invoices', loadComponent: page.recurringList, title: 'Recurring invoices · Averqo' },
      { path: 'recurring-invoices/new', loadComponent: page.recurringForm, title: 'New schedule · Averqo' },
      { path: 'recurring-invoices/:id', loadComponent: page.recurringDetail, title: 'Recurring schedule · Averqo' },
      { path: 'recurring-invoices/:id/edit', loadComponent: page.recurringForm, title: 'Edit schedule · Averqo' },

      { path: 'expenses', loadComponent: page.expenseList, title: 'Expenses · Averqo' },
      { path: 'expenses/new', loadComponent: page.expenseForm, title: 'New expense · Averqo' },
      { path: 'expenses/:id', loadComponent: page.expenseForm, title: 'Expense · Averqo' },

      { path: 'time-tracking', loadComponent: page.timesheet, title: 'Timesheet · Averqo' },
      { path: 'time-tracking/projects', loadComponent: page.projectList, title: 'Projects · Averqo' },
      { path: 'time-tracking/projects/new', loadComponent: page.projectForm, title: 'New project · Averqo' },
      { path: 'time-tracking/projects/:id', loadComponent: page.projectDetail, title: 'Project · Averqo' },
      { path: 'time-tracking/projects/:id/edit', loadComponent: page.projectForm, title: 'Edit project · Averqo' },

      { path: 'gst-filing', loadComponent: page.gstFiling, title: 'GST filing · Averqo' },
      { path: 'reports', loadComponent: page.reportList, title: 'Reports · Averqo' },
      { path: 'reports/:key', loadComponent: page.reportView, title: 'Report · Averqo' },

      { path: '**', redirectTo: 'home' },
    ],
  },
];
