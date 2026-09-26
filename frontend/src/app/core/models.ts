// Types that mirror the JSON returned by the Go API.

export type GstTreatment = 'registered' | 'unregistered' | 'consumer' | 'overseas';
export type Lifecycle = 'draft' | 'sent' | 'void';

export interface State {
  code: string;
  name: string;
}

export interface Meta {
  states: State[];
  gstRates: number[];
  units: string[];
  paymentModes: { value: string; label: string }[];
  challanTypes: { value: string; label: string }[];
  creditReasons: { value: string; label: string }[];
}

export interface Organization {
  name: string;
  gstRegistered: boolean;
  gstin: string;
  stateCode: string;
  address: string;
  city: string;
  pincode: string;
  email: string;
  phone: string;
  bankName: string;
  bankAccountNumber: string;
  bankIfsc: string;
  upiId: string;
  invoicePrefix: string;
  nextInvoiceNumber: number;
  paymentPrefix: string;
  nextPaymentNumber: number;
  quotePrefix: string;
  nextQuoteNumber: number;
  challanPrefix: string;
  nextChallanNumber: number;
  creditPrefix: string;
  nextCreditNumber: number;
  paymentTermsDays: number;
  quoteValidityDays: number;
  invoiceNotes: string;
  invoiceTerms: string;
  quoteNotes: string;
  quoteTerms: string;
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  smtpPassword: string; // write-only: always empty when read
  smtpPasswordSet: boolean;
  smtpFromEmail: string;
  smtpFromName: string;
  gstFilingFrequency: 'monthly' | 'quarterly';
}

export interface Customer {
  id: number;
  displayName: string;
  contactPerson: string;
  email: string;
  phone: string;
  gstTreatment: GstTreatment;
  gstin: string;
  stateCode: string;
  address: string;
  city: string;
  pincode: string;
  paymentTermsDays: number | null;
  notes: string;
  archived: boolean;
  createdAt: string;
  invoiced: number;
  received: number;
  outstanding: number;
  credits: number;
}

export interface Item {
  id: number;
  name: string;
  kind: 'goods' | 'service';
  hsnSac: string;
  unit: string;
  rate: number;
  taxRate: number;
  description: string;
  archived: boolean;
  createdAt: string;
  timesUsed: number;
}

export interface InvoiceLine {
  id?: number;
  itemId: number | null;
  description: string;
  hsnSac: string;
  unit: string;
  quantity: number;
  rate: number;
  discountPct: number;
  taxRate: number;
  taxableAmount?: number;
  cgst?: number;
  sgst?: number;
  igst?: number;
  timeEntryIds?: number[];
  expenseId?: number | null;
}

export interface InvoicePayment {
  paymentId: number;
  paymentNumber: string;
  paymentDate: string;
  mode: string;
  amount: number;
}

export interface Invoice {
  id: number;
  invoiceNumber: string;
  customerId: number;
  customerName: string;
  customerEmail: string;
  customerGstin: string;
  billingAddress: string;
  placeOfSupply: string;
  issueDate: string;
  dueDate: string;
  lifecycle: Lifecycle;
  reference: string;
  subtotal: number;
  discountTotal: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  total: number;
  paid: number;
  credited: number;
  balance: number;
  notes: string;
  terms: string;
  recurringId: number | null;
  createdAt: string;
  lines?: InvoiceLine[];
  payments?: InvoicePayment[];
  credits?: { allocationId: number; creditNoteId: number; number: string; appliedOn: string; amount: number }[];
  related?: DocRef[];
  activity?: ActivityEntry[];
}

export type DocType = 'quote' | 'challan' | 'credit_note';

export interface DocRef {
  id: number;
  type: DocType;
  number: string;
  status: string;
  total: number;
}

export interface ActivityEntry {
  action: string;
  detail: string;
  createdAt: string;
}

/** A quote, delivery challan, or credit note. */
export interface SalesDoc {
  id: number;
  type: DocType;
  number: string;
  customerId: number;
  customerName: string;
  customerEmail: string;
  customerGstin: string;
  billingAddress: string;
  placeOfSupply: string;
  issueDate: string;
  expiryDate: string | null;
  status: string;
  challanType: string;
  reason: string;
  invoiceId: number | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  reference: string;
  subtotal: number;
  discountTotal: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  total: number;
  applied: number;
  refunded: number;
  balance: number;
  notes: string;
  terms: string;
  createdAt: string;
  lines?: InvoiceLine[];
  allocations?: { id: number; invoiceId: number; invoiceNumber: string; appliedOn: string; amount: number }[];
  refunds?: { id: number; refundDate: string; amount: number; mode: string; reference: string }[];
  activity?: ActivityEntry[];
}

