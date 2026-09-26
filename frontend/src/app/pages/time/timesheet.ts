import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { Api, errorMessage } from '../../core/api';
import { addDays, downloadCsv, todayISO } from '../../core/format';
import { Project, TimeEntry } from '../../core/models';
import { Timer, clock, duration } from '../../core/timer';
import { Toasts } from '../../core/toast';
import { TimeEntryDialog } from './time-entry-dialog';

/** Monday of the week containing the date. */
function weekStart(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return addDays(iso, -((d.getDay() + 6) % 7));
}

@Component({
  selector: 'app-timesheet',
  imports: [RouterLink, DatePipe, FormsModule, TimeEntryDialog],
  template: `
    <section class="page page-wide">
      <div class="page-head">
        <div>
          <h1>Timesheet</h1>
          <p class="muted">{{ fmt(weekTotal()) }} this week · {{ fmt(weekBillable()) }} billable</p>
        </div>
        <div class="head-actions">
          <a class="btn" routerLink="/time-tracking/projects"><i class="ti ti-briefcase" aria-hidden="true"></i>Projects</a>
          <button type="button" class="btn" (click)="exportCsv()" [disabled]="!entries().length"><i class="ti ti-download" aria-hidden="true"></i>Export CSV</button>
          <button type="button" class="btn btn-primary" (click)="openLog(null)" [disabled]="!activeProjects().length"><i class="ti ti-plus" aria-hidden="true"></i>Log time</button>
        </div>
      </div>

      @if (error()) {
        <div class="alert" role="alert"><span>{{ error() }}</span><button type="button" class="btn" (click)="load()">Try again</button></div>
      } @else if (loading()) {
        <p class="muted">Loading timesheet…</p>
      } @else if (!projects().length) {
        <div class="empty">
          <i class="ti ti-clock-hour-4" aria-hidden="true"></i>
          <h2>Start by creating a project</h2>
          <p>A project belongs to a customer and has an hourly rate. Then track time with the timer or log it by hand, and bill it on an invoice.</p>
          <a class="btn btn-primary" routerLink="/time-tracking/projects/new">New project</a>
        </div>
      } @else {
        <div class="card timer-card">
          @if (timer.running(); as t) {
            <div class="timer-live">
              <span class="timer-dot" aria-hidden="true"></span>
              <div><strong>{{ t.projectName }}</strong><div class="sub">{{ t.task || 'No task description' }} · {{ t.customerName }}</div></div>
              <span class="timer-clock mono" aria-live="off">{{ clock(timer.elapsed()) }}</span>
              <button type="button" class="btn btn-primary" (click)="stop()"><i class="ti ti-player-stop-filled" aria-hidden="true"></i>Stop and save</button>
            </div>
          } @else {
            <form class="timer-start" (ngSubmit)="start()">
              <select name="tp" [(ngModel)]="timerProject" aria-label="Project for the timer">
                <option [ngValue]="0" disabled>Choose a project</option>
                @for (p of activeProjects(); track p.id) { <option [ngValue]="p.id">{{ p.name }} · {{ p.customerName }}</option> }
              </select>
              <input type="text" name="tt" [(ngModel)]="timerTask" placeholder="What are you working on?" maxlength="255" aria-label="Task" />
              <label class="check"><input type="checkbox" name="tb" [(ngModel)]="timerBillable" /><span>Billable</span></label>
              <button type="submit" class="btn btn-primary"><i class="ti ti-player-play-filled" aria-hidden="true"></i>Start timer</button>
            </form>
          }
        </div>

        <div class="week-nav">
          <button type="button" class="icon-btn" (click)="shift(-7)" aria-label="Previous week"><i class="ti ti-chevron-left" aria-hidden="true"></i></button>
          <strong>{{ week() | date: 'd MMM' }} – {{ weekEnd() | date: 'd MMM y' }}</strong>
          <button type="button" class="icon-btn" (click)="shift(7)" aria-label="Next week"><i class="ti ti-chevron-right" aria-hidden="true"></i></button>
          @if (week() !== thisWeek) { <button type="button" class="link-btn" (click)="goToday()">This week</button> }
        </div>

        <div class="week-grid">
          @for (d of days(); track d.date) {
            <div class="card day-card" [class.today]="d.date === today">
              <div class="day-head">
                <span>{{ d.date | date: 'EEE d MMM' }}</span>
                <span class="sub">{{ d.minutes ? fmt(d.minutes) : '' }}</span>
                <button type="button" class="icon-btn" (click)="openLog(null, d.date)" [attr.aria-label]="'Log time on ' + d.date" [disabled]="!activeProjects().length"><i class="ti ti-plus" aria-hidden="true"></i></button>
              </div>
              @for (e of d.entries; track e.id) {
                <div class="entry" [class.running]="e.running">
                  <div class="entry-main">
                    <strong>{{ e.projectName }}</strong>
                    <span class="sub">{{ e.task || 'No task' }} · {{ e.customerName }}@if (e.userName) { · {{ e.userName }} }</span>
                  </div>
                  <span class="entry-time mono">{{ e.running ? 'Running' : fmt(e.minutes) }}</span>
                  @if (e.invoiceNumber) {
                    <a class="badge" data-tone="paid" [routerLink]="['/invoices', e.invoiceId]">Billed · {{ e.invoiceNumber }}</a>
                  } @else if (!e.running) {
                    <span class="badge" [attr.data-tone]="e.billable ? 'sent' : 'muted'">{{ e.billable ? 'Billable' : 'Not billable' }}</span>
                    <button type="button" class="icon-btn" (click)="openLog(e)" [attr.aria-label]="'Edit ' + e.task"><i class="ti ti-pencil" aria-hidden="true"></i></button>
                    <button type="button" class="icon-btn" (click)="remove(e)" aria-label="Delete entry"><i class="ti ti-trash" aria-hidden="true"></i></button>
                  }
                </div>
              } @empty {
                <p class="sub day-empty">No time logged</p>
              }
            </div>
          }
        </div>
      }
    </section>

    @if (logOpen()) {
      <app-time-entry-dialog [projects]="projects()" [entry]="editing()" [datePreset]="logDate()" [projectPreset]="timerProject"
        (saved)="onSaved()" (closed)="logOpen.set(false)" />
    }
  `,
})
export class Timesheet {
  private api = inject(Api);
  private toasts = inject(Toasts);
  protected timer = inject(Timer);
  protected readonly clock = clock;
  protected readonly fmt = duration;
  protected readonly today = todayISO();
  protected readonly thisWeek = weekStart(this.today);

