import { Routes } from '@angular/router';
import { AdminPreviewComponent } from './admin-preview.component';
import { HomeComponent } from './home.component';
import { PostDetailComponent } from './post-detail.component';

export const routes: Routes = [
  { path: '', component: HomeComponent, pathMatch: 'full' },
  { path: 'posts/:slug', component: PostDetailComponent },
  { path: 'admin', component: AdminPreviewComponent },
  { path: '**', redirectTo: '' },
];