export interface SalesDocInput {
  customerId: number;
  issueDate: string;
  expiryDate: string;
  reference: string;
  notes: string;
  terms: string;
  status: string;
  challanType: string;
  reason: string;
  invoiceId: number | null;
  applyToInvoice: boolean;
  lines: InvoiceLine[];
}

export type Frequency = 'weekly' | 'monthly' | 'quarterly' | 'half_yearly' | 'yearly';

export interface RecurringProfile {
  id: number;
  profileName: string;
  customerId: number;
  customerName: string;
  frequency: Frequency;
  startDate: string;
  endDate: string | null;
  nextRunDate: string | null;
  occurrences: number;
  status: 'active' | 'paused' | 'ended';
  createAs: 'draft' | 'sent';
  paymentTermsDays: number;
  reference: string;
  notes: string;
  terms: string;
  lastError: string;
  subtotal: number;
  invoiceCount: number;
  createdAt: string;
  lines?: InvoiceLine[];
  activity?: ActivityEntry[];
}

export interface RecurringInput {
  profileName: string;
  customerId: number;
  frequency: Frequency;
  startDate: string;
  endDate: string;
  createAs: 'draft' | 'sent';
  paymentTermsDays: number;
  reference: string;
  notes: string;
  terms: string;
  lines: InvoiceLine[];
}

export interface EmailStatus {
  configured: boolean;
  fromEmail: string;
  fromName: string;
}

export interface InvoiceInput {
  customerId: number;
  issueDate: string;
  dueDate: string;
  reference: string;
  notes: string;
  terms: string;
  status: 'draft' | 'sent';
  lines: InvoiceLine[];
}

export interface Payment {
  id: number;
  paymentNumber: string;
  customerId: number;
  customerName: string;
  paymentDate: string;
  amount: number;
  mode: string;
  reference: string;
  notes: string;
  createdAt: string;
  invoiceNumbers: string;
  allocations?: { invoiceId: number; invoiceNumber: string; amount: number }[];
}

export interface PaymentInput {
  customerId: number;
  paymentDate: string;
  amount: number;
  mode: string;
  reference: string;
  notes: string;
  allocations: { invoiceId: number; amount: number }[];
}

export interface InvoiceBrief {
  id: number;
  invoiceNumber: string;
  customerName: string;
  dueDate: string;
  amount: number;
}

export interface Dashboard {
  receivables: number;
  overdue: number;
  dueThisWeek: number;
  invoicedThisMonth: number;
  receivedThisMonth: number;
  overdueInvoices: InvoiceBrief[];
  dueSoonInvoices: InvoiceBrief[];
  draftInvoices: InvoiceBrief[];
  draftCount: number;
  months: { month: string; invoiced: number; received: number }[];
  aging: { label: string; amount: number }[];
  recentPayments: Payment[];
  setup: {
    profile: boolean;
    customer: boolean;
    item: boolean;
    invoice: boolean;
    sent: boolean;
    payment: boolean;
    orgName: string;
  };
}

export interface SearchResult {
  type: 'customer' | 'invoice' | 'item' | 'payment' | DocType;
  id: number;
  title: string;
  subtitle: string;
}

// ---------- Sign-in and team ----------
export interface User {
  id: number;
  name: string;
  email: string;
  role: 'owner' | 'staff';
  active: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}
export interface AuthStatus {
  setupNeeded: boolean;
  setupCodeRequired: boolean;
  user: User | null;
}

// ---------- Expenses ----------
export interface ExpenseCategory {
  id: number;
  name: string;
  archived: boolean;
  used: number;
}
export interface Expense {
  id: number;
  date: string;
  categoryId: number;
  categoryName: string;
  vendorName: string;
  vendorGstin: string;
  vendorState: string;
  billNumber: string;
  hsnSac: string;
  description: string;
  amountIncludesTax: boolean;
  gstRate: number;
  subtotal: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  itcEligible: boolean;
  reverseCharge: boolean;
  paidThrough: string;
  reference: string;
  customerId: number | null;
  customerName: string | null;
  billable: boolean;
  markupPct: number;
  invoiceId: number | null;
  invoiceNumber: string | null;
  receiptName: string | null;
  createdAt: string;
}
export interface ExpenseInput {
  date: string;
  categoryId: number;
  vendorName: string;
  vendorGstin: string;
  vendorState: string;
  billNumber: string;
  hsnSac: string;
  description: string;
  amount: number;
  amountIncludesTax: boolean;
  gstRate: number;
  itcEligible: boolean;
  reverseCharge: boolean;
  paidThrough: string;
  reference: string;
  customerId: number | null;
  billable: boolean;
  markupPct: number;
}
export interface Vendor {
  name: string;
  gstin: string;
  state: string;
}

