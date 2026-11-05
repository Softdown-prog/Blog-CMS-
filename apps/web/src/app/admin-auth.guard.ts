import { HttpClient } from '@angular/common/http';
import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';

/** Nunca confiar em sinal local para liberar navegação administrativa. */
export const adminGuard: CanActivateFn = () => {
  const http = inject(HttpClient);
  const router = inject(Router);
  return http.get('/api/admin/session').pipe(
    map(() => true),
    catchError(() => of(router.createUrlTree(['/login']))),
  );
};