  protected projects = signal<Project[]>([]);
  protected entries = signal<TimeEntry[]>([]);
  protected loading = signal(true);
  protected error = signal('');
  protected week = signal(this.thisWeek);
  protected weekEnd = computed(() => addDays(this.week(), 6));
  protected logOpen = signal(false);
  protected editing = signal<TimeEntry | null>(null);
  protected logDate = signal('');
  protected timerProject = 0;
  protected timerTask = '';
  protected timerBillable = true;

  protected activeProjects = computed(() => this.projects().filter((p) => p.status === 'active'));
  protected days = computed(() => Array.from({ length: 7 }, (_, i) => {
    const date = addDays(this.week(), i);
    const entries = this.entries().filter((e) => e.date === date);
    return { date, entries, minutes: entries.reduce((s, e) => s + e.minutes, 0) };
  }));
  protected weekTotal = computed(() => this.entries().reduce((s, e) => s + e.minutes, 0));
  protected weekBillable = computed(() => this.entries().filter((e) => e.billable).reduce((s, e) => s + e.minutes, 0));

  constructor() {
    this.load();
  }

  protected load() {
    this.loading.set(true);
    this.error.set('');
    forkJoin({ projects: this.api.projects(), entries: this.api.timeEntries({ from: this.week(), to: this.weekEnd() }) }).subscribe({
      next: ({ projects, entries }) => {
        this.projects.set(projects);
        this.entries.set(entries);
        if (!this.timerProject) this.timerProject = projects.find((p) => p.status === 'active')?.id ?? 0;
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.loading.set(false);
      },
    });
  }

  private reloadEntries() {
    this.api.timeEntries({ from: this.week(), to: this.weekEnd() }).subscribe({ next: (e) => this.entries.set(e) });
  }

  protected shift(days: number) {
    this.week.set(addDays(this.week(), days));
    this.reloadEntries();
  }

  protected goToday() {
    this.week.set(this.thisWeek);
    this.reloadEntries();
  }

  protected start() {
    if (!this.timerProject) return this.toasts.show('Choose a project first.', 'error');
    this.timer.start({ projectId: this.timerProject, task: this.timerTask, billable: this.timerBillable }).subscribe({
      next: () => {
        this.timerTask = '';
        this.reloadEntries();
      },
      error: (e) => this.toasts.show(errorMessage(e), 'error'),
    });
  }

  protected stop() {
    this.timer.stop().subscribe({
      next: (t) => {
        this.toasts.show(`Saved ${duration(t.minutes)} on ${t.projectName}`);
        this.reloadEntries();
      },
      error: (e) => this.toasts.show(errorMessage(e), 'error'),
    });
  }

  protected openLog(entry: TimeEntry | null, date = '') {
    this.editing.set(entry);
    this.logDate.set(date);
    this.logOpen.set(true);
  }

  protected onSaved() {
    this.logOpen.set(false);
    this.toasts.show(this.editing() ? 'Time updated' : 'Time logged');
    this.reloadEntries();
  }

  protected remove(e: TimeEntry) {
    if (!confirm(`Delete ${duration(e.minutes)} on ${e.projectName}?`)) return;
    this.api.deleteTimeEntry(e.id).subscribe({
      next: () => this.reloadEntries(),
      error: (err) => this.toasts.show(errorMessage(err), 'error'),
    });
  }

  protected exportCsv() {
    downloadCsv(`averqo-timesheet-${this.week()}.csv`,
      ['Date', 'Project', 'Customer', 'Task', 'Notes', 'Hours', 'Minutes', 'Billable', 'Billed on', 'Person'],
      this.entries().filter((e) => !e.running).map((e) => [e.date, e.projectName, e.customerName, e.task, e.notes,
        (e.minutes / 60).toFixed(2), e.minutes, e.billable ? 'Yes' : 'No', e.invoiceNumber ?? '', e.userName ?? '']));
  }
}
