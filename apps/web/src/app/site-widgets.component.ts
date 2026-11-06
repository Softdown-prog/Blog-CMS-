import { HttpClient } from '@angular/common/http';
import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';
interface WidgetItem {
 readonly id: string; readonly title: string; readonly slug: string;
 readonly kind: 'post' | 'page'; readonly views?: number;
}
interface WidgetButton {
 readonly id: string; readonly label: string; readonly hoverText: string;
 readonly href: string; readonly enabled: boolean; readonly position: number;
}
interface DisplayWidget {
 readonly key: 'latest-posts' | 'popular-posts' | 'page-links' | 'text' | 'buttons';
 readonly title: string; readonly position: number; readonly content: string;
 readonly items: readonly WidgetItem[]; readonly buttons?: readonly WidgetButton[];
}
@Component({
 selector: 'blog-site-widgets', standalone: true, imports: [RouterLink],
 template: `
   <aside class="site-widgets" aria-label="Widgets do blog">
     @for (widget of widgets(); track widget.key) {
       <section class="panel site-widget" [attr.data-widget]="widget.key">
         <h2>{{ widget.title }}</h2>
         @if (widget.key === 'buttons') {
           <div class="widget-button-list" data-testid="public-buttons">
             @for (button of widget.buttons ?? []; track button.id) {
               <div class="widget-button-entry">
                 <a class="widget-action-button" [href]="button.href"
                   [attr.target]="button.href.startsWith('http://') || button.href.startsWith('https://') ? '_blank' : null"
                   [attr.rel]="button.href.startsWith('http://') || button.href.startsWith('https://') ? 'noopener noreferrer' : null"
                   [attr.title]="button.hoverText || null"
                   [attr.aria-describedby]="button.hoverText ? 'widget-tip-' + button.id : null">
                   {{ button.label }}
                 </a>
                 @if (button.hoverText) {
                   <span class="widget-button-tooltip" [id]="'widget-tip-' + button.id" role="note">{{ button.hoverText }}</span>
                 }
               </div>
             }
           </div>
         } @else if (widget.key === 'text') {
           <p class="widget-text">{{ widget.content }}</p>
         } @else {
           <ul class="widget-links">
             @for (entry of widget.items; track entry.id) {
               <li>
                 <a [routerLink]="entry.kind === 'page' ? ['/pages', entry.slug] : ['/posts', entry.slug]">{{ entry.title }}</a>
                 @if (widget.key === 'popular-posts' && entry.views !== undefined) {
                   <small>{{ entry.views }} leituras estimadas</small>
                 }
               </li>
             }
           </ul>
         }
       </section>
     }
   </aside>
 `,
})
export class SiteWidgetsComponent {
 private readonly http = inject(HttpClient);
 protected readonly widgets = toSignal(
   this.http.get<readonly DisplayWidget[]>('/api/public/widgets').pipe(
     catchError(() => of([] as readonly DisplayWidget[])),
   ),
   { initialValue: [] as readonly DisplayWidget[] },
 );
}
