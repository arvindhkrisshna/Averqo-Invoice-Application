import { CurrencyPipe, DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, errorMessage } from '../../core/api';
import { MODE_LABEL, dueText } from '../../core/format';
import { Dashboard } from '../../core/models';

@Component({
  selector: 'app-home',
  imports: [RouterLink, CurrencyPipe, DatePipe],
  templateUrl: './home.html',
})
export class Home {
  private api = inject(Api);
  protected readonly dueText = dueText;
  protected readonly modeLabel = MODE_LABEL;
  protected data = signal<Dashboard | null>(null);
  protected error = signal('');

  protected greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  })();

  protected setupSteps = computed(() => {
    const s = this.data()?.setup;
    return s ? [s.profile, s.customer, s.item, s.invoice, s.sent, s.payment] : [];
  });
  protected setupDone = computed(() => this.setupSteps().filter(Boolean).length);

  protected nextStep = computed(() => {
    const s = this.data()?.setup;
    if (!s) return '';
    if (!s.profile) return 'add your business details';
    if (!s.customer) return 'add a customer';
    if (!s.item) return 'add an item';
    if (!s.invoice) return 'create an invoice';
    if (!s.sent) return 'send an invoice';
    return 'record a payment';
  });

  /** Bar heights for the 6-month chart, as percentages of the tallest bar. */
  protected chart = computed(() => {
    const months = this.data()?.months ?? [];
    const max = Math.max(1, ...months.flatMap((m) => [m.invoiced, m.received]));
    return months.map((m) => ({
      label: new Date(m.month + '-01T00:00:00').toLocaleString('en-IN', { month: 'short' }),
      invoiced: m.invoiced,
      received: m.received,
      hInvoiced: (m.invoiced / max) * 100,
      hReceived: (m.received / max) * 100,
    }));
  });

  protected agingMax = computed(() => Math.max(1, ...(this.data()?.aging ?? []).map((a) => a.amount)));
  protected attentionCount = computed(() => {
    const d = this.data();
    return d ? d.overdueInvoices.length + d.dueSoonInvoices.length + d.draftInvoices.length : 0;
  });

  constructor() {
    this.load();
  }

  protected load() {
    this.error.set('');
    this.api.dashboard().subscribe({
      next: (d) => this.data.set(d),
      error: (e) => this.error.set(errorMessage(e)),
    });
  }
}
