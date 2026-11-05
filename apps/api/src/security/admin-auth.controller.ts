import { createHmac } from 'node:crypto';
import { Algorithm, hash, parseOptions, verify } from '@node-rs/argon2';
import {
  Body, Controller, Get, HttpCode, HttpException, Inject,
  Post, Req, Res, ServiceUnavailableException,
  UnauthorizedException, ForbiddenException,
} from '@nestjs/common';
import type { Provider } from '@nestjs/common';
import type { Pool } from 'pg';
import { BLOG_DATABASE } from '../database';
import { AdminSessionAccess } from './admin-session';
import type { AdminCredentialInput } from './admin-session';
import { VerifyPasswordLogin } from './password-login';
import { PgAuthenticationStore } from './postgres-auth';
import { SessionLifecycle } from './session-lifecycle';
import type { SessionCredentials } from './session-lifecycle';

export const CMS_AUTH = 'CMS_AUTH';
const SESSION_COOKIE = 'cms_session';
const CSRF_COOKIE = 'cms_csrf';
const COOKIE_MAX_AGE = 8 * 60 * 60;
const ARGON_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

interface HttpRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly socket: { readonly remoteAddress?: string };
}
interface HttpResponse {
  setHeader(name: string, value: string | readonly string[]): void;
}
interface UserPublic {
  readonly id: string;
  readonly role: 'author' | 'editor' | 'admin';
}
interface AuthService {
  readonly origin: string;
  readonly https: boolean;
  readonly access: AdminSessionAccess;
  readonly lifecycle: SessionLifecycle;
  readonly login: VerifyPasswordLogin;
  readonly store: PgAuthenticationStore;
  networkDigest(remoteAddress: string): string;
}

export const authProvider: Provider = {
  provide: CMS_AUTH,
  inject: [BLOG_DATABASE],
  useFactory: async (pool: Pool | null): Promise<AuthService | null> => {
    const origin = process.env['CMS_APP_ORIGIN'];
    const secret = process.env['CMS_AUTH_HMAC_SECRET'];
    // Disabled is safer than an in-memory or hardcoded password fallback.
    if (!pool || !origin || !secret) return null;
    const store = new PgAuthenticationStore(pool, secret);
    const access = new AdminSessionAccess(store, Date.now, origin);
    const lifecycle = new SessionLifecycle(store, access, Date.now);
    const dummyHash = await hash('CMS non-existing account dummy hash', ARGON_OPTIONS);
    const passwords = {
      async verify(password: string, encodedArgon2id: string): Promise<boolean> {
        try {
          const options = parseOptions(encodedArgon2id);
          // Prevent expensive or incompatible hashes in the persisted database.
          if (options.algorithm !== Algorithm.Argon2id
            || options.memoryCost < 19_456 || options.memoryCost > 65_536
            || options.timeCost < 2 || options.timeCost > 4
            || options.parallelism !== 1) return false;
          return await verify(encodedArgon2id, password);
        } catch {
          return false;
        }
      },
    };
    const login = new VerifyPasswordLogin(store, passwords, store, Date.now, dummyHash);
    return {
      origin, https: origin.startsWith('https:'), access, lifecycle, login, store,
      networkDigest(remoteAddress: string): string {
        return createHmac('sha256', secret).update(remoteAddress).digest('hex');
      },
    };
  },
};

function parsedCookies(request: HttpRequest, name: string): string | undefined {
  const value = request.headers.cookie;
  if (typeof value !== 'string' || value.length > 8192) return undefined;
  const matches = value.split(';').map(part => part.trim())
    .filter(part => part.startsWith(name + '='));
  if (matches.length !== 1) return undefined;
  const token = matches[0]?.slice(name.length + 1);
  return token && /^[A-Za-z0-9_-]+$/.test(token) ? token : undefined;
}

