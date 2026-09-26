import { CurrencyPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api, errorMessage } from '../../core/api';
import { downloadCsv } from '../../core/format';
import { Project } from '../../core/models';
import { duration } from '../../core/timer';

@Component({
  selector: 'app-project-list',
  imports: [RouterLink, CurrencyPipe],
  template: `
    <section class="page page-wide">
      <div class="page-head">
        <div>
          <a class="back" routerLink="/time-tracking"><i class="ti ti-arrow-left" aria-hidden="true"></i>Timesheet</a>
          <h1>Projects</h1>
          @if (projects().length) { <p class="muted">{{ unbilledTotal() | currency }} of time not yet billed</p> }
        </div>
        <div class="head-actions">
          <button type="button" class="btn" (click)="exportCsv()" [disabled]="!shown().length"><i class="ti ti-download" aria-hidden="true"></i>Export CSV</button>
          <a class="btn btn-primary" routerLink="/time-tracking/projects/new"><i class="ti ti-plus" aria-hidden="true"></i>New project</a>
        </div>
      </div>
      @if (error()) {
        <div class="alert" role="alert"><span>{{ error() }}</span><button type="button" class="btn" (click)="load()">Try again</button></div>
      } @else if (loading()) {
        <p class="muted">Loading projects…</p>
      } @else if (!projects().length) {
        <div class="empty">
          <i class="ti ti-briefcase" aria-hidden="true"></i>
          <h2>No projects yet</h2>
          <p>Create a project for each piece of work you do for a customer. Its hourly rate prices the time you bill.</p>
          <a class="btn btn-primary" routerLink="/time-tracking/projects/new">New project</a>
        </div>
      } @else {
        <div class="toolbar">
          <div class="chips" role="radiogroup" aria-label="Status">
            @for (s of ['active', 'completed', 'all']; track s) {
              <button type="button" class="chip" [class.active]="status() === s" (click)="status.set(s)">{{ s === 'all' ? 'All' : s === 'active' ? 'Active' : 'Completed' }}</button>
            }
          </div>
        </div>
        <div class="table-card">
          <table class="table">
            <thead><tr><th>Project</th><th>Customer</th><th class="num hide-sm">Rate</th><th class="num">Logged</th><th class="num">Not yet billed</th><th class="num hide-sm">Unbilled value</th></tr></thead>
            <tbody>
              @for (p of shown(); track p.id) {
                <tr class="clickable" (click)="router.navigate(['/time-tracking/projects', p.id])">
                  <td><a [routerLink]="['/time-tracking/projects', p.id]" class="strong-link" (click)="$event.stopPropagation()">{{ p.name }}</a>
                    @if (p.status === 'completed') { <span class="badge" data-tone="void">Completed</span> }
                    @if (p.budgetHours) { <div class="sub">{{ fmt(p.loggedMinutes) }} of {{ p.budgetHours }}h budget</div> }</td>
                  <td>{{ p.customerName }}</td>
                  <td class="num hide-sm">{{ p.hourlyRate | currency }}/h</td>
                  <td class="num">{{ fmt(p.loggedMinutes) }}</td>
                  <td class="num">{{ fmt(p.unbilledMinutes) }}</td>
                  <td class="num hide-sm">{{ p.unbilledAmount | currency }}</td>
                </tr>
              } @empty {
                <tr><td colspan="6" class="empty-row">No {{ status() }} projects.</td></tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
})
export class ProjectList {
  private api = inject(Api);
  protected router = inject(Router);
  protected readonly fmt = duration;
  protected projects = signal<Project[]>([]);
  protected loading = signal(true);
  protected error = signal('');
  protected status = signal('active');
  protected shown = computed(() => this.projects().filter((p) => this.status() === 'all' || p.status === this.status()));
  protected unbilledTotal = computed(() => this.projects().reduce((s, p) => s + p.unbilledAmount, 0));

  constructor() {
    this.load();
  }

  protected load() {
    this.loading.set(true);
    this.error.set('');
    this.api.projects().subscribe({
      next: (p) => {
        this.projects.set(p);
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.loading.set(false);
      },
    });
  }

  protected exportCsv() {
    downloadCsv('averqo-projects.csv', ['Project', 'Customer', 'Status', 'Hourly rate', 'SAC', 'Budget hours', 'Hours logged',
      'Billable hours', 'Unbilled hours', 'Unbilled value'],
      this.shown().map((p) => [p.name, p.customerName, p.status, p.hourlyRate.toFixed(2), p.sac, p.budgetHours ?? '',
        (p.loggedMinutes / 60).toFixed(2), (p.billableMinutes / 60).toFixed(2), (p.unbilledMinutes / 60).toFixed(2), p.unbilledAmount.toFixed(2)]));
  }
}
