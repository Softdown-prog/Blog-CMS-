import { Routes } from '@angular/router';
import { adminGuard } from './admin-auth.guard';
import { AdminWorkspaceComponent } from './admin-workspace.component';
import { HomeComponent } from './home.component';
import { LoginComponent } from './login.component';
import { PostDetailComponent } from './post-detail.component';

export const routes: Routes = [
  { path: '', component: HomeComponent, pathMatch: 'full' },
  { path: 'posts/:slug', component: PostDetailComponent },
  { path: 'login', component: LoginComponent },
  { path: 'admin', component: AdminWorkspaceComponent, canActivate: [adminGuard] },
  { path: '**', redirectTo: '' },
];