export function credentials(request: HttpRequest): AdminCredentialInput {
  return {
    sessionToken: parsedCookies(request, SESSION_COOKIE),
    csrfHeader: request.headers['x-cms-csrf'],
    requestOrigin: request.headers.origin,
  };
}
function rejectAuth(reason: string): never {
  if (reason === 'csrf-rejected' || reason === 'forbidden') {
    throw new ForbiddenException('Acesso negado.');
  }
  throw new UnauthorizedException('Sessão inválida.');
}
function cookieValue(
  name: string, value: string, https: boolean, httpOnly: boolean, maxAge: number,
): string {
  return name + '=' + value + '; Path=/; SameSite=Strict; Max-Age=' + maxAge
    + (https ? '; Secure' : '') + (httpOnly ? '; HttpOnly' : '');
}
function setCookies(res: HttpResponse, tokens: SessionCredentials, https: boolean): void {
  res.setHeader('Set-Cookie', [
    cookieValue(SESSION_COOKIE, tokens.sessionToken, https, true, COOKIE_MAX_AGE),
    cookieValue(CSRF_COOKIE, tokens.csrfToken, https, false, COOKIE_MAX_AGE),
  ]);
}
function clearCookies(res: HttpResponse, https: boolean): void {
  res.setHeader('Set-Cookie', [
    cookieValue(SESSION_COOKIE, '', https, true, 0),
    cookieValue(CSRF_COOKIE, '', https, false, 0),
  ]);
}
function noStore(res: HttpResponse): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
}
function strictLoginBody(body: unknown): body is { email: unknown; password: unknown } {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).length === 2
    && Object.hasOwn(body, 'email') && Object.hasOwn(body, 'password');
}

@Controller('admin')
export class AdminAuthController {
  constructor(@Inject(CMS_AUTH) private readonly auth: AuthService | null) {}

  private service(): AuthService {
    if (!this.auth) throw new ServiceUnavailableException('Autenticação indisponível.');
    return this.auth;
  }

  private requireOrigin(request: HttpRequest, service: AuthService): void {
    if (request.headers.origin !== service.origin) {
      throw new ForbiddenException('Origem não autorizada.');
    }
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown, @Req() request: HttpRequest, @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<{ user: UserPublic }> {
    noStore(res);
    const service = this.service();
    this.requireOrigin(request, service);
    if (!strictLoginBody(body)) throw new UnauthorizedException('Credenciais inválidas.');
    const address = request.socket.remoteAddress;
    if (!address) throw new ForbiddenException('Rede não identificada.');
    try {
      const result = await service.login.execute({
        email: body.email, password: body.password,
        trustedNetworkKey: service.networkDigest(address),
      });
      if (!result.ok) {
        if (result.reason === 'rate-limited') {
          throw new HttpException('Tentativas excessivas.', 429);
        }
        throw new UnauthorizedException('Credenciais inválidas.');
      }
      const issued = await service.lifecycle.issue(result.verified);
      if (!issued.ok) throw new UnauthorizedException('Credenciais inválidas.');
      const user = await service.store.findUserById(result.verified.userId);
      if (!user?.enabled || user.authVersion !== result.verified.authVersion) {
        // Account changed after token issue: session authVersion check prevents use.
        throw new UnauthorizedException('Credenciais inválidas.');
      }
      setCookies(res, issued.credentials, service.https);
      return { user: { id: user.id, role: user.role } };
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Autenticação temporariamente indisponível.');
    }
  }

  @Get('session')
  async session(@Req() request: HttpRequest, @Res({ passthrough: true }) res: HttpResponse):
    Promise<{ user: UserPublic }> {
    noStore(res);
    const service = this.service();
    try {
      const access = await service.access.authorize('list-posts', credentials(request));
      if (!access.ok) return rejectAuth(access.reason);
      return { user: { id: access.actor.id, role: access.actor.role } };
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Autenticação temporariamente indisponível.');
    }
  }

  @Post('rotate')
  @HttpCode(200)
  async rotate(
    @Req() request: HttpRequest, @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<{ ok: true }> {
    noStore(res);
    const service = this.service();
    this.requireOrigin(request, service);
    try {
      const rotated = await service.lifecycle.rotate(credentials(request));
      if (!rotated.ok) return rejectAuth(rotated.error);
      setCookies(res, rotated.credentials, service.https);
      return { ok: true };
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Autenticação temporariamente indisponível.');
    }
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() request: HttpRequest, @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<void> {
    noStore(res);
    const service = this.service();
    this.requireOrigin(request, service);
    try {
      const result = await service.lifecycle.logout(credentials(request));
      if (!result.ok) return rejectAuth(result.error);
      clearCookies(res, service.https);
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Autenticação temporariamente indisponível.');
    }
  }
}
