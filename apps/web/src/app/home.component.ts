import { HttpClient } from '@angular/common/http';
import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { catchError, of } from 'rxjs';

interface PostSummary {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly excerpt: string;
  readonly publishedAt: string;
}

@Component({
  selector: 'blog-home',
  standalone: true,
  template: `
    <section class="container">
      <p class="eyebrow">BLOG</p>
      <h1>Artigos e novidades</h1>
      <p>Área pública do Blog CMS.</p>
      <div class="posts" aria-live="polite">
        @for (post of posts(); track post.id) {
          <article class="panel">
            <h2>{{ post.title }}</h2>
            <p>{{ post.excerpt }}</p>
          </article>
        } @empty {
          <p class="panel">Ainda não existem publicações. O backend está em preparação.</p>
        }
      </div>
    </section>
  `,
})
export class HomeComponent {
  private readonly http = inject(HttpClient);
  protected readonly posts = toSignal(
    this.http.get<readonly PostSummary[]>('/api/public/posts').pipe(
      catchError(() => of([] as readonly PostSummary[])),
    ),
    { initialValue: [] as readonly PostSummary[] },
  );
}