// ---------- Time tracking ----------
export interface Project {
  id: number;
  name: string;
  customerId: number;
  customerName: string;
  hourlyRate: number;
  sac: string;
  taxRate: number;
  budgetHours: number | null;
  status: 'active' | 'completed';
  description: string;
  loggedMinutes: number;
  billableMinutes: number;
  unbilledMinutes: number;
  unbilledAmount: number;
  createdAt: string;
}
export interface ProjectInput {
  name: string;
  customerId: number;
  hourlyRate: number;
  sac: string;
  taxRate: number;
  budgetHours: number | null;
  status: 'active' | 'completed';
  description: string;
}
export interface TimeEntry {
  id: number;
  projectId: number;
  projectName: string;
  customerId: number;
  customerName: string;
  userId: number | null;
  userName: string | null;
  date: string;
  task: string;
  minutes: number;
  notes: string;
  billable: boolean;
  invoiceId: number | null;
  invoiceNumber: string | null;
  running: boolean;
  elapsedSeconds: number;
}
export interface TimeEntryInput {
  projectId: number;
  date: string;
  task: string;
  minutes: number;
  notes: string;
  billable: boolean;
}
export interface UnbilledTime {
  projectId: number;
  projectName: string;
  entryIds: number[];
  minutes: number;
  hours: number;
  rate: number;
  amount: number;
  sac: string;
  taxRate: number;
  from: string;
  to: string;
}
export interface UnbilledExpense {
  id: number;
  date: string;
  category: string;
  vendor: string;
  description: string;
  amount: number;
  taxRate: number;
  hsnSac: string;
}
export interface Unbilled {
  time: UnbilledTime[];
  expenses: UnbilledExpense[];
}

// ---------- GST filing ----------
export interface TaxAmt {
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
}
export interface G1Item extends TaxAmt {
  rate: number;
}
export interface G1Doc {
  id: number;
  number: string;
  date: string;
  customer: string;
  gstin: string;
  pos: string;
  value: number;
  type: string;
  against: string;
  items: G1Item[];
  total: TaxAmt;
}
export interface G1B2CS extends TaxAmt {
  supplyType: 'INTRA' | 'INTER';
  pos: string;
  rate: number;
}
export interface G1HSN extends TaxAmt {
  hsn: string;
  desc: string;
  uqc: string;
  qty: number;
  rate: number;
}
export interface GstCheck {
  level: 'error' | 'warning' | 'info';
  message: string;
  link: string;
}
export interface GSTR1 {
  from: string;
  to: string;
  gstin: string;
  b2b: G1Doc[];
  b2cl: G1Doc[];
  b2cs: G1B2CS[];
  exp: G1Doc[];
  cdnr: G1Doc[];
  cdnur: G1Doc[];
  hsnB2b: G1HSN[];
  hsnB2c: G1HSN[];
  nil: { supplyType: string; label: string; amount: number }[];
  docs: { nature: string; docNum: number; from: string; to: string; total: number; cancelled: number }[];
  totals: TaxAmt;
  invoices: number;
  checks: GstCheck[];
}
export interface Heads {
  igst: number;
  cgst: number;
  sgst: number;
}
export interface GSTR3B {
  from: string;
  to: string;
  outward: TaxAmt;
  zeroRated: TaxAmt;
  nilExempt: TaxAmt;
  reverseCharge: TaxAmt;
  interUnregistered: { pos: string; state: string; taxable: number; igst: number }[];
  itcReverseCharge: TaxAmt;
  itcOther: TaxAmt;
  itcNet: TaxAmt;
  setoff: { liability: Heads; credit: Heads; fromIgst: Heads; fromCgst: Heads; fromSgst: Heads; cash: Heads; creditLeft: Heads };
  reverseChargeCash: Heads;
  checks: GstCheck[];
}
export interface GstReturn {
  id: number;
  returnType: 'GSTR1' | 'GSTR3B';
  periodStart: string;
  periodEnd: string;
  filedOn: string;
  arn: string;
  filedBy: string | null;
}

// ---------- Reports and statements ----------
export interface ReportColumn {
  key: string;
  label: string;
  type: 'text' | 'money' | 'number' | 'hours' | 'date';
}
export type ReportRow = Record<string, string | number | null | undefined>;
export interface Report {
  key: string;
  title: string;
  from: string;
  to: string;
  asOf: boolean;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: ReportRow | null;
  note: string;
}
export interface StatementLine {
  date: string;
  type: 'invoice' | 'payment' | 'credit';
  number: string;
  detail: string;
  link: string;
  debit: number;
  credit: number;
  balance: number;
}
export interface Statement {
  customer: Customer;
  from: string;
  to: string;
  opening: number;
  lines: StatementLine[];
  debits: number;
  credits: number;
  closing: number;
}
