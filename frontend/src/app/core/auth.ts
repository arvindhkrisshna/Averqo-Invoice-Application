import { HttpClient, HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot } from '@angular/router';
import { Observable, catchError, map, of, shareReplay, tap, throwError } from 'rxjs';
import { AuthStatus, User } from './models';

/** Who is signed in. Every page except sign-in needs a signed-in user. */
@Injectable({ providedIn: 'root' })
export class Auth {
  private http = inject(HttpClient);
  private router = inject(Router);
  readonly status = signal<AuthStatus | null>(null);
  readonly user = computed(() => this.status()?.user ?? null);
  readonly isOwner = computed(() => this.user()?.role === 'owner');
  private pending$?: Observable<AuthStatus>;

  load(force = false): Observable<AuthStatus> {
    const current = this.status();
    if (current && !force) return of(current);
    return (this.pending$ ??= this.http.get<AuthStatus>('/api/auth/status').pipe(
      tap((s) => {
        this.status.set(s);
        this.pending$ = undefined;
      }),
      shareReplay(1),
    ));
  }

  private signedIn(u: User) {
    this.status.set({ setupNeeded: false, setupCodeRequired: false, user: u });
  }

  login(email: string, password: string) {
    return this.http.post<User>('/api/auth/login', { email, password }).pipe(tap((u) => this.signedIn(u)));
  }

  setup(body: { name: string; email: string; password: string; setupCode: string }) {
    return this.http.post<User>('/api/auth/setup', body).pipe(tap((u) => this.signedIn(u)));
  }

  logout() {
    return this.http.post<void>('/api/auth/logout', {}).pipe(
      catchError(() => of(undefined)),
      tap(() => {
        this.status.set({ setupNeeded: false, setupCodeRequired: false, user: null });
        this.router.navigate(['/login']);
      }),
    );
  }

  changePassword(currentPassword: string, newPassword: string) {
    return this.http.post<{ status: string }>('/api/auth/password', { currentPassword, newPassword });
  }

  /** Called when the server says the sign-in has ended (expired, or turned off by the owner). */
  signedOut() {
    if (!this.user()) return;
    const next = this.router.url;
    this.status.set({ setupNeeded: false, setupCodeRequired: false, user: null });
    this.router.navigate(['/login'], { queryParams: next && !next.startsWith('/login') ? { next } : {} });
  }
}

/** Adds the header the server requires on every change (blocks cross-site requests), and handles expired sign-ins. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(Auth);
  const request = req.url.startsWith('/api/') ? req.clone({ setHeaders: { 'X-Requested-With': 'Averqo' } }) : req;
  return next(request).pipe(
    catchError((e: unknown) => {
      if (e instanceof HttpErrorResponse && e.status === 401 && !req.url.startsWith('/api/auth/')) auth.signedOut();
      return throwError(() => e);
    }),
  );
};

/** Pages inside the app need a signed-in user. */
export const authGuard = (_route: ActivatedRouteSnapshot, state: RouterStateSnapshot) => {
  const auth = inject(Auth);
  const router = inject(Router);
  return auth.load().pipe(
    map((s) => {
      if (s.user) return true;
      if (s.setupNeeded) return router.createUrlTree(['/setup']);
      const next = state.url && !['/', '/home'].includes(state.url) ? { next: state.url } : {};
      return router.createUrlTree(['/login'], { queryParams: next });
    }),
    catchError(() => of(router.createUrlTree(['/login']))),
  );
};

/** The sign-in and setup pages are only for people who aren't signed in. */
export const guestGuard = (route: ActivatedRouteSnapshot) => {
  const auth = inject(Auth);
  const router = inject(Router);
  const isSetup = route.routeConfig?.path === 'setup';
  return auth.load().pipe(
    map((s) => {
      if (s.user) return router.createUrlTree(['/home']);
      if (isSetup && !s.setupNeeded) return router.createUrlTree(['/login']);
      if (!isSetup && s.setupNeeded) return router.createUrlTree(['/setup']);
      return true;
    }),
    catchError(() => of(true)),
  );
};
