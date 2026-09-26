import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, errorMessage } from '../../core/api';
import { Dashboard } from '../../core/models';

@Component({
  selector: 'app-getting-started',
  imports: [RouterLink],
  template: `
    <section class="page">
      <div class="page-head">
        <div>
          <h1>Getting started</h1>
          <p class="muted">Six steps take you from an empty account to your first payment. Most people finish in about ten minutes.</p>
        </div>
      </div>

      @if (error()) {
        <div class="alert" role="alert"><span>{{ error() }}</span></div>
      } @else if (steps().length) {
        <div class="progress progress-lg" aria-hidden="true"><span [style.width.%]="(done() / steps().length) * 100"></span></div>
        <p class="muted progress-text">{{ done() }} of {{ steps().length }} done</p>

        <ol class="steps">
          @for (s of steps(); track s.title; let i = $index) {
            <li class="step" [class.done]="s.done" [class.current]="i === firstOpen()">
              <span class="step-mark" aria-hidden="true">
                @if (s.done) {
                  <i class="ti ti-check"></i>
                } @else {
                  {{ i + 1 }}
                }
              </span>
              <div class="step-body">
                <h2>{{ s.title }}</h2>
                <p class="muted">{{ s.text }}</p>
              </div>
              @if (s.done) {
                <span class="badge" data-tone="paid">Done</span>
              } @else {
                <a class="btn" [class.btn-primary]="i === firstOpen()" [routerLink]="s.link">{{ s.cta }}</a>
              }
            </li>
          }
        </ol>

        <div class="card tip">
          <i class="ti ti-keyboard" aria-hidden="true"></i>
          <p>Press <kbd>Ctrl K</kbd> anywhere to find a customer or invoice, or to create something new without leaving the page you're on.</p>
        </div>
      }
    </section>
  `,
})
export class GettingStarted {
  private api = inject(Api);
  private data = signal<Dashboard | null>(null);
  protected error = signal('');

  protected steps = computed(() => {
    const s = this.data()?.setup;
    if (!s) return [];
    return [
      { done: s.profile, title: 'Add your business details', cta: 'Open settings', link: '/settings',
        text: 'Your name, state, and GSTIN appear on every invoice. Your state decides whether CGST + SGST or IGST applies.' },
      { done: s.customer, title: 'Add a customer', cta: 'Add customer', link: '/customers/new',
        text: 'Save their GSTIN and state once, and Averqo picks the right GST on every invoice.' },
      { done: s.item, title: 'Add a product or service', cta: 'Add item', link: '/items/new',
        text: 'Items remember the rate, unit, HSN/SAC code, and GST rate, so invoices take seconds.' },
      { done: s.invoice, title: 'Create an invoice', cta: 'Create invoice', link: '/invoices/new',
        text: 'Pick a customer and items. GST, totals, and the amount in words are filled in for you.' },
      { done: s.sent, title: 'Send it', cta: 'View invoices', link: '/invoices',
        text: 'Print it or save it as a PDF for your customer, then mark it as sent so Averqo tracks what you are owed.' },
      { done: s.payment, title: 'Record a payment', cta: 'Record payment', link: '/payments/new',
        text: 'When money arrives, record it once. One payment can settle several invoices.' },
    ];
  });
  protected done = computed(() => this.steps().filter((s) => s.done).length);
  protected firstOpen = computed(() => this.steps().findIndex((s) => !s.done));

  constructor() {
    this.api.dashboard().subscribe({ next: (d) => this.data.set(d), error: (e) => this.error.set(errorMessage(e)) });
  }
}
