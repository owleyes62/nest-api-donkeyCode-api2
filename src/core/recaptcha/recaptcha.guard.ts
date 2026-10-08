import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { RecaptchaService } from './recaptcha.service';
import { RECAPTCHA_ACAO } from './recaptcha.decorator';

// O front pode nomear o campo de formas diferentes; aceitar os três evita um
// 400 chato só por causa do nome da chave.
const CAMPOS_ACEITOS = ['recaptchaToken', 'captchaToken', 'recaptcha'] as const;

/**
 * Valida o captcha antes de o handler rodar.
 *
 * Fica como guard (e não dentro do service) para que a regra seja declarativa
 * na rota e o AuthService/UserService continuem sem saber que captcha existe.
 */
@Injectable()
export class RecaptchaGuard implements CanActivate {
  constructor(
    private readonly recaptcha: RecaptchaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const acao = this.reflector.getAllAndOverride<string | null>(RECAPTCHA_ACAO, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<Request>();
    const body = (request.body ?? {}) as Record<string, unknown>;

    const token = CAMPOS_ACEITOS.map((campo) => body[campo]).find(
      (v) => typeof v === 'string' && v.trim() !== '',
    );

    await this.recaptcha.verificar(token, {
      acao: acao ?? undefined,
      // remoteip é opcional no siteverify, mas ajuda o Google a pontuar.
      ip: request.ip,
    });

    return true;
  }
}
