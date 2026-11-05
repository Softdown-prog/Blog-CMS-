import { HttpClient } from '@angular/common/http';
import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';
interface PageItem { readonly id: string; readonly title: string; readonly slug: string; readonly excerpt: string }
type State = { status: 'loading' | 'ready' | 'error'; pages: readonly PageItem[] };
@Component({
 selector: 'blog-pages-index', standalone: true, imports: [RouterLink],
 template: `
   <section class="container">
     <p class="eyebrow">PÁGINAS</p>
     <h1>Páginas e tutoriais</h1>
     <p>Guias e informações permanentes, separados das postagens do blog.</p>
     @if (state().status === 'loading') {
       <p class="panel">Carregando páginas…</p>
     } @else if (state().status === 'error') {
       <p class="panel" role="alert">Não foi possível carregar as páginas.</p>
     } @else {
       @for (page of state().pages; track page.id) {
         <article class="panel">
           <h2><a [routerLink]="['/pages', page.slug]">{{ page.title }}</a></h2>
           <p>{{ page.excerpt }}</p>
         </article>
       } @empty {
         <p class="panel">Nenhuma página publicada por enquanto.</p>
       }
     }
   </section>
 `,
})
export class PagesIndexComponent {
 private readonly http = inject(HttpClient);
 protected readonly state = toSignal(
   this.http.get<readonly PageItem[]>('/api/public/pages').pipe(
     map((pages): State => ({ status: 'ready', pages })),
     catchError(() => of<State>({ status: 'error', pages: [] })),
   ),
   { initialValue: { status: 'loading', pages: [] } as State },
 );
}
