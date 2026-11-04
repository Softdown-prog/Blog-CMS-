import { Module } from '@nestjs/common';
import { DatabaseLifecycle, databaseProvider } from './database';
import { HealthController } from './health.controller';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';

@Module({
  controllers: [HealthController, PostsController],
  providers: [databaseProvider, DatabaseLifecycle, PostsService],
})
export class AppModule {}

