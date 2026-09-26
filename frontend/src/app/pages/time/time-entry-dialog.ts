import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, errorMessage } from '../../core/api';
import { todayISO } from '../../core/format';
import { Project, TimeEntry } from '../../core/models';
import { duration, parseDuration } from '../../core/timer';

/** Log or edit one timesheet entry. */
@Component({
  selector: 'app-time-entry-dialog',
  imports: [FormsModule],
  template: `
    <div class="dialog-backdrop" (click)="closed.emit()">
      <div class="dialog card" role="dialog" aria-modal="true" aria-labelledby="te-title" (click)="$event.stopPropagation()">
        <div class="dialog-head"><h2 id="te-title">{{ entry() ? 'Edit time' : 'Log time' }}</h2>
          <button type="button" class="icon-btn" aria-label="Close" (click)="closed.emit()"><i class="ti ti-x" aria-hidden="true"></i></button></div>
        <form (ngSubmit)="save()" class="form-grid" novalidate>
          <label class="field span-2"><span>Project</span>
            <select name="project" [(ngModel)]="projectId" (ngModelChange)="projectChanged()">
              <option [ngValue]="0" disabled>Choose a project</option>
              @for (p of options(); track p.id) { <option [ngValue]="p.id">{{ p.name }} · {{ p.customerName }}</option> }
            </select></label>
          <label class="field"><span>Date</span><input type="date" name="date" [(ngModel)]="date" /></label>
          <label class="field"><span>Time spent</span><input type="text" name="duration" [(ngModel)]="durationText" placeholder="1:30 or 1.5" autocomplete="off" />
            <small class="hint">{{ minutes() ? '= ' + fmt(minutes()) : 'Hours:minutes, or hours like 1.5' }}</small></label>
          <label class="field span-2"><span>Task</span><input type="text" name="task" [(ngModel)]="task" maxlength="255" placeholder="What did you work on?" /></label>
          <label class="field span-2"><span>Notes <em class="sub">(optional)</em></span><textarea name="notes" [(ngModel)]="notes" rows="2" maxlength="1000"></textarea></label>
          <label class="check span-2"><input type="checkbox" name="billable" [(ngModel)]="billable" /><span>Billable to the customer</span></label>
          @if (error()) { <div class="alert span-2" role="alert"><span>{{ error() }}</span></div> }
          <div class="form-actions span-2">
            <button type="button" class="btn" (click)="closed.emit()">Cancel</button>
            <button type="submit" class="btn btn-primary" [disabled]="saving()">{{ saving() ? 'Saving…' : 'Save' }}</button>
          </div>
        </form>
      </div>
    </div>
  `,
})
export class TimeEntryDialog implements OnInit {
  private api = inject(Api);
  readonly projects = input.required<Project[]>();
  readonly entry = input<TimeEntry | null>(null);
  readonly projectPreset = input<number>(0);
  readonly datePreset = input<string>('');
  readonly saved = output<TimeEntry>();
  readonly closed = output<void>();
  protected readonly fmt = duration;

  protected projectId = 0;
  protected date = todayISO();
  protected durationText = '';
  protected task = '';
  protected notes = '';
  protected billable = true;
  protected saving = signal(false);
  protected error = signal('');
  protected options = computed(() => this.projects().filter((p) => p.status === 'active' || p.id === this.entry()?.projectId));

  protected minutes() {
    return parseDuration(this.durationText);
  }

  ngOnInit() {
    const e = this.entry();
    if (e) {
      this.projectId = e.projectId;
      this.date = e.date;
      this.durationText = `${Math.floor(e.minutes / 60)}:${String(e.minutes % 60).padStart(2, '0')}`;
      this.task = e.task;
      this.notes = e.notes;
      this.billable = e.billable;
    } else {
      this.projectId = this.projectPreset() || 0;
      if (this.datePreset()) this.date = this.datePreset();
      this.projectChanged();
    }
  }

  protected projectChanged() {
    const p = this.projects().find((x) => x.id === this.projectId);
    if (p && !this.entry()) this.billable = p.hourlyRate > 0;
  }

  protected save() {
    this.error.set('');
    const minutes = this.minutes();
    if (!this.projectId) return this.error.set('Choose a project.');
    if (minutes < 1 || minutes > 1440) return this.error.set('Enter the time spent, like 1:30 or 1.5 (up to 24 hours).');
    this.saving.set(true);
    const body = { projectId: this.projectId, date: this.date, task: this.task, minutes, notes: this.notes, billable: this.billable };
    this.api.saveTimeEntry(body, this.entry()?.id).subscribe({
      next: (t) => this.saved.emit(t),
      error: (e) => {
        this.error.set(errorMessage(e));
        this.saving.set(false);
      },
    });
  }
}
