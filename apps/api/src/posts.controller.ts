import { Controller, Get } from '@nestjs/common';
import { PostsService, PublicPostSummary } from './posts.service';

@Controller('public/posts')
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  @Get()
  listPublic(): Promise<readonly PublicPostSummary[]> {
    return this.posts.listPublic();
  }
}

