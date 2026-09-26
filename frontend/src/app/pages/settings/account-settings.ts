import { DatePipe } from '@angular/common';
import { AfterViewInit, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Api, errorMessage } from '../../core/api';
import { Auth } from '../../core/auth';
import { User } from '../../core/models';
import { Toasts } from '../../core/toast';

/** "Your account" (change password) for everyone, and "Team" for the owner. */
@Component({
  selector: 'app-account-settings',
  imports: [FormsModule, DatePipe],
  template: `
    <div class="card form-card" id="account">
      <h2>Your account</h2>
      <p class="muted">Signed in as <strong>{{ auth.user()?.name }}</strong> ({{ auth.user()?.email }}), {{ auth.isOwner() ? 'owner' : 'staff' }}.</p>
      <form class="form-grid" (ngSubmit)="changePassword()" novalidate>
        <label class="field span-2"><span>Current password</span><input type="password" name="cur" [(ngModel)]="current" autocomplete="current-password" /></label>
        <label class="field"><span>New password</span><input type="password" name="new" [(ngModel)]="next" autocomplete="new-password" /></label>
        <label class="field"><span>Type it again</span><input type="password" name="again" [(ngModel)]="again" autocomplete="new-password" /></label>
        @if (pwError()) { <div class="alert span-2" role="alert"><span>{{ pwError() }}</span></div> }
        <div class="form-actions span-2"><button type="submit" class="btn" [disabled]="pwBusy()">{{ pwBusy() ? 'Changing…' : 'Change password' }}</button></div>
      </form>
      <p class="sub">Changing your password signs you out on your other devices.</p>
    </div>

    @if (auth.isOwner()) {
      <div class="card form-card" id="team">
        <h2>Team</h2>
        <p class="muted">Staff can do everyday work: invoices, payments, expenses, time, GST filing, and reports. Only owners can change these settings and the team.</p>
        <div class="table-card">
          <table class="table">
            <thead><tr><th>Name</th><th>Role</th><th class="hide-sm">Last signed in</th><th></th></tr></thead>
            <tbody>
              @for (u of users(); track u.id) {
                <tr [class.muted]="!u.active">
                  <td><strong>{{ u.name }}</strong> @if (u.id === auth.user()?.id) { <span class="sub">(you)</span> }<div class="sub">{{ u.email }}</div></td>
                  <td>
                    <select [ngModel]="u.role" (ngModelChange)="update(u, { role: $event })" [attr.aria-label]="'Role for ' + u.name">
                      <option value="owner">Owner</option><option value="staff">Staff</option>
                    </select>
                    @if (!u.active) { <span class="badge" data-tone="void">Turned off</span> }
                  </td>
                  <td class="hide-sm">{{ u.lastLoginAt ? (u.lastLoginAt + 'Z' | date: 'd MMM y, h:mm a') : 'Never' }}</td>
                  <td class="row-end">
                    @if (u.id !== auth.user()?.id) {
                      <button type="button" class="link-btn" (click)="update(u, { active: !u.active })">{{ u.active ? 'Turn off' : 'Turn on' }}</button>
                      <button type="button" class="link-btn" (click)="resetPassword(u)">Set password</button>
                      <button type="button" class="icon-btn" (click)="remove(u)" [attr.aria-label]="'Remove ' + u.name"><i class="ti ti-trash" aria-hidden="true"></i></button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <h3 class="subhead">Add a team member</h3>
        <form class="form-grid" (ngSubmit)="add()" novalidate>
          <label class="field"><span>Name</span><input type="text" name="n" [(ngModel)]="newName" maxlength="100" /></label>
          <label class="field"><span>Email</span><input type="email" name="e" [(ngModel)]="newEmail" /></label>
          <label class="field"><span>Role</span><select name="r" [(ngModel)]="newRole"><option value="staff">Staff</option><option value="owner">Owner</option></select></label>
          <label class="field"><span>Password for them</span><input type="text" name="p" [(ngModel)]="newPassword" autocomplete="off" />
            <small class="hint">At least 8 characters. Share it with them privately; they can change it after signing in.</small></label>
          @if (teamError()) { <div class="alert span-2" role="alert"><span>{{ teamError() }}</span></div> }
          <div class="form-actions span-2"><button type="submit" class="btn">Add team member</button></div>
        </form>
      </div>
    }
  `,
})
export class AccountSettings implements AfterViewInit {
  protected auth = inject(Auth);
  private api = inject(Api);
  private toasts = inject(Toasts);
  private route = inject(ActivatedRoute);
  protected current = '';
  protected next = '';
  protected again = '';
  protected pwBusy = signal(false);
  protected pwError = signal('');
  protected users = signal<User[]>([]);
  protected teamError = signal('');
  protected newName = '';
  protected newEmail = '';
  protected newRole = 'staff';
  protected newPassword = '';

  constructor() {
    if (this.auth.isOwner()) this.loadUsers();
  }

  ngAfterViewInit() {
    const f = this.route.snapshot.fragment;
    if (f) setTimeout(() => document.getElementById(f)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }

  private loadUsers() {
    this.api.users().subscribe({ next: (u) => this.users.set(u), error: (e) => this.teamError.set(errorMessage(e)) });
  }

  protected changePassword() {
    this.pwError.set('');
    if (this.next.length < 8) return this.pwError.set('Use a new password of at least 8 characters.');
    if (this.next !== this.again) return this.pwError.set("The new passwords don't match.");
    this.pwBusy.set(true);
    this.auth.changePassword(this.current, this.next).subscribe({
      next: () => {
        this.pwBusy.set(false);
        this.current = this.next = this.again = '';
        this.toasts.show('Password changed');
      },
      error: (e) => {
        this.pwBusy.set(false);
        this.pwError.set(errorMessage(e));
      },
    });
  }

  protected add() {
    this.teamError.set('');
    this.api.saveUser({ name: this.newName, email: this.newEmail, role: this.newRole, password: this.newPassword }).subscribe({
      next: (u) => {
        this.toasts.show(`${u.name} can now sign in`);
        this.newName = this.newEmail = this.newPassword = '';
        this.newRole = 'staff';
        this.loadUsers();
      },
      error: (e) => this.teamError.set(errorMessage(e)),
    });
  }

  protected update(u: User, change: Partial<User>) {
    const next = { ...u, ...change };
    this.api.saveUser({ name: next.name, email: next.email, role: next.role, active: next.active }, u.id).subscribe({
      next: () => this.loadUsers(),
      error: (e) => {
        this.toasts.show(errorMessage(e), 'error');
        this.loadUsers();
      },
    });
  }

  protected resetPassword(u: User) {
    const p = prompt(`New password for ${u.name} (at least 8 characters). They'll be signed out everywhere.`);
    if (!p) return;
    this.api.resetUserPassword(u.id, p).subscribe({
      next: () => this.toasts.show(`Password changed for ${u.name}`),
      error: (e) => this.toasts.show(errorMessage(e), 'error'),
    });
  }

  protected remove(u: User) {
    if (!confirm(`Remove ${u.name} from the team? Their past work stays.`)) return;
    this.api.deleteUser(u.id).subscribe({ next: () => this.loadUsers(), error: (e) => this.toasts.show(errorMessage(e), 'error') });
  }
}
