import { Module } from '@nestjs/common';
import { DatabaseLifecycle, databaseProvider } from './database';
import { HealthController } from './health.controller';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { AdminAuthController, authProvider } from './security/admin-auth.controller';

@Module({
  controllers: [HealthController, PostsController, AdminAuthController],
  providers: [databaseProvider, DatabaseLifecycle, PostsService, authProvider],
})
export class AppModule {}

