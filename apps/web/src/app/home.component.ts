import { HttpClient } from '@angular/common/http';
import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
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
              <h2>{{ post.title }}</h2>
              <p>{{ post.excerpt }}</p>
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
      catchError((): ReturnType<typeof of<PostState>> =>
        of({ status: 'error', posts: [] })),
    ),
    { initialValue: { status: 'loading', posts: [] } as PostState },
  );
}

