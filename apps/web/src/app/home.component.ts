import { HttpClient } from '@angular/common/http';
import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';

interface PostSummary {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly excerpt: string;
  readonly publishedAt: string;
}
type PostState =
  | { readonly status: 'loading'; readonly posts: readonly PostSummary[] }
  | { readonly status: 'ready'; readonly posts: readonly PostSummary[] }
  | { readonly status: 'error'; readonly posts: readonly PostSummary[] };

@Component({
  selector: 'blog-home',
  standalone: true,
  imports: [RouterLink],
  template: `
    <section class="container">
      <p class="eyebrow">BLOG</p>
      <h1>Artigos e novidades</h1>
      <p>Área pública do Blog CMS.</p>
      <div class="posts" aria-live="polite">
        @if (state().status === 'loading') {
          <p class="panel">Carregando artigos…</p>
        } @else if (state().status === 'error') {
          <p class="panel" role="alert">Não foi possível carregar os artigos agora.</p>
        } @else {
          @for (post of state().posts; track post.id) {
            <article class="panel">
              <h2><a [routerLink]="['/posts', post.slug]">{{ post.title }}</a></h2>
              <p>{{ post.excerpt }}</p>
              <a [routerLink]="['/posts', post.slug]" [attr.aria-label]="'Ler artigo: ' + post.title">Ler artigo</a>
            </article>
          } @empty {
            <p class="panel">Ainda não existem artigos publicados.</p>
          }
        }
      </div>
    </section>
  `,
})
export class HomeComponent {
  private readonly http = inject(HttpClient);
  protected readonly state = toSignal(
    this.http.get<readonly PostSummary[]>('/api/public/posts').pipe(
      map((posts): PostState => ({ status: 'ready', posts })),
      catchError(() => of({ status: 'error' as const, posts: [] as readonly PostSummary[] })),
    ),
    { initialValue: { status: 'loading', posts: [] } as PostState },
  );
}
