import { Component, HostListener, effect, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { Api, errorMessage } from './core/api';
import { Auth } from './core/auth';
import { Timer, clock } from './core/timer';
import { Toasts } from './core/toast';
import { CommandPalette } from './shell/command-palette';

interface NavLink {
  label: string;
  path: string;
  icon: string;
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, CommandPalette],
  templateUrl: './app.html',
})
export class App {
  protected api = inject(Api);
  protected auth = inject(Auth);
  protected timer = inject(Timer);
  protected toasts = inject(Toasts);
  protected readonly clock = clock;
  protected userMenu = signal(false);
  protected navOpen = signal(false);
  protected paletteOpen = signal(false);

  protected readonly top: NavLink[] = [
    { label: 'Getting started', path: '/getting-started', icon: 'rocket' },
    { label: 'Home', path: '/home', icon: 'home' },
  ];
  protected readonly groups: { title: string; links: NavLink[] }[] = [
    {
      title: 'Sales',
      links: [
        { label: 'Customers', path: '/customers', icon: 'users' },
        { label: 'Items', path: '/items', icon: 'package' },
        { label: 'Quotes', path: '/quotes', icon: 'file-description' },
        { label: 'Delivery challans', path: '/delivery-challans', icon: 'truck-delivery' },
        { label: 'Invoices', path: '/invoices', icon: 'file-invoice' },
        { label: 'Payments received', path: '/payments', icon: 'cash' },
        { label: 'Recurring invoices', path: '/recurring-invoices', icon: 'repeat' },
        { label: 'Credit notes', path: '/credit-notes', icon: 'receipt-refund' },
      ],
    },
    {
      title: 'Costs and time',
      links: [
        { label: 'Expenses', path: '/expenses', icon: 'receipt' },
        { label: 'Time tracking', path: '/time-tracking', icon: 'clock-hour-4' },
      ],
    },
    {
      title: 'Tax and insight',
      links: [
        { label: 'GST filing', path: '/gst-filing', icon: 'building-bank' },
        { label: 'Reports', path: '/reports', icon: 'chart-bar' },
      ],
    },
  ];

  constructor() {
    // Load the business profile and any running timer once someone is signed in.
    effect(() => {
      if (this.auth.user()) {
        this.api.loadOrg().subscribe({ error: () => {} });
        this.timer.refresh();
      } else {
        this.timer.clear();
      }
    });
    inject(Router)
      .events.pipe(filter((e) => e instanceof NavigationEnd))
      .subscribe(() => {
        this.navOpen.set(false);
        this.userMenu.set(false);
      });
  }

  protected initials(name: string) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
  }

  protected stopTimer() {
    this.timer.stop().subscribe({
      next: (t) => this.toasts.show(`Saved ${Math.floor(t.minutes / 60)}h ${t.minutes % 60}m on ${t.projectName}`),
      error: (e) => this.toasts.show(errorMessage(e), 'error'),
    });
  }

  protected signOut() {
    this.auth.logout().subscribe();
  }

  /** Ctrl+K (Cmd+K on Mac) opens search from anywhere. */
  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') this.userMenu.set(false);
    if (!this.auth.user()) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      this.paletteOpen.update((v) => !v);
    }
  }
}
