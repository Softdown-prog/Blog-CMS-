import { Routes } from '@angular/router';
import { AdminPreviewComponent } from './admin-preview.component';
import { HomeComponent } from './home.component';

export const routes: Routes = [
  { path: '', component: HomeComponent, pathMatch: 'full' },
  { path: 'admin', component: AdminPreviewComponent },
  { path: '**', redirectTo: '' },
];

