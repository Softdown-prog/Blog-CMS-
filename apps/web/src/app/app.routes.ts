import { Routes } from '@angular/router';
import { adminGuard } from './admin-auth.guard';
import { AdminWorkspaceComponent } from './admin-workspace.component';
import { AdminSiteComponent } from './admin-site.component';
import { HomeComponent } from './home.component';
import { LoginComponent } from './login.component';
import { PagesIndexComponent } from './pages-index.component';
import { PostDetailComponent } from './post-detail.component';
export const routes: Routes = [
 { path: '', component: HomeComponent, pathMatch: 'full' },
 { path: 'posts/:slug', component: PostDetailComponent, data: { kind: 'post' } },
 { path: 'pages', component: PagesIndexComponent },
 { path: 'pages/:slug', component: PostDetailComponent, data: { kind: 'page' } },
 { path: 'login', component: LoginComponent },
 { path: 'admin/site', component: AdminSiteComponent, canActivate: [adminGuard] },
 { path: 'admin', component: AdminWorkspaceComponent, canActivate: [adminGuard],
   canDeactivate: [(workspace: AdminWorkspaceComponent) => workspace.canLeave()] },
 { path: '**', redirectTo: '' },
];
