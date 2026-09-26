import { CurrencyPipe, DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { Api, errorMessage } from '../../core/api';
import { Project, TimeEntry } from '../../core/models';
import { duration } from '../../core/timer';
import { Toasts } from '../../core/toast';
import { TimeEntryDialog } from './time-entry-dialog';

@Component({
  selector: 'app-project-detail',
  imports: [RouterLink, CurrencyPipe, DatePipe, TimeEntryDialog],
  template: `
    <section class="page page-wide">
      @if (error()) {
        <div class="alert" role="alert"><span>{{ error() }}</span></div>
      } @else if (!project()) {
        <p class="muted">Loading…</p>
      } @else {
        @let p = project()!;
        <div class="page-head">
          <div>
            <a class="back" routerLink="/time-tracking/projects"><i class="ti ti-arrow-left" aria-hidden="true"></i>Projects</a>
            <h1>{{ p.name }} @if (p.status === 'completed') { <span class="badge" data-tone="void">Completed</span> }</h1>
            <p class="muted"><a [routerLink]="['/customers', p.customerId]" class="strong-link">{{ p.customerName }}</a> · {{ p.hourlyRate | currency }} an hour</p>
          </div>
          <div class="head-actions">
            <a class="btn" [routerLink]="['/time-tracking/projects', p.id, 'edit']"><i class="ti ti-pencil" aria-hidden="true"></i>Edit</a>
            @if (p.status === 'active') { <button type="button" class="btn" (click)="logOpen.set(true)"><i class="ti ti-clock-plus" aria-hidden="true"></i>Log time</button> }
            @if (p.unbilledMinutes > 0) {
              <a class="btn btn-primary" routerLink="/invoices/new" [queryParams]="{ customerId: p.customerId }"><i class="ti ti-file-invoice" aria-hidden="true"></i>Invoice unbilled time</a>
            }
          </div>
        </div>

        <div class="tiles tiles-3">
          <div class="tile"><span class="tile-label">Logged</span><span class="tile-value">{{ fmt(p.loggedMinutes) }}</span><span class="tile-sub">{{ fmt(p.billableMinutes) }} billable</span></div>
          <div class="tile"><span class="tile-label">Not yet billed</span><span class="tile-value">{{ p.unbilledAmount | currency }}</span><span class="tile-sub">{{ fmt(p.unbilledMinutes) }}</span></div>
          <div class="tile"><span class="tile-label">Budget</span>
            @if (p.budgetHours) {
              <span class="tile-value">{{ budgetPct() }}%</span>
              <div class="progress" [class.over]="budgetPct() > 100"><span [style.width.%]="budgetPct() > 100 ? 100 : budgetPct()"></span></div>
              <span class="tile-sub">{{ fmt(p.loggedMinutes) }} of {{ p.budgetHours }}h</span>
            } @else { <span class="tile-value">—</span><span class="tile-sub">No budget set</span> }
          </div>
        </div>
        @if (p.description) { <p class="muted pre">{{ p.description }}</p> }

        <div class="table-card">
          <table class="table">
            <thead><tr><th>Date</th><th>Task</th><th class="hide-sm">Person</th><th class="num">Time</th><th>Billing</th><th></th></tr></thead>
            <tbody>
              @for (e of entries(); track e.id) {
                <tr>
                  <td>{{ e.date | date: 'd MMM y' }}</td>
                  <td>{{ e.task || '—' }} @if (e.notes) { <div class="sub">{{ e.notes }}</div> }</td>
                  <td class="hide-sm">{{ e.userName || '—' }}</td>
                  <td class="num mono">{{ e.running ? 'Running' : fmt(e.minutes) }}</td>
                  <td>
                    @if (e.invoiceNumber) { <a class="badge" data-tone="paid" [routerLink]="['/invoices', e.invoiceId]">Billed · {{ e.invoiceNumber }}</a> }
                    @else { <span class="badge" [attr.data-tone]="e.billable ? 'sent' : 'muted'">{{ e.billable ? 'Unbilled' : 'Not billable' }}</span> }
                  </td>
                  <td class="row-end">
                    @if (!e.invoiceId && !e.running) {
                      <button type="button" class="icon-btn" (click)="edit(e)" aria-label="Edit entry"><i class="ti ti-pencil" aria-hidden="true"></i></button>
                      <button type="button" class="icon-btn" (click)="remove(e)" aria-label="Delete entry"><i class="ti ti-trash" aria-hidden="true"></i></button>
                    }
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="6" class="empty-row">No time logged on this project yet.</td></tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>
    @if (logOpen() && project()) {
      <app-time-entry-dialog [projects]="[project()!]" [entry]="editing()" [projectPreset]="project()!.id"
        (saved)="saved()" (closed)="close()" />
    }
  `,
})
export class ProjectDetail implements OnInit {
  private api = inject(Api);
  private toasts = inject(Toasts);
  readonly id = input.required<string>();
  protected readonly fmt = duration;
  protected project = signal<Project | null>(null);
  protected entries = signal<TimeEntry[]>([]);
  protected error = signal('');
  protected logOpen = signal(false);
  protected editing = signal<TimeEntry | null>(null);
  protected budgetPct = computed(() => {
    const p = this.project();
    return p?.budgetHours ? Math.round((p.loggedMinutes / 60 / p.budgetHours) * 100) : 0;
  });

  ngOnInit() {
    this.load();
  }

  private load() {
    forkJoin({ project: this.api.project(this.id()), entries: this.api.timeEntries({ projectId: Number(this.id()) }) }).subscribe({
      next: ({ project, entries }) => {
        this.project.set(project);
        this.entries.set(entries);
      },
      error: (e) => this.error.set(errorMessage(e)),
    });
  }

  protected edit(e: TimeEntry) {
    this.editing.set(e);
    this.logOpen.set(true);
  }

  protected close() {
    this.logOpen.set(false);
    this.editing.set(null);
  }

  protected saved() {
    this.toasts.show(this.editing() ? 'Time updated' : 'Time logged');
    this.close();
    this.load();
  }

  protected remove(e: TimeEntry) {
    if (!confirm(`Delete ${duration(e.minutes)} logged on ${e.date}?`)) return;
    this.api.deleteTimeEntry(e.id).subscribe({ next: () => this.load(), error: (err) => this.toasts.show(errorMessage(err), 'error') });
  }
}
